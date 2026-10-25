import type { Env } from './types.ts';
import { authenticateRequest } from './auth.ts';
import { jsonResponse } from './http.ts';
import { academicUpdateSchema } from '../shared/schema.ts';
import { DEFAULT_RENEWAL_DAYS, confirmationDue, programName } from '../shared/academic.ts';

export function renewalDays(env: Env): number {
  const n = Number(env.ACADEMIC_RENEWAL_DAYS);
  return Number.isFinite(n) && n >= 1 && n <= 3650 ? Math.floor(n) : DEFAULT_RENEWAL_DAYS;
}

interface Row {
  program: string | null;
  session: string | null;
  section: string | null;
  academic_status: string;
  academic_confirmed_at: string | null;
  graduated_at: string | null;
  class_id: string | null;
  class_name: string | null;
}

async function load(env: Env, userId: string): Promise<Row | null> {
  return env.DB.prepare(
    `SELECT up.program, up.session, up.section, up.academic_status, up.academic_confirmed_at, up.graduated_at,
            p.class_id, c.name AS class_name
     FROM profiles p
     LEFT JOIN user_private up ON up.user_id = p.user_id
     LEFT JOIN classes c ON c.id = p.class_id
     WHERE p.user_id = ?`
  )
    .bind(userId)
    .first<Row>();
}

function view(env: Env, r: Row) {
  const status = r.academic_status === 'graduated' ? 'graduated' : 'current';
  return {
    program: r.program,
    program_name: programName(r.program),
    session: r.session,
    section: r.section,
    class_id: r.class_id,
    class_name: r.class_name,
    status,
    confirmed_at: r.academic_confirmed_at,
    graduated_at: r.graduated_at,
    // People who signed up before these fields existed have nothing confirmed yet, so they are asked once
    confirm_due: confirmationDue(status, r.academic_confirmed_at, Date.now(), renewalDays(env)),
    renewal_days: renewalDays(env),
  };
}

/** /api/me/academic (GET, PUT), /confirm and /graduate. Own details only; null when the path is not one of these. */
export async function handleAcademicRoutes(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith('/api/me/academic')) return null;
  const method = request.method.toUpperCase();
  const known =
    (pathname === '/api/me/academic' && (method === 'GET' || method === 'PUT')) ||
    (pathname === '/api/me/academic/confirm' && method === 'POST') ||
    (pathname === '/api/me/academic/graduate' && method === 'POST');
  if (!known) return null;

  const auth = await authenticateRequest(request, env.DB);
  if (!auth) return jsonResponse({ error: 'Unauthorized' }, 401);
  const userId = auth.user.id;
  const row = await load(env, userId);
  if (!row) return jsonResponse({ error: 'Profile not found' }, 404);

  if (method === 'GET') return jsonResponse(view(env, row));

  if (row.academic_status === 'graduated') {
    return jsonResponse({ error: 'This account is marked as graduated. Its posts and messages are kept.' }, 409);
  }
  const now = new Date().toISOString();

  if (pathname.endsWith('/confirm')) {
    await env.DB.prepare(
      `INSERT INTO user_private (user_id, academic_confirmed_at) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET academic_confirmed_at = excluded.academic_confirmed_at`
    ).bind(userId, now).run();
  } else if (pathname.endsWith('/graduate')) {
    // Status and class change together; nothing the student posted or sent is touched.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user_private (user_id, academic_status, graduated_at, academic_confirmed_at) VALUES (?, 'graduated', ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET academic_status = 'graduated', graduated_at = excluded.graduated_at, academic_confirmed_at = excluded.academic_confirmed_at`
      ).bind(userId, now, now),
      env.DB.prepare("UPDATE profiles SET class_id = 'cls_alumni' WHERE user_id = ? AND EXISTS (SELECT 1 FROM classes WHERE id = 'cls_alumni')").bind(userId),
    ]);
  } else {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }
    const parsed = academicUpdateSchema.safeParse(raw);
    if (!parsed.success) return jsonResponse({ error: 'Validation failed', issues: parsed.error.issues }, 400);
    const d = parsed.data;
    const cls = await env.DB.prepare('SELECT id FROM classes WHERE id = ?').bind(d.class_id).first();
    if (!cls) return jsonResponse({ error: 'Class not found' }, 400);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user_private (user_id, program, session, section, academic_confirmed_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET program = excluded.program, session = excluded.session, section = excluded.section, academic_confirmed_at = excluded.academic_confirmed_at`
      ).bind(userId, d.program, d.session, d.section || null, now),
      env.DB.prepare('UPDATE profiles SET class_id = ? WHERE user_id = ?').bind(d.class_id, userId),
    ]);
  }
  const fresh = await load(env, userId);
  return jsonResponse(view(env, fresh!));
}
