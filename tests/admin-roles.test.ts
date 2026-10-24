import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../worker/index.ts';
import { createSqliteD1 } from '../worker/db/sqlite-d1.ts';
import { createMemoryR2Bucket } from '../worker/db/r2-shim.ts';
import { ALL_MIGRATIONS, runMigrations } from '../worker/db/migrate.ts';
import { effectiveRole } from '../worker/admin.ts';
import type { Env } from '../worker/types.ts';

const BASE = 'http://localhost:3000';

describe('admin roles: master, appointed admins (hot potato), standard users', () => {
  let env: Env;
  const cookies: Record<string, string> = {};

  const seed = async (id: string, username: string, opts: { role?: string; status?: string } = {}) => {
    const now = new Date().toISOString();
    await env.DB.prepare('INSERT INTO users (id, provider_subject, created_at, status, role) VALUES (?, ?, ?, ?, ?)')
      .bind(id, `sub_${id}`, now, opts.status ?? 'active', opts.role ?? 'user').run();
    await env.DB.prepare('INSERT INTO profiles (user_id, username, username_normalized, display_name, bio) VALUES (?, ?, ?, ?, ?)')
      .bind(id, username, username.toLowerCase(), username, `bio of ${username}`).run();
    await env.DB.prepare('INSERT INTO user_settings (user_id) VALUES (?)').bind(id).run();
    await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(`sess_${id}`, id, new Date(Date.now() + 86400000).toISOString()).run();
    cookies[id] = `session_id=sess_${id}`;
  };

  const call = (as: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    worker.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: { ...(as ? { Cookie: cookies[as]! } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      }),
      env
    );
  const roleOf = async (id: string) => (await env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(id).first<{ role: string }>())!.role;
  const statusOf = async (id: string) => (await env.DB.prepare('SELECT status FROM users WHERE id = ?').bind(id).first<{ status: string }>())!.status;

  beforeEach(async () => {
    const db = createSqliteD1(':memory:');
    await runMigrations(db, ALL_MIGRATIONS);
    env = {
      DB: db,
      MEDIA_BUCKET: createMemoryR2Bucket(),
      APP_URL: BASE,
      GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'secret',
      ENVIRONMENT: 'production',
      ADMIN_SECRET: 'super-admin-secret-test-key-12345',
    };
    await seed('usr_master', 'owner', { role: 'master' }); // what the bootstrap command leaves behind
    await seed('usr_admin1', 'admin1', { role: 'admin' });
    await seed('usr_admin2', 'admin2', { role: 'admin' });
    await seed('usr_u1', 'userone');
    await seed('usr_u2', 'usertwo');
    await seed('usr_u3', 'userthree');
  });

  describe('who is what', () => {
    it('the role comes from the stored value; anything unexpected counts as an ordinary user', () => {
      expect(effectiveRole({ role: 'master' })).toBe('master');
      expect(effectiveRole({ role: 'admin' })).toBe('admin');
      expect(effectiveRole({ role: 'user' })).toBe('user');
      expect(effectiveRole({ role: 'owner' })).toBe('user');
      expect(effectiveRole({ role: null })).toBe('user');
      expect(effectiveRole({})).toBe('user');
    });

    it('/api/me tells each person their own role', async () => {
      const role = async (id: string) => ((await (await call(id, 'GET', '/api/me')).json()) as { role: string }).role;
      expect(await role('usr_master')).toBe('master');
      expect(await role('usr_admin1')).toBe('admin');
      expect(await role('usr_u1')).toBe('user');
    });
  });

  describe('standard users are shut out', () => {
    it('no session is 401 and a standard user is 403 on every new admin route', async () => {
      const routes: Array<[string, string, unknown?]> = [
        ['GET', '/api/admin/users'],
        ['GET', '/api/admin/actions'],
        ['GET', '/api/admin/reports/rep_x/preview'],
        ['POST', '/api/admin/users/usr_u2/status', { status: 'banned' }],
        ['POST', '/api/admin/appoint', { user_id: 'usr_u2' }],
      ];
      for (const [method, path, body] of routes) {
        expect((await call(null, method, path, body)).status, `${method} ${path} signed out`).toBe(401);
        expect((await call('usr_u1', method, path, body)).status, `${method} ${path} as user`).toBe(403);
      }
      expect(await statusOf('usr_u2')).toBe('active');
      expect(await roleOf('usr_u2')).toBe('user');
    });

    it('the secret header does not open the people routes (they need someone to act as)', async () => {
      const res = await call(null, 'GET', '/api/admin/users', undefined, { 'x-admin-secret': env.ADMIN_SECRET! });
      expect(res.status).toBe(401);
    });
  });

  describe('older endpoints also accept a signed-in admin', () => {
    it('admin and master get stats without the header; a standard user still gets 401; the header still works', async () => {
      expect((await call('usr_admin1', 'GET', '/api/admin/stats')).status).toBe(200);
      expect((await call('usr_master', 'GET', '/api/admin/stats')).status).toBe(200);
      expect((await call('usr_u1', 'GET', '/api/admin/stats')).status).toBe(401);
      expect((await call(null, 'GET', '/api/admin/stats')).status).toBe(401);
      expect((await call(null, 'GET', '/api/admin/stats', undefined, { 'x-admin-secret': env.ADMIN_SECRET! })).status).toBe(200);
      expect((await call('usr_admin1', 'GET', '/api/admin/stats', undefined, { 'x-admin-secret': 'wrong' })).status).toBe(403);
    });
  });

  describe('the directory never shows the master', () => {
    it('lists everyone else, can search by username start, and leaves the master out for admin and master alike', async () => {
      for (const who of ['usr_admin1', 'usr_master']) {
        const body = (await (await call(who, 'GET', '/api/admin/users')).json()) as { users: Array<{ id: string; username: string; role: string }> };
        const ids = body.users.map((u) => u.id);
        expect(ids).not.toContain('usr_master');
        expect(ids).toEqual(expect.arrayContaining(['usr_admin1', 'usr_admin2', 'usr_u1', 'usr_u2', 'usr_u3']));
        expect(JSON.stringify(body)).not.toContain('owner');
      }
      const q = (await (await call('usr_admin1', 'GET', '/api/admin/users?q=user')).json()) as { users: Array<{ id: string }> };
      expect(q.users.map((u) => u.id).sort()).toEqual(['usr_u1', 'usr_u2', 'usr_u3']);
      const none = (await (await call('usr_admin1', 'GET', '/api/admin/users?q=owner')).json()) as { users: unknown[] };
      expect(none.users).toEqual([]);
    });

    it('there can never be a second master, whatever tries to write one', async () => {
      await expect(env.DB.prepare("UPDATE users SET role = 'master' WHERE id = 'usr_u1'").run()).rejects.toThrow();
      expect(await roleOf('usr_u1')).toBe('user');
      expect(((await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'master'").first<{ n: number }>())!.n)).toBe(1);
    });
  });

  describe('the master is immune', () => {
    it('nobody else can suspend, ban, reinstate or appoint the master, and it looks like the account does not exist', async () => {
      for (const who of ['usr_admin1', 'usr_admin2']) {
        for (const status of ['suspended', 'banned', 'active']) {
          const res = await call(who, 'POST', '/api/admin/users/usr_master/status', { status });
          expect(res.status, `${who} ${status}`).toBe(404);
        }
        expect((await call(who, 'POST', '/api/admin/appoint', { user_id: 'usr_master' })).status).toBe(404);
      }
      expect(await statusOf('usr_master')).toBe('active');
      expect(await roleOf('usr_admin1')).toBe('admin'); // a failed handover to the master demotes nobody
    });

    it('the master cannot be demoted through a hand-over either, and cannot act on themselves', async () => {
      expect((await call('usr_master', 'POST', '/api/admin/users/usr_master/status', { status: 'banned' })).status).toBe(400);
      expect((await call('usr_master', 'POST', '/api/admin/appoint', { user_id: 'usr_master' })).status).toBe(400);
      expect(await statusOf('usr_master')).toBe('active');
    });

    it('a report about the master shows no account to act on', async () => {
      await env.DB.prepare("INSERT INTO reports (id, reporter_id, target_type, target_id, reason, status, created_at) VALUES ('rep_m', 'usr_u1', 'user', 'usr_master', 'rude', 'pending', ?)")
        .bind(new Date().toISOString()).run();
      const body = (await (await call('usr_admin1', 'GET', '/api/admin/reports/rep_m/preview')).json()) as { author_id: string | null; author_username: string | null };
      expect(body.author_id).toBeNull();
      expect(body.author_username).toBeNull();
    });

    it('the activity log shows the master only as "master admin"', async () => {
      await call('usr_master', 'POST', '/api/admin/users/usr_u1/status', { status: 'suspended', reason: 'spam' });
      const body = (await (await call('usr_admin1', 'GET', '/api/admin/actions')).json()) as { actions: Array<{ actor_id: string | null; actor_username: string; action: string; target_username: string }> };
      expect(body.actions[0]).toMatchObject({ actor_id: null, actor_username: 'master admin', action: 'status:suspended', target_username: 'userone' });
    });
  });

  describe('suspend, ban and reinstate', () => {
    it('suspending locks the person out at once (their sessions are deleted) and is logged with the reason', async () => {
      const res = await call('usr_admin1', 'POST', '/api/admin/users/usr_u1/status', { status: 'suspended', reason: 'spamming' });
      expect(res.status).toBe(200);
      expect(await statusOf('usr_u1')).toBe('suspended');
      expect((await call('usr_u1', 'GET', '/api/me')).status).toBe(401);
      const log = await env.DB.prepare("SELECT actor_id, action, target_id, detail FROM admin_actions WHERE target_id = 'usr_u1'").first();
      expect(log).toMatchObject({ actor_id: 'usr_admin1', action: 'status:suspended', target_id: 'usr_u1', detail: 'spamming' });
    });

    it('an appointed admin can reinstate a suspended account but only the master can reinstate a banned one', async () => {
      await call('usr_admin1', 'POST', '/api/admin/users/usr_u1/status', { status: 'suspended' });
      expect((await call('usr_admin2', 'POST', '/api/admin/users/usr_u1/status', { status: 'active' })).status).toBe(200);
      expect(await statusOf('usr_u1')).toBe('active');

      await call('usr_admin1', 'POST', '/api/admin/users/usr_u2/status', { status: 'banned' });
      expect((await call('usr_admin2', 'POST', '/api/admin/users/usr_u2/status', { status: 'active' })).status).toBe(403);
      expect(await statusOf('usr_u2')).toBe('banned');
      expect((await call('usr_master', 'POST', '/api/admin/users/usr_u2/status', { status: 'active' })).status).toBe(200);
      expect(await statusOf('usr_u2')).toBe('active');
    });

    it('banning also takes the person\'s posts out of circulation', async () => {
      const now = new Date().toISOString();
      const later = new Date(Date.now() + 86400000).toISOString();
      await env.DB.prepare("INSERT INTO posts (id, author_id, body, created_at, expires_at, status) VALUES ('post_1', 'usr_u3', 'hello', ?, ?, 'active')").bind(now, later).run();
      await call('usr_admin1', 'POST', '/api/admin/users/usr_u3/status', { status: 'suspended' });
      expect((await env.DB.prepare("SELECT status FROM posts WHERE id = 'post_1'").first<{ status: string }>())!.status).toBe('active'); // suspension is temporary
      await call('usr_admin1', 'POST', '/api/admin/users/usr_u3/status', { status: 'banned' });
      expect((await env.DB.prepare("SELECT status FROM posts WHERE id = 'post_1'").first<{ status: string }>())!.status).toBe('removed');
    });

    it('an appointed admin cannot act on another admin or on themselves; the master can, and that ends the admin role', async () => {
      expect((await call('usr_admin1', 'POST', '/api/admin/users/usr_admin2/status', { status: 'banned' })).status).toBe(403);
      expect((await call('usr_admin1', 'POST', '/api/admin/users/usr_admin1/status', { status: 'banned' })).status).toBe(400);
      expect(await statusOf('usr_admin2')).toBe('active');
      expect((await call('usr_master', 'POST', '/api/admin/users/usr_admin2/status', { status: 'suspended' })).status).toBe(200);
      expect(await roleOf('usr_admin2')).toBe('user');
      await call('usr_master', 'POST', '/api/admin/users/usr_admin2/status', { status: 'active' });
      expect(await roleOf('usr_admin2')).toBe('user'); // reinstated as an ordinary account
    });

    it('rejects an unknown status, extra fields and unknown people', async () => {
      expect((await call('usr_admin1', 'POST', '/api/admin/users/usr_u1/status', { status: 'deleted' })).status).toBe(400);
      expect((await call('usr_admin1', 'POST', '/api/admin/users/usr_u1/status', { status: 'banned', role: 'master' })).status).toBe(400);
      expect((await call('usr_admin1', 'POST', '/api/admin/users/usr_nobody/status', { status: 'banned' })).status).toBe(404);
      expect(await statusOf('usr_u1')).toBe('active');
    });
  });

  describe('appointing: the master adds, an appointed admin hands over', () => {
    it('the master makes an admin and stays the master', async () => {
      const res = await call('usr_master', 'POST', '/api/admin/appoint', { user_id: 'usr_u1' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ success: true, your_role: 'master' });
      expect(await roleOf('usr_u1')).toBe('admin');
      expect(await roleOf('usr_master')).toBe('master');
      expect((await call('usr_master', 'GET', '/api/admin/users')).status).toBe(200);
    });

    it('hot potato: when an appointed admin names a successor, the successor gains the role and the appointer loses it in the same step', async () => {
      const res = await call('usr_admin1', 'POST', '/api/admin/appoint', { user_id: 'usr_u1' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ success: true, your_role: 'user' });
      expect(await roleOf('usr_u1')).toBe('admin');
      expect(await roleOf('usr_admin1')).toBe('user');
      const row = await env.DB.prepare("SELECT appointed_by, appointed_at FROM users WHERE id = 'usr_u1'").first<{ appointed_by: string; appointed_at: string }>();
      expect(row!.appointed_by).toBe('usr_admin1');
      expect(row!.appointed_at).toBeTruthy();
      const gone = await env.DB.prepare("SELECT appointed_by FROM users WHERE id = 'usr_admin1'").first<{ appointed_by: string | null }>();
      expect(gone!.appointed_by).toBeNull();
      // the old admin is shut out straight away, the new one is in
      expect((await call('usr_admin1', 'GET', '/api/admin/users')).status).toBe(403);
      expect((await call('usr_admin1', 'POST', '/api/admin/users/usr_u2/status', { status: 'banned' })).status).toBe(403);
      expect((await call('usr_u1', 'GET', '/api/admin/users')).status).toBe(200);
      const log = await env.DB.prepare("SELECT action FROM admin_actions WHERE actor_id = 'usr_admin1'").first<{ action: string }>();
      expect(log!.action).toBe('appoint:handover');
    });

    it('two hand-overs at the same time from one admin: exactly one goes through, the number of admins does not grow', async () => {
      const before = (await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").first<{ n: number }>())!.n; // admin1 and admin2
      const [a, b] = await Promise.all([
        call('usr_admin1', 'POST', '/api/admin/appoint', { user_id: 'usr_u1' }),
        call('usr_admin1', 'POST', '/api/admin/appoint', { user_id: 'usr_u2' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const after = (await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").first<{ n: number }>())!.n;
      expect(after).toBe(before);
      expect(await roleOf('usr_admin1')).toBe('user');
    });

    it('refuses to appoint yourself, an existing admin, or anyone who is not active, and then changes nothing', async () => {
      await call('usr_master', 'POST', '/api/admin/users/usr_u2/status', { status: 'suspended' });
      await call('usr_master', 'POST', '/api/admin/users/usr_u3/status', { status: 'banned' });
      expect((await call('usr_admin1', 'POST', '/api/admin/appoint', { user_id: 'usr_admin1' })).status).toBe(400);
      expect((await call('usr_admin1', 'POST', '/api/admin/appoint', { user_id: 'usr_admin2' })).status).toBe(409);
      expect((await call('usr_admin1', 'POST', '/api/admin/appoint', { user_id: 'usr_u2' })).status).toBe(409);
      expect((await call('usr_admin1', 'POST', '/api/admin/appoint', { user_id: 'usr_u3' })).status).toBe(409);
      expect((await call('usr_admin1', 'POST', '/api/admin/appoint', { user_id: 'usr_nobody' })).status).toBe(404);
      expect((await call('usr_admin1', 'POST', '/api/admin/appoint', { user_id: 'usr_u1', role: 'master' })).status).toBe(400);
      expect(await roleOf('usr_admin1')).toBe('admin');
      expect(await roleOf('usr_u1')).toBe('user');
    });

    it('the master cannot delete their own account from the app, an appointed admin can (the role goes with it)', async () => {
      const res = await call('usr_master', 'DELETE', '/api/me');
      expect(res.status).toBe(409);
      expect(await roleOf('usr_master')).toBe('master');
      expect((await call('usr_admin2', 'DELETE', '/api/me')).status).toBe(200);
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE id = 'usr_admin2'").first<{ n: number }>()).toEqual({ n: 0 });
    });

    it('a standard user can never reach an admin role by any route', async () => {
      await call('usr_u1', 'POST', '/api/admin/appoint', { user_id: 'usr_u1' });
      await call('usr_u1', 'PATCH', '/api/me', { role: 'admin' });
      expect(await roleOf('usr_u1')).toBe('user');
    });
  });

  describe('signing in while suspended or banned', () => {
    const signIn = async (username: string) => {
      const devEnv: Env = { ...env, ENVIRONMENT: 'development' };
      const start = await worker.fetch(new Request(`${BASE}/api/auth/google?intent=login&mock=true&as=${username}`), devEnv);
      const stateCookie = (start.headers.get('Set-Cookie') || '').split(';')[0]!;
      const callback = await worker.fetch(new Request(`${BASE}${new URL(start.headers.get('Location')!, BASE).pathname}${new URL(start.headers.get('Location')!, BASE).search}`, { headers: { Cookie: stateCookie } }), devEnv);
      return callback;
    };

    it('an active account gets a session; a suspended or banned one gets no session and is told why', async () => {
      const ok = await signIn('userone');
      expect(ok.headers.get('Location')).toBe('/');
      expect(ok.headers.get('Set-Cookie')).toContain('session_id=');

      await call('usr_admin1', 'POST', '/api/admin/users/usr_u2/status', { status: 'suspended' });
      const suspended = await signIn('usertwo');
      expect(suspended.headers.get('Location')).toBe('/?auth=suspended');
      expect(suspended.headers.get('Set-Cookie') || '').not.toContain('session_id=sess_');

      await call('usr_admin1', 'POST', '/api/admin/users/usr_u3/status', { status: 'banned' });
      const banned = await signIn('userthree');
      expect(banned.headers.get('Location')).toBe('/?auth=banned');
      expect(banned.headers.get('Set-Cookie') || '').not.toContain('session_id=sess_');
      const sessions = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id IN ('usr_u2','usr_u3')").first<{ n: number }>();
      expect(sessions!.n).toBe(0);
    });
  });

  describe('report preview', () => {
    it('shows what a report is about and who wrote it', async () => {
      const now = new Date().toISOString();
      const later = new Date(Date.now() + 86400000).toISOString();
      await env.DB.prepare("INSERT INTO posts (id, author_id, body, created_at, expires_at, status) VALUES ('post_9', 'usr_u2', 'rude words', ?, ?, 'active')").bind(now, later).run();
      await env.DB.prepare("INSERT INTO reports (id, reporter_id, target_type, target_id, reason, status, created_at) VALUES ('rep_1', 'usr_u1', 'post', 'post_9', 'abuse', 'pending', ?)").bind(now).run();
      const body = (await (await call('usr_admin1', 'GET', '/api/admin/reports/rep_1/preview')).json()) as Record<string, unknown>;
      expect(body).toMatchObject({ target_type: 'post', exists: true, text: 'rude words', author_id: 'usr_u2', author_username: 'usertwo' });
      expect((await call('usr_admin1', 'GET', '/api/admin/reports/rep_nope/preview')).status).toBe(404);
    });
  });
});
