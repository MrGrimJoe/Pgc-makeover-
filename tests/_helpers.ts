import worker from '../worker/index.ts';
import { createSqliteD1 } from '../worker/db/sqlite-d1.ts';
import { createMemoryR2Bucket } from '../worker/db/r2-shim.ts';
import { runMigrations, ALL_MIGRATIONS } from '../worker/db/migrate.ts';
import type { Env } from '../worker/types.ts';

export async function makeEnv(overrides: Partial<Env> = {}): Promise<Env> {
  const db = createSqliteD1(':memory:');
  await runMigrations(db, ALL_MIGRATIONS);
  return {
    DB: db,
    MEDIA_BUCKET: createMemoryR2Bucket(),
    APP_URL: 'http://localhost:3000',
    GOOGLE_CLIENT_ID: 'test-google-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
    ENVIRONMENT: 'development',
    ...overrides,
  };
}

export interface CallOptions {
  cookie?: string;
  json?: unknown;
  raw?: string;
  headers?: Record<string, string>;
}

export interface CallResult {
  status: number;
  json: any;
  text: string;
  headers: Headers;
}

export async function call(env: Env, method: string, path: string, opts: CallOptions = {}): Promise<CallResult> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cookie) headers.Cookie = opts.cookie;
  let body = opts.raw;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers['Content-Type'] = 'application/json';
  }
  const res = await worker.fetch(new Request(`http://localhost:3000${path}`, { method, headers, body }), env);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, json, text, headers: res.headers };
}

const FAR_FUTURE = () => new Date(Date.now() + 86_400_000).toISOString();

export async function seedClassCampus(env: Env) {
  // classes are seeded by migration 003: cls_2026, cls_2027, ...
  const now = new Date().toISOString();
  const campuses: Array<[string, string, string, string]> = [
    ['cmp_x', 'Central Campus', 'Lahore', 'approved'],
    ['cmp_y', 'North Campus', 'Karachi', 'approved'],
  ];
  for (const [id, name, city, status] of campuses) {
    await env.DB.prepare(
      'INSERT INTO campuses (id, name, name_normalized, city, city_normalized, status, created_at) VALUES (?,?,?,?,?,?,?)'
    )
      .bind(id, name, name.toLowerCase(), city, city.toLowerCase(), status, now)
      .run();
  }
}

export interface SeedUserOptions {
  classId?: string | null;
  campusId?: string | null;
  realName?: string | null;
  dmPolicy?: string;
}

/** Inserts a user, profile, settings and session directly. Returns the session cookie. */
export async function seedUser(env: Env, id: string, username: string, opts: SeedUserOptions = {}): Promise<string> {
  const now = new Date().toISOString();
  await env.DB.prepare('INSERT INTO users (id, provider_subject, created_at, status) VALUES (?,?,?,?)')
    .bind(id, `sub_${id}`, now, 'active')
    .run();
  await env.DB.prepare(
    'INSERT INTO profiles (user_id, username, username_normalized, display_name, bio, class_id, campus_id, real_name) VALUES (?,?,?,?,?,?,?,?)'
  )
    .bind(id, username, username, username, '', opts.classId ?? null, opts.campusId ?? null, opts.realName ?? null)
    .run();
  await env.DB.prepare('INSERT INTO user_settings (user_id, dm_policy) VALUES (?,?)')
    .bind(id, opts.dmPolicy ?? 'everyone')
    .run();
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)')
    .bind(`sess_${id}`, id, FAR_FUTURE())
    .run();
  return `session_id=sess_${id}`;
}

/** Runs the real OAuth flow (mock Google) with intent=signup and returns the sign-up ticket cookie. */
export async function startSignup(
  env: Env,
  opts: { sub?: string; email?: string; name?: string } = {}
): Promise<{ cookie: string; ticketId: string; location: string | null }> {
  const sub = opts.sub ?? 's1';
  const email = opts.email ?? 'stu.dent@gmail.com';
  const name = opts.name ?? 'Stu Dent';
  const init = await worker.fetch(
    new Request(
      `http://localhost:3000/api/auth/google?mock=true&intent=signup&mock_sub=${encodeURIComponent(sub)}` +
        `&mock_email=${encodeURIComponent(email)}&mock_name=${encodeURIComponent(name)}`
    ),
    env
  );
  const location = init.headers.get('Location')!;
  const oauth = /oauth_state=([^;]+)/.exec(init.headers.get('Set-Cookie') ?? '')![1]!;
  const cb = await worker.fetch(
    new Request(`http://localhost:3000${location}`, { headers: { Cookie: `oauth_state=${oauth}` } }),
    env
  );
  const ticketId = /signup_ticket=([^;]+)/.exec(cb.headers.get('Set-Cookie') ?? '')?.[1] ?? '';
  return { cookie: `signup_ticket=${ticketId}`, ticketId, location: cb.headers.get('Location') };
}

/** Collects every key name in a JSON value, at any depth. */
export function deepKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((v) => deepKeys(v, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      deepKeys(v, out);
    }
  }
  return out;
}
