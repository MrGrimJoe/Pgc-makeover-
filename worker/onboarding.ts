import type { D1PreparedStatement } from '@cloudflare/workers-types';
import type { Env, SignupTicketRow } from './types.ts';
import {
  authenticateRequest,
  generateRandomString,
  parseCookies,
  serializeCookie,
  type AuthenticatedUser,
} from './auth.ts';
import { checkRateLimit } from './rate-limit.ts';
import { jsonResponse, cookieFlags } from './http.ts';
import { buildMeResponse } from './me.ts';
import {
  signupCompleteSchema,
  usernameSchema,
  type SignupSessionResponse,
  type SuggestedPersonItem,
} from '../shared/schema.ts';
import { findCampus, campusName, cleanCampusOther } from '../shared/campus.ts';
import { isReservedUsername, normalizeUsername } from '../shared/username.ts';
import { barcodeMatchesRoll, campusKey, normalizeRoll, rollLast3 } from '../shared/roll.ts';
import { computeRollKey } from './roll-key.ts';
import { turnstileEnabled, verifyTurnstile } from './turnstile.ts';

export const SIGNUP_TICKET_COOKIE = 'signup_ticket';
export const SIGNUP_TICKET_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
      card_scan: 'required',
      ...(turnstileEnabled(env) ? { turnstile_site_key: env.TURNSTILE_SITE_KEY } : {}),
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

    if (data.campus_id && !findCampus(data.campus_id)) {
      return jsonResponse({ error: 'Campus not found' }, 400);
    }
    // Free-text campus gets the same cleaning as everywhere else (2 to 80 characters, no markup).
    let campusOther: string | null = null;
    if (data.campus_other !== undefined) {
      campusOther = cleanCampusOther(data.campus_other);
      if (!campusOther) return jsonResponse({ error: 'Other campus must be 2 to 80 characters with no markup' }, 400);
    }

    // Bot check, before anything is looked up or written
    if (!(await verifyTurnstile(env, data.turnstile_token, request.headers.get('CF-Connecting-IP')))) {
      return jsonResponse({ error: 'The security check did not pass. Reload the check and try again.', code: 'turnstile_failed' }, 403);
    }

    // ---- Student identity: roll number + campus, and what the card said ----
    const dayLimit = await checkRateLimit(env.DB, `signup-roll:${ticket.provider_subject}`, 20, 24 * 60 * 60 * 1000);
    if (!dayLimit.allowed) {
      return jsonResponse({ error: 'Too many attempts today. Please try again tomorrow.' }, 429, {
        'Retry-After': String(dayLimit.retryAfterSeconds),
      });
    }
    const rollNormalized = normalizeRoll(data.roll_number);
    const regKey = campusKey(data.campus_id, campusOther);
    const rollKey = await computeRollKey(env, regKey, rollNormalized);
    if (!rollKey) return jsonResponse({ error: 'Sign-up is not available right now. Please try again later.' }, 503);

    let verificationStatus: 'unverified' | 'provisional' = 'unverified';
    // A barcode read from a picture file is recorded as such: it is no stronger than a camera scan, and easier to copy.
    const verificationMethod = data.card?.source === 'upload' ? 'barcode-photo' : 'barcode';
    if (data.card) {
      if (!barcodeMatchesRoll(data.card.barcode, data.roll_number)) {
        return jsonResponse(
          {
            error: 'The barcode on your card does not match the roll number you typed. Check the number, or scan the card again.',
            code: 'card_mismatch',
          },
          422
        );
      }
      verificationStatus = 'provisional';
    } else {
      // Not negotiable: there is no switch to turn this off. No card, no account.
      return jsonResponse({ error: 'Scan or upload your student card to finish signing up.', code: 'card_required' }, 422);
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

    const duplicateResponse = async (): Promise<Response> => {
      // Not a ban and not an error on the student's side: keep the attempt for an administrator, reveal nothing about the other account.
      await env.DB.prepare(
        `INSERT OR IGNORE INTO registration_disputes (id, provider_subject, email, campus_key, roll_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(newId('dsp'), ticket.provider_subject, ticket.email, regKey, rollKey, new Date().toISOString())
        .run();
      return jsonResponse(
        {
          error:
            'This roll number is already registered at this campus. If it is yours, your request has been passed to an administrator who can help you get access. You have not been blocked.',
          code: 'duplicate_registration',
        },
        409
      );
    };
    const alreadyRegistered = await env.DB.prepare('SELECT 1 FROM user_private WHERE campus_key = ? AND roll_key = ?')
      .bind(regKey, rollKey)
      .first();
    if (alreadyRegistered) return duplicateResponse();

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
        `INSERT INTO profiles (user_id, username, username_normalized, display_name, bio, class_id, campus_id, campus_other, real_name)
         VALUES (?, ?, ?, ?, '', ?, ?, ?, ?)`
      ).bind(userId, usernameNormalized, usernameNormalized, usernameNormalized, data.class_id, data.campus_id ?? null, campusOther, data.real_name),
      env.DB.prepare('INSERT INTO user_settings (user_id) VALUES (?)').bind(userId),
      env.DB.prepare(
        `INSERT INTO user_private (user_id, email, roll_last3, campus_key, roll_key, verification_status, verification_method, verified_at,
                                  program, session, section, academic_confirmed_at, verification_detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        userId,
        ticket.email,
        rollLast3(rollNormalized),
        regKey,
        rollKey,
        verificationStatus,
        verificationStatus === 'provisional' ? verificationMethod : null,
        verificationStatus === 'provisional' ? now : null,
        data.program,
        data.session,
        data.section || null,
        now,
        data.card?.printed ? JSON.stringify(data.card.printed) : null
      ),
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
        if (unique.includes('roll_key')) return duplicateResponse();
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
              c.name AS class_name, p.campus_id,
              (p.class_id IS NOT NULL AND p.class_id = ?) AS same_class,
              (p.campus_id IS NOT NULL AND p.campus_id = ?) AS same_campus
       FROM profiles p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN classes c ON c.id = p.class_id
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
        campus_id: string | null;
        same_class: number;
        same_campus: number;
      }>();

    const people: SuggestedPersonItem[] = (rows.results || []).map((r) => ({
      username: r.username,
      display_name: r.display_name,
      avatar_media_id: r.avatar_media_id,
      class_name: r.class_name,
      campus_name: campusName(r.campus_id),
      relation: Number(r.same_class) === 1 ? 'class' : 'campus',
    }));
    return jsonResponse({ people });
  }


  return null;
}

/** Exported for the callback: removes stale tickets so the table cannot grow without bound. */
export async function purgeExpiredSignupTickets(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM signup_tickets WHERE expires_at < ?').bind(new Date().toISOString()).run();
}
