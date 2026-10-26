import type { ExecutionContext, D1PreparedStatement, ScheduledController, D1Database } from '@cloudflare/workers-types';
import type {
  Env,
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
import { normalizeUsername, isReservedUsername } from '../shared/username.ts';
import { findCampus, campusName, cleanCampusOther } from '../shared/campus.ts';
import { handleOnboardingRoutes, getValidSignupTicket, purgeExpiredSignupTickets, SIGNUP_TICKET_COOKIE, SIGNUP_TICKET_TTL_MS } from './onboarding.ts';
import { buildMeResponse } from './me.ts';
import { handleAppealRoutes, issueAppealTicket } from './appeals.ts';
import { handleAcademicRoutes } from './academic.ts';
import { handleFeedPipelineRoutes } from './feed-pipeline/controller.ts';
import { effectiveRole, handleAdminRoute, legacyAdminGate } from './admin.ts';
import { DEFAULT_PRESET_IDS } from '../shared/presets.ts';
import {
  updateProfileSchema,
  createPostSchema,
  pollVoteSchema,
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
import { isBlockedBetween, canSendDmTo } from './permissions.ts';
import { validateStickerKey } from './stickers.ts';
import { bundledKind } from '../shared/sticker-keys.ts';
import { loadMediaItem, handleUpload, serveMedia, deleteOwnMedia, listLibrary, addToLibrary, removeFromLibrary, forwardMessage } from './media.ts';
import { runPostLifecycleExpiry, deletePostAndMedia } from './jobs/expiry.ts';
import { hydratePolls } from './polls.ts';
import { getSpamLockUntil } from './spam-lock.ts';
import { assessSpam, DUPLICATE_MIN_LENGTH, normalizeForDuplicate, POST_LIMIT_MAX, POST_LIMIT_WINDOW_MS } from './content/spam.ts';
import { checkPollOptions } from '../shared/poll.ts';
import { extractTopicsFromText } from './content/topics.ts';
import { rankPosts, type CandidatePost, type UserRankingContext } from './ranking/engine.ts';
import { computeDecayedWeight } from './ranking/decay.ts';
import { RANKING_CONFIG } from './ranking/config.ts';
import { recordImpressions } from './impressions.ts';
import { decodeDeliveredCursor, encodeDeliveredCursor, hashPostId } from './ranking/cursor.ts';

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
 * Safely parses limit query param, falling back to defaultLimit for NaN/invalid values,
 * and clamping to min..max (1..50).
 */
export function parseLimitParam(
  param: string | null | undefined,
  defaultLimit = 20,
  min = 1,
  max = 50
): number {
  if (param === null || param === undefined || param.trim() === '') {
    return defaultLimit;
  }
  const parsed = Number(param);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    return defaultLimit;
  }
  return Math.min(Math.max(Math.floor(parsed), min), max);
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
      `SELECT pm.post_id, m.id, m.object_key, m.mime_type, m.size_bytes, m.kind, m.width, m.height
       FROM post_media pm
       JOIN media m ON m.id = pm.media_id
       WHERE pm.post_id IN (${placeholders})`
    )
    .bind(...postIds)
    .all<{ post_id: string; id: string; object_key: string; mime_type: string; size_bytes: number; kind: string; width: number | null; height: number | null }>();

  const mediaMap = new Map<string, MediaItem[]>();
  for (const m of mediaRows.results || []) {
    const list = mediaMap.get(m.post_id) || [];
    list.push({
      id: m.id,
      object_key: m.object_key,
      mime_type: m.mime_type,
      size_bytes: m.size_bytes,
      kind: m.kind,
      width: m.width,
      height: m.height,
    });
    mediaMap.set(m.post_id, list);
  }

  // Sticker/GIF keys (one batched query, so every feed, search and profile query stays unchanged)
  const stickerRows = await db
    .prepare(`SELECT id, sticker_key FROM posts WHERE id IN (${placeholders}) AND sticker_key IS NOT NULL`)
    .bind(...postIds)
    .all<{ id: string; sticker_key: string }>();
  const stickerMap = new Map<string, string>((stickerRows.results || []).map((r) => [r.id, r.sticker_key]));

  // Polls: a fixed number of queries for the whole page (see worker/polls.ts)
  const pollMap = await hydratePolls(db, rows, currentUserId);

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
    sticker_key: stickerMap.get(p.id) ?? null,
    poll: pollMap.get(p.id) ?? null,
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

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  for (const pt of postTopics.results || []) {
    // Decay the stored weight to "now" before adding, otherwise old interest comes back at full
    // strength every time the topic is touched. Clamp so one binge cannot dominate for weeks.
    const existing = await db
      .prepare('SELECT weight, updated_at FROM user_topic_signals WHERE user_id = ? AND topic_id = ?')
      .bind(userId, pt.topic_id)
      .first<{ weight: number; updated_at: string }>();
    const current = existing ? computeDecayedWeight(existing.weight, existing.updated_at, nowMs) : 0;
    const next = Math.max(RANKING_CONFIG.SIGNAL_MIN, Math.min(RANKING_CONFIG.SIGNAL_MAX, current + delta));
    await db
      .prepare(
        `INSERT INTO user_topic_signals (user_id, topic_id, weight, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, topic_id) DO UPDATE SET
           weight = excluded.weight,
           updated_at = excluded.updated_at`
      )
      .bind(userId, pt.topic_id, next, now)
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

    // Several rows per statement: one query per trending topic could pass the free plan's 50 queries per run.
    const TREND_ROWS_PER_INSERT = 15; // 5 bound values each, under D1's limit of 100 per query
    for (let i = 0; i < results.length; i += TREND_ROWS_PER_INSERT) {
      const chunk = results.slice(i, i + TREND_ROWS_PER_INSERT);
      const values = chunk.map(() => '(?, ?, ?, ?, ?)').join(', ');
      const binds: unknown[] = [];
      for (const r of chunk) {
        const snapId = `snap_${generateRandomString(16).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
        binds.push(snapId, r.topic_id, window, cutoffIso, Number(r.author_count) * 2.0 + Number(r.post_count));
      }
      await db
        .prepare(`INSERT INTO trend_snapshots (id, topic_id, window, window_start, score) VALUES ${values}`)
        .bind(...binds)
        .run();
    }
  }
}

export default {
  // Cloudflare Scheduled Cron Trigger handler for daily post expiry and hourly trends job
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Each job on its own: if expiry stops early (the free plan allows 50 D1 queries per run), trends still run,
    // and the next hourly run picks the rest of the expiry work up.
    try {
      await runPostLifecycleExpiry(env);
    } catch (err) {
      console.error('[cron] expiry failed', err instanceof Error ? err.message : err);
    }
    try {
      await computeTrends(env.DB);
    } catch (err) {
      console.error('[cron] trends failed', err instanceof Error ? err.message : err);
    }
  },

  async fetch(request: Request, env: Env, _ctx?: ExecutionContext): Promise<Response> {
    try {
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

    // Own academic details: update, confirm, graduate
    const academicResponse = await handleAcademicRoutes(request, env, pathname);
    if (academicResponse) return academicResponse;

    // Feed pipeline: packaged SAFE/WILD batches for the phone's local cache (/api/v1/feed/bootstrap and /next)
    const pipelineResponse = await handleFeedPipelineRoutes(request, env, pathname, { hydratePosts, getBlockedUserIds });
    if (pipelineResponse) return pipelineResponse;

    // Appeals from suspended or banned students (ticket cookie, no session)
    const appealResponse = await handleAppealRoutes(request, env, pathname);
    if (appealResponse) return appealResponse;

    // Sign-up, campuses, username availability, suggested people and campus admin
    const onboardingResponse = await handleOnboardingRoutes(request, env);
    if (onboardingResponse) return onboardingResponse;

    // ==========================================
    // 1. AUTHENTICATION ROUTES
    // ==========================================

    // GET /api/auth/google - Initiate Google Sign-In with PKCE
    if (pathname === '/api/auth/google' && method === 'GET') {
      // DEV-ONLY: remove before launch
      const isMockRequested =
        url.searchParams.get('mock') === 'true' || env.GOOGLE_CLIENT_ID === 'PLACEHOLDER';
      const asUser = url.searchParams.get('as');
      const intentParam = url.searchParams.get('intent') ?? 'login';
      if (intentParam !== 'login' && intentParam !== 'signup') {
        return jsonResponse({ error: 'intent must be login or signup' }, 400);
      }
      const intent: 'login' | 'signup' = intentParam;

      // DEV-ONLY: remove before launch
      if (asUser !== null && !isDevelopment) {
        return jsonResponse({ error: 'User switching is only allowed in development' }, 400);
      }

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
        intent,
      };

      const encodedStateCookie = encodeOAuthState(statePayload);

      if (isMockRequested) {
        const asQuery = asUser ? `&as=${encodeURIComponent(asUser)}` : '';
        // DEV-ONLY: remove before launch (lets tests and previews sign up as different mock Google accounts)
        const mockQuery = ['mock_sub', 'mock_email', 'mock_name']
          .map((k) => (url.searchParams.get(k) ? `&${k}=${encodeURIComponent(url.searchParams.get(k)!)}` : ''))
          .join('');
        const mockRedirect = (isDevelopment || isTest)
          ? `/api/auth/callback?code=mock_code&state=${encodeURIComponent(state)}&mock=true&intent=${intent}${asQuery}${mockQuery}`
          : `${redirectUri}?code=mock_code&state=${encodeURIComponent(state)}&mock=true&intent=${intent}${asQuery}${mockQuery}`;

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
      const asUser = url.searchParams.get('as');

      // DEV-ONLY: remove before launch
      if (asUser !== null && !isDevelopment) {
        return jsonResponse({ error: 'User switching is only allowed in development' }, 400);
      }

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
      let email: string | null = null;
      let targetUserRow: UserRow | null = null;

      if (isMock) {
        // DEV-ONLY: remove before launch
        if (asUser && isDevelopment) {
          const normalized = normalizeUsername(asUser);
          const profile = await env.DB.prepare(
            'SELECT user_id, display_name FROM profiles WHERE username_normalized = ?'
          )
            .bind(normalized)
            .first<{ user_id: string; display_name: string }>();

          if (!profile) {
            return jsonResponse({ error: `User @${asUser} not found` }, 400);
          }

          targetUserRow = await env.DB.prepare('SELECT id, provider_subject, created_at, status FROM users WHERE id = ?')
            .bind(profile.user_id)
            .first<UserRow>();

          if (!targetUserRow) {
            return jsonResponse({ error: `User account for @${asUser} not found` }, 400);
          }

          providerSubject = targetUserRow.provider_subject;
          displayName = profile.display_name;
        } else {
          // DEV-ONLY: remove before launch (mock_* params pick which mock Google account signs in)
          const mockSub = url.searchParams.get('mock_sub');
          providerSubject = mockSub ? `mock-google-sub-${mockSub}`.slice(0, 100) : 'mock-google-sub-12345';
          displayName = (url.searchParams.get('mock_name') || 'Test User').slice(0, 100);
          email = (url.searchParams.get('mock_email') || '').slice(0, 200) || null;
        }
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
          email = claims.email ? claims.email.slice(0, 200) : null;
        } catch {
          return jsonResponse({ error: 'Failed to verify Google identity token' }, 400);
        }
      }

      const user = targetUserRow || (await env.DB.prepare('SELECT id, created_at, status FROM users WHERE provider_subject = ?')
        .bind(providerSubject)
        .first<UserRow>());

      const clearOauthStateCookie = serializeCookie('oauth_state', '', {
        path: oauthCookiePath,
        maxAge: 0,
        httpOnly: true,
        secure: cookieSecure,
        sameSite: cookieSameSite,
        partitioned: cookiePartitioned,
      });

      // Log in and Sign up are separate. The callback never creates an account: an unknown Google
      // account either goes back to the login screen (intent=login) or gets a short-lived sign-up
      // ticket and moves on to onboarding (intent=signup).
      const urlIntent = url.searchParams.get('intent');
      const intent: 'login' | 'signup' =
        oauthState?.intent ??
        ((isDevelopment || isTest) && urlIntent === 'signup' ? 'signup' : 'login');

      if (!user) {
        if (intent !== 'signup') {
          const noAccountHeaders = new Headers();
          noAccountHeaders.append('Set-Cookie', clearOauthStateCookie);
          noAccountHeaders.set('Location', '/?auth=no_account');
          return new Response(null, { status: 302, headers: noAccountHeaders });
        }

        await purgeExpiredSignupTickets(env);
        await env.DB.prepare('DELETE FROM signup_tickets WHERE provider_subject = ? AND used_at IS NULL')
          .bind(providerSubject)
          .run();

        const ticketId = `tkt_${generateRandomString(32)}`;
        const ticketNow = Date.now();
        await env.DB.prepare(
          `INSERT INTO signup_tickets (id, provider_subject, email, display_name, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
          .bind(
            ticketId,
            providerSubject,
            email,
            displayName.slice(0, 100),
            new Date(ticketNow).toISOString(),
            new Date(ticketNow + SIGNUP_TICKET_TTL_MS).toISOString()
          )
          .run();

        const ticketHeaders = new Headers();
        ticketHeaders.append(
          'Set-Cookie',
          serializeCookie(SIGNUP_TICKET_COOKIE, ticketId, {
            path: '/',
            maxAge: SIGNUP_TICKET_TTL_MS / 1000,
            httpOnly: true,
            secure: cookieSecure,
            sameSite: cookieSameSite,
            partitioned: cookiePartitioned,
          })
        );
        ticketHeaders.append('Set-Cookie', clearOauthStateCookie);
        ticketHeaders.set('Location', '/?signup=1');
        return new Response(null, { status: 302, headers: ticketHeaders });
      }

      // Suspended and banned accounts get no session; they are told why instead of looping back to the login screen
      if (user.status !== 'active') {
        const blockedHeaders = new Headers();
        blockedHeaders.append('Set-Cookie', clearOauthStateCookie);
        // Lets them send one request for a review; it cannot do anything else
        blockedHeaders.append('Set-Cookie', await issueAppealTicket(request, env, user.id));
        blockedHeaders.set('Location', user.status === 'banned' ? '/?auth=banned' : '/?auth=suspended');
        return new Response(null, { status: 302, headers: blockedHeaders });
      }

      // Existing account: remember the verified email for people who signed up before it was stored.
      if (email) {
        try {
          await env.DB.prepare(
            `INSERT INTO user_private (user_id, email) VALUES (?, ?)
             ON CONFLICT(user_id) DO UPDATE SET email = COALESCE(user_private.email, excluded.email)`
          )
            .bind(user.id, email)
            .run();
        } catch {
          // Non-critical: login must not fail because of this
        }
      }

      const sessionId = `sess_${generateRandomString(32)}`;
      const sessionExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
        .bind(sessionId, user.id, sessionExpiry)
        .run();

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
                p.campus_id, p.campus_other, p.real_name, p.wallpaper_id, p.wallpaper_media_id, p.theme_id, p.text_style_id,
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
          campus_id: string | null;
          real_name: string | null;
          wallpaper_id: string | null;
          wallpaper_media_id: string | null;
          theme_id: string | null;
          text_style_id: string | null;
          class_name: string | null;
          campus_other: string | null;
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
        campus_id: findCampus(row.campus_id) ? row.campus_id : null,
        campus_name: campusName(row.campus_id),
        campus_other: row.campus_other,
        // The real name is shown on the profile page only, never in feeds, search or messages.
        real_name: row.real_name,
        wallpaper_id: row.wallpaper_id,
        wallpaper_media_id: row.wallpaper_id === 'custom' ? row.wallpaper_media_id : null,
        theme_id: row.theme_id,
        text_style_id: row.text_style_id,
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

      const me = await buildMeResponse(env.DB, auth.user, auth.settings, effectiveRole(auth.user));
      if (!me) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
      return jsonResponse(me);
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

      // Cap feed_preferences at 2000 characters
      if (data.feed_preferences !== undefined) {
        const prefsStr =
          typeof data.feed_preferences === 'string'
            ? data.feed_preferences
            : JSON.stringify(data.feed_preferences);
        if (prefsStr.length > 2000) {
          return jsonResponse({ error: 'feed_preferences cannot exceed 2000 characters' }, 400);
        }
      }

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

      // Reserved names (admin, support, ...) cannot be taken; keeping an existing one is allowed
      if (
        data.username !== undefined &&
        normalizeUsername(data.username) !== auth.profile.username_normalized &&
        isReservedUsername(data.username)
      ) {
        return jsonResponse({ error: 'That username is reserved' }, 400);
      }

      // A profile picture must be an upload that belongs to this person
      if (data.avatar_media_id !== undefined && data.avatar_media_id !== null) {
        const ownMedia = await env.DB.prepare('SELECT 1 FROM media WHERE id = ? AND owner_id = ?')
          .bind(data.avatar_media_id, auth.user.id)
          .first();
        if (!ownMedia) {
          return jsonResponse({ error: 'Media not found' }, 400);
        }
      }

      // A custom background must be an upload of kind 'background' that belongs to this person.
      if (data.wallpaper_media_id) {
        const bg = await env.DB.prepare("SELECT 1 FROM media WHERE id = ? AND owner_id = ? AND kind = 'background'")
          .bind(data.wallpaper_media_id, auth.user.id)
          .first();
        if (!bg) {
          return jsonResponse({ error: 'Background image not found' }, 400);
        }
        if (data.wallpaper_id !== undefined && data.wallpaper_id !== 'custom') {
          return jsonResponse({ error: 'A background image and a preset wallpaper cannot both be chosen' }, 400);
        }
      }
      if (
        data.wallpaper_id === 'custom' &&
        (data.wallpaper_media_id === null || (data.wallpaper_media_id === undefined && !auth.profile.wallpaper_media_id))
      ) {
        return jsonResponse({ error: 'Choose a background image first' }, 400);
      }

      // A campus must be on the bundled list; free text goes in campus_other and the two never coexist.
      if (data.campus_id !== undefined && data.campus_id !== null && !findCampus(data.campus_id)) {
        return jsonResponse({ error: 'Campus not found' }, 400);
      }
      if (data.campus_other !== undefined && data.campus_other !== null) {
        const cleaned = cleanCampusOther(data.campus_other);
        if (!cleaned) return jsonResponse({ error: 'Other campus must be 2 to 80 characters with no markup' }, 400);
        if (data.campus_id) return jsonResponse({ error: 'Choose a campus from the list or enter another campus, not both' }, 400);
        data.campus_other = cleaned;
      }

      // Reject class_id values that do not exist in the classes table with 400
      if (data.class_id !== undefined && data.class_id !== null) {
        const classExists = await env.DB.prepare('SELECT 1 FROM classes WHERE id = ?')
          .bind(data.class_id)
          .first();
        if (!classExists) {
          return jsonResponse({ error: 'Class not found' }, 400);
        }
      }

      const batchStatements: D1PreparedStatement[] = [];

      if (
        data.username !== undefined ||
        data.display_name !== undefined ||
        data.bio !== undefined ||
        data.avatar_media_id !== undefined ||
        data.class_id !== undefined ||
        data.campus_id !== undefined ||
        data.campus_other !== undefined ||
        data.real_name !== undefined ||
        data.wallpaper_id !== undefined ||
        data.wallpaper_media_id !== undefined ||
        data.theme_id !== undefined ||
        data.text_style_id !== undefined
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

        let newCampusId = data.campus_id !== undefined ? data.campus_id : currentProfile.campus_id || null;
        let newCampusOther = data.campus_other !== undefined ? data.campus_other : currentProfile.campus_other || null;
        // Setting one clears the other.
        if (data.campus_id) newCampusOther = null;
        else if (data.campus_other) newCampusId = null;
        const newRealName = data.real_name !== undefined ? data.real_name : currentProfile.real_name || null;
        // The default preset is stored as NULL so the column only ever holds a real choice
        const presetOrNull = (value: string | null | undefined, defaultId: string, current: string | null) =>
          value === undefined ? current || null : value === null || value === defaultId ? null : value;
        let newWallpaper = presetOrNull(data.wallpaper_id, DEFAULT_PRESET_IDS.wallpaper, currentProfile.wallpaper_id);
        let newWallpaperMedia = currentProfile.wallpaper_media_id ?? null;
        if (data.wallpaper_media_id !== undefined) {
          // Choosing an image makes the wallpaper 'custom'; removing it falls back to the default unless a preset came with it.
          newWallpaperMedia = data.wallpaper_media_id;
          if (newWallpaperMedia) newWallpaper = 'custom';
          else if (data.wallpaper_id === undefined && currentProfile.wallpaper_id === 'custom') newWallpaper = null;
        } else if (data.wallpaper_id !== undefined && data.wallpaper_id !== 'custom') {
          newWallpaperMedia = null;
        }
        const newTheme = presetOrNull(data.theme_id, DEFAULT_PRESET_IDS.theme, currentProfile.theme_id);
        const newTextStyle = presetOrNull(data.text_style_id, DEFAULT_PRESET_IDS.textStyle, currentProfile.text_style_id);

        batchStatements.push(
          env.DB.prepare(
            `UPDATE profiles
             SET username = ?, username_normalized = ?, display_name = ?, bio = ?, avatar_media_id = ?, class_id = ?,
                 campus_id = ?, campus_other = ?, real_name = ?, wallpaper_id = ?, wallpaper_media_id = ?, theme_id = ?, text_style_id = ?
             WHERE user_id = ?`
          ).bind(
            newUsername,
            newNorm,
            newDisplayName,
            newBio,
            newAvatar,
            newClassId,
            newCampusId,
            newCampusOther,
            newRealName,
            newWallpaper,
            newWallpaperMedia,
            newTheme,
            newTextStyle,
            auth.user.id
          )
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
          const errMsg = String((dbErr as Error)?.message || dbErr || '');
          const lower = errMsg.toLowerCase();
          if (
            lower.includes('unique') ||
            (lower.includes('constraint') && (lower.includes('username') || lower.includes('profile'))) ||
            (dbErr as any)?.code === 'SQLITE_CONSTRAINT' ||
            (dbErr as any)?.code === 'SQLITE_CONSTRAINT_UNIQUE'
          ) {
            return jsonResponse({ error: 'Username is already taken' }, 409);
          }
          return jsonResponse({ error: 'Failed to update profile' }, 500);
        }
      }

      const updatedSettings = await env.DB.prepare('SELECT * FROM user_settings WHERE user_id = ?')
        .bind(auth.user.id)
        .first<UserSettingsRow>();

      const meResponse = await buildMeResponse(env.DB, auth.user, updatedSettings ?? auth.settings, effectiveRole(auth.user));
      if (!meResponse) {
        return jsonResponse({ error: 'Failed to update profile' }, 500);
      }
      return jsonResponse(meResponse);
    }

    // DELETE /api/me - Account deletion in D1 batch
    if (pathname === '/api/me' && method === 'DELETE') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      // The master admin account cannot be deleted from inside the app: the app would be left without one
      if (effectiveRole(auth.user) === 'master') {
        return jsonResponse({ error: 'The master admin account cannot be deleted. Hand it over first (see "Recovery" in the README).' }, 409);
      }

      const userId = auth.user.id;

      // Collect all R2 keys for this user (own media and message attachments)
      const keysToDelete = new Set<string>();

      const userMedia = await env.DB.prepare('SELECT object_key FROM media WHERE owner_id = ?')
        .bind(userId)
        .all<{ object_key: string }>();

      if (userMedia.results) {
        for (const m of userMedia.results) {
          keysToDelete.add(m.object_key);
        }
      }

      try {
        const msgMedia = await env.DB.prepare(`
          SELECT m.object_key FROM media m
          JOIN message_media mm ON mm.media_id = m.id
          JOIN messages msg ON msg.id = mm.message_id
          WHERE msg.sender_id = ?
        `).bind(userId).all<{ object_key: string }>();

        if (msgMedia.results) {
          for (const m of msgMedia.results) {
            keysToDelete.add(m.object_key);
          }
        }
      } catch {
        // Table might not exist in some migrations
      }

      if (env.MEDIA_BUCKET && keysToDelete.size > 0) {
        for (const key of keysToDelete) {
          try {
            await env.MEDIA_BUCKET.delete(key);
          } catch {
            // Ignore R2 error on account purge
          }
        }
      }

      const batchStatements: D1PreparedStatement[] = [
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM user_private WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM user_settings WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM profiles WHERE user_id = ?').bind(userId),
      ];

      try {
        batchStatements.push(
          env.DB.prepare('DELETE FROM message_media WHERE message_id IN (SELECT id FROM messages WHERE sender_id = ?)').bind(userId),
          env.DB.prepare('DELETE FROM messages WHERE sender_id = ?').bind(userId)
        );
      } catch {
        // Table may not exist
      }

      batchStatements.push(
        env.DB.prepare('DELETE FROM media WHERE owner_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId)
      );

      await env.DB.batch(batchStatements);

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
      // Signed-in people, and people in the middle of signing up (they pick a class before an account exists)
      const auth = await authenticateRequest(request, env.DB);
      if (!auth && !(await getValidSignupTicket(request, env))) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
      const classesResult = await env.DB.prepare('SELECT id, name FROM classes ORDER BY name ASC').all<ClassRow>();
      return jsonResponse({ classes: classesResult.results || [] });
    }

    // GET /api/trends - Topic trend snapshots
    if (pathname === '/api/trends' && method === 'GET') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
      const windowParam = url.searchParams.get('window') === '7d' ? '7d' : '24h';
      const blockedIds = await getBlockedUserIds(env.DB, auth.user.id);

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

      let body: { impressions?: unknown };
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      // A fixed handful of D1 queries however many posts are in the batch (see worker/impressions.ts)
      const result = await recordImpressions(env.DB, auth.user.id, body?.impressions);
      return jsonResponse({ success: true, recorded: result.received });
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
      const limit = parseLimitParam(url.searchParams.get('limit'), 20, 1, 50);

      // scope narrows results to the caller's own class or campus; default is everyone
      const scope = url.searchParams.get('scope') ?? 'all';
      if (scope !== 'all' && scope !== 'class' && scope !== 'campus') {
        return jsonResponse({ error: 'scope must be class, campus or all' }, 400);
      }
      const scopeValue = scope === 'class' ? auth.profile.class_id : scope === 'campus' ? auth.profile.campus_id : null;
      if ((scope === 'class' || scope === 'campus') && !scopeValue) {
        // Nothing to match against: say so instead of silently searching everyone
        return jsonResponse({ posts: [], total: 0, scope_missing: scope });
      }

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

      // Placeholder order: now, 3 patterns, [scope value], [blocked ids...], limit
      const scopeFilter =
        scope === 'class' ? ' AND pr.class_id = ?' : scope === 'campus' ? ' AND pr.campus_id = ?' : '';
      const searchParams: unknown[] = [nowIso, searchPattern, searchPattern, searchPattern];
      if (scopeFilter) {
        searchParams.push(scopeValue);
      }
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
           ))${scopeFilter}${blockedFilter}
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

    // PUT /api/posts/:id/poll/vote - Cast or change the caller's vote (one vote per account, enforced by the primary key)
    const pollVoteMatch = pathname.match(/^\/api\/posts\/([^/]+)\/poll\/vote$/);
    if (pollVoteMatch && method === 'PUT') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      const rate = await checkRateLimit(env.DB, `pollvote:${auth.user.id}`, 60, 60 * 60 * 1000);
      if (!rate.allowed) {
        return jsonResponse(
          { error: 'Rate limit exceeded: maximum 60 votes per hour. Please try again later.' },
          429,
          { 'Retry-After': String(rate.retryAfterSeconds) }
        );
      }

      let voteBody: unknown;
      try {
        voteBody = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }
      const voteParse = pollVoteSchema.safeParse(voteBody);
      if (!voteParse.success) {
        return jsonResponse({ error: 'Validation failed', issues: voteParse.error.issues }, 400);
      }

      let votePostId: string;
      try {
        votePostId = decodeURIComponent(pollVoteMatch[1]!);
      } catch {
        return jsonResponse({ error: 'Poll not found' }, 404);
      }

      const pollPost = await env.DB.prepare(
        `SELECT p.id, p.author_id, p.expires_at, p.status
         FROM posts p JOIN polls pl ON pl.post_id = p.id
         WHERE p.id = ?`
      )
        .bind(votePostId)
        .first<{ id: string; author_id: string; expires_at: string; status: string }>();
      // A post the caller cannot see (inactive, or blocked in either direction) looks the same as a missing one
      if (!pollPost || pollPost.status !== 'active' || (await isBlockedBetween(env.DB, auth.user.id, pollPost.author_id))) {
        return jsonResponse({ error: 'Poll not found' }, 404);
      }
      if (Date.parse(pollPost.expires_at) <= Date.now()) {
        return jsonResponse({ error: 'This poll is closed' }, 409);
      }

      const optionRow = await env.DB.prepare('SELECT 1 FROM poll_options WHERE id = ? AND poll_id = ?')
        .bind(voteParse.data.option_id, pollPost.id)
        .first();
      if (!optionRow) {
        return jsonResponse({ error: 'That option does not belong to this poll' }, 400);
      }

      // One statement, so parallel requests from the same account end as exactly one row
      await env.DB.prepare(
        `INSERT INTO poll_votes (poll_id, user_id, option_id, voted_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(poll_id, user_id) DO UPDATE SET option_id = excluded.option_id, voted_at = excluded.voted_at`
      )
        .bind(pollPost.id, auth.user.id, voteParse.data.option_id, new Date().toISOString())
        .run();

      // The caller has voted now, so the counts are returned
      const updated = await hydratePolls(env.DB, [pollPost], auth.user.id);
      return jsonResponse({ poll: updated.get(pollPost.id) ?? null }, 200);
    }

    // POST /api/posts - Create new post (body max 1000 chars, up to 4 images, 7-day expiry)
    if (pathname === '/api/posts' && method === 'POST') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      // A spam lock stops posting for 3 days after 3 spam-looking attempts in a row
      const lockedUntil = await getSpamLockUntil(env.DB, auth.user.id);
      if (lockedUntil) {
        return jsonResponse(
          { error: `Posting is paused until ${lockedUntil.toISOString()} because your recent posts looked like spam.`, code: 'spam_locked', locked_until: lockedUntil.toISOString() },
          403,
          { 'Retry-After': String(Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 1000))) }
        );
      }

      // A loose guard so rejected requests cannot be used to hammer the database. The real post limit
      // (3 per 15 minutes) is applied further down, only to posts that passed every check.
      const attempts = await checkRateLimit(env.DB, `postattempt:${auth.user.id}`, 60, POST_LIMIT_WINDOW_MS);
      if (!attempts.allowed) {
        return jsonResponse(
          { error: 'Too many attempts. Please try again later.' },
          429,
          { 'Retry-After': String(attempts.retryAfterSeconds) }
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

      const { body: postBody, media_ids = [], sticker_key: postStickerKey, poll: pollInput } = parseResult.data;
      // The schema already validated the options; this cleans them the same way (trimmed, whitespace collapsed).
      const pollCheck = pollInput ? checkPollOptions(pollInput.options) : null;
      if (pollCheck && !pollCheck.ok) {
        return jsonResponse({ error: pollCheck.error }, 400);
      }

      // Validate media_ids: max 4, owned by author, exist
      if (media_ids.length > 0) {
        for (const mId of media_ids) {
          const mediaRow = await env.DB.prepare(
            'SELECT id, owner_id, kind FROM media WHERE id = ?'
          )
            .bind(mId)
            .first<{ id: string; owner_id: string; kind: string }>();

          if (!mediaRow) {
            return jsonResponse({ error: `Media ${mId} not found` }, 400);
          }
          if (mediaRow.owner_id !== auth.user.id) {
            return jsonResponse({ error: `You do not own media ${mId}` }, 403);
          }
          // Photos only; a sticker or GIF goes in sticker_key
          if (mediaRow.kind !== 'photo') {
            return jsonResponse({ error: 'Only photos can be attached to a post. Use sticker_key for a sticker or GIF.' }, 400);
          }
        }
      }

      // One sticker or GIF per post. Bundled keys store only the key; uploaded ones are attached too.
      let postStickerMedia: string | null = null;
      if (postStickerKey) {
        const check = await validateStickerKey(env, postStickerKey, auth.user.id);
        if (!check.ok) return jsonResponse({ error: check.error }, check.status);
        postStickerMedia = check.mediaId;
      }

      // Spam check on the text people will read (post and poll options). A spam-looking attempt is refused and
      // recorded as a strike; it does not use up the post limit.
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const recentBodies = await env.DB.prepare('SELECT body FROM posts WHERE author_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 20')
        .bind(auth.user.id, dayAgo)
        .all<{ body: string }>();
      const normalizedNew = normalizeForDuplicate(postBody);
      const duplicateOfRecent = normalizedNew.length >= DUPLICATE_MIN_LENGTH && (recentBodies.results || []).some((r) => normalizeForDuplicate(r.body) === normalizedNew);
      const verdict = assessSpam([postBody, ...(pollCheck && pollCheck.ok ? pollCheck.options : [])].join(' '), { duplicateOfRecent });
      if (verdict.spam) {
        await env.DB.prepare('INSERT INTO spam_strikes (id, user_id, signals, created_at) VALUES (?, ?, ?, ?)')
          .bind(`stk_${generateRandomString(16).toLowerCase().replace(/[^a-z0-9]/g, '')}`, auth.user.id, verdict.signals.join(','), new Date().toISOString())
          .run();
        const nowLocked = await getSpamLockUntil(env.DB, auth.user.id);
        return jsonResponse(
          {
            error: nowLocked
              ? `This looks like spam, and so did your last posts. Posting is paused until ${nowLocked.toISOString()}.`
              : 'This post looks like spam, so it was not published. Change it and try again.',
            code: nowLocked ? 'spam_locked' : 'spam',
            ...(nowLocked ? { locked_until: nowLocked.toISOString() } : {}),
          },
          nowLocked ? 403 : 422
        );
      }

      // The post limit counts only posts that got this far: 3 per 15 minutes
      const rate = await checkRateLimit(env.DB, `post:${auth.user.id}`, POST_LIMIT_MAX, POST_LIMIT_WINDOW_MS);
      if (!rate.allowed) {
        return jsonResponse(
          { error: 'Rate limit exceeded: maximum 3 posts per 15 minutes. Please try again later.' },
          429,
          { 'Retry-After': String(rate.retryAfterSeconds) }
        );
      }

      const nowMs = Date.now();
      const createdAt = new Date(nowMs).toISOString();
      // New posts get expires_at = created_at + 7 days (bound ISO timestamp)
      const expiresAt = new Date(nowMs + 7 * 24 * 60 * 60 * 1000).toISOString();
      const postId = `pst_${generateRandomString(16).toLowerCase().replace(/[^a-z0-9]/g, '')}`;

      const statements: D1PreparedStatement[] = [
        env.DB.prepare(
          'INSERT INTO posts (id, author_id, body, sticker_key, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(postId, auth.user.id, postBody, postStickerKey ?? null, createdAt, expiresAt, 'active'),
      ];
      if (postStickerMedia) {
        statements.push(env.DB.prepare('INSERT INTO post_media (post_id, media_id) VALUES (?, ?)').bind(postId, postStickerMedia));
      }
      if (pollCheck && pollCheck.ok) {
        statements.push(env.DB.prepare('INSERT INTO polls (post_id, created_at) VALUES (?, ?)').bind(postId, createdAt));
        pollCheck.options.forEach((text, position) => {
          const optionId = `opt_${generateRandomString(12).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
          statements.push(env.DB.prepare('INSERT INTO poll_options (id, poll_id, position, text) VALUES (?, ?, ?, ?)').bind(optionId, postId, position, text));
        });
      }

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
          sticker_key: postStickerKey ?? null,
          // The author always sees the counts, so a new poll starts at zero
          poll: pollCheck?.ok
            ? (await hydratePolls(env.DB, [{ id: postId, author_id: auth.user.id, expires_at: expiresAt, status: 'active' }], auth.user.id)).get(postId) ?? null
            : null,
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
      const limit = parseLimitParam(url.searchParams.get('limit'), 20, 1, 50);
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

        // 3b. Posts already shown to this viewer recently (they get demoted)
        const seenSinceIso = new Date(Date.now() - RANKING_CONFIG.SEEN_WINDOW_MS).toISOString();
        const seenRows = await env.DB.prepare(
          'SELECT DISTINCT post_id FROM impressions WHERE viewer_id = ? AND shown_at >= ?'
        )
          .bind(auth.user.id, seenSinceIso)
          .all<{ post_id: string }>();
        const seenPostIds = new Set((seenRows.results || []).map((r) => r.post_id));

        // 3c. Trending topics from the 24h snapshots, scaled to 0..1
        const trendRows = await env.DB.prepare(
          `SELECT t.slug, ts.score
           FROM trend_snapshots ts
           JOIN topics t ON t.id = ts.topic_id
           WHERE ts.window = '24h'
           ORDER BY ts.score DESC
           LIMIT 20`
        ).all<{ slug: string; score: number }>();
        const maxTrend = Math.max(0, ...(trendRows.results || []).map((r) => Number(r.score)));
        const trendingTopics = new Map<string, number>();
        for (const r of trendRows.results || []) {
          if (maxTrend > 0) trendingTopics.set(r.slug, Number(r.score) / maxTrend);
        }

        const rankingContext: UserRankingContext = {
          userId: auth.user.id,
          userClassId: auth.profile.class_id || null,
          followedUserIds,
          notInterestedPostIds,
          userTopicSignals,
          trendingTopics,
          seenPostIds,
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

        const candidateSql = (extraWhere: string, limit: number): string => `
          SELECT p.id, p.author_id, p.body, p.created_at, p.expires_at, p.status,
                 pr.username AS author_username, pr.display_name AS author_display_name,
                 pr.avatar_media_id AS author_avatar_media_id, pr.class_id AS author_class_id,
                 c.name AS author_class_name,
                 (SELECT COUNT(DISTINCT user_id) FROM post_reactions WHERE post_id = p.id${engagersExclude}) +
                 (SELECT COUNT(DISTINCT author_id) FROM comments WHERE post_id = p.id${commentsExclude}) AS distinct_engagers,
                 p.impressions_count AS impressions_count
          FROM posts p
          JOIN profiles pr ON pr.user_id = p.author_id
          LEFT JOIN classes c ON c.id = pr.class_id
          WHERE p.status = 'active'
            AND p.expires_at > ?
            ${candidateFilter}
            ${extraWhere}
          ORDER BY p.created_at DESC
          LIMIT ${limit}
        `;

        // Bind order MUST match the placeholder order in candidateQuery above:
        //   1. engagersExclude (blocked ids)  - post_reactions subquery in SELECT
        //   2. commentsExclude (blocked ids)  - comments subquery in SELECT
        //   3. p.expires_at > ?               - nowIso
        //   4. candidateFilter (blocked ids)  - WHERE author filter
        const candidateParams: unknown[] = [];
        if (hasBlocked) {
          candidateParams.push(...blockedIds); // engagersExclude
          candidateParams.push(...blockedIds); // commentsExclude
        }
        candidateParams.push(nowIso); // expires_at
        if (hasBlocked) {
          candidateParams.push(...blockedIds); // candidateFilter
        }

        type CandidateRow = PostRow & {
          author_username: string;
          author_display_name: string;
          author_avatar_media_id: string | null;
          author_class_id: string | null;
          author_class_name: string | null;
          distinct_engagers: number;
          impressions_count: number;
        };

        // Newest 100 posts: the baseline pool.
        const latestRows = await env.DB.prepare(candidateSql('', 100))
          .bind(...candidateParams)
          .all<CandidateRow>();

        // Plus posts on the viewer's strongest interests and on trending topics, however old (but
        // still unexpired), so discovery is not limited to whatever was posted in the last few minutes.
        const interestSlugs = [...userTopicSignals.entries()]
          .map(([slug, sig]) => [slug, computeDecayedWeight(sig.weight, sig.updatedAt)] as const)
          .filter(([, w]) => w > 0.5)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([slug]) => slug);
        const wantedSlugs = [...new Set([...interestSlugs, ...[...trendingTopics.keys()].slice(0, 5)])];
        let extraResults: CandidateRow[] = [];
        if (wantedSlugs.length > 0) {
          const slugPh = wantedSlugs.map(() => '?').join(',');
          const extraRows = await env.DB.prepare(
            candidateSql(
              `AND p.id IN (SELECT pt.post_id FROM post_topics pt JOIN topics tp ON tp.id = pt.topic_id WHERE tp.slug IN (${slugPh}))`,
              RANKING_CONFIG.INTEREST_CANDIDATES + RANKING_CONFIG.TREND_CANDIDATES
            )
          )
            .bind(...candidateParams, ...wantedSlugs)
            .all<CandidateRow>();
          extraResults = extraRows.results || [];
        }
        const latestIds = new Set((latestRows.results || []).map((r) => r.id));
        const candidateRows = {
          results: [...(latestRows.results || []), ...extraResults.filter((r) => !latestIds.has(r.id))],
        };

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

        // Pagination: the cursor remembers which posts were already delivered, and each page is the best
        // of what is left. (Recomputing "page N" would shift page boundaries as the ranking moves while
        // the viewer scrolls, skipping and repeating posts.) Page 0 is the plain ranked top. The pool is
        // at most about 160 posts.
        const delivered = decodeDeliveredCursor(url.searchParams.get('cursor'));
        const remaining = candidates.filter(
          (c) =>
            c.status === 'active' &&
            c.expires_at > nowIso &&
            !notInterestedPostIds.has(c.id) &&
            !(delivered && delivered.has(hashPostId(c.id)))
        );
        const ranked = rankPosts(remaining, rankingContext, limit);
        const takenOnPage = new Set(ranked.map((rp) => rp.post.id));
        const hasMoreRanked = remaining.some((c) => !takenOnPage.has(c.id));
        const nextCursor = hasMoreRanked
          ? encodeDeliveredCursor([...(delivered ?? []), ...ranked.map((rp) => hashPostId(rp.post.id))])
          : null;
        const rankedIds = ranked.map((rp) => rp.post.id);
        const matchedRows = (candidateRows.results || []).filter((r) => rankedIds.includes(r.id));
        const hydrated = await hydratePosts(env.DB, matchedRows, auth.user.id);

        // Sort hydrated according to ranked order
        hydrated.sort((a, b) => rankedIds.indexOf(a.id) - rankedIds.indexOf(b.id));

        return jsonResponse({
          posts: hydrated,
          next_cursor: nextCursor,
          has_more: hasMoreRanked,
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
      const limit = parseLimitParam(url.searchParams.get('limit'), 20, 1, 50);

      const blockedIds = await getBlockedUserIds(env.DB, auth.user.id);
      const hasBlocked = blockedIds.length > 0;
      const blockedFilter = hasBlocked
        ? ` AND c.author_id NOT IN (${blockedIds.map(() => '?').join(',')})`
        : '';

      let query = `
        SELECT c.id, c.post_id, c.author_id, c.body, c.sticker_key, c.created_at,
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

      // One sticker or GIF per comment. Bundled keys store only the key; uploaded ones are attached too.
      let commentStickerKey: string | null = null;
      let commentStickerMedia: string | null = null;
      if (parseResult.data.sticker_key) {
        const check = await validateStickerKey(env, parseResult.data.sticker_key, auth.user.id);
        if (!check.ok) return jsonResponse({ error: check.error }, check.status);
        commentStickerKey = check.key;
        commentStickerMedia = check.mediaId;
      }

      const commentStatements: D1PreparedStatement[] = [
        env.DB.prepare(
          'INSERT INTO comments (id, post_id, author_id, body, sticker_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(commentId, postId, auth.user.id, parseResult.data.body, commentStickerKey, now, post.expires_at),
      ];
      if (commentStickerMedia) {
        commentStatements.push(env.DB.prepare('INSERT INTO comment_media (comment_id, media_id) VALUES (?, ?)').bind(commentId, commentStickerMedia));
      }
      await env.DB.batch(commentStatements);

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
          sticker_key: commentStickerKey,
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
          `SELECT id, sender_id, body, sent_at, expires_at, sticker_key,
                  (SELECT m.kind FROM message_media mm JOIN media m ON m.id = mm.media_id WHERE mm.message_id = messages.id LIMIT 1) AS media_kind
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
            media_kind: string | null;
            sticker_key: string | null;
          }>();
        if (lastMsg && !lastMsg.media_kind && lastMsg.sticker_key) lastMsg.media_kind = bundledKind(lastMsg.sticker_key);

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
          `SELECT id, sender_id, body, sent_at, expires_at, sticker_key,
                  (SELECT m.kind FROM message_media mm JOIN media m ON m.id = mm.media_id WHERE mm.message_id = messages.id LIMIT 1) AS media_kind
           FROM messages
           WHERE conversation_id = ? AND expires_at > ?
           ORDER BY sent_at DESC, id DESC
           LIMIT 1`
        )
          .bind(existing.id, nowIso)
          .first<{ id: string; sender_id: string; body: string; sent_at: string; expires_at: string; media_kind: string | null; sticker_key: string | null }>();
        if (lastMsg && !lastMsg.media_kind && lastMsg.sticker_key) lastMsg.media_kind = bundledKind(lastMsg.sticker_key);

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

      const limit = parseLimitParam(url.searchParams.get('limit'), 20, 1, 50);
      const cursorParam = url.searchParams.get('cursor');
      const nowIso = new Date().toISOString();

      let query = `
        SELECT m.id, m.conversation_id, m.sender_id, m.body, m.sticker_key, m.sent_at, m.expires_at,
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
        sticker_key: string | null;
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
          `SELECT mm.message_id, m.id, m.object_key, m.mime_type, m.size_bytes, m.kind, m.width, m.height, m.duration_ms
           FROM message_media mm
           JOIN media m ON m.id = mm.media_id
           WHERE mm.message_id IN (${placeholders})`
        )
          .bind(...messageIds)
          .all<{ message_id: string; id: string; object_key: string; mime_type: string; size_bytes: number; kind: string; width: number | null; height: number | null; duration_ms: number | null }>();

        for (const mr of mediaRows.results || []) {
          const list = mediaMap.get(mr.message_id) || [];
          list.push({
            id: mr.id,
            object_key: mr.object_key,
            mime_type: mr.mime_type,
            size_bytes: mr.size_bytes,
            kind: mr.kind,
            width: mr.width,
            height: mr.height,
            duration_ms: mr.duration_ms,
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
        sticker_key: m.sticker_key,
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

      const { body: msgBody, media_ids = [], sticker_key: stickerKey } = parseResult.data;

      // Validate media ownership
      const mediaItems: MediaItem[] = [];
      if (media_ids && media_ids.length > 0) {
        for (const mid of media_ids) {
          const m = await env.DB.prepare(
            'SELECT id, owner_id, object_key, mime_type, size_bytes, kind, width, height, duration_ms FROM media WHERE id = ?'
          )
            .bind(mid)
            .first<MediaRow & { kind: string; width: number | null; height: number | null; duration_ms: number | null }>();

          if (!m || m.owner_id !== auth.user.id) {
            return jsonResponse({ error: `Invalid media attachment: ${mid}` }, 400);
          }
          mediaItems.push({
            id: m.id,
            object_key: m.object_key,
            mime_type: m.mime_type,
            size_bytes: m.size_bytes,
            kind: m.kind,
            width: m.width,
            height: m.height,
            duration_ms: m.duration_ms,
          });
        }
      }

      // A sticker or GIF key: bundled keys store only the key; uploaded ones are also attached so retention and read rules apply
      if (stickerKey) {
        const check = await validateStickerKey(env, stickerKey, auth.user.id);
        if (!check.ok) return jsonResponse({ error: check.error }, check.status);
        if (check.mediaId && !mediaItems.some((x) => x.id === check.mediaId)) {
          const item = await loadMediaItem(env, check.mediaId);
          if (item) mediaItems.push(item);
        }
      }

      const nowMs = Date.now();
      const msgId = `msg_${nowMs}_${generateRandomString(12).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      const sentAt = new Date(nowMs).toISOString();
      const expiresAt = new Date(nowMs + 14 * 24 * 60 * 60 * 1000).toISOString();

      const batchStatements: D1PreparedStatement[] = [
        env.DB.prepare(
          'INSERT INTO messages (id, conversation_id, sender_id, body, sticker_key, sent_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(msgId, convId, auth.user.id, msgBody, stickerKey ?? null, sentAt, expiresAt),
      ];

      for (const m of mediaItems) {
        batchStatements.push(
          env.DB.prepare('INSERT INTO message_media (message_id, media_id) VALUES (?, ?)').bind(msgId, m.id)
        );
        batchStatements.push(
          env.DB.prepare('UPDATE media SET expires_at = MAX(expires_at, ?) WHERE id = ?').bind(expiresAt, m.id)
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
        sticker_key: stickerKey ?? null,
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
          `SELECT m.id, m.object_key, m.kind, m.sha256 FROM media m
           JOIN message_media mm ON mm.media_id = m.id
           WHERE mm.message_id = ?`
        )
          .bind(reportedMessage.id)
          .all<{ id: string; object_key: string; kind: string; sha256: string | null }>();

        const attachmentKeys = (mediaRows.results || []).map((r) => r.object_key);
        const snapshot = JSON.stringify({
          message_id: reportedMessage.id,
          conversation_id: reportedMessage.conversation_id,
          sender_id: reportedMessage.sender_id,
          body: reportedMessage.body,
          sent_at: reportedMessage.sent_at,
          expires_at: reportedMessage.expires_at,
          attachment_keys: attachmentKeys,
          sticker_key: reportedMessage.sticker_key ?? null,
          // Media ids, kinds and hashes so a moderator can identify the exact files even after storage cleanup
          attachments: (mediaRows.results || []).map((r) => ({ media_id: r.id, kind: r.kind, sha256: r.sha256 })),
        });

        const evidenceId = `evi_${generateRandomString(16).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
        const evidenceExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

        batchStatements.push(
          env.DB.prepare(
            'INSERT INTO report_evidence (id, report_id, snapshot, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
          ).bind(evidenceId, reportId, snapshot, now, evidenceExpiresAt)
        );
      }

      // Posts and comments disappear when they expire, so keep what was reported (text, sticker key, media ids and hashes)
      if (target_type === 'post' || target_type === 'comment') {
        const isPost = target_type === 'post';
        const row = isPost
          ? await env.DB.prepare('SELECT id, author_id, body, sticker_key, created_at, expires_at FROM posts WHERE id = ?').bind(target_id).first<Record<string, string | null>>()
          : await env.DB.prepare('SELECT id, post_id, author_id, body, sticker_key, created_at, expires_at FROM comments WHERE id = ?').bind(target_id).first<Record<string, string | null>>();
        if (row) {
          const attachTable = isPost ? 'post_media' : 'comment_media';
          const idColumn = isPost ? 'post_id' : 'comment_id';
          const media = await env.DB.prepare(
            `SELECT m.id, m.kind, m.sha256 FROM media m JOIN ${attachTable} a ON a.media_id = m.id WHERE a.${idColumn} = ?`
          )
            .bind(target_id)
            .all<{ id: string; kind: string; sha256: string | null }>();
          const evidenceId = `evi_${generateRandomString(16).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
          batchStatements.push(
            env.DB.prepare('INSERT INTO report_evidence (id, report_id, snapshot, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').bind(
              evidenceId,
              reportId,
              JSON.stringify({
                [isPost ? 'post_id' : 'comment_id']: row.id,
                ...(isPost ? {} : { post_id: row.post_id }),
                author_id: row.author_id,
                body: row.body,
                sticker_key: row.sticker_key ?? null,
                created_at: row.created_at,
                expires_at: row.expires_at,
                attachments: (media.results || []).map((r) => ({ media_id: r.id, kind: r.kind, sha256: r.sha256 })),
              }),
              now,
              new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
            )
          );
        }
      }

      // A user report records which background image was showing, so a moderator can identify the file later.
      if (target_type === 'user') {
        const bg = await env.DB.prepare(
          `SELECT m.id, m.kind, m.sha256 FROM profiles p JOIN media m ON m.id = p.wallpaper_media_id WHERE p.user_id = ?`
        )
          .bind(target_id)
          .first<{ id: string; kind: string; sha256: string | null }>();
        if (bg) {
          const evidenceId = `evi_${generateRandomString(16).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
          batchStatements.push(
            env.DB.prepare('INSERT INTO report_evidence (id, report_id, snapshot, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').bind(
              evidenceId,
              reportId,
              JSON.stringify({ user_id: target_id, attachments: [{ media_id: bg.id, kind: bg.kind, sha256: bg.sha256 }] }),
              now,
              new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
            )
          );
        }
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

    // People moderation (users, suspend/ban, appoint, report preview, log): signed-in admins only
    const adminResponse = await handleAdminRoute(request, env, url);
    if (adminResponse) return adminResponse;

    // GET /api/admin/stats - System health & usage counts (requires admin secret or a signed-in admin)
    if (pathname === '/api/admin/stats' && method === 'GET') {
      const adminDenied = await legacyAdminGate(request, env);
      if (adminDenied) return adminDenied;

      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const in24hIso = new Date(now + 24 * 60 * 60 * 1000).toISOString();

      const [
        usersRow,
        postsRow,
        commentsRow,
        mediaRow,
        openReportsRow,
        expiringPostsRow,
      ] = await Promise.all([
        env.DB.prepare('SELECT COUNT(*) as count FROM users').first<{ count: number }>(),
        env.DB.prepare('SELECT COUNT(*) as count FROM posts').first<{ count: number }>(),
        env.DB.prepare('SELECT COUNT(*) as count FROM comments').first<{ count: number }>(),
        env.DB.prepare('SELECT COUNT(*) as count, COALESCE(SUM(size_bytes), 0) as total_bytes FROM media').first<{ count: number; total_bytes: number }>(),
        env.DB.prepare("SELECT COUNT(*) as count FROM reports WHERE status = 'pending' OR status = 'open'").first<{ count: number }>(),
        env.DB.prepare("SELECT COUNT(*) as count FROM posts WHERE status = 'active' AND expires_at >= ? AND expires_at <= ?").bind(nowIso, in24hIso).first<{ count: number }>(),
      ]);

      let messagesCount = 0;
      let conversationsCount = 0;
      try {
        const msgRow = await env.DB.prepare('SELECT COUNT(*) as count FROM messages').first<{ count: number }>();
        messagesCount = msgRow?.count ?? 0;
      } catch {
        // Table may not exist yet
      }
      try {
        const convRow = await env.DB.prepare('SELECT COUNT(*) as count FROM conversations').first<{ count: number }>();
        conversationsCount = convRow?.count ?? 0;
      } catch {
        // Table may not exist yet
      }

      return jsonResponse({
        users: usersRow?.count ?? 0,
        posts: postsRow?.count ?? 0,
        comments: commentsRow?.count ?? 0,
        messages: messagesCount,
        conversations: conversationsCount,
        media: mediaRow?.count ?? 0,
        media_rows: mediaRow?.count ?? 0,
        total_media_bytes: Number(mediaRow?.total_bytes ?? 0),
        media_bytes: Number(mediaRow?.total_bytes ?? 0),
        open_reports: openReportsRow?.count ?? 0,
        posts_expiring_within_24h: expiringPostsRow?.count ?? 0,
      });
    }

    // GET /api/admin/reports - Retrieve all moderation reports (requires admin secret)
    if (pathname === '/api/admin/reports' && method === 'GET') {
      const adminDenied = await legacyAdminGate(request, env);
      if (adminDenied) return adminDenied;

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
      const adminDenied = await legacyAdminGate(request, env);
      if (adminDenied) return adminDenied;

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

    // POST /api/media/uploads - kinds, caps, quotas, metadata stripping and per-owner dedupe live in worker/media.ts
    if (pathname === '/api/media/uploads' && method === 'POST') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) return jsonResponse({ error: 'Unauthorized' }, 401);
      return handleUpload(request, env, auth.user.id);
    }

    // Sticker/GIF library
    if (pathname === '/api/stickers/library' && (method === 'GET' || method === 'POST')) {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) return jsonResponse({ error: 'Unauthorized' }, 401);
      if (method === 'GET') return listLibrary(env, auth.user.id);
      let body: any;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }
      return addToLibrary(env, auth.user.id, body?.media_id);
    }
    if (pathname.startsWith('/api/stickers/library/') && method === 'DELETE') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) return jsonResponse({ error: 'Unauthorized' }, 401);
      return removeFromLibrary(env, auth.user.id, pathname.slice('/api/stickers/library/'.length));
    }

    // POST /api/messages/:id/forward
    if (/^\/api\/messages\/[^/]+\/forward$/.test(pathname) && method === 'POST') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) return jsonResponse({ error: 'Unauthorized' }, 401);
      let body: any;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }
      return forwardMessage(env, auth, pathname.split('/')[3]!, body?.conversation_id);
    }

    // GET /api/media/:id and /api/media/:id/thumb
    if (pathname.startsWith('/api/media/') && method === 'GET') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) return jsonResponse({ error: 'Unauthorized' }, 401);
      const rest = pathname.slice('/api/media/'.length);
      const wantThumb = rest.endsWith('/thumb');
      return serveMedia(request, env, auth.user.id, wantThumb ? rest.slice(0, -'/thumb'.length) : rest, wantThumb);
    }

    // DELETE /api/media/:id - owner only, refused while something still uses the file
    if (pathname.startsWith('/api/media/') && method === 'DELETE') {
      const auth = await authenticateRequest(request, env.DB);
      if (!auth) return jsonResponse({ error: 'Unauthorized' }, 401);
      return deleteOwnMedia(env, auth.user.id, pathname.slice('/api/media/'.length));
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
      const assetResponse = await env.ASSETS.fetch(request);
      // Bundled stickers never change under a URL (the hash is in the query), so they can be cached for a year
      if (pathname.startsWith('/stickers/') && assetResponse.ok && /\.(webp|png|gif)$/i.test(pathname)) {
        const headers = new Headers(assetResponse.headers);
        headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        headers.set('X-Content-Type-Options', 'nosniff');
        return new Response(assetResponse.body, { status: assetResponse.status, headers });
      }
      return assetResponse;
    }

      return new Response('Not Found', { status: 404 });
    } catch (err) {
      console.error('Unhandled worker error:', err);
      return jsonResponse({ error: 'Internal error' }, 500);
    }
  },
};
