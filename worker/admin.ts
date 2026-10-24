import { adminAppointSchema, adminUserStatusSchema } from '../shared/schema.ts';
import { authenticateRequest, generateRandomString, type AuthenticatedUser } from './auth.ts';
import { constantTimeCompare, jsonResponse } from './http.ts';
import type { Env } from './types.ts';

/**
 * Admin roles and moderation of people.
 *
 *  master  the owner. Set only by the bootstrap command (scripts/bootstrap-master.mts); there can only ever be one
 *          (unique index). Cannot be seen, changed, suspended or banned by anyone else.
 *  admin   appointed. Can suspend and ban ordinary accounts and can hand the admin role to someone else (hot potato).
 *  user    everyone else. No access to anything under /api/admin.
 *
 * The role is read from the database on every request, so a demoted admin is shut out immediately.
 * Hot potato: an appointed admin who names a successor stops being an admin in the very same database statement,
 * so the number of appointed admins never grows. Only the master can add an admin without losing the role.
 */

export type Role = 'user' | 'admin' | 'master';

/** What this account may do, from its stored role. Anything unexpected counts as an ordinary user. */
export function effectiveRole(user: { role?: string | null }): Role {
  return user.role === 'master' || user.role === 'admin' ? user.role : 'user';
}

/**
 * The older admin endpoints (stats, reports) also accept a signed-in admin, not only the X-Admin-Secret header.
 * Returns an error Response, or null when allowed. A header, when sent, is always judged on its own.
 */
export async function legacyAdminGate(request: Request, env: Env): Promise<Response | null> {
  const header = request.headers.get('x-admin-secret');
  if (header) {
    if (!env.ADMIN_SECRET || !constantTimeCompare(header, env.ADMIN_SECRET)) {
      return jsonResponse({ error: 'Forbidden: Invalid admin secret' }, 403);
    }
    return null;
  }
  const auth = await authenticateRequest(request, env.DB);
  if (auth && effectiveRole(auth.user) !== 'user') return null;
  const relaxed = env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test';
  if (relaxed && !env.ADMIN_SECRET) return null;
  return jsonResponse({ error: 'Unauthorized: Admin secret required' }, 401);
}

async function audit(env: Env, actorId: string, action: string, targetId: string | null, detail: string | null): Promise<void> {
  await env.DB.prepare('INSERT INTO admin_actions (id, actor_id, action, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(`act_${generateRandomString(12).toLowerCase().replace(/[^a-z0-9]/g, '')}`, actorId, action, targetId, detail, new Date().toISOString())
    .run();
}

interface TargetRow {
  id: string;
  role: string;
  status: string;
  username: string;
}

async function loadTarget(env: Env, id: string): Promise<TargetRow | null> {
  const row = await env.DB.prepare(
    `SELECT u.id, u.role, u.status, pr.username
     FROM users u JOIN profiles pr ON pr.user_id = u.id
     WHERE u.id = ?`
  )
    .bind(id)
    .first<TargetRow>();
  // The master does not exist as far as anyone else can tell
  if (!row || row.role === 'master') return null;
  return row;
}

/**
 * Handles the people-moderation routes. Returns null when the path is not one of them.
 * These always need a signed-in admin or master (they act as someone, for the hot-potato rule and the log);
 * the X-Admin-Secret header does not open them.
 */
export async function handleAdminRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  const { pathname } = url;
  const method = request.method;

  const isPeople = pathname === '/api/admin/users' && method === 'GET';
  const isStatus = /^\/api\/admin\/users\/[^/]+\/status$/.test(pathname) && method === 'POST';
  const isAppoint = pathname === '/api/admin/appoint' && method === 'POST';
  const isPreview = /^\/api\/admin\/reports\/[^/]+\/preview$/.test(pathname) && method === 'GET';
  const isLog = pathname === '/api/admin/actions' && method === 'GET';
  const isDisputes = pathname === '/api/admin/disputes' && method === 'GET';
  const isDisputeResolve = /^\/api\/admin\/disputes\/[^/]+\/resolve$/.test(pathname) && method === 'POST';
  if (!isPeople && !isStatus && !isAppoint && !isPreview && !isLog && !isDisputes && !isDisputeResolve) return null;

  const auth = await authenticateRequest(request, env.DB);
  if (!auth) return jsonResponse({ error: 'Unauthorized' }, 401);
  const role = effectiveRole(auth.user);
  if (role === 'user') return jsonResponse({ error: 'Forbidden: Admin access required' }, 403);

  if (isPeople) return listPeople(env, url);
  if (isLog) return listActions(env);
  if (isDisputes) return listDisputes(env);
  if (isDisputeResolve) return resolveDispute(request, env, auth, decodeURIComponent(pathname.split('/')[4]!));
  if (isPreview) return reportPreview(env, decodeURIComponent(pathname.split('/')[4]!));
  if (isStatus) return changeStatus(request, env, auth, role, decodeURIComponent(pathname.split('/')[4]!));
  return appoint(request, env, auth, role);
}

async function listPeople(env: Env, url: URL): Promise<Response> {
  const q = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 40);
  const params: unknown[] = [];
  let where = "u.role != 'master'";
  if (q) {
    where += " AND pr.username_normalized LIKE ? ESCAPE '\\'";
    params.push(`${q.replace(/[\\%_]/g, '\\$&')}%`);
  }
  const rows = await env.DB.prepare(
    `SELECT u.id, u.role, u.status, u.created_at, pr.username, pr.display_name
     FROM users u JOIN profiles pr ON pr.user_id = u.id
     WHERE ${where}
     ORDER BY pr.username_normalized ASC
     LIMIT 100`
  )
    .bind(...params)
    .all();
  return jsonResponse({ users: rows.results || [] });
}

async function changeStatus(request: Request, env: Env, auth: AuthenticatedUser, role: Role, targetId: string): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = adminUserStatusSchema.safeParse(body);
  if (!parsed.success) return jsonResponse({ error: 'Validation failed', issues: parsed.error.issues }, 400);
  const { status: next, reason } = parsed.data;

  if (targetId === auth.user.id) return jsonResponse({ error: 'You cannot change your own account' }, 400);
  const target = await loadTarget(env, targetId);
  if (!target) return jsonResponse({ error: 'User not found' }, 404);

  if (target.role === 'admin' && role !== 'master') {
    return jsonResponse({ error: 'Only the master admin can act on another admin' }, 403);
  }
  if (target.status === 'banned' && next === 'active' && role !== 'master') {
    return jsonResponse({ error: 'Only the master admin can reinstate a banned account' }, 403);
  }
  if (target.status === next) return jsonResponse({ success: true, id: target.id, status: next, changed: false });

  const statements = [
    // A suspended or banned admin is no longer an admin; the master can appoint them again later
    env.DB.prepare(
      "UPDATE users SET status = ?, role = CASE WHEN ? = 'active' THEN role ELSE 'user' END WHERE id = ? AND role != 'master'"
    ).bind(next, next, target.id),
  ];
  if (next !== 'active') {
    statements.push(env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target.id)); // locked out right away
  }
  if (next === 'banned') {
    statements.push(env.DB.prepare("UPDATE posts SET status = 'removed' WHERE author_id = ? AND status = 'active'").bind(target.id));
  }
  await env.DB.batch(statements);
  await audit(env, auth.user.id, `status:${next}`, target.id, reason ?? null);

  return jsonResponse({ success: true, id: target.id, status: next, changed: true });
}

async function appoint(request: Request, env: Env, auth: AuthenticatedUser, role: Role): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = adminAppointSchema.safeParse(body);
  if (!parsed.success) return jsonResponse({ error: 'Validation failed', issues: parsed.error.issues }, 400);
  const targetId = parsed.data.user_id;

  if (targetId === auth.user.id) return jsonResponse({ error: 'You cannot appoint yourself' }, 400);
  const target = await loadTarget(env, targetId);
  if (!target) return jsonResponse({ error: 'User not found' }, 404);
  if (target.status !== 'active') return jsonResponse({ error: 'Only an active account can be made an admin' }, 409);
  if (target.role === 'admin') return jsonResponse({ error: 'That account is already an admin' }, 409);

  let changes: number;
  if (role === 'master') {
    // The master adds an admin and stays the master
    const res = await env.DB.prepare(
      "UPDATE users SET role = 'admin', appointed_by = ?, appointed_at = ? WHERE id = ? AND role = 'user' AND status = 'active'"
    )
      .bind(auth.user.id, new Date().toISOString(), target.id)
      .run();
    changes = res.meta.changes;
    if (changes !== 1) return jsonResponse({ error: 'Something changed while you were doing that, try again' }, 409);
  } else {
    // Hot potato: one statement, so both roles change together or neither does. It only applies while the appointer is
    // still an active admin and the successor is still an active plain user, checked against the data as it is right now.
    const res = await env.DB.prepare(
      `UPDATE users
       SET role = CASE WHEN id = ?1 THEN 'user' ELSE 'admin' END,
           appointed_by = CASE WHEN id = ?1 THEN NULL ELSE ?1 END,
           appointed_at = CASE WHEN id = ?1 THEN NULL ELSE ?3 END
       WHERE id IN (?1, ?2)
         AND (SELECT COUNT(*) FROM users
              WHERE (id = ?1 AND role = 'admin' AND status = 'active')
                 OR (id = ?2 AND role = 'user' AND status = 'active')) = 2`
    )
      .bind(auth.user.id, target.id, new Date().toISOString())
      .run();
    changes = res.meta.changes;
    if (changes !== 2) return jsonResponse({ error: 'Something changed while you were doing that, try again' }, 409);
  }

  await audit(env, auth.user.id, role === 'master' ? 'appoint' : 'appoint:handover', target.id, null);
  return jsonResponse({ success: true, target_id: target.id, your_role: role === 'master' ? 'master' : 'user' });
}

async function listActions(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT a.id, a.action, a.detail, a.created_at,
            a.actor_id, ap.username AS actor_username, au.role AS actor_role,
            a.target_id, tp.username AS target_username
     FROM admin_actions a
     LEFT JOIN users au ON au.id = a.actor_id
     LEFT JOIN profiles ap ON ap.user_id = a.actor_id
     LEFT JOIN profiles tp ON tp.user_id = a.target_id
     ORDER BY a.created_at DESC
     LIMIT 50`
  ).all();
  // The master's own name is not shown to appointed admins
  const actions = (rows.results || []).map(({ actor_role, ...r }) =>
    actor_role === 'master' ? { ...r, actor_id: null, actor_username: 'master admin' } : r
  );
  return jsonResponse({ actions });
}

/** What a report is about, so an admin can judge it without leaving the page. */
async function reportPreview(env: Env, reportId: string): Promise<Response> {
  const report = await env.DB.prepare('SELECT id, target_type, target_id FROM reports WHERE id = ?')
    .bind(reportId)
    .first<{ id: string; target_type: string; target_id: string }>();
  if (!report) return jsonResponse({ error: 'Report not found' }, 404);

  let row: { text: string | null; author_id: string | null; author_username: string | null; status: string | null } | null = null;
  if (report.target_type === 'post') {
    row = await env.DB.prepare(
      `SELECT p.body AS text, p.author_id, pr.username AS author_username, p.status
       FROM posts p LEFT JOIN profiles pr ON pr.user_id = p.author_id WHERE p.id = ?`
    ).bind(report.target_id).first();
  } else if (report.target_type === 'comment') {
    row = await env.DB.prepare(
      `SELECT c.body AS text, c.author_id, pr.username AS author_username, NULL AS status
       FROM comments c LEFT JOIN profiles pr ON pr.user_id = c.author_id WHERE c.id = ?`
    ).bind(report.target_id).first();
  } else if (report.target_type === 'message') {
    row = await env.DB.prepare(
      `SELECT m.body AS text, m.sender_id AS author_id, pr.username AS author_username, NULL AS status
       FROM messages m LEFT JOIN profiles pr ON pr.user_id = m.sender_id WHERE m.id = ?`
    ).bind(report.target_id).first();
  } else if (report.target_type === 'user') {
    row = await env.DB.prepare(
      `SELECT pr.bio AS text, pr.user_id AS author_id, pr.username AS author_username, u.status
       FROM profiles pr JOIN users u ON u.id = pr.user_id WHERE pr.user_id = ?`
    ).bind(report.target_id).first();
  }

  // The master cannot be acted on, so a report about them shows no account to act on
  const authorRole = row?.author_id
    ? (await env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(row.author_id).first<{ role: string }>())?.role
    : null;
  const authorIsMaster = authorRole === 'master';
  return jsonResponse({
    report_id: report.id,
    target_type: report.target_type,
    exists: !!row,
    text: row?.text ?? null,
    author_id: authorIsMaster ? null : row?.author_id ?? null,
    author_username: authorIsMaster ? null : row?.author_username ?? null,
    status: row?.status ?? null,
  });
}

/**
 * People who were told "this roll number is already registered at this campus". The admin sees who asked (their
 * Google email) and the username of the account that holds the roll number, so they can decide who the real student is
 * using the normal suspend / ban tools. The master account is never shown as the holder.
 */
async function listDisputes(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT d.id, d.email, d.status, d.created_at, d.resolved_at,
            (SELECT pr.username FROM user_private up
               JOIN users u ON u.id = up.user_id AND u.role != 'master'
               JOIN profiles pr ON pr.user_id = up.user_id
              WHERE up.campus_key = d.campus_key AND up.roll_key = d.roll_key) AS holder_username
     FROM registration_disputes d
     ORDER BY (d.status = 'open') DESC, d.created_at DESC
     LIMIT 100`
  ).all();
  return jsonResponse({ disputes: rows.results || [] });
}

async function resolveDispute(request: Request, env: Env, auth: AuthenticatedUser, id: string): Promise<Response> {
  let note = '';
  try {
    const body = (await request.json()) as { note?: unknown };
    if (typeof body.note === 'string') note = body.note.trim().slice(0, 500);
  } catch {
    // no body is fine: the note is optional
  }
  const res = await env.DB.prepare(
    "UPDATE registration_disputes SET status = 'resolved', resolved_at = ?, resolved_by = ?, note = ? WHERE id = ? AND status = 'open'"
  )
    .bind(new Date().toISOString(), auth.user.id, note, id)
    .run();
  if (res.meta.changes !== 1) return jsonResponse({ error: 'Not found or already resolved' }, 404);
  await audit(env, auth.user.id, 'dispute:resolved', null, note || null);
  return jsonResponse({ success: true });
}
