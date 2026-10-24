import type { Env } from './types.ts';
import { generateRandomString, parseCookies, serializeCookie } from './auth.ts';
import { checkRateLimit } from './rate-limit.ts';
import { jsonResponse, cookieFlags } from './http.ts';

export const APPEAL_COOKIE = 'appeal_ticket';
export const APPEAL_TICKET_TTL_MS = 60 * 60 * 1000;

const newId = (prefix: string) => `${prefix}_${generateRandomString(16).toLowerCase().replace(/[^a-z0-9]/g, '')}`;

/** Called when a suspended or banned account signs in: returns the Set-Cookie value that lets them send one appeal. */
export async function issueAppealTicket(request: Request, env: Env, userId: string): Promise<string> {
  const id = newId('apt');
  await env.DB.prepare('INSERT INTO appeal_tickets (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(id, userId, new Date(Date.now() + APPEAL_TICKET_TTL_MS).toISOString())
    .run();
  const flags = cookieFlags(request, env);
  return serializeCookie(APPEAL_COOKIE, id, { path: '/', maxAge: APPEAL_TICKET_TTL_MS / 1000, httpOnly: true, secure: flags.secure, sameSite: flags.sameSite });
}

async function ticketUser(request: Request, env: Env): Promise<{ userId: string; status: 'suspended' | 'banned' } | null> {
  const id = parseCookies(request.headers.get('Cookie'))[APPEAL_COOKIE];
  if (!id || id.length > 100) return null;
  const row = await env.DB.prepare(
    `SELECT t.user_id, u.status FROM appeal_tickets t JOIN users u ON u.id = t.user_id
     WHERE t.id = ? AND t.expires_at > ?`
  )
    .bind(id, new Date().toISOString())
    .first<{ user_id: string; status: string }>();
  // Someone reinstated in the meantime has nothing to appeal
  if (!row || (row.status !== 'suspended' && row.status !== 'banned')) return null;
  return { userId: row.user_id, status: row.status };
}

/** Student side: GET /api/appeals/mine and POST /api/appeals. Null when the path is not an appeal route. */
export async function handleAppealRoutes(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const method = request.method.toUpperCase();
  const isMine = pathname === '/api/appeals/mine' && method === 'GET';
  const isCreate = pathname === '/api/appeals' && method === 'POST';
  if (!isMine && !isCreate) return null;

  const who = await ticketUser(request, env);
  if (!who) return jsonResponse({ error: 'Sign in again to ask for a review.' }, 401);

  if (isMine) {
    const latest = await env.DB.prepare(
      'SELECT status, created_at, decided_at, decision_note FROM appeals WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'
    )
      .bind(who.userId)
      .first();
    return jsonResponse({ account_status: who.status, appeal: latest ?? null });
  }

  const rate = await checkRateLimit(env.DB, `appeal:${who.userId}`, 10, 24 * 60 * 60 * 1000);
  if (!rate.allowed) return jsonResponse({ error: 'Too many requests today.' }, 429, { 'Retry-After': String(rate.retryAfterSeconds) });

  let body: { message?: unknown };
  try {
    body = (await request.json()) as { message?: unknown };
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message || message.length > 500 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F<>]/.test(message) || Object.keys(body).some((k) => k !== 'message')) {
    return jsonResponse({ error: 'Write 1 to 500 characters, with no markup.' }, 400);
  }
  try {
    await env.DB.prepare('INSERT INTO appeals (id, user_id, message, account_status, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(newId('apl'), who.userId, message, who.status, new Date().toISOString())
      .run();
  } catch (err) {
    if (/unique/i.test(String((err as Error)?.message))) return jsonResponse({ error: 'You already have a request waiting for review.' }, 409);
    return jsonResponse({ error: 'Could not send your request' }, 500);
  }
  return jsonResponse({ success: true }, 201);
}

/** Admin side. */
export async function listAppeals(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT a.id, a.user_id, a.message, a.status, a.account_status, a.created_at, a.decided_at, a.decision_note,
            pr.username
     FROM appeals a JOIN users u ON u.id = a.user_id AND u.role != 'master' JOIN profiles pr ON pr.user_id = a.user_id
     ORDER BY (a.status = 'open') DESC, a.created_at DESC LIMIT 100`
  ).all();
  return jsonResponse({ appeals: rows.results || [] });
}

export interface DecideResult { response: Response; reinstated?: string }

export async function decideAppeal(
  env: Env,
  actorId: string,
  actorIsMaster: boolean,
  appealId: string,
  body: { decision?: unknown; note?: unknown }
): Promise<DecideResult> {
  const decision = body.decision === 'granted' || body.decision === 'denied' ? body.decision : null;
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
  if (!decision) return { response: jsonResponse({ error: 'decision must be granted or denied' }, 400) };
  const appeal = await env.DB.prepare(
    `SELECT a.id, a.user_id, a.status, u.status AS user_status, u.role FROM appeals a JOIN users u ON u.id = a.user_id WHERE a.id = ?`
  )
    .bind(appealId)
    .first<{ id: string; user_id: string; status: string; user_status: string; role: string }>();
  if (!appeal || appeal.role === 'master') return { response: jsonResponse({ error: 'Appeal not found' }, 404) };
  if (appeal.status !== 'open') return { response: jsonResponse({ error: 'Already decided' }, 409) };
  // Same rule as everywhere else: only the master reinstates a banned account
  if (decision === 'granted' && appeal.user_status === 'banned' && !actorIsMaster) {
    return { response: jsonResponse({ error: 'Only the master admin can reinstate a banned account' }, 403) };
  }
  const now = new Date().toISOString();
  const statements = [
    env.DB.prepare("UPDATE appeals SET status = ?, decided_at = ?, decided_by = ?, decision_note = ? WHERE id = ? AND status = 'open'").bind(decision, now, actorId, note, appeal.id),
  ];
  if (decision === 'granted') {
    statements.push(env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ? AND role != 'master'").bind(appeal.user_id));
  }
  await env.DB.batch(statements);
  return { response: jsonResponse({ success: true, decision }), reinstated: decision === 'granted' ? appeal.user_id : undefined };
}
