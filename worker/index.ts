import type { ExecutionContext, D1PreparedStatement, ScheduledController, D1Database } from '@cloudflare/workers-types';
import type {
  Env,
  ProfileRow,
  UserRow,
  UserSettingsRow,
  PostRow,
  MediaRow,
  ClassRow,
  MessageRow,
} from './types.ts';
import {
  authenticateRequest,
  decodeOAuthState,
  encodeOAuthState,
  generateCodeChallenge,
  generateRandomString,
  parseCookies,
  serializeCookie,
  verifyGoogleIdToken,
} from './auth.ts';
import { normalizeUsername } from '../shared/username.ts';
import {
  updateProfileSchema,
  createPostSchema,
  createCommentSchema,
  createReportSchema,
  createFeedbackSchema,
  updateReportSchema,
  createConversationSchema,
  createMessageSchema,
  createBlockSchema,
  type PostItem,
  type CommentItem,
  type MediaItem,
  type TopicItem,
  type UserInterestTopic,
  type TrendItem,
  type ConversationItem,
  type MessageItem,
  type BlockItem,
} from '../shared/schema.ts';
import { checkRateLimit } from './rate-limit.ts';
import { runPostLifecycleExpiry, deletePostAndMedia } from './jobs/expiry.ts';
import { extractTopicsFromText } from './content/topics.ts';
import { rankPosts, type CandidatePost, type UserRankingContext } from './ranking/engine.ts';
import { computeDecayedWeight } from './ranking/decay.ts';

function jsonResponse(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

/**
 * Constant-time string comparison for secrets to prevent timing attacks.
 */
function constantTimeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = new TextEncoder().encode(a);
  const bBuf = new TextEncoder().encode(b);
  if (aBuf.byteLength !== bBuf.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < aBuf.byteLength; i++) {
    diff |= aBuf[i]! ^ bBuf[i]!;
  }
  return diff === 0;
}

/**
 * Encodes composite cursor for (created_at, id) pairs.
 */
function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`).toString('base64url');
}

/**
 * Decodes composite cursor. Supports base64url composite or raw ISO string fallback.
 */
function decodeCursor(cursorStr: string): { createdAt: string; id: string } | null {
  try {
    const raw = Buffer.from(cursorStr, 'base64url').toString('utf-8');
    if (raw.includes('|')) {
      const [createdAt, id] = raw.split('|');
      if (createdAt && id) return { createdAt, id };
    }
  } catch {
    // Fall back to direct string check
  }

  if (cursorStr.includes('T') && cursorStr.includes('Z')) {
    return { createdAt: cursorStr, id: '' };
  }
  return null;
}

/**
 * Checks if userA has blocked userB or vice versa.
 */
async function isBlockedBetween(db: D1Database, userA: string, userB: string): Promise<boolean> {
  try {
    const row = await db.prepare(
      'SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1'
    ).bind(userA, userB, userB, userA).first();
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Gets all user IDs blocked with the given user in either direction.
 */
async function getBlockedUserIds(db: D1Database, userId: string): Promise<string[]> {
  try {
    const rows = await db.prepare(
      'SELECT blocked_id AS id FROM blocks WHERE blocker_id = ? UNION SELECT blocker_id AS id FROM blocks WHERE blocked_id = ?'
    ).bind(userId, userId).all<{ id: string }>();
    return (rows.results || []).map((r) => r.id);
  } catch {
    return [];
  }
}


/**
 * Checks if sender is permitted to send a DM to recipient based on blocks and dm_policy.
 */
async function canSendDmTo(
  db: D1Database,
  senderId: string,
  recipientId: string
): Promise<{ allowed: boolean; reason?: string }> {
  // 1. Check blocking in either direction
  const blocked = await isBlockedBetween(db, senderId, recipientId);
  if (blocked) {
    return { allowed: false, reason: 'Forbidden: Cannot message this user' };
  }

  // 2. Check recipient DM policy
  const settings = await db.prepare(
    'SELECT dm_policy FROM user_settings WHERE user_id = ?'
  ).bind(recipientId).first<{ dm_policy: string }>();

  // Default dm_policy is followed_only
  const policy = settings?.dm_policy || 'followed_only';

  if (policy === 'nobody' || policy === 'none') {
    return { allowed: false, reason: 'Forbidden: User does not accept direct messages' };
  }

  if (policy === 'followed_only' || policy === 'following') {
    // Recipient must follow sender
    const isFollowed = await db.prepare(
      'SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ? LIMIT 1'
    ).bind(recipientId, senderId).first();

    if (!isFollowed) {
      return { allowed: false, reason: 'Forbidden: User only accepts direct messages from users they follow' };
    }
  }

  return { allowed: true };
}

function generateRandomUsername(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let suffix = '';
  for (let i = 0; i < 6; i++) {
    suffix += chars[bytes[i]! % chars.length];
  }
  return `user_${suffix}`;
}

/**
 * Batch-hydrates posts to completely prevent N+1 queries.
 * Fetches media, like counts, "liked by me", comment counts, and topics in single batched queries.
 */
async function hydratePosts(
  db: D1Database,
  rows: Array<
    PostRow & {
      author_username: string;
      author_display_name: string;
      author_avatar_media_id: string | null;
      author_class_name?: string | null;
    }
  >,
  currentUserId: string
): Promise<PostItem[]> {
  if (rows.length === 0) return [];
  const postIds = rows.map((r) => r.id);
  const placeholders = postIds.map(() => '?').join(',');

  // 1. Batched media query
  const mediaRows = await db
    .prepare(
      `SELECT pm.post_id, m.id, m.object_key, m.mime_type, m.size_bytes
       FROM post_media pm
       JOIN media m ON m.id = pm.media_id
       WHERE pm.post_id IN (${placeholders})`
    )
    .bind(...postIds)
    .all<{ post_id: string; id: string; object_key: string; mime_type: string; size_bytes: number }>();

  const mediaMap = new Map<string, MediaItem[]>();
  for (const m of mediaRows.results || []) {
    const list = mediaMap.get(m.post_id) || [];
    list.push({
      id: m.id,
      object_key: m.object_key,
      mime_type: m.mime_type,
      size_bytes: m.size_bytes,
    });
    mediaMap.set(m.post_id, list);
  }

  const blockedIds = await getBlockedUserIds(db, currentUserId);
  const hasBlocked = blockedIds.length > 0;
  const blockedPh = hasBlocked ? blockedIds.map(() => '?').join(',') : '';

  // 2. Batched like counts (excluding blocked users)
  const likeCountsQuery = hasBlocked
    ? `SELECT post_id, COUNT(*) as count
       FROM post_reactions
       WHERE type = 'like' AND post_id IN (${placeholders})
         AND user_id NOT IN (${blockedPh})
       GROUP BY post_id`
    : `SELECT post_id, COUNT(*) as count
       FROM post_reactions
       WHERE type = 'like' AND post_id IN (${placeholders})
       GROUP BY post_id`;

  const likeCountsParams = hasBlocked ? [...postIds, ...blockedIds] : postIds;
  const likeCountsRows = await db
    .prepare(likeCountsQuery)
    .bind(...likeCountsParams)
    .all<{ post_id: string; count: number }>();

  const likeCountMap = new Map<string, number>();
  for (const lc of likeCountsRows.results || []) {
    likeCountMap.set(lc.post_id, Number(lc.count));
  }

  // 3. Batched "liked by me"
  const hasLikedRows = await db
    .prepare(
      `SELECT post_id
       FROM post_reactions
       WHERE type = 'like' AND user_id = ? AND post_id IN (${placeholders})`
    )
    .bind(currentUserId, ...postIds)
    .all<{ post_id: string }>();

  const likedSet = new Set((hasLikedRows.results || []).map((r) => r.post_id));

  // 4. Batched comment counts (excluding blocked users)
  const commentCountsQuery = hasBlocked
    ? `SELECT post_id, COUNT(*) as count
       FROM comments
       WHERE post_id IN (${placeholders})
         AND author_id NOT IN (${blockedPh})
       GROUP BY post_id`
    : `SELECT post_id, COUNT(*) as count
       FROM comments
       WHERE post_id IN (${placeholders})
       GROUP BY post_id`;

  const commentCountsParams = hasBlocked ? [...postIds, ...blockedIds] : postIds;
  const commentCountsRows = await db
    .prepare(commentCountsQuery)
    .bind(...commentCountsParams)
    .all<{ post_id: string; count: number }>();

  const commentCountMap = new Map<string, number>();
  for (const cc of commentCountsRows.results || []) {
    commentCountMap.set(cc.post_id, Number(cc.count));
  }

  // 5. Batched topics
  const topicRows = await db
    .prepare(
      `SELECT pt.post_id, t.id, t.slug, t.display_name, pt.confidence
       FROM post_topics pt
       JOIN topics t ON t.id = pt.topic_id
       WHERE pt.post_id IN (${placeholders})`
    )
    .bind(...postIds)
    .all<{ post_id: string; id: string; slug: string; display_name: string; confidence: number }>();

  const topicMap = new Map<string, TopicItem[]>();
  for (const t of topicRows.results || []) {
    const list = topicMap.get(t.post_id) || [];
    list.push({
      id: t.id,
      slug: t.slug,
      display_name: t.display_name,
      confidence: t.confidence,
    });
    topicMap.set(t.post_id, list);
  }

  return rows.map((p) => ({
    id: p.id,
    author_id: p.author_id,
    author_username: p.author_username,
    author_display_name: p.author_display_name,
    author_avatar_media_id: p.author_avatar_media_id,
    author_class_name: p.author_class_name || null,
    body: p.body,
    created_at: p.created_at,
    expires_at: p.expires_at,
    status: p.status,
    media: mediaMap.get(p.id) || [],
    topics: topicMap.get(p.id) || [],
    likes_count: likeCountMap.get(p.id) || 0,
    has_liked: likedSet.has(p.id),
    comments_count: commentCountMap.get(p.id) || 0,
  }));
}

/**
 * Updates user topic signals for all topics attached to a post.
 */
async function updateUserTopicSignalsForPost(
  db: D1Database,
  userId: string,
  postId: string,
  delta: number
): Promise<void> {
  const postTopics = await db
    .prepare('SELECT topic_id FROM post_topics WHERE post_id = ?')
    .bind(postId)
    .all<{ topic_id: string }>();

  const now = new Date().toISOString();
  for (const pt of postTopics.results || []) {
    await db
      .prepare(
        `INSERT INTO user_topic_signals (user_id, topic_id, weight, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, topic_id) DO UPDATE SET
           weight = user_topic_signals.weight + excluded.weight,
           updated_at = excluded.updated_at`
      )
      .bind(userId, pt.topic_id, delta, now)
      .run();
  }
}

/**
 * Computes trend snapshots for active topics requiring at least 3 distinct authors.
 */
export async function computeTrends(db: D1Database, nowMs = Date.now()): Promise<void> {
  const windows: Array<{ window: '24h' | '7d'; durationMs: number }> = [
    { window: '24h', durationMs: 24 * 60 * 60 * 1000 },
    { window: '7d', durationMs: 7 * 24 * 60 * 60 * 1000 },
  ];

  for (const { window, durationMs } of windows) {
    const cutoffIso = new Date(nowMs - durationMs).toISOString();
    const rows = await db
      .prepare(
        `SELECT pt.topic_id, COUNT(DISTINCT p.author_id) as author_count, COUNT(*) as post_count
         FROM post_topics pt
         JOIN posts p ON p.id = pt.post_id
         WHERE p.status = 'active' AND p.created_at >= ?
         GROUP BY pt.topic_id
         HAVING author_count >= 3`
      )
      .bind(cutoffIso)
      .all<{ topic_id: string; author_count: number; post_count: number }>();

    const results = rows.results || [];
    await db.prepare('DELETE FROM trend_snapshots WHERE window = ?').bind(window).run();

    for (const r of results) {
      const snapId = `snap_${generateRandomString(16).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      const score = Number(r.author_count) * 2.0 + Number(r.post_count);
      await db
        .prepare(
          'INSERT INTO trend_snapshots (id, topic_id, window, window_start, score) VALUES (?, ?, ?, ?, ?)'
        )
        .bind(snapId, r.topic_id, window, cutoffIso, score)
        .run();
    }
  }
}

export default {
  // Cloudflare Scheduled Cron Trigger handler for daily post expiry and hourly trends job
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runPostLifecycleExpiry(env);
    await computeTrends(env.DB);
  },

  async fetch(request: Request, env: Env, _ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method.toUpperCase();
    const isDevelopment = env.ENVIRONMENT === 'development';
    const isTest = env.ENVIRONMENT === 'test';
    const isHttps = url.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';

    // DEV-ONLY: remove before launch
    // In development / test:
    // - On HTTPS (AI Studio preview iframe), use SameSite=None; Secure; Partitioned
    // - On HTTP (localhost), use SameSite=Lax without Secure so Safari doesn't drop cookies
    // In production:
    // - Always enforce Secure; HttpOnly; SameSite=Lax
    const cookieSecure = (isDevelopment || isTest) ? isHttps : true;
    const cookieSameSite = (isDevelopment || isTest) && isHttps ? ('None' as const) : ('Lax' as const);
    const cookiePartitioned = (isDevelopment || isTest) && isHttps;

    // CLEANUP #1: Revert oauth_state cookie to Path=/api/auth/callback outside development
    const oauthCookiePath = (isDevelopment || isTest) ? '/' : '/api/auth/callback';

    // CORS / preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': env.APP_URL || url.origin,
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Cookie, X-Admin-Secret',
          'Access-Control-Allow-Credentials': 'true',
        },
      });
    }

    // ==========================================
    // 1. AUTHENTICATION ROUTES
    // ==========================================

    // GET /api/auth/google - Initiate Google Sign-In with PKCE
    if (pathname === '/api/auth/google' && method === 'GET') {
      // DEV-ONLY: remove before launch
      const isMockRequested =
        url.searchParams.get('mock') === 'true' || env.GOOGLE_CLIENT_ID === 'PLACEHOLDER';

      if (isMockRequested && !isDevelopment && !isTest) {
        return jsonResponse({ error: 'Mock authentication is disabled in production' }, 400);
      }

      const state = generateRandomString(24);
      const codeVerifier = generateRandomString(32);
      const nonce = generateRandomString(24);
      const codeChallenge = await generateCodeChallenge(codeVerifier);

      const redirectUri = `${env.APP_URL || url.origin}/api/auth/callback`;

      const statePayload = {
        state,
        codeVerifier,
        nonce,
        createdAt: Date.now(),
      };

      const encodedStateCookie = encodeOAuthState(statePayload);

      if (isMockRequested) {
        const mockRedirect = (isDevelopment || isTest)
          ? `/api/auth/callback?code=mock_code&state=${encodeURIComponent(state)}&mock=true`
          : `${redirectUri}?code=mock_code&state=${encodeURIComponent(state)}&mock=true`;

        return new Response(null, {
          status: 302,
          headers: {
            Location: mockRedirect,
            'Set-Cookie': serializeCookie('oauth_state', encodedStateCookie, {
              path: oauthCookiePath,
              maxAge: 600,
              httpOnly: true,
              secure: cookieSecure,
              sameSite: cookieSameSite,
              partitioned: cookiePartitioned,
            }),
          },
        });
      }

      const params = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        nonce,
        prompt: 'select_account',
      });

      return new Response(null, {
        status: 302,
        headers: {
          Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
          'Set-Cookie': serializeCookie('oauth_state', encodedStateCookie, {
            path: oauthCookiePath,
            maxAge: 600,
            httpOnly: true,
            secure: cookieSecure,
            sameSite: cookieSameSite,
            partitioned: cookiePartitioned,
          }),
        },
      });
    }

    // GET /api/auth/callback - Handle OAuth callback
    if (pathname === '/api/auth/callback' && method === 'GET') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const errorParam = url.searchParams.get('error');
      const isMock = url.searchParams.get('mock') === 'true';

      if (errorParam) {
        return jsonResponse({ error: 'Authentication was denied or encountered an error' }, 400);
      }

      if (!code || !state) {
        return jsonResponse({ error: 'Missing code or state in OAuth callback' }, 400);
      }

      if (isMock && !isDevelopment && !isTest) {
        return jsonResponse({ error: 'Mock authorization is disabled in production' }, 400);
      }

      const cookies = parseCookies(request.headers.get('Cookie'));
      const rawStateCookie = cookies['oauth_state'];
      if (!rawStateCookie && (!isMock || (!isDevelopment && !isTest))) {
        return jsonResponse({ error: 'Missing OAuth state cookie' }, 400);
      }

      const oauthState = rawStateCookie ? decodeOAuthState(rawStateCookie) : null;
      if (!oauthState && (!isMock || (!isDevelopment && !isTest))) {
        return jsonResponse({ error: 'Invalid or corrupt OAuth state' }, 400);
      }

      if (oauthState) {
        if (Date.now() - oauthState.createdAt > 10 * 60 * 1000) {
          return jsonResponse({ error: 'OAuth session expired. Please sign in again.' }, 400);
        }

        if (oauthState.state !== state) {
          return jsonResponse({ error: 'Invalid OAuth state parameter' }, 400);
        }
      }

      let providerSubject: string;
      let displayName: string;

      if (isMock) {
        providerSubject = 'mock-google-sub-12345';
        displayName = 'Test User';
      } else {
        const redirectUri = `${env.APP_URL || url.origin}/api/auth/callback`;

        const tokenParams = new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
          code_verifier: oauthState?.codeVerifier || '',
        });

        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenParams.toString(),
        });

        if (!tokenRes.ok) {
          return jsonResponse({ error: 'Failed to authenticate with Google' }, 400);
        }

        const tokenData = (await tokenRes.json()) as { id_token?: string };
        if (!tokenData.id_token) {
          return jsonResponse({ error: 'Missing ID token from Google response' }, 400);
        }

        try {
          const claims = await verifyGoogleIdToken(tokenData.id_token, env.GOOGLE_CLIENT_ID, oauthState?.nonce || '');
          providerSubject = claims.sub;
          displayName = claims.name || claims.email?.split('@')[0] || 'Dialtone User';
        } catch {
          return jsonResponse({ error: 'Failed to verify Google identity token' }, 400);
        }
      }

      let user = await env.DB.prepare('SELECT id, created_at, status FROM users WHERE provider_subject = ?')
        .bind(providerSubject)
        .first<UserRow>();

      const now = new Date().toISOString();

      if (!user) {
        const userId = `usr_${generateRandomString(16).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
        const randomUsername = generateRandomUsername();

        const signupStatements: D1PreparedStatement[] = [
          env.DB.prepare('INSERT INTO users (id, provider_subject, created_at, status) VALUES (?, ?, ?, ?)').bind(
            userId,
            providerSubject,
            now,
            'active'
          ),
          env.DB.prepare(
            'INSERT INTO profiles (user_id, username, username_normalized, display_name, bio) VALUES (?, ?, ?, ?, ?)'
          ).bind(userId, randomUsername, normalizeUsername(randomUsername), displayName, ''),
          env.DB.prepare('INSERT INTO user_settings (user_id) VALUES (?)').bind(userId),
        ];

        try {
          await env.DB.batch(signupStatements);
        } catch (dbErr) {
          const errMsg = (dbErr as Error).message || '';
          if (errMsg.includes('UNIQUE constraint') && errMsg.includes('username')) {
            const retryUsername = generateRandomUsername();
            await env.DB.batch([
              signupStatements[0]!,
              env.DB.prepare(
                'INSERT INTO profiles (user_id, username, username_normalized, display_name, bio) VALUES (?, ?, ?, ?, ?)'
              ).bind(userId, retryUsername, normalizeUsername(retryUsername), displayName, ''),
              signupStatements[2]!,
            ]);
          } else {
            return jsonResponse({ error: 'Failed to create user account' }, 500);
          }
        }

        user = {
          id: userId,
          provider_subject: providerSubject,
          created_at: now,
          status: 'active',
        };
      }

      const sessionId = `sess_${generateRandomString(32)}`;
      const sessionExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
        .bind(sessionId, user.id, sessionExpiry)
        .run();

      const clearOauthStateCookie = serializeCookie('oauth_state', '', {
        path: oauthCookiePath,
        maxAge: 0,
        httpOnly: true,
        secure: cookieSecure,
        sameSite: cookieSameSite,
        partitioned: cookiePartitioned,
      });

      const sessionCookie = serializeCookie('session_id', sessionId, {
        path: '/',
        maxAge: 30 * 24 * 60 * 60,
        httpOnly: true,
        secure: cookieSecure,
        sameSite: cookieSameSite,
        partitioned: cookiePartitioned,
      });

      const responseHeaders = new Headers();
      responseHeaders.append('Set-Cookie', sessionCookie);
      responseHeaders.append('Set-Cookie', clearOauthStateCookie);
      responseHeaders.set('Location', '/');

      return new Response(null, {
        status: 302,
        headers: responseHeaders,
      });
    }

    // POST /api/auth/logout - Invalidate session
    if (pathname === '/api/auth/logout' && method === 'POST') {
      const cookies = parseCookies(request.headers.get('Cookie'));
      const sessionId = cookies['session_id'];

      if (sessionId) {
        await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
      }

      const clearSessionCookie = serializeCookie('session_id', '', {
        path: '/',
        maxAge: 0,
        httpOnly: true,
        secure: cookieSecure,
        sameSite: cookieSameSite,
        partitioned: cookiePartitioned,
      });

      return jsonResponse(
        { success: true, message: 'Logged out successfully' },
        200,
        { 'Set-Cookie': clearSessionCookie }
      );
    }

    // ==========================================
    // 2. USER PROFILE & SETTINGS ROUTES
    // ==========================================

    // GET /api/users/:username - Public profile by username (requires session)
    if (pathname.startsWith('/api/users/') && !pathname.includes('/follow') && method === 'GET') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      const usernameParam = pathname.slice('/api/users/'.length);
      if (!usernameParam) {
        return jsonResponse({ error: 'Username required' }, 400);
      }

      const normalized = normalizeUsername(usernameParam);

      const row = await env.DB.prepare(
        `SELECT p.user_id, p.username, p.display_name, p.bio, p.avatar_media_id, p.class_id,
                c.name AS class_name, u.created_at
         FROM profiles p
         JOIN users u ON u.id = p.user_id
         LEFT JOIN classes c ON c.id = p.class_id
         WHERE p.username_normalized = ? AND u.status = 'active'`
      )
        .bind(normalized)
        .first<{
          user_id: string;
          username: string;
          display_name: string;
          bio: string;
          avatar_media_id: string | null;
          class_id: string | null;
          class_name: string | null;
          created_at: string;
        }>();

      if (!row) {
        return jsonResponse({ error: 'User not found' }, 404);
      }

      if (row.user_id !== auth.user.id) {
        const blocked = await isBlockedBetween(env.DB, auth.user.id, row.user_id);
        if (blocked) {
          return jsonResponse({ error: 'User not found' }, 404);
        }
      }

      const blockedIds = await getBlockedUserIds(env.DB, auth.user.id);
      const hasBlocked = blockedIds.length > 0;
      const blockedPh = hasBlocked ? blockedIds.map(() => '?').join(',') : '';

      const isFollowing = await env.DB.prepare(
        'SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?'
      )
        .bind(auth.user.id, row.user_id)
        .first();

      const followersQuery = hasBlocked
        ? `SELECT COUNT(*) as count FROM follows WHERE followed_id = ? AND follower_id NOT IN (${blockedPh})`
        : 'SELECT COUNT(*) as count FROM follows WHERE followed_id = ?';
      const followersParams = hasBlocked ? [row.user_id, ...blockedIds] : [row.user_id];
      const followersCount = await env.DB.prepare(followersQuery)
        .bind(...followersParams)
        .first<{ count: number }>();

      const followingQuery = hasBlocked
        ? `SELECT COUNT(*) as count FROM follows WHERE follower_id = ? AND followed_id NOT IN (${blockedPh})`
        : 'SELECT COUNT(*) as count FROM follows WHERE follower_id = ?';
      const followingParams = hasBlocked ? [row.user_id, ...blockedIds] : [row.user_id];
      const followingCount = await env.DB.prepare(followingQuery)
        .bind(...followingParams)
        .first<{ count: number }>();

      const postsCount = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM posts WHERE author_id = ? AND status = 'active'"
      )
        .bind(row.user_id)
        .first<{ count: number }>();

      return jsonResponse({
        username: row.username,
        display_name: row.display_name,
        bio: row.bio,
        avatar_media_id: row.avatar_media_id,
        class_id: row.class_id,
        class_name: row.class_name,
        created_at: row.created_at,
        is_following: !!isFollowing,
        followers_count: Number(followersCount?.count || 0),
        following_count: Number(followingCount?.count || 0),
        posts_count: Number(postsCount?.count || 0),
      });
    }

    // GET /api/me - Retrieve current authenticated profile
    if (pathname === '/api/me' && method === 'GET') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      const classRow = auth.profile.class_id
        ? await env.DB.prepare('SELECT name FROM classes WHERE id = ?').bind(auth.profile.class_id).first<{ name: string }>()
        : null;

      return jsonResponse({
        user: {
          id: auth.user.id,
          created_at: auth.user.created_at,
          status: auth.user.status,
        },
        profile: {
          username: auth.profile.username,
          username_normalized: auth.profile.username_normalized,
          display_name: auth.profile.display_name,
          bio: auth.profile.bio,
          avatar_media_id: auth.profile.avatar_media_id,
          class_id: auth.profile.class_id || null,
          class_name: classRow?.name || null,
        },
        settings: {
          dm_policy: auth.settings.dm_policy,
          feed_preferences: auth.settings.feed_preferences,
        },
      });
    }

    // PATCH /api/me - Update profile fields (validated with shared schema, using D1 batch)
    if (pathname === '/api/me' && method === 'PATCH') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      const parseResult = updateProfileSchema.safeParse(body);
      if (!parseResult.success) {
        return jsonResponse(
          {
            error: 'Validation failed',
            issues: parseResult.error.issues,
          },
          400
        );
      }

      const data = parseResult.data;

      // Check username uniqueness if updating username
      if (data.username !== undefined) {
        const normalized = normalizeUsername(data.username);
        const conflict = await env.DB.prepare(
          'SELECT user_id FROM profiles WHERE username_normalized = ? AND user_id != ?'
        )
          .bind(normalized, auth.user.id)
          .first();

        if (conflict) {
          return jsonResponse({ error: 'Username is already taken' }, 409);
        }
      }

      const batchStatements: D1PreparedStatement[] = [];

      if (
        data.username !== undefined ||
        data.display_name !== undefined ||
        data.bio !== undefined ||
        data.avatar_media_id !== undefined ||
        data.class_id !== undefined
      ) {
        const currentProfile = auth.profile;
        const newUsername = data.username !== undefined ? data.username : currentProfile.username;
        const newNorm = normalizeUsername(newUsername);
        const newDisplayName =
          data.display_name !== undefined ? data.display_name : currentProfile.display_name;
        const newBio = data.bio !== undefined ? data.bio : currentProfile.bio;
        const newAvatar =
          data.avatar_media_id !== undefined ? data.avatar_media_id : currentProfile.avatar_media_id;
        const newClassId =
          data.class_id !== undefined ? data.class_id : (currentProfile.class_id || null);

        batchStatements.push(
          env.DB.prepare(
            `UPDATE profiles
             SET username = ?, username_normalized = ?, display_name = ?, bio = ?, avatar_media_id = ?, class_id = ?
             WHERE user_id = ?`
          ).bind(newUsername, newNorm, newDisplayName, newBio, newAvatar, newClassId, auth.user.id)
        );
      }

      if (data.dm_policy !== undefined || data.feed_preferences !== undefined) {
        const currentSettings = auth.settings;
        const newDmPolicy =
          data.dm_policy !== undefined ? data.dm_policy : currentSettings.dm_policy;
        const newFeedPrefs =
          data.feed_preferences !== undefined
            ? typeof data.feed_preferences === 'string'
              ? data.feed_preferences
              : JSON.stringify(data.feed_preferences)
            : currentSettings.feed_preferences;

        batchStatements.push(
          env.DB.prepare(
            `UPDATE user_settings
             SET dm_policy = ?, feed_preferences = ?
             WHERE user_id = ?`
          ).bind(newDmPolicy, newFeedPrefs, auth.user.id)
        );
      }

      if (batchStatements.length > 0) {
        try {
          await env.DB.batch(batchStatements);
        } catch (dbErr) {
          const errMsg = (dbErr as Error).message || '';
          if (errMsg.includes('UNIQUE constraint') && errMsg.includes('username')) {
            return jsonResponse({ error: 'Username is already taken' }, 409);
          }
          return jsonResponse({ error: 'Failed to update profile' }, 500);
        }
      }

      const updatedProfile = await env.DB.prepare('SELECT * FROM profiles WHERE user_id = ?')
        .bind(auth.user.id)
        .first<ProfileRow>();

      const updatedSettings = await env.DB.prepare('SELECT * FROM user_settings WHERE user_id = ?')
        .bind(auth.user.id)
        .first<UserSettingsRow>();

      return jsonResponse({
        user: {
          id: auth.user.id,
          created_at: auth.user.created_at,
          status: auth.user.status,
        },
        profile: updatedProfile,
        settings: updatedSettings,
      });
    }

    // DELETE /api/me - Account deletion in D1 batch
    if (pathname === '/api/me' && method === 'DELETE') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      const userId = auth.user.id;

      const userMedia = await env.DB.prepare('SELECT object_key FROM media WHERE owner_id = ?')
        .bind(userId)
        .all<{ object_key: string }>();

      if (env.MEDIA_BUCKET && userMedia.results) {
        for (const m of userMedia.results) {
          try {
            await env.MEDIA_BUCKET.delete(m.object_key);
          } catch {
            // Ignore R2 error on account purge
          }
        }
      }

      await env.DB.batch([
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM user_settings WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM profiles WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId),
      ]);

      return jsonResponse(
        { success: true, message: 'Account and associated data deleted permanently' },
        200,
        {
          'Set-Cookie': serializeCookie('session_id', '', {
            path: '/',
            maxAge: 0,
            httpOnly: true,
            secure: cookieSecure,
            sameSite: cookieSameSite,
            partitioned: cookiePartitioned,
          }),
        }
      );
    }

    // ==========================================
    // 3. DISCOVERY METADATA & SIGNALS
    // ==========================================

    // GET /api/classes - Available campus classes
    if (pathname === '/api/classes' && method === 'GET') {
      const classesResult = await env.DB.prepare('SELECT id, name FROM classes ORDER BY name ASC').all<ClassRow>();
      return jsonResponse({ classes: classesResult.results || [] });
    }

    // GET /api/trends - Topic trend snapshots
    if (pathname === '/api/trends' && method === 'GET') {
      const windowParam = url.searchParams.get('window') === '7d' ? '7d' : '24h';
      const auth = await authenticateRequest(request, env.DB);
      const blockedIds = auth ? await getBlockedUserIds(env.DB, auth.user.id) : [];

      if (blockedIds.length > 0) {
        const durationMs = windowParam === '7d' ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
        const cutoffIso = new Date(Date.now() - durationMs).toISOString();
        const ph = blockedIds.map(() => '?').join(',');
        const rows = await env.DB.prepare(
          `SELECT pt.topic_id, t.slug, t.display_name, COUNT(DISTINCT p.author_id) as author_count, COUNT(*) as post_count
           FROM post_topics pt
           JOIN topics t ON t.id = pt.topic_id
           JOIN posts p ON p.id = pt.post_id
           WHERE p.status = 'active' AND p.created_at >= ?
             AND p.author_id NOT IN (${ph})
           GROUP BY pt.topic_id
           HAVING author_count >= 3
           ORDER BY (COUNT(DISTINCT p.author_id) * 2.0 + COUNT(*)) DESC
           LIMIT 20`
        )
          .bind(cutoffIso, ...blockedIds)
          .all<{ topic_id: string; slug: string; display_name: string; author_count: number; post_count: number }>();

        const computedTrends: TrendItem[] = (rows.results || []).map((r) => ({
          topic_id: r.topic_id,
          slug: r.slug,
          display_name: r.display_name,
          window: windowParam,
          score: Number(r.author_count) * 2.0 + Number(r.post_count),
        }));

        return jsonResponse({
          window: windowParam,
          trends: computedTrends,
        });
      }

      let trends = await env.DB.prepare(
        `SELECT ts.topic_id, t.slug, t.display_name, ts.window, ts.score
         FROM trend_snapshots ts
         JOIN topics t ON t.id = ts.topic_id
         WHERE ts.window = ?
         ORDER BY ts.score DESC
         LIMIT 20`
      )
        .bind(windowParam)
        .all<TrendItem>();

      if (!trends.results || trends.results.length === 0) {
        await computeTrends(env.DB);
        trends = await env.DB.prepare(
          `SELECT ts.topic_id, t.slug, t.display_name, ts.window, ts.score
           FROM trend_snapshots ts
           JOIN topics t ON t.id = ts.topic_id
           WHERE ts.window = ?
           ORDER BY ts.score DESC
           LIMIT 20`
        )
          .bind(windowParam)
          .all<TrendItem>();
      }

      return jsonResponse({
        window: windowParam,
        trends: trends.results || [],
      });
    }

    // GET /api/me/interests - User interest topics with 14-day decayed effective weights
    if (pathname === '/api/me/interests' && method === 'GET') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      const rows = await env.DB.prepare(
        `SELECT uts.topic_id, t.slug, t.display_name, uts.weight AS raw_weight, uts.updated_at
         FROM user_topic_signals uts
         JOIN topics t ON t.id = uts.topic_id
         WHERE uts.user_id = ?
         ORDER BY uts.weight DESC`
      )
        .bind(auth.user.id)
        .all<{ topic_id: string; slug: string; display_name: string; raw_weight: number; updated_at: string }>();

      const now = Date.now();
      const interests: UserInterestTopic[] = (rows.results || []).map((r) => ({
        topic_id: r.topic_id,
        slug: r.slug,
        display_name: r.display_name,
        raw_weight: r.raw_weight,
        effective_weight: Number(computeDecayedWeight(r.raw_weight, r.updated_at, now).toFixed(3)),
        updated_at: r.updated_at,
      }));

      return jsonResponse({ interests });
    }

    // DELETE /api/me/interests/:id - Remove individual interest topic signal
    if (
      pathname.startsWith('/api/me/interests/') &&
      pathname !== '/api/me/interests/reset' &&
      method === 'DELETE'
    ) {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      const topicParam = pathname.slice('/api/me/interests/'.length);
      await env.DB.prepare(
        `DELETE FROM user_topic_signals
         WHERE user_id = ? AND (topic_id = ? OR topic_id IN (SELECT id FROM topics WHERE slug = ?))`
      )
        .bind(auth.user.id, topicParam, topicParam)
        .run();

      return jsonResponse({ success: true, message: 'Topic signal removed' });
    }

    // DELETE /api/me/interests or POST /api/me/interests/reset - Reset topic signals
    if (
      (pathname === '/api/me/interests' && method === 'DELETE') ||
      (pathname === '/api/me/interests/reset' && method === 'POST')
    ) {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      await env.DB.prepare('DELETE FROM user_topic_signals WHERE user_id = ?').bind(auth.user.id).run();
      return jsonResponse({ success: true, message: 'Interests reset successfully' });
    }

    // POST /api/feedback - Post feedback ('more_like_this', 'show_less', 'not_interested')
    if (pathname === '/api/feedback' && method === 'POST') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      const parseResult = createFeedbackSchema.safeParse(body);
      if (!parseResult.success) {
        return jsonResponse({ error: 'Validation failed', issues: parseResult.error.issues }, 400);
      }

      const { post_id, type } = parseResult.data;
      const feedbackId = `fb_${generateRandomString(16).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      const now = new Date().toISOString();

      await env.DB.prepare(
        'INSERT INTO feedback (id, user_id, post_id, type, created_at) VALUES (?, ?, ?, ?, ?)'
      )
        .bind(feedbackId, auth.user.id, post_id, type, now)
        .run();

      // Update interest signals based on feedback type:
      // more_like_this: +3, show_less: -3, not_interested: -4
      const signalDelta = type === 'more_like_this' ? 3.0 : type === 'show_less' ? -3.0 : -4.0;
      await updateUserTopicSignalsForPost(env.DB, auth.user.id, post_id, signalDelta);

      return jsonResponse({ success: true, type, post_id }, 201);
    }

    // POST /api/impressions - Record post impression and view duration
    if (pathname === '/api/impressions' && method === 'POST') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      let body: { impressions?: Array<{ post_id: string; position?: number; duration_ms?: number }> };
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      const impressions = body.impressions || [];
      const now = new Date().toISOString();

      const oneHourAgoIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      for (const item of impressions) {
        if (!item.post_id) continue;
        const existing = await env.DB.prepare(
          'SELECT id FROM impressions WHERE viewer_id = ? AND post_id = ? AND shown_at >= ? LIMIT 1'
        )
          .bind(auth.user.id, item.post_id, oneHourAgoIso)
          .first();

        if (!existing) {
          const impId = `imp_${generateRandomString(16).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
          await env.DB.prepare(
            'INSERT INTO impressions (id, viewer_id, post_id, shown_at, position) VALUES (?, ?, ?, ?, ?)'
          )
            .bind(impId, auth.user.id, item.post_id, now, item.position || 0)
            .run();
        }

        // View over 3 seconds (+0.1 signal)
        if (item.duration_ms && item.duration_ms >= 3000) {
          await updateUserTopicSignalsForPost(env.DB, auth.user.id, item.post_id, 0.1);
        }
      }

      return jsonResponse({ success: true, recorded: impressions.length });
    }

    // GET /api/search - Search posts by query or topic with rate limiting
    if (pathname === '/api/search' && method === 'GET') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      // FIX #3: Rate limit search: max 60 per minute per user
      const rate = await checkRateLimit(env.DB, `search:${auth.user.id}`, 60, 60 * 1000);
      if (!rate.allowed) {
        return jsonResponse(
          { error: 'Search rate limit exceeded. Please wait a moment.' },
          429,
          { 'Retry-After': String(rate.retryAfterSeconds) }
        );
      }

      const q = (url.searchParams.get('q') || '').trim();
      const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') || 20)), 50);

      if (!q) {
        return jsonResponse({ posts: [], total: 0 });
      }

      const nowIso = new Date().toISOString();
      const searchPattern = `%${q}%`;

      const blockedIds = await getBlockedUserIds(env.DB, auth.user.id);
      const hasBlocked = blockedIds.length > 0;
      const blockedFilter = hasBlocked
        ? ` AND p.author_id NOT IN (${blockedIds.map(() => '?').join(',')})`
        : '';

      const searchParams: unknown[] = [nowIso, searchPattern, searchPattern, searchPattern];
      if (hasBlocked) {
        searchParams.push(...blockedIds);
      }
      searchParams.push(limit);

      const searchRows = await env.DB.prepare(
        `SELECT p.id, p.author_id, p.body, p.created_at, p.expires_at, p.status,
                pr.username AS author_username, pr.display_name AS author_display_name,
                pr.avatar_media_id AS author_avatar_media_id, c.name AS author_class_name
         FROM posts p
         JOIN profiles pr ON pr.user_id = p.author_id
         LEFT JOIN classes c ON c.id = pr.class_id
         WHERE p.status = 'active'
           AND p.expires_at > ?
           AND (p.body LIKE ? OR p.id IN (
             SELECT pt.post_id FROM post_topics pt
             JOIN topics t ON t.id = pt.topic_id
             WHERE t.slug LIKE ? OR t.display_name LIKE ?
           ))${blockedFilter}
         ORDER BY p.created_at DESC
         LIMIT ?`
      )
        .bind(...searchParams)
        .all<
          PostRow & {
            author_username: string;
            author_display_name: string;
            author_avatar_media_id: string | null;
            author_class_name: string | null;
          }
        >();

      const hydrated = await hydratePosts(env.DB, searchRows.results || [], auth.user.id);
      return jsonResponse({ posts: hydrated, total: hydrated.length });
    }

    // ==========================================
    // 4. SOCIAL POSTS, FEED & INTERACTIONS
    // ==========================================

    // POST /api/posts - Create new post (body max 1000 chars, up to 4 images, 7-day expiry)
    if (pathname === '/api/posts' && method === 'POST') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      // FIX #3: D1-backed rate limit: max 10 posts per hour per user
      const rate = await checkRateLimit(env.DB, `post:${auth.user.id}`, 10, 60 * 60 * 1000);
      if (!rate.allowed) {
        return jsonResponse(
          { error: 'Rate limit exceeded: maximum 10 posts per hour. Please try again later.' },
          429,
          { 'Retry-After': String(rate.retryAfterSeconds) }
        );
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      const parseResult = createPostSchema.safeParse(body);
      if (!parseResult.success) {
        return jsonResponse(
          { error: 'Validation failed', issues: parseResult.error.issues },
          400
        );
      }

      const { body: postBody, media_ids = [] } = parseResult.data;

      // Validate media_ids: max 4, owned by author, exist
      if (media_ids.length > 0) {
        for (const mId of media_ids) {
          const mediaRow = await env.DB.prepare(
            'SELECT id, owner_id FROM media WHERE id = ?'
          )
            .bind(mId)
            .first<{ id: string; owner_id: string }>();

          if (!mediaRow) {
            return jsonResponse({ error: `Media ${mId} not found` }, 400);
          }
          if (mediaRow.owner_id !== auth.user.id) {
            return jsonResponse({ error: `You do not own media ${mId}` }, 403);
          }
        }
      }

      const nowMs = Date.now();
      const createdAt = new Date(nowMs).toISOString();
      // New posts get expires_at = created_at + 7 days (bound ISO timestamp)
      const expiresAt = new Date(nowMs + 7 * 24 * 60 * 60 * 1000).toISOString();
      const postId = `pst_${generateRandomString(16).toLowerCase().replace(/[^a-z0-9]/g, '')}`;

      const statements: D1PreparedStatement[] = [
        env.DB.prepare(
          'INSERT INTO posts (id, author_id, body, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(postId, auth.user.id, postBody, createdAt, expiresAt, 'active'),
      ];

      for (const mId of media_ids) {
        statements.push(
          env.DB.prepare(
            'INSERT INTO post_media (post_id, media_id) VALUES (?, ?)'
          ).bind(postId, mId)
        );
      }

      await env.DB.batch(statements);

      // Content Understanding: extract hashtags and keyword topics (code-only, no external AI calls)
      const extractedTopics = extractTopicsFromText(postBody);
      for (const t of extractedTopics) {
        const topicId = `top_${t.slug}`;
        await env.DB.prepare(
          'INSERT OR IGNORE INTO topics (id, slug, display_name) VALUES (?, ?, ?)'
        )
          .bind(topicId, t.slug, t.displayName)
          .run();

        const realTopic = await env.DB.prepare('SELECT id FROM topics WHERE slug = ?')
          .bind(t.slug)
          .first<{ id: string }>();

        if (realTopic) {
          await env.DB.prepare(
            'INSERT OR REPLACE INTO post_topics (post_id, topic_id, confidence) VALUES (?, ?, ?)'
          )
            .bind(postId, realTopic.id, t.confidence)
            .run();
        }
      }

      return jsonResponse(
        {
          id: postId,
          author_id: auth.user.id,
          body: postBody,
          created_at: createdAt,
          expires_at: expiresAt,
          status: 'active',
          media_ids,
          topics: extractedTopics,
        },
        201
      );
    }

    // GET /api/posts/:id - Retrieve single post with media, likes count, and user like status
    if (
      pathname.startsWith('/api/posts/') &&
      !pathname.includes('/likes') &&
      !pathname.includes('/comments') &&
      method === 'GET'
    ) {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      const postId = pathname.slice('/api/posts/'.length);
      const postRow = await env.DB.prepare(
        `SELECT p.id, p.author_id, p.body, p.created_at, p.expires_at, p.status,
                pr.username AS author_username, pr.display_name AS author_display_name,
                pr.avatar_media_id AS author_avatar_media_id, c.name AS author_class_name
         FROM posts p
         JOIN profiles pr ON pr.user_id = p.author_id
         LEFT JOIN classes c ON c.id = pr.class_id
         WHERE p.id = ? AND p.status = 'active'`
      )
        .bind(postId)
        .first<
          PostRow & {
            author_username: string;
            author_display_name: string;
            author_avatar_media_id: string | null;
            author_class_name: string | null;
          }
        >();

      if (!postRow) {
        return jsonResponse({ error: 'Post not found' }, 404);
      }

      if (await isBlockedBetween(env.DB, auth.user.id, postRow.author_id)) {
        return jsonResponse({ error: 'Post not found' }, 404);
      }

      const hydrated = await hydratePosts(env.DB, [postRow], auth.user.id);
      return jsonResponse(hydrated[0]);
    }

    // DELETE /api/posts/:id - Author only delete
    if (
      pathname.startsWith('/api/posts/') &&
      !pathname.includes('/likes') &&
      !pathname.includes('/comments') &&
      method === 'DELETE'
    ) {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      const postId = pathname.slice('/api/posts/'.length);
      const post = await env.DB.prepare('SELECT author_id FROM posts WHERE id = ?')
        .bind(postId)
        .first<{ author_id: string }>();

      if (!post) {
        return jsonResponse({ error: 'Post not found' }, 404);
      }

      if (post.author_id !== auth.user.id) {
        return jsonResponse({ error: 'Forbidden: You can only delete your own posts' }, 403);
      }

      await deletePostAndMedia(env, postId);
      return jsonResponse({ success: true, message: 'Post and associated media deleted' });
    }

    // GET /api/feed - Chronological or Discovery Ranked Feed with (created_at, id) cursor pagination
    if (pathname === '/api/feed' && method === 'GET') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      const rawCursor = url.searchParams.get('cursor');
      const cursorObj = rawCursor ? decodeCursor(rawCursor) : null;
      const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') || 20)), 50);
      const mode = url.searchParams.get('mode'); // 'ranked' | 'for_you' | 'following' | 'chronological'
      const isRankedRequested = mode === 'ranked' || mode === 'for_you';

      // Bound ISO timestamp for expiry comparison (FIX #2)
      const nowIso = new Date().toISOString();

      if (isRankedRequested) {
        // Discovery Ranking Engine
        // 1. Fetch user topic signals
        const signalRows = await env.DB.prepare(
          `SELECT t.slug, uts.weight, uts.updated_at
           FROM user_topic_signals uts
           JOIN topics t ON t.id = uts.topic_id
           WHERE uts.user_id = ?`
        )
          .bind(auth.user.id)
          .all<{ slug: string; weight: number; updated_at: string }>();

        const userTopicSignals = new Map<string, { weight: number; updatedAt: string }>();
        for (const s of signalRows.results || []) {
          userTopicSignals.set(s.slug, { weight: s.weight, updatedAt: s.updated_at });
        }

        // 2. Followed user IDs
        const followRows = await env.DB.prepare(
          'SELECT followed_id FROM follows WHERE follower_id = ?'
        )
          .bind(auth.user.id)
          .all<{ followed_id: string }>();
        const followedUserIds = new Set((followRows.results || []).map((f) => f.followed_id));

        // 3. Not interested post IDs
        const notIntRows = await env.DB.prepare(
          "SELECT post_id FROM feedback WHERE user_id = ? AND type = 'not_interested'"
        )
          .bind(auth.user.id)
          .all<{ post_id: string }>();
        const notInterestedPostIds = new Set((notIntRows.results || []).map((f) => f.post_id));

        const rankingContext: UserRankingContext = {
          userId: auth.user.id,
          userClassId: auth.profile.class_id || null,
          followedUserIds,
          notInterestedPostIds,
          userTopicSignals,
          nowMs: Date.now(),
        };

        // 4. Candidate posts from active pool
        const blockedIds = await getBlockedUserIds(env.DB, auth.user.id);
        const hasBlocked = blockedIds.length > 0;
        const blockedPh = hasBlocked ? blockedIds.map(() => '?').join(',') : '';

        const candidateFilter = hasBlocked
          ? ` AND p.author_id NOT IN (${blockedPh})`
          : '';
        const engagersExclude = hasBlocked
          ? ` AND user_id NOT IN (${blockedPh})`
          : '';
        const commentsExclude = hasBlocked
          ? ` AND author_id NOT IN (${blockedPh})`
          : '';

        if (hasBlocked) {
          for (const bId of blockedIds) {
            followedUserIds.delete(bId);
          }
        }

        let candidateQuery = `
          SELECT p.id, p.author_id, p.body, p.created_at, p.expires_at, p.status,
                 pr.username AS author_username, pr.display_name AS author_display_name,
                 pr.avatar_media_id AS author_avatar_media_id, pr.class_id AS author_class_id,
                 c.name AS author_class_name,
                 (SELECT COUNT(DISTINCT user_id) FROM post_reactions WHERE post_id = p.id${engagersExclude}) +
                 (SELECT COUNT(DISTINCT author_id) FROM comments WHERE post_id = p.id${commentsExclude}) AS distinct_engagers,
                 (SELECT COUNT(*) FROM impressions WHERE post_id = p.id) AS impressions_count
          FROM posts p
          JOIN profiles pr ON pr.user_id = p.author_id
          LEFT JOIN classes c ON c.id = pr.class_id
          WHERE p.status = 'active'
            AND p.expires_at > ?
            ${candidateFilter}
          ORDER BY p.created_at DESC
          LIMIT 100
        `;

        const candidateParams: unknown[] = [nowIso];
        if (hasBlocked) {
          candidateParams.push(...blockedIds); // for engagersExclude
          candidateParams.push(...blockedIds); // for commentsExclude
          candidateParams.push(...blockedIds); // for candidateFilter
        }

        const candidateRows = await env.DB.prepare(candidateQuery)
          .bind(...candidateParams)
          .all<
            PostRow & {
              author_username: string;
              author_display_name: string;
              author_avatar_media_id: string | null;
              author_class_id: string | null;
              author_class_name: string | null;
              distinct_engagers: number;
              impressions_count: number;
            }
          >();

        const postTopicsMap = new Map<string, Array<{ slug: string; confidence: number }>>();
        if (candidateRows.results && candidateRows.results.length > 0) {
          const cIds = candidateRows.results.map((r) => r.id);
          const ph = cIds.map(() => '?').join(',');
          const tRows = await env.DB.prepare(
            `SELECT pt.post_id, t.slug, pt.confidence
             FROM post_topics pt
             JOIN topics t ON t.id = pt.topic_id
             WHERE pt.post_id IN (${ph})`
          )
            .bind(...cIds)
            .all<{ post_id: string; slug: string; confidence: number }>();

          for (const tr of tRows.results || []) {
            const list = postTopicsMap.get(tr.post_id) || [];
            list.push({ slug: tr.slug, confidence: tr.confidence });
            postTopicsMap.set(tr.post_id, list);
          }
        }

        const candidates: CandidatePost[] = (candidateRows.results || []).map((r) => ({
          id: r.id,
          author_id: r.author_id,
          author_class_id: r.author_class_id,
          body: r.body,
          created_at: r.created_at,
          expires_at: r.expires_at,
          status: r.status,
          topics: postTopicsMap.get(r.id) || [],
          distinct_engagers: Number(r.distinct_engagers || 0),
          impressions_count: Number(r.impressions_count || 0),
        }));

        const ranked = rankPosts(candidates, rankingContext, limit);
        const rankedIds = ranked.map((rp) => rp.post.id);
        const matchedRows = (candidateRows.results || []).filter((r) => rankedIds.includes(r.id));
        const hydrated = await hydratePosts(env.DB, matchedRows, auth.user.id);

        // Sort hydrated according to ranked order
        hydrated.sort((a, b) => rankedIds.indexOf(a.id) - rankedIds.indexOf(b.id));

        return jsonResponse({
          posts: hydrated,
          next_cursor: null,
          has_more: false,
        });
      }

      // Check author filter (for profile posts grid)
      const authorParam = url.searchParams.get('author_id') || url.searchParams.get('author') || url.searchParams.get('username');
      let targetAuthorId: string | null = null;
      if (authorParam) {
        if (authorParam.startsWith('usr_')) {
          targetAuthorId = authorParam;
        } else {
          const profileRow = await env.DB.prepare('SELECT user_id FROM profiles WHERE username_normalized = ?')
            .bind(normalizeUsername(authorParam))
            .first<{ user_id: string }>();
          if (profileRow) {
            targetAuthorId = profileRow.user_id;
          }
        }

        if (targetAuthorId && targetAuthorId !== auth.user.id) {
          const isBlocked = await isBlockedBetween(env.DB, auth.user.id, targetAuthorId);
          if (isBlocked) {
            return jsonResponse({ posts: [], next_cursor: null, has_more: false });
          }
        }
      }

      const blockedIds = await getBlockedUserIds(env.DB, auth.user.id);
      const hasBlocked = blockedIds.length > 0;
      const blockedFilter = hasBlocked
        ? ` AND p.author_id NOT IN (${blockedIds.map(() => '?').join(',')})`
        : '';

      let query = '';
      const params: unknown[] = [nowIso];

      if (targetAuthorId) {
        query = `
          SELECT p.id, p.author_id, p.body, p.created_at, p.expires_at, p.status,
                 pr.username AS author_username, pr.display_name AS author_display_name,
                 pr.avatar_media_id AS author_avatar_media_id, c.name AS author_class_name
          FROM posts p
          JOIN profiles pr ON pr.user_id = p.author_id
          LEFT JOIN classes c ON c.id = pr.class_id
          WHERE p.status = 'active'
            AND p.expires_at > ?
            AND p.author_id = ?
            ${blockedFilter}
        `;
        params.push(targetAuthorId);
      } else {
        query = `
          SELECT p.id, p.author_id, p.body, p.created_at, p.expires_at, p.status,
                 pr.username AS author_username, pr.display_name AS author_display_name,
                 pr.avatar_media_id AS author_avatar_media_id, c.name AS author_class_name
          FROM posts p
          JOIN profiles pr ON pr.user_id = p.author_id
          LEFT JOIN classes c ON c.id = pr.class_id
          WHERE p.status = 'active'
            AND p.expires_at > ?
            AND (p.author_id = ? OR p.author_id IN (SELECT followed_id FROM follows WHERE follower_id = ?))
            ${blockedFilter}
        `;
        params.push(auth.user.id, auth.user.id);
      }

      if (hasBlocked) {
        params.push(...blockedIds);
      }

      // FIX #7: Cursor pagination on (created_at, id) pairs
      if (cursorObj) {
        if (cursorObj.id) {
          query += ' AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))';
          params.push(cursorObj.createdAt, cursorObj.createdAt, cursorObj.id);
        } else {
          query += ' AND p.created_at < ?';
          params.push(cursorObj.createdAt);
        }
      }

      query += ' ORDER BY p.created_at DESC, p.id DESC LIMIT ?';
      params.push(limit + 1);

      const rowsResult = await env.DB.prepare(query)
        .bind(...params)
        .all<
          PostRow & {
            author_username: string;
            author_display_name: string;
            author_avatar_media_id: string | null;
            author_class_name: string | null;
          }
        >();

      const rows = rowsResult.results || [];
      const hasMore = rows.length > limit;
      const itemsToReturn = hasMore ? rows.slice(0, limit) : rows;

      // FIX #6: Hydrate in batched queries (zero N+1)
      const posts = await hydratePosts(env.DB, itemsToReturn, auth.user.id);

      const nextCursor =
        hasMore && posts.length > 0
          ? encodeCursor(posts[posts.length - 1]!.created_at, posts[posts.length - 1]!.id)
          : null;

      return jsonResponse({
        posts,
        next_cursor: nextCursor,
        has_more: hasMore,
      });
    }

    // POST /api/posts/:id/likes - Like a post
    if (pathname.match(/^\/api\/posts\/[^/]+\/likes$/) && method === 'POST') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      const postId = pathname.split('/')[3]!;
      const post = await env.DB.prepare("SELECT id, author_id FROM posts WHERE id = ? AND status = 'active'")
        .bind(postId)
        .first<{ id: string; author_id: string }>();

      if (!post || (await isBlockedBetween(env.DB, auth.user.id, post.author_id))) {
        return jsonResponse({ error: 'Post not found' }, 404);
      }

      const now = new Date().toISOString();
      try {
        await env.DB.prepare(
          'INSERT OR IGNORE INTO post_reactions (post_id, user_id, type, created_at) VALUES (?, ?, ?, ?)'
        )
          .bind(postId, auth.user.id, 'like', now)
          .run();

        // Interest profile: like gives +1 signal to post's topics
        await updateUserTopicSignalsForPost(env.DB, auth.user.id, postId, 1.0);
      } catch {
        // Ignored
      }

      const blockedIds = await getBlockedUserIds(env.DB, auth.user.id);
      const hasBlocked = blockedIds.length > 0;
      let countQuery = 'SELECT COUNT(*) as count FROM post_reactions WHERE post_id = ?';
      const countParams: unknown[] = [postId];
      if (hasBlocked) {
        countQuery += ` AND user_id NOT IN (${blockedIds.map(() => '?').join(',')})`;
        countParams.push(...blockedIds);
      }
      const likesCount = await env.DB.prepare(countQuery)
        .bind(...countParams)
        .first<{ count: number }>();

      return jsonResponse({
        success: true,
        has_liked: true,
        likes_count: Number(likesCount?.count || 0),
      });
    }

    // DELETE /api/posts/:id/likes - Unlike a post
    if (pathname.match(/^\/api\/posts\/[^/]+\/likes$/) && method === 'DELETE') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      const postId = pathname.split('/')[3]!;
      const post = await env.DB.prepare("SELECT id, author_id FROM posts WHERE id = ? AND status = 'active'")
        .bind(postId)
        .first<{ id: string; author_id: string }>();

      if (!post || (await isBlockedBetween(env.DB, auth.user.id, post.author_id))) {
        return jsonResponse({ error: 'Post not found' }, 404);
      }

      await env.DB.prepare(
        'DELETE FROM post_reactions WHERE post_id = ? AND user_id = ? AND type = "like"'
      )
        .bind(postId, auth.user.id)
        .run();

      const blockedIds = await getBlockedUserIds(env.DB, auth.user.id);
      const hasBlocked = blockedIds.length > 0;
      let countQuery = 'SELECT COUNT(*) as count FROM post_reactions WHERE post_id = ?';
      const countParams: unknown[] = [postId];
      if (hasBlocked) {
        countQuery += ` AND user_id NOT IN (${blockedIds.map(() => '?').join(',')})`;
        countParams.push(...blockedIds);
      }
      const likesCount = await env.DB.prepare(countQuery)
        .bind(...countParams)
        .first<{ count: number }>();

      return jsonResponse({
        success: true,
        has_liked: false,
        likes_count: Number(likesCount?.count || 0),
      });
    }

    // GET /api/posts/:id/comments - Retrieve comments on a post
    if (pathname.match(/^\/api\/posts\/[^/]+\/comments$/) && method === 'GET') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      const postId = pathname.split('/')[3]!;
      const post = await env.DB.prepare("SELECT id, author_id FROM posts WHERE id = ? AND status = 'active'")
        .bind(postId)
        .first<{ id: string; author_id: string }>();

      if (!post || (await isBlockedBetween(env.DB, auth.user.id, post.author_id))) {
        return jsonResponse({ error: 'Post not found' }, 404);
      }

      const cursor = url.searchParams.get('cursor');
      const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') || 20)), 50);

      const blockedIds = await getBlockedUserIds(env.DB, auth.user.id);
      const hasBlocked = blockedIds.length > 0;
      const blockedFilter = hasBlocked
        ? ` AND c.author_id NOT IN (${blockedIds.map(() => '?').join(',')})`
        : '';

      let query = `
        SELECT c.id, c.post_id, c.author_id, c.body, c.created_at,
               pr.username AS author_username, pr.display_name AS author_display_name
        FROM comments c
        JOIN profiles pr ON pr.user_id = c.author_id
        WHERE c.post_id = ?${blockedFilter}
      `;
      const params: unknown[] = [postId];
      if (hasBlocked) {
        params.push(...blockedIds);
      }

      if (cursor) {
        query += ' AND c.created_at > ?';
        params.push(cursor);
      }

      query += ' ORDER BY c.created_at ASC LIMIT ?';
      params.push(limit + 1);

      const rowsResult = await env.DB.prepare(query)
        .bind(...params)
        .all<CommentItem>();

      const rows = rowsResult.results || [];
      const hasMore = rows.length > limit;
      const comments = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor =
        hasMore && comments.length > 0 ? comments[comments.length - 1]!.created_at : null;

      return jsonResponse({
        comments,
        next_cursor: nextCursor,
        has_more: hasMore,
      });
    }

    // POST /api/posts/:id/comments - Add comment to post
    if (pathname.match(/^\/api\/posts\/[^/]+\/comments$/) && method === 'POST') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      // FIX #3: D1-backed rate limit: max 30 comments per hour per user
      const rate = await checkRateLimit(env.DB, `comment:${auth.user.id}`, 30, 60 * 60 * 1000);
      if (!rate.allowed) {
        return jsonResponse(
          { error: 'Rate limit exceeded: maximum 30 comments per hour. Please try again later.' },
          429,
          { 'Retry-After': String(rate.retryAfterSeconds) }
        );
      }

      const postId = pathname.split('/')[3]!;
      const post = await env.DB.prepare("SELECT id, author_id, expires_at FROM posts WHERE id = ? AND status = 'active'")
        .bind(postId)
        .first<{ id: string; author_id: string; expires_at: string }>();

      if (!post || (await isBlockedBetween(env.DB, auth.user.id, post.author_id))) {
        return jsonResponse({ error: 'Post not found' }, 404);
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      const parseResult = createCommentSchema.safeParse(body);
      if (!parseResult.success) {
        return jsonResponse(
          { error: 'Validation failed', issues: parseResult.error.issues },
          400
        );
      }

      const commentId = `cmt_${generateRandomString(16).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      const now = new Date().toISOString();

      await env.DB.prepare(
        'INSERT INTO comments (id, post_id, author_id, body, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
        .bind(commentId, postId, auth.user.id, parseResult.data.body, now, post.expires_at)
        .run();

      // Interest profile: comment gives +3 signal to post's topics
      await updateUserTopicSignalsForPost(env.DB, auth.user.id, postId, 3.0);

      return jsonResponse(
        {
          id: commentId,
          post_id: postId,
          author_id: auth.user.id,
          author_username: auth.profile.username,
          author_display_name: auth.profile.display_name,
          body: parseResult.data.body,
          created_at: now,
        },
        201
      );
    }

    // DELETE /api/comments/:id - Author only delete comment
    if (pathname.startsWith('/api/comments/') && method === 'DELETE') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      const commentId = pathname.slice('/api/comments/'.length);
      const comment = await env.DB.prepare('SELECT author_id FROM comments WHERE id = ?')
        .bind(commentId)
        .first<{ author_id: string }>();

      if (!comment) {
        return jsonResponse({ error: 'Comment not found' }, 404);
      }

      if (comment.author_id !== auth.user.id) {
        return jsonResponse({ error: 'Forbidden: You can only delete your own comments' }, 403);
      }

      await env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(commentId).run();

      return jsonResponse({ success: true, message: 'Comment deleted successfully' });
    }

    // ==========================================
    // 5. SOCIAL FOLLOWS & REPORTS
    // ==========================================

    // POST /api/users/:id/follow - Follow user
    if (pathname.match(/^\/api\/users\/[^/]+\/follow$/) && method === 'POST') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      // FIX #3: D1-backed rate limit: max 60 follows per hour
      const rate = await checkRateLimit(env.DB, `follow:${auth.user.id}`, 60, 60 * 60 * 1000);
      if (!rate.allowed) {
        return jsonResponse(
          { error: 'Follow rate limit exceeded. Please wait a moment.' },
          429,
          { 'Retry-After': String(rate.retryAfterSeconds) }
        );
      }

      const param = pathname.split('/')[3]!;

      const target = await env.DB.prepare(
        'SELECT id FROM users WHERE id = ? OR id IN (SELECT user_id FROM profiles WHERE username_normalized = ?)'
      )
        .bind(param, normalizeUsername(param))
        .first<{ id: string }>();

      if (!target) {
        return jsonResponse({ error: 'User not found' }, 404);
      }

      if (target.id === auth.user.id) {
        return jsonResponse({ error: 'Cannot follow yourself' }, 400);
      }

      if (await isBlockedBetween(env.DB, auth.user.id, target.id)) {
        return jsonResponse({ error: 'Cannot follow a blocked user' }, 403);
      }

      const now = new Date().toISOString();
      await env.DB.prepare(
        'INSERT OR IGNORE INTO follows (follower_id, followed_id, created_at) VALUES (?, ?, ?)'
      )
        .bind(auth.user.id, target.id, now)
        .run();

      return jsonResponse({ success: true, is_following: true });
    }

    // DELETE /api/users/:id/follow - Unfollow user
    if (pathname.match(/^\/api\/users\/[^/]+\/follow$/) && method === 'DELETE') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      const param = pathname.split('/')[3]!;

      const target = await env.DB.prepare(
        'SELECT id FROM users WHERE id = ? OR id IN (SELECT user_id FROM profiles WHERE username_normalized = ?)'
      )
        .bind(param, normalizeUsername(param))
        .first<{ id: string }>();

      if (target) {
        await env.DB.prepare(
          'DELETE FROM follows WHERE follower_id = ? AND followed_id = ?'
        )
          .bind(auth.user.id, target.id)
          .run();
      }

      return jsonResponse({ success: true, is_following: false });
    }

    // ==========================================
    // 5. MESSAGING & BLOCKING ROUTES (M4)
    // ==========================================

    // GET /api/conversations - List conversations for authenticated user
    if (pathname === '/api/conversations' && method === 'GET') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      const convRows = await env.DB.prepare(
        `SELECT c.id, c.created_at,
                cm_other.user_id AS other_user_id,
                p.username AS other_username,
                p.display_name AS other_display_name,
                p.avatar_media_id AS other_avatar_media_id
         FROM conversation_members cm
         JOIN conversations c ON c.id = cm.conversation_id
         JOIN conversation_members cm_other ON cm_other.conversation_id = c.id AND cm_other.user_id != cm.user_id
         JOIN profiles p ON p.user_id = cm_other.user_id
         WHERE cm.user_id = ?`
      )
        .bind(auth.user.id)
        .all<{
          id: string;
          created_at: string;
          other_user_id: string;
          other_username: string;
          other_display_name: string;
          other_avatar_media_id: string | null;
        }>();

      const convList = convRows.results || [];
      const nowIso = new Date().toISOString();

      const conversations: ConversationItem[] = [];

      for (const conv of convList) {
        const lastMsg = await env.DB.prepare(
          `SELECT id, sender_id, body, sent_at, expires_at
           FROM messages
           WHERE conversation_id = ? AND expires_at > ?
           ORDER BY sent_at DESC, id DESC
           LIMIT 1`
        )
          .bind(conv.id, nowIso)
          .first<{
            id: string;
            sender_id: string;
            body: string;
            sent_at: string;
            expires_at: string;
          }>();

        conversations.push({
          id: conv.id,
          created_at: conv.created_at,
          other_user: {
            id: conv.other_user_id,
            username: conv.other_username,
            display_name: conv.other_display_name,
            avatar_media_id: conv.other_avatar_media_id,
          },
          last_message: lastMsg || null,
        });
      }

      // Order conversations by latest activity (last message sent_at or conversation created_at)
      conversations.sort((a, b) => {
        const timeA = a.last_message?.sent_at || a.created_at;
        const timeB = b.last_message?.sent_at || b.created_at;
        return timeB.localeCompare(timeA);
      });

      return jsonResponse({ conversations });
    }

    // POST /api/conversations - Find or create 1:1 conversation with target user
    if (pathname === '/api/conversations' && method === 'POST') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      const parseResult = createConversationSchema.safeParse(body);
      if (!parseResult.success) {
        return jsonResponse(
          { error: 'Validation failed', issues: parseResult.error.issues },
          400
        );
      }

      let targetUserId = parseResult.data.user_id;

      const targetUser = await env.DB.prepare(
        'SELECT u.id, p.username, p.display_name, p.avatar_media_id FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = ? OR p.username_normalized = ?'
      )
        .bind(targetUserId, normalizeUsername(targetUserId))
        .first<{ id: string; username: string; display_name: string; avatar_media_id: string | null }>();

      if (!targetUser) {
        return jsonResponse({ error: 'User not found' }, 404);
      }

      targetUserId = targetUser.id;

      if (targetUserId === auth.user.id) {
        return jsonResponse({ error: 'Cannot start conversation with yourself' }, 400);
      }

      // Check DM policy & blocking permissions
      const check = await canSendDmTo(env.DB, auth.user.id, targetUserId);
      if (!check.allowed) {
        return jsonResponse({ error: check.reason }, 403);
      }

      // Check if 1:1 conversation already exists
      const existing = await env.DB.prepare(
        `SELECT cm1.conversation_id AS id, c.created_at
         FROM conversation_members cm1
         JOIN conversation_members cm2 ON cm1.conversation_id = cm2.conversation_id
         JOIN conversations c ON c.id = cm1.conversation_id
         WHERE cm1.user_id = ? AND cm2.user_id = ?
         LIMIT 1`
      )
        .bind(auth.user.id, targetUserId)
        .first<{ id: string; created_at: string }>();

      if (existing) {
        const nowIso = new Date().toISOString();
        const lastMsg = await env.DB.prepare(
          `SELECT id, sender_id, body, sent_at, expires_at
           FROM messages
           WHERE conversation_id = ? AND expires_at > ?
           ORDER BY sent_at DESC, id DESC
           LIMIT 1`
        )
          .bind(existing.id, nowIso)
          .first<{ id: string; sender_id: string; body: string; sent_at: string; expires_at: string }>();

        const item: ConversationItem = {
          id: existing.id,
          created_at: existing.created_at,
          other_user: {
            id: targetUser.id,
            username: targetUser.username,
            display_name: targetUser.display_name,
            avatar_media_id: targetUser.avatar_media_id,
          },
          last_message: lastMsg || null,
        };
        return jsonResponse({ conversation: item }, 200);
      }

      // Create new conversation
      const convId = `conv_${generateRandomString(16).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      const now = new Date().toISOString();

      await env.DB.batch([
        env.DB.prepare('INSERT INTO conversations (id, created_at) VALUES (?, ?)').bind(convId, now),
        env.DB.prepare('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)').bind(convId, auth.user.id),
        env.DB.prepare('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)').bind(convId, targetUserId),
      ]);

      const item: ConversationItem = {
        id: convId,
        created_at: now,
        other_user: {
          id: targetUser.id,
          username: targetUser.username,
          display_name: targetUser.display_name,
          avatar_media_id: targetUser.avatar_media_id,
        },
        last_message: null,
      };

      return jsonResponse({ conversation: item }, 201);
    }

    // GET /api/conversations/:id/messages - Paginated messages in a conversation
    if (pathname.match(/^\/api\/conversations\/[^/]+\/messages$/) && method === 'GET') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      const convId = pathname.split('/')[3]!;

      // Enforce membership
      const membership = await env.DB.prepare(
        'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
      )
        .bind(convId, auth.user.id)
        .first();

      if (!membership) {
        return jsonResponse({ error: 'Forbidden: Not a member of this conversation' }, 403);
      }

      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 20), 1), 50);
      const cursorParam = url.searchParams.get('cursor');
      const nowIso = new Date().toISOString();

      let query = `
        SELECT m.id, m.conversation_id, m.sender_id, m.body, m.sent_at, m.expires_at,
               p.username AS sender_username, p.display_name AS sender_display_name
        FROM messages m
        JOIN profiles p ON p.user_id = m.sender_id
        WHERE m.conversation_id = ? AND m.expires_at > ?
      `;
      const params: unknown[] = [convId, nowIso];

      if (cursorParam) {
        const decoded = decodeCursor(cursorParam);
        if (decoded) {
          query += ' AND (m.sent_at < ? OR (m.sent_at = ? AND m.id < ?))';
          params.push(decoded.createdAt, decoded.createdAt, decoded.id);
        }
      }

      query += ' ORDER BY m.sent_at DESC, m.id DESC LIMIT ?';
      params.push(limit + 1);

      const msgRows = await env.DB.prepare(query).bind(...params).all<{
        id: string;
        conversation_id: string;
        sender_id: string;
        body: string;
        sent_at: string;
        expires_at: string;
        sender_username: string;
        sender_display_name: string;
      }>();

      const results = msgRows.results || [];
      const hasMore = results.length > limit;
      const items = hasMore ? results.slice(0, limit) : results;

      const nextCursor =
        hasMore && items.length > 0
          ? encodeCursor(items[items.length - 1]!.sent_at, items[items.length - 1]!.id)
          : null;

      // Hydrate attached media in single batch query
      const messageIds = items.map((m) => m.id);
      const mediaMap = new Map<string, MediaItem[]>();

      if (messageIds.length > 0) {
        const placeholders = messageIds.map(() => '?').join(',');
        const mediaRows = await env.DB.prepare(
          `SELECT mm.message_id, m.id, m.object_key, m.mime_type, m.size_bytes
           FROM message_media mm
           JOIN media m ON m.id = mm.media_id
           WHERE mm.message_id IN (${placeholders})`
        )
          .bind(...messageIds)
          .all<{ message_id: string; id: string; object_key: string; mime_type: string; size_bytes: number }>();

        for (const mr of mediaRows.results || []) {
          const list = mediaMap.get(mr.message_id) || [];
          list.push({
            id: mr.id,
            object_key: mr.object_key,
            mime_type: mr.mime_type,
            size_bytes: mr.size_bytes,
          });
          mediaMap.set(mr.message_id, list);
        }
      }

      const messages: MessageItem[] = items.map((m) => ({
        id: m.id,
        conversation_id: m.conversation_id,
        sender_id: m.sender_id,
        sender_username: m.sender_username,
        sender_display_name: m.sender_display_name,
        body: m.body,
        sent_at: m.sent_at,
        expires_at: m.expires_at,
        media: mediaMap.get(m.id) || [],
      }));

      return jsonResponse({
        messages,
        next_cursor: nextCursor,
        has_more: hasMore,
      });
    }

    // POST /api/conversations/:id/messages - Send message to conversation
    if (pathname.match(/^\/api\/conversations\/[^/]+\/messages$/) && method === 'POST') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      const convId = pathname.split('/')[3]!;

      // Enforce membership
      const membership = await env.DB.prepare(
        'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
      )
        .bind(convId, auth.user.id)
        .first();

      if (!membership) {
        return jsonResponse({ error: 'Forbidden: Not a member of this conversation' }, 403);
      }

      // Check other member(s) permissions
      const otherMembers = await env.DB.prepare(
        'SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?'
      )
        .bind(convId, auth.user.id)
        .all<{ user_id: string }>();

      for (const other of otherMembers.results || []) {
        const check = await canSendDmTo(env.DB, auth.user.id, other.user_id);
        if (!check.allowed) {
          return jsonResponse({ error: check.reason }, 403);
        }
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      const parseResult = createMessageSchema.safeParse(body);
      if (!parseResult.success) {
        return jsonResponse(
          { error: 'Validation failed', issues: parseResult.error.issues },
          400
        );
      }

      const { body: msgBody, media_ids = [] } = parseResult.data;

      // Validate media ownership
      const mediaItems: MediaItem[] = [];
      if (media_ids && media_ids.length > 0) {
        for (const mid of media_ids) {
          const m = await env.DB.prepare(
            'SELECT id, owner_id, object_key, mime_type, size_bytes FROM media WHERE id = ?'
          )
            .bind(mid)
            .first<MediaRow>();

          if (!m || m.owner_id !== auth.user.id) {
            return jsonResponse({ error: `Invalid media attachment: ${mid}` }, 400);
          }
          mediaItems.push({
            id: m.id,
            object_key: m.object_key,
            mime_type: m.mime_type,
            size_bytes: m.size_bytes,
          });
        }
      }

      const msgId = `msg_${generateRandomString(16).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      const nowMs = Date.now();
      const sentAt = new Date(nowMs).toISOString();
      const expiresAt = new Date(nowMs + 14 * 24 * 60 * 60 * 1000).toISOString();

      const batchStatements: D1PreparedStatement[] = [
        env.DB.prepare(
          'INSERT INTO messages (id, conversation_id, sender_id, body, sent_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(msgId, convId, auth.user.id, msgBody, sentAt, expiresAt),
      ];

      for (const m of mediaItems) {
        batchStatements.push(
          env.DB.prepare('INSERT INTO message_media (message_id, media_id) VALUES (?, ?)').bind(msgId, m.id)
        );
        batchStatements.push(
          env.DB.prepare('UPDATE media SET expires_at = ? WHERE id = ?').bind(expiresAt, m.id)
        );
      }

      await env.DB.batch(batchStatements);

      const messageItem: MessageItem = {
        id: msgId,
        conversation_id: convId,
        sender_id: auth.user.id,
        sender_username: auth.profile.username,
        sender_display_name: auth.profile.display_name,
        body: msgBody,
        sent_at: sentAt,
        expires_at: expiresAt,
        media: mediaItems,
      };

      return jsonResponse({ message: messageItem }, 201);
    }

    // GET /api/blocks - List blocked users
    if (pathname === '/api/blocks' && method === 'GET') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      const blocks = await env.DB.prepare(
        `SELECT b.blocked_id AS user_id, p.username, p.display_name, b.created_at
         FROM blocks b
         JOIN profiles p ON p.user_id = b.blocked_id
         WHERE b.blocker_id = ?
         ORDER BY b.created_at DESC`
      )
        .bind(auth.user.id)
        .all<BlockItem>();

      return jsonResponse({ blocks: blocks.results || [] });
    }

    // POST /api/blocks or POST /api/blocks/:id - Block a user
    if ((pathname === '/api/blocks' || pathname.startsWith('/api/blocks/')) && method === 'POST') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      let targetUserId = '';
      if (pathname.startsWith('/api/blocks/') && pathname !== '/api/blocks') {
        targetUserId = pathname.slice('/api/blocks/'.length);
      } else {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ error: 'Invalid JSON body' }, 400);
        }
        const parseResult = createBlockSchema.safeParse(body);
        if (!parseResult.success) {
          return jsonResponse({ error: 'Validation failed', issues: parseResult.error.issues }, 400);
        }
        targetUserId = parseResult.data.user_id;
      }

      const targetUser = await env.DB.prepare(
        'SELECT id FROM users WHERE id = ? OR id IN (SELECT user_id FROM profiles WHERE username_normalized = ?)'
      )
        .bind(targetUserId, normalizeUsername(targetUserId))
        .first<{ id: string }>();

      if (!targetUser) {
        return jsonResponse({ error: 'User not found' }, 404);
      }
      const resolvedUserId = targetUser.id;

      if (resolvedUserId === auth.user.id) {
        return jsonResponse({ error: 'Cannot block yourself' }, 400);
      }

      const now = new Date().toISOString();
      await env.DB.prepare(
        'INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)'
      )
        .bind(auth.user.id, resolvedUserId, now)
        .run();

      // Remove any follows in either direction
      await env.DB.prepare(
        'DELETE FROM follows WHERE (follower_id = ? AND followed_id = ?) OR (follower_id = ? AND followed_id = ?)'
      )
        .bind(auth.user.id, resolvedUserId, resolvedUserId, auth.user.id)
        .run();

      return jsonResponse({ success: true, message: 'User blocked' }, 201);
    }

    // DELETE /api/blocks/:id - Unblock a user
    if (pathname.startsWith('/api/blocks/') && method === 'DELETE') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      const targetParam = pathname.slice('/api/blocks/'.length);
      let targetUserId = targetParam;
      const targetUser = await env.DB.prepare(
        'SELECT id FROM users WHERE id = ? OR id IN (SELECT user_id FROM profiles WHERE username_normalized = ?)'
      )
        .bind(targetParam, normalizeUsername(targetParam))
        .first<{ id: string }>();
      if (targetUser) {
        targetUserId = targetUser.id;
      }

      await env.DB.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?')
        .bind(auth.user.id, targetUserId)
        .run();

      return jsonResponse({ success: true, message: 'User unblocked' });
    }

    // POST /api/reports - File a moderation report (FIX #8)
    if (pathname === '/api/reports' && method === 'POST') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      // FIX #3: D1 rate limiter: max 10 reports per hour per user
      const rate = await checkRateLimit(env.DB, `report:${auth.user.id}`, 10, 60 * 60 * 1000);
      if (!rate.allowed) {
        return jsonResponse(
          { error: 'Report rate limit exceeded. Please try again later.' },
          429,
          { 'Retry-After': String(rate.retryAfterSeconds) }
        );
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      const parseResult = createReportSchema.safeParse(body);
      if (!parseResult.success) {
        return jsonResponse(
          { error: 'Validation failed', issues: parseResult.error.issues },
          400
        );
      }

      const { target_type, target_id, reason } = parseResult.data;

      // FIX #8: Verify target exists
      let reportedMessage: MessageRow | null = null;
      if (target_type === 'post') {
        const p = await env.DB.prepare('SELECT id FROM posts WHERE id = ?').bind(target_id).first();
        if (!p) return jsonResponse({ error: 'Post target not found' }, 404);
      } else if (target_type === 'comment') {
        const c = await env.DB.prepare('SELECT id FROM comments WHERE id = ?').bind(target_id).first();
        if (!c) return jsonResponse({ error: 'Comment target not found' }, 404);
      } else if (target_type === 'user') {
        const u = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(target_id).first();
        if (!u) return jsonResponse({ error: 'User target not found' }, 404);
      } else if (target_type === 'message') {
        const m = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(target_id).first<MessageRow>();
        if (!m) return jsonResponse({ error: 'Message target not found' }, 404);
        reportedMessage = m;
      }

      // FIX #8: One open report per reporter and target
      const existingReport = await env.DB.prepare(
        "SELECT id FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = 'pending'"
      )
        .bind(auth.user.id, target_type, target_id)
        .first();

      if (existingReport) {
        return jsonResponse(
          { error: 'You already have an open report pending review for this item' },
          409
        );
      }

      const reportId = `rep_${generateRandomString(16).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      const now = new Date().toISOString();

      const batchStatements: D1PreparedStatement[] = [
        env.DB.prepare(
          'INSERT INTO reports (id, reporter_id, target_type, target_id, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(reportId, auth.user.id, target_type, target_id, reason, 'pending', now),
      ];

      if (target_type === 'message' && reportedMessage) {
        const mediaRows = await env.DB.prepare(
          `SELECT m.object_key FROM media m
           JOIN message_media mm ON mm.media_id = m.id
           WHERE mm.message_id = ?`
        )
          .bind(reportedMessage.id)
          .all<{ object_key: string }>();

        const attachmentKeys = (mediaRows.results || []).map((r) => r.object_key);
        const snapshot = JSON.stringify({
          message_id: reportedMessage.id,
          conversation_id: reportedMessage.conversation_id,
          sender_id: reportedMessage.sender_id,
          body: reportedMessage.body,
          sent_at: reportedMessage.sent_at,
          expires_at: reportedMessage.expires_at,
          attachment_keys: attachmentKeys,
        });

        const evidenceId = `evi_${generateRandomString(16).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
        const evidenceExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

        batchStatements.push(
          env.DB.prepare(
            'INSERT INTO report_evidence (id, report_id, snapshot, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
          ).bind(evidenceId, reportId, snapshot, now, evidenceExpiresAt)
        );
      }

      await env.DB.batch(batchStatements);

      return jsonResponse(
        { success: true, message: 'Report submitted successfully', id: reportId },
        201
      );
    }

    // ==========================================
    // 6. ADMIN MODERATION ROUTES (FIX #8)
    // ==========================================

    // GET /api/admin/reports - Retrieve all moderation reports (requires admin secret)
    if (pathname === '/api/admin/reports' && method === 'GET') {
      const adminSecretHeader = request.headers.get('x-admin-secret');
      if (!adminSecretHeader) {
        if (!((isDevelopment || isTest) && !env.ADMIN_SECRET)) {
          return jsonResponse({ error: 'Unauthorized: Admin secret required' }, 401);
        }
      } else if (!env.ADMIN_SECRET || !constantTimeCompare(adminSecretHeader, env.ADMIN_SECRET)) {
        return jsonResponse({ error: 'Forbidden: Invalid admin secret' }, 403);
      }

      const statusParam = url.searchParams.get('status') || '';
      let query = `
        SELECT r.id, r.reporter_id, r.target_type, r.target_id, r.reason, r.status, r.created_at,
               pr.username AS reporter_username
        FROM reports r
        JOIN profiles pr ON pr.user_id = r.reporter_id
      `;
      const params: unknown[] = [];

      if (statusParam) {
        query += ' WHERE r.status = ?';
        params.push(statusParam);
      }

      query += ' ORDER BY r.created_at DESC LIMIT 100';

      const reports = await env.DB.prepare(query).bind(...params).all();
      return jsonResponse({ reports: reports.results || [] });
    }

    // PATCH /api/admin/reports/:id - Set report status (reviewed or dismissed)
    if (pathname.startsWith('/api/admin/reports/') && method === 'PATCH') {
      const adminSecretHeader = request.headers.get('x-admin-secret');
      if (!adminSecretHeader) {
        if (!((isDevelopment || isTest) && !env.ADMIN_SECRET)) {
          return jsonResponse({ error: 'Unauthorized: Admin secret required' }, 401);
        }
      } else if (!env.ADMIN_SECRET || !constantTimeCompare(adminSecretHeader, env.ADMIN_SECRET)) {
        return jsonResponse({ error: 'Forbidden: Invalid admin secret' }, 403);
      }

      const reportId = pathname.slice('/api/admin/reports/'.length);

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      const parseResult = updateReportSchema.safeParse(body);
      if (!parseResult.success) {
        return jsonResponse({ error: 'Validation failed', issues: parseResult.error.issues }, 400);
      }

      const { status: newStatus } = parseResult.data;

      const report = await env.DB.prepare('SELECT id FROM reports WHERE id = ?').bind(reportId).first();
      if (!report) {
        return jsonResponse({ error: 'Report not found' }, 404);
      }

      await env.DB.prepare('UPDATE reports SET status = ? WHERE id = ?').bind(newStatus, reportId).run();

      return jsonResponse({ success: true, id: reportId, status: newStatus });
    }

    // ==========================================
    // 7. MEDIA STORAGE (R2) & AUTHORIZED SERVING
    // ==========================================

    // POST /api/media/uploads - Upload media (max 5 MB, jpeg/png/webp only) (FIX #4)
    if (pathname === '/api/media/uploads' && method === 'POST') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      // FIX #3: D1 rate limiter: max 20 uploads per hour per user
      const rate = await checkRateLimit(env.DB, `upload:${auth.user.id}`, 20, 60 * 60 * 1000);
      if (!rate.allowed) {
        return jsonResponse(
          { error: 'Rate limit exceeded: maximum 20 uploads per hour. Please try again later.' },
          429,
          { 'Retry-After': String(rate.retryAfterSeconds) }
        );
      }

      // FIX #4: Reject by Content-Length before reading the body
      const clHeader = request.headers.get('content-length');
      const maxSizeBytes = 5 * 1024 * 1024;
      if (clHeader) {
        const declaredSize = Number(clHeader);
        if (declaredSize > maxSizeBytes) {
          return jsonResponse(
            { error: `File exceeds maximum size of 5 MB (actual: ${(declaredSize / (1024 * 1024)).toFixed(2)} MB)` },
            400
          );
        }
      }

      const contentType = request.headers.get('Content-Type') || '';
      let fileBytes: Uint8Array;
      let mimeType = '';

      if (contentType.includes('multipart/form-data')) {
        let formData: FormData;
        try {
          formData = await request.formData();
        } catch {
          return jsonResponse({ error: 'Invalid form data' }, 400);
        }

        const file = formData.get('file');
        if (!file || typeof file === 'string') {
          return jsonResponse({ error: 'Missing file field in form data' }, 400);
        }

        mimeType = (file as File).type;
        const ab = await (file as File).arrayBuffer();
        fileBytes = new Uint8Array(ab);
      } else {
        mimeType = contentType.split(';')[0]!.trim();
        const ab = await request.arrayBuffer();
        fileBytes = new Uint8Array(ab);
      }

      // Validate MIME type
      const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
      if (!allowedTypes.includes(mimeType)) {
        return jsonResponse(
          { error: `Invalid image type: "${mimeType}". Only JPEG, PNG, and WebP are supported.` },
          400
        );
      }

      // Validate file size
      if (fileBytes.length === 0) {
        return jsonResponse({ error: 'File is empty' }, 400);
      }
      if (fileBytes.length > maxSizeBytes) {
        return jsonResponse(
          { error: `File exceeds maximum size of 5 MB (actual: ${(fileBytes.length / (1024 * 1024)).toFixed(2)} MB)` },
          400
        );
      }

      // FIX #4: Verify magic bytes match declared type
      const isJpeg =
        fileBytes.length >= 3 && fileBytes[0] === 0xff && fileBytes[1] === 0xd8 && fileBytes[2] === 0xff;
      const isPng =
        fileBytes.length >= 4 &&
        fileBytes[0] === 0x89 &&
        fileBytes[1] === 0x50 &&
        fileBytes[2] === 0x4e &&
        fileBytes[3] === 0x47;
      const isWebp =
        fileBytes.length >= 12 &&
        fileBytes[0] === 0x52 &&
        fileBytes[1] === 0x49 &&
        fileBytes[2] === 0x46 &&
        fileBytes[3] === 0x46 &&
        fileBytes[8] === 0x57 &&
        fileBytes[9] === 0x45 &&
        fileBytes[10] === 0x42 &&
        fileBytes[11] === 0x50;

      if (mimeType === 'image/jpeg' && !isJpeg) {
        return jsonResponse({ error: 'File magic bytes do not match declared image/jpeg' }, 400);
      }
      if (mimeType === 'image/png' && !isPng) {
        return jsonResponse({ error: 'File magic bytes do not match declared image/png' }, 400);
      }
      if (mimeType === 'image/webp' && !isWebp) {
        return jsonResponse({ error: 'File magic bytes do not match declared image/webp' }, 400);
      }

      const mediaId = `med_${generateRandomString(16).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      const objectKey = `media_${generateRandomString(24).toLowerCase().replace(/[^a-z0-9]/g, '')}`;

      if (env.MEDIA_BUCKET) {
        await env.MEDIA_BUCKET.put(objectKey, fileBytes, {
          httpMetadata: { contentType: mimeType },
        });
      }

      const nowMs = Date.now();
      const createdAt = new Date(nowMs).toISOString();
      const expiresAt = new Date(nowMs + 7 * 24 * 60 * 60 * 1000).toISOString();

      await env.DB.prepare(
        'INSERT INTO media (id, owner_id, object_key, mime_type, size_bytes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
        .bind(mediaId, auth.user.id, objectKey, mimeType, fileBytes.length, createdAt, expiresAt)
        .run();

      return jsonResponse(
        {
          id: mediaId,
          object_key: objectKey,
          mime_type: mimeType,
          size_bytes: fileBytes.length,
          created_at: createdAt,
        },
        201
      );
    }

    // GET /api/media/:id - Authorized Worker route serving R2 stream with nosniff (FIX #4)
    if (pathname.startsWith('/api/media/') && method === 'GET') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      const mediaId = pathname.slice('/api/media/'.length);
      const media = await env.DB.prepare(
        'SELECT id, object_key, mime_type FROM media WHERE id = ?'
      )
        .bind(mediaId)
        .first<MediaRow>();

      if (!media) {
        return jsonResponse({ error: 'Media not found' }, 404);
      }

      if (!env.MEDIA_BUCKET) {
        return jsonResponse({ error: 'Storage unavailable' }, 503);
      }

      const r2Object = await env.MEDIA_BUCKET.get(media.object_key);
      if (!r2Object) {
        return jsonResponse({ error: 'Media file missing from storage' }, 404);
      }

      // FIX #4: add nosniff header on media responses
      return new Response(r2Object.body as any, {
        headers: {
          'Content-Type': media.mime_type,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, max-age=86400',
        },
      });
    }

    // DELETE /api/media/:id - Delete media (owner only)
    if (pathname.startsWith('/api/media/') && method === 'DELETE') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      const mediaId = pathname.slice('/api/media/'.length);
      const media = await env.DB.prepare(
        'SELECT id, owner_id, object_key FROM media WHERE id = ?'
      )
        .bind(mediaId)
        .first<MediaRow>();

      if (!media) {
        return jsonResponse({ error: 'Media not found' }, 404);
      }

      if (media.owner_id !== auth.user.id) {
        return jsonResponse({ error: 'Forbidden: You can only delete your own media' }, 403);
      }

      if (env.MEDIA_BUCKET) {
        try {
          await env.MEDIA_BUCKET.delete(media.object_key);
        } catch {
          // Ignore R2 error
        }
      }

      await env.DB.prepare('DELETE FROM media WHERE id = ?').bind(mediaId).run();

      return jsonResponse({ success: true, message: 'Media deleted successfully' });
    }

    // ==========================================
    // 8. JOBS & LIFECYCLE (FIX #1, FIX #2)
    // ==========================================

    // POST /api/jobs/cleanup-expired - Trigger post lifecycle expiry job
    if (pathname === '/api/jobs/cleanup-expired' && method === 'POST') {
      const adminSecretHeader = request.headers.get('x-admin-secret');
      const isDevOrTest = isDevelopment || isTest;
      if (!isDevOrTest) {
        if (!adminSecretHeader) {
          return jsonResponse({ error: 'Unauthorized: Admin secret required' }, 401);
        }
        if (!env.ADMIN_SECRET || !constantTimeCompare(adminSecretHeader, env.ADMIN_SECRET)) {
          return jsonResponse({ error: 'Forbidden: Invalid admin secret' }, 403);
        }
      } else if (env.ADMIN_SECRET && adminSecretHeader && !constantTimeCompare(adminSecretHeader, env.ADMIN_SECRET)) {
        return jsonResponse({ error: 'Forbidden: Invalid admin secret' }, 403);
      }

      // FIX #1: Remove the reference_time parameter outside tests; the daily cron uses the real clock
      let refTime = Date.now();
      if (isDevOrTest) {
        const refTimeParam = url.searchParams.get('reference_time');
        if (refTimeParam) {
          refTime = Number(refTimeParam);
        }
      }

      const result = await runPostLifecycleExpiry(env, refTime);
      return jsonResponse(result);
    }

    // ==========================================
    // 9. 404 CATCH-ALL
    // ==========================================

    if (pathname.startsWith('/api/')) {
      return jsonResponse({ error: 'Endpoint not found' }, 404);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};
