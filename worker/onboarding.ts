import type { D1PreparedStatement } from '@cloudflare/workers-types';
import type { Env, SignupTicketRow, CampusRow } from './types.ts';
import {
  authenticateRequest,
  generateRandomString,
  parseCookies,
  serializeCookie,
  type AuthenticatedUser,
} from './auth.ts';
import { checkRateLimit } from './rate-limit.ts';
import { jsonResponse, cookieFlags, checkAdmin } from './http.ts';
import { buildMeResponse } from './me.ts';
import {
  createCampusSchema,
  signupCompleteSchema,
  usernameSchema,
  type CampusItem,
  type SignupSessionResponse,
  type SuggestedPersonItem,
} from '../shared/schema.ts';
import { checkCampusInput, escapeLike, normalizeCampusText } from '../shared/campus.ts';
import { isReservedUsername, normalizeUsername } from '../shared/username.ts';

export const SIGNUP_TICKET_COOKIE = 'signup_ticket';
export const SIGNUP_TICKET_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PENDING_CAMPUSES = 1000;
const CAMPUS_RESULT_LIMIT = 20;

type Actor =
  | { kind: 'user'; key: string; userId: string; auth: AuthenticatedUser }
  | { kind: 'ticket'; key: string; ticket: SignupTicketRow };

function newId(prefix: string, bytes = 16): string {
  return `${prefix}_${generateRandomString(bytes).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

/** Returns the sign-up ticket named by the cookie when it exists, is unused and has not expired. */
export async function getValidSignupTicket(request: Request, env: Env): Promise<SignupTicketRow | null> {
  const id = parseCookies(request.headers.get('Cookie'))[SIGNUP_TICKET_COOKIE];
  if (!id || id.length > 100) return null;
  const row = await env.DB.prepare('SELECT * FROM signup_tickets WHERE id = ?').bind(id).first<SignupTicketRow>();
  if (!row || row.used_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

/** Someone signed in (session) or in the middle of signing up (ticket). */
async function resolveActor(request: Request, env: Env): Promise<Actor | null> {
  const auth = await authenticateRequest(request, env.DB);
  if (auth) return { kind: 'user', key: auth.user.id, userId: auth.user.id, auth };
  const ticket = await getValidSignupTicket(request, env);
  if (ticket) return { kind: 'ticket', key: `ticket:${ticket.id}`, ticket };
  return null;
}

function isUniqueViolation(err: unknown): string | null {
  const msg = String((err as Error)?.message || err || '');
  const lower = msg.toLowerCase();
  const code = (err as { code?: string })?.code;
  if (lower.includes('unique') || code === 'SQLITE_CONSTRAINT' || code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return lower;
  }
  return null;
}

function toCampusItem(row: Pick<CampusRow, 'id' | 'name' | 'city' | 'status'>): CampusItem {
  return { id: row.id, name: row.name, city: row.city, status: row.status };
}

/** A campus can be chosen if it is approved, or if this actor is one of the people who requested it. */
export async function campusSelectableBy(env: Env, campusId: string, actorKey: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM campuses c
     WHERE c.id = ?
       AND (c.status = 'approved'
            OR EXISTS (SELECT 1 FROM campus_requests r WHERE r.campus_id = c.id AND r.actor_key = ?))`
  )
    .bind(campusId, actorKey)
    .first();
  return !!row;
}

export async function handleOnboardingRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method.toUpperCase();

  if (!pathname.startsWith('/api/')) return null;

  // ------------------------------------------------------------------
  // GET /api/signup/session - is the sign-up ticket still valid? (prefill data)
  // ------------------------------------------------------------------
  if (pathname === '/api/signup/session' && method === 'GET') {
    const ticket = await getValidSignupTicket(request, env);
    if (!ticket) return jsonResponse({ error: 'Sign-up session expired. Please start again.' }, 401);
    const body: SignupSessionResponse = {
      valid: true,
      suggested_name: ticket.display_name,
      email: ticket.email,
    };
    return jsonResponse(body);
  }

  // ------------------------------------------------------------------
  // POST /api/signup/complete - create the account (single D1 batch)
  // ------------------------------------------------------------------
  if (pathname === '/api/signup/complete' && method === 'POST') {
    const ticket = await getValidSignupTicket(request, env);
    if (!ticket) return jsonResponse({ error: 'Sign-up session expired. Please start again.' }, 401);

    const rate = await checkRateLimit(env.DB, `signup:${ticket.id}`, 10, 15 * 60 * 1000);
    if (!rate.allowed) {
      return jsonResponse({ error: 'Too many attempts. Please wait a moment.' }, 429, {
        'Retry-After': String(rate.retryAfterSeconds),
      });
    }

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }
    const parsed = signupCompleteSchema.safeParse(raw);
    if (!parsed.success) {
      return jsonResponse({ error: 'Validation failed', issues: parsed.error.issues }, 400);
    }
    const data = parsed.data;
    const usernameNormalized = normalizeUsername(data.username);

    if (isReservedUsername(usernameNormalized)) {
      return jsonResponse({ error: 'That username is reserved' }, 400);
    }

    const classExists = await env.DB.prepare('SELECT 1 FROM classes WHERE id = ?').bind(data.class_id).first();
    if (!classExists) return jsonResponse({ error: 'Class not found' }, 400);

    const actorKey = `ticket:${ticket.id}`;
    if (!(await campusSelectableBy(env, data.campus_id, actorKey))) {
      return jsonResponse({ error: 'Campus not found' }, 400);
    }

    const existingAccount = await env.DB.prepare('SELECT id FROM users WHERE provider_subject = ?')
      .bind(ticket.provider_subject)
      .first();
    if (existingAccount) {
      return jsonResponse({ error: 'An account already exists for this Google account. Log in instead.' }, 409);
    }

    const taken = await env.DB.prepare('SELECT 1 FROM profiles WHERE username_normalized = ?')
      .bind(usernameNormalized)
      .first();
    if (taken) return jsonResponse({ error: 'Username is already taken' }, 409);

    const now = new Date().toISOString();
    const userId = newId('usr');
    const sessionId = `sess_${generateRandomString(32)}`;
    const sessionExpiry = new Date(Date.now() + SESSION_TTL_MS).toISOString();

    const statements: D1PreparedStatement[] = [
      env.DB.prepare('INSERT INTO users (id, provider_subject, created_at, status) VALUES (?, ?, ?, ?)').bind(
        userId,
        ticket.provider_subject,
        now,
        'active'
      ),
      // Until the person picks a nickname, the display name is the username, so the real name
      // never appears in feeds, search or messages.
      env.DB.prepare(
        `INSERT INTO profiles (user_id, username, username_normalized, display_name, bio, class_id, campus_id, real_name)
         VALUES (?, ?, ?, ?, '', ?, ?, ?)`
      ).bind(userId, usernameNormalized, usernameNormalized, usernameNormalized, data.class_id, data.campus_id, data.real_name),
      env.DB.prepare('INSERT INTO user_settings (user_id) VALUES (?)').bind(userId),
      env.DB.prepare('INSERT INTO user_private (user_id, email, roll_last3) VALUES (?, ?, ?)').bind(
        userId,
        ticket.email,
        data.roll_last3
      ),
      env.DB.prepare('UPDATE campus_requests SET actor_key = ? WHERE actor_key = ?').bind(userId, actorKey),
      env.DB.prepare('UPDATE signup_tickets SET used_at = ? WHERE id = ? AND used_at IS NULL').bind(now, ticket.id),
      env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').bind(
        sessionId,
        userId,
        sessionExpiry
      ),
    ];

    try {
      await env.DB.batch(statements);
    } catch (err) {
      const unique = isUniqueViolation(err);
      if (unique) {
        if (unique.includes('provider_subject')) {
          return jsonResponse({ error: 'An account already exists for this Google account. Log in instead.' }, 409);
        }
        return jsonResponse({ error: 'Username is already taken' }, 409);
      }
      return jsonResponse({ error: 'Failed to create account' }, 500);
    }

    const me = await buildMeResponse(
      env.DB,
      { id: userId, created_at: now, status: 'active' },
      { dm_policy: 'everyone', feed_preferences: '{}' }
    );

    const flags = cookieFlags(request, env);
    const headers = new Headers();
    headers.append(
      'Set-Cookie',
      serializeCookie('session_id', sessionId, {
        path: '/',
        maxAge: SESSION_TTL_MS / 1000,
        httpOnly: true,
        secure: flags.secure,
        sameSite: flags.sameSite,
        partitioned: flags.partitioned,
      })
    );
    headers.append(
      'Set-Cookie',
      serializeCookie(SIGNUP_TICKET_COOKIE, '', {
        path: '/',
        maxAge: 0,
        httpOnly: true,
        secure: flags.secure,
        sameSite: flags.sameSite,
        partitioned: flags.partitioned,
      })
    );
    headers.set('Content-Type', 'application/json');
    return new Response(JSON.stringify({ success: true, me }), { status: 201, headers });
  }

  // ------------------------------------------------------------------
  // GET /api/username-available?u=
  // ------------------------------------------------------------------
  if (pathname === '/api/username-available' && method === 'GET') {
    const actor = await resolveActor(request, env);
    if (!actor) return jsonResponse({ error: 'Unauthorized' }, 401);

    const rate = await checkRateLimit(env.DB, `uname:${actor.key}`, 30, 60 * 1000);
    if (!rate.allowed) {
      return jsonResponse({ error: 'Too many checks. Please wait a moment.' }, 429, {
        'Retry-After': String(rate.retryAfterSeconds),
      });
    }

    const candidate = url.searchParams.get('u') ?? '';
    const parsed = usernameSchema.safeParse(candidate);
    if (!parsed.success) {
      return jsonResponse({
        available: false,
        reason: 'invalid',
        message: parsed.error.issues[0]?.message ?? 'Invalid username',
      });
    }
    const normalized = normalizeUsername(parsed.data);
    if (isReservedUsername(normalized)) {
      return jsonResponse({ available: false, reason: 'reserved', message: 'That username is reserved' });
    }
    const row = await env.DB.prepare('SELECT user_id FROM profiles WHERE username_normalized = ?')
      .bind(normalized)
      .first<{ user_id: string }>();
    const mine = actor.kind === 'user' && row?.user_id === actor.userId;
    if (row && !mine) {
      return jsonResponse({ available: false, reason: 'taken', message: 'Username is already taken' });
    }
    return jsonResponse({ available: true });
  }

  // ------------------------------------------------------------------
  // GET /api/campuses/cities
  // ------------------------------------------------------------------
  if (pathname === '/api/campuses/cities' && method === 'GET') {
    const actor = await resolveActor(request, env);
    if (!actor) return jsonResponse({ error: 'Unauthorized' }, 401);

    const rows = await env.DB.prepare(
      `SELECT MIN(city) AS city FROM campuses
       WHERE status = 'approved' AND city_normalized != ''
       GROUP BY city_normalized
       ORDER BY city_normalized ASC
       LIMIT 200`
    ).all<{ city: string }>();
    return jsonResponse({ cities: (rows.results || []).map((r) => r.city) });
  }

  // ------------------------------------------------------------------
  // GET /api/campuses?q=&city=&limit=
  // ------------------------------------------------------------------
  if (pathname === '/api/campuses' && method === 'GET') {
    const actor = await resolveActor(request, env);
    if (!actor) return jsonResponse({ error: 'Unauthorized' }, 401);

    const rate = await checkRateLimit(env.DB, `campus-search:${actor.key}`, 120, 60 * 1000);
    if (!rate.allowed) {
      return jsonResponse({ error: 'Too many searches. Please wait a moment.' }, 429, {
        'Retry-After': String(rate.retryAfterSeconds),
      });
    }

    const q = normalizeCampusText(url.searchParams.get('q') ?? '').slice(0, 80);
    const city = normalizeCampusText(url.searchParams.get('city') ?? '').slice(0, 60);
    const limitParam = Number(url.searchParams.get('limit'));
    const limit =
      Number.isFinite(limitParam) && limitParam >= 1
        ? Math.min(Math.floor(limitParam), CAMPUS_RESULT_LIMIT)
        : CAMPUS_RESULT_LIMIT;

    // Parameters are pushed in the order the placeholders appear in the SQL text.
    const params: unknown[] = [];
    let rankExpr = '0';
    let textFilter = '';
    if (q) {
      const prefix = `${escapeLike(q)}%`;
      const contains = `%${escapeLike(q)}%`;
      rankExpr = `CASE WHEN c.name_normalized LIKE ? ESCAPE '\\' THEN 0
                       WHEN c.name_normalized LIKE ? ESCAPE '\\' THEN 1
                       ELSE 2 END`;
      params.push(prefix, contains);
      textFilter = ` AND (c.name_normalized LIKE ? ESCAPE '\\' OR c.city_normalized LIKE ? ESCAPE '\\')`;
    }
    // visibility placeholder comes after the rank placeholders and before the text filter
    const visibility = `(c.status = 'approved' OR EXISTS (SELECT 1 FROM campus_requests r WHERE r.campus_id = c.id AND r.actor_key = ?))`;
    params.push(actor.key);
    if (q) {
      params.push(`%${escapeLike(q)}%`, `%${escapeLike(q)}%`);
    }
    let cityFilter = '';
    if (city) {
      cityFilter = ' AND c.city_normalized = ?';
      params.push(city);
    }
    params.push(limit);

    const rows = await env.DB.prepare(
      `SELECT c.id, c.name, c.city, c.status, ${rankExpr} AS rank
       FROM campuses c
       WHERE ${visibility}${textFilter}${cityFilter}
       ORDER BY rank ASC, c.name_normalized ASC, c.id ASC
       LIMIT ?`
    )
      .bind(...params)
      .all<Pick<CampusRow, 'id' | 'name' | 'city' | 'status'>>();

    return jsonResponse({ campuses: (rows.results || []).map(toCampusItem) });
  }

  // ------------------------------------------------------------------
  // POST /api/campuses - request a campus that is not on the list (pending until approved)
  // ------------------------------------------------------------------
  if (pathname === '/api/campuses' && method === 'POST') {
    const actor = await resolveActor(request, env);
    if (!actor) return jsonResponse({ error: 'Unauthorized' }, 401);

    const rate = await checkRateLimit(env.DB, `campus-create:${actor.key}`, 5, 60 * 60 * 1000);
    if (!rate.allowed) {
      return jsonResponse({ error: 'Too many campus requests. Please try again later.' }, 429, {
        'Retry-After': String(rate.retryAfterSeconds),
      });
    }

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }
    const parsed = createCampusSchema.safeParse(raw);
    if (!parsed.success) return jsonResponse({ error: 'Validation failed', issues: parsed.error.issues }, 400);

    const checked = checkCampusInput(parsed.data.name, parsed.data.city);
    if (!checked.ok) return jsonResponse({ error: checked.error }, 400);

    const nameNorm = normalizeCampusText(checked.name);
    const cityNorm = normalizeCampusText(checked.city);
    const now = new Date().toISOString();

    const findExisting = () =>
      env.DB.prepare(
        'SELECT id, name, city, status FROM campuses WHERE name_normalized = ? AND city_normalized = ?'
      )
        .bind(nameNorm, cityNorm)
        .first<Pick<CampusRow, 'id' | 'name' | 'city' | 'status'>>();

    let existing = await findExisting();
    if (existing) {
      if (existing.status === 'pending') {
        await env.DB.prepare('INSERT OR IGNORE INTO campus_requests (campus_id, actor_key, created_at) VALUES (?, ?, ?)')
          .bind(existing.id, actor.key, now)
          .run();
      }
      return jsonResponse({ campus: toCampusItem(existing), existing: true });
    }

    const pendingCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM campuses WHERE status = 'pending'").first<{
      n: number;
    }>();
    if (Number(pendingCount?.n ?? 0) >= MAX_PENDING_CAMPUSES) {
      return jsonResponse({ error: 'Campus requests are temporarily closed. Please try again later.' }, 429);
    }

    const id = newId('cmp');
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO campuses (id, name, name_normalized, city, city_normalized, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`
        ).bind(id, checked.name, nameNorm, checked.city, cityNorm, now),
        env.DB.prepare('INSERT INTO campus_requests (campus_id, actor_key, created_at) VALUES (?, ?, ?)').bind(
          id,
          actor.key,
          now
        ),
      ]);
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Someone created the same campus a moment ago: join their request instead.
        existing = await findExisting();
        if (existing) {
          if (existing.status === 'pending') {
            await env.DB.prepare(
              'INSERT OR IGNORE INTO campus_requests (campus_id, actor_key, created_at) VALUES (?, ?, ?)'
            )
              .bind(existing.id, actor.key, now)
              .run();
          }
          return jsonResponse({ campus: toCampusItem(existing), existing: true });
        }
      }
      return jsonResponse({ error: 'Failed to request campus' }, 500);
    }

    return jsonResponse(
      { campus: { id, name: checked.name, city: checked.city, status: 'pending' } satisfies CampusItem, existing: false },
      201
    );
  }

  // ------------------------------------------------------------------
  // GET /api/people/suggested - classmates first, then people on the same campus
  // ------------------------------------------------------------------
  if (pathname === '/api/people/suggested' && method === 'GET') {
    const auth = await authenticateRequest(request, env.DB);
    if (!auth) return jsonResponse({ error: 'Unauthorized' }, 401);

    const rate = await checkRateLimit(env.DB, `suggested:${auth.user.id}`, 30, 60 * 1000);
    if (!rate.allowed) {
      return jsonResponse({ error: 'Too many requests. Please wait a moment.' }, 429, {
        'Retry-After': String(rate.retryAfterSeconds),
      });
    }

    const limitParam = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(limitParam) && limitParam >= 1 ? Math.min(Math.floor(limitParam), 20) : 10;

    const myClass = auth.profile.class_id || null;
    const myCampus = auth.profile.campus_id || null;
    if (!myClass && !myCampus) return jsonResponse({ people: [] });

    const blockedRows = await env.DB.prepare(
      'SELECT blocked_id AS id FROM blocks WHERE blocker_id = ? UNION SELECT blocker_id AS id FROM blocks WHERE blocked_id = ?'
    )
      .bind(auth.user.id, auth.user.id)
      .all<{ id: string }>();
    const blockedIds = (blockedRows.results || []).map((r) => r.id);
    const blockedFilter = blockedIds.length
      ? ` AND p.user_id NOT IN (${blockedIds.map(() => '?').join(',')})`
      : '';

    // A value that can never equal a real id stands in for "not set".
    const NONE = '__none__';
    // Placeholder order: same_class, same_campus, self, follower, [blocked...], class, campus, limit.
    const params: unknown[] = [myClass ?? NONE, myCampus ?? NONE, auth.user.id, auth.user.id, ...blockedIds, myClass ?? NONE, myCampus ?? NONE, limit];

    const rows = await env.DB.prepare(
      `SELECT p.user_id, p.username, p.display_name, p.avatar_media_id,
              c.name AS class_name, cm.name AS campus_name,
              (p.class_id IS NOT NULL AND p.class_id = ?) AS same_class,
              (p.campus_id IS NOT NULL AND p.campus_id = ?) AS same_campus
       FROM profiles p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN classes c ON c.id = p.class_id
       LEFT JOIN campuses cm ON cm.id = p.campus_id AND cm.status = 'approved'
       WHERE u.status = 'active'
         AND p.user_id != ?
         AND p.user_id NOT IN (SELECT followed_id FROM follows WHERE follower_id = ?)${blockedFilter}
         AND ((p.class_id IS NOT NULL AND p.class_id = ?) OR (p.campus_id IS NOT NULL AND p.campus_id = ?))
       ORDER BY same_class DESC, same_campus DESC, u.created_at DESC, p.username ASC
       LIMIT ?`
    )
      .bind(...params)
      .all<{
        user_id: string;
        username: string;
        display_name: string;
        avatar_media_id: string | null;
        class_name: string | null;
        campus_name: string | null;
        same_class: number;
        same_campus: number;
      }>();

    const people: SuggestedPersonItem[] = (rows.results || []).map((r) => ({
      username: r.username,
      display_name: r.display_name,
      avatar_media_id: r.avatar_media_id,
      class_name: r.class_name,
      campus_name: r.campus_name,
      relation: Number(r.same_class) === 1 ? 'class' : 'campus',
    }));
    return jsonResponse({ people });
  }

  // ------------------------------------------------------------------
  // Admin: GET /api/admin/campuses?status=pending|approved|all
  // ------------------------------------------------------------------
  if (pathname === '/api/admin/campuses' && method === 'GET') {
    const denied = checkAdmin(request, env);
    if (denied) return denied;

    const status = url.searchParams.get('status') ?? 'pending';
    if (!['pending', 'approved', 'all'].includes(status)) {
      return jsonResponse({ error: 'status must be pending, approved or all' }, 400);
    }
    const where = status === 'all' ? '' : 'WHERE c.status = ?';
    const params = status === 'all' ? [] : [status];
    const rows = await env.DB.prepare(
      `SELECT c.id, c.name, c.city, c.status, c.created_at,
              (SELECT COUNT(*) FROM campus_requests r WHERE r.campus_id = c.id) AS requesters,
              (SELECT COUNT(*) FROM profiles p WHERE p.campus_id = c.id) AS students
       FROM campuses c
       ${where}
       ORDER BY requesters DESC, c.created_at ASC
       LIMIT 200`
    )
      .bind(...params)
      .all<CampusRow & { requesters: number; students: number }>();
    return jsonResponse({
      campuses: (rows.results || []).map((r) => ({
        ...toCampusItem(r),
        created_at: r.created_at,
        requesters: Number(r.requesters),
        students: Number(r.students),
      })),
    });
  }

  // ------------------------------------------------------------------
  // Admin: PATCH /api/admin/campuses/:id  {action: approve | merge | reject, into?}
  // ------------------------------------------------------------------
  if (pathname.startsWith('/api/admin/campuses/') && method === 'PATCH') {
    const denied = checkAdmin(request, env);
    if (denied) return denied;

    const id = decodeURIComponent(pathname.slice('/api/admin/campuses/'.length));
    if (!id || id.includes('/')) return jsonResponse({ error: 'Campus id required' }, 400);

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }
    const body = (raw && typeof raw === 'object' ? raw : {}) as { action?: unknown; into?: unknown };

    const campus = await env.DB.prepare('SELECT id, status FROM campuses WHERE id = ?')
      .bind(id)
      .first<{ id: string; status: string }>();
    if (!campus) return jsonResponse({ error: 'Campus not found' }, 404);

    if (body.action === 'approve') {
      await env.DB.batch([
        env.DB.prepare("UPDATE campuses SET status = 'approved' WHERE id = ?").bind(id),
        env.DB.prepare('DELETE FROM campus_requests WHERE campus_id = ?').bind(id),
      ]);
      return jsonResponse({ success: true, action: 'approve' });
    }

    if (body.action === 'reject') {
      // profiles.campus_id is ON DELETE SET NULL, campus_requests cascades
      await env.DB.prepare('DELETE FROM campuses WHERE id = ?').bind(id).run();
      return jsonResponse({ success: true, action: 'reject' });
    }

    if (body.action === 'merge') {
      const into = typeof body.into === 'string' ? body.into : '';
      if (!into || into === id) return jsonResponse({ error: 'into must be a different campus id' }, 400);
      const target = await env.DB.prepare('SELECT id, status FROM campuses WHERE id = ?')
        .bind(into)
        .first<{ id: string; status: string }>();
      if (!target) return jsonResponse({ error: 'Target campus not found' }, 404);
      if (target.status !== 'approved') {
        return jsonResponse({ error: 'Target campus must be approved before merging into it' }, 400);
      }
      await env.DB.batch([
        env.DB.prepare('UPDATE profiles SET campus_id = ? WHERE campus_id = ?').bind(into, id),
        env.DB.prepare('DELETE FROM campuses WHERE id = ?').bind(id),
      ]);
      return jsonResponse({ success: true, action: 'merge', into });
    }

    return jsonResponse({ error: 'action must be approve, reject or merge' }, 400);
  }

  return null;
}

/** Exported for the callback: removes stale tickets so the table cannot grow without bound. */
export async function purgeExpiredSignupTickets(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM signup_tickets WHERE expires_at < ?').bind(new Date().toISOString()).run();
}
