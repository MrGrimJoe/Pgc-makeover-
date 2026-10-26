import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import worker from '../worker/index.ts';
import { makeEnv, call, seedUser } from './_helpers.ts';
import { clearRateLimits } from '../worker/rate-limit.ts';
import type { Env } from '../worker/types.ts';

/**
 * A suspended or banned account can do one thing: ask for a review. Every other route must refuse it, even if it
 * still holds a session (for example one created a moment before the suspension landed).
 *
 * The routes are discovered from the worker source, so a route added later is covered without editing this file.
 */
const BASE = 'http://localhost:3000';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

// Open to everyone by design: the sign-in hand-off, sign-up for new people, and the appeal routes (ticket cookie).
const OPEN = new Set([
  '/api/auth/google',
  '/api/auth/callback',
  '/api/auth/logout',
  '/api/signup/session',
  '/api/signup/complete',
  '/api/username-available',
  '/api/appeals',
  '/api/appeals/mine',
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}
const code = sourceFiles(new URL('../worker', import.meta.url).pathname).map((f) => readFileSync(f, 'utf8')).join('\n');
const literalRoutes = [...new Set([...code.matchAll(/pathname === '(\/api\/[a-zA-Z0-9/_-]+)'/g)].map((m) => m[1]!))].filter((p) => !OPEN.has(p));
// Routes with an id in the path (the worker matches these with patterns), one sample of each shape.
const patternRoutes = [
  '/api/users/someone',
  '/api/users/usr_x/follow',
  '/api/posts/p1/likes',
  '/api/posts/p1/comments',
  '/api/posts/p1/poll/vote',
  '/api/posts/p1',
  '/api/comments/c1',
  '/api/conversations/cv1/messages',
  '/api/messages/m1/forward',
  '/api/blocks/usr_x',
  '/api/media/med1',
  '/api/media/med1/thumb',
  '/api/stickers/library/s1',
  '/api/me/interests/some-topic',
  '/api/admin/users/usr_x/status',
  '/api/admin/reports/r1',
  '/api/admin/reports/r1/preview',
  '/api/admin/appeals/a1/decide',
  '/api/admin/disputes/d1/resolve',
  '/api/v1/feed/bootstrap',
  '/api/v1/feed/next',
];

describe('suspended and banned accounts can only ask for a review', () => {
  let env: Env;
  // The sweeps run as production: in development a few secret-gated routes (the cleanup job) are deliberately open
  // for local work, which says nothing about what a suspended account can do. Same database either way.
  let prod: Env;
  const cookies: Record<string, string> = {};

  beforeEach(async () => {
    clearRateLimits();
    env = await makeEnv({ ADMIN_SECRET: 'test-admin-secret' });
    prod = { ...env, ENVIRONMENT: 'production' };
    await seedUser(env, 'usr_ok', 'active_one');
    for (const [id, name, status] of [['usr_s', 'suspended_one', 'suspended'], ['usr_b', 'banned_one', 'banned']] as const) {
      cookies[name] = await seedUser(env, id, name);
      // The session row is left in place on purpose: the check must not depend on it having been deleted.
      await env.DB.prepare('UPDATE users SET status = ? WHERE id = ?').bind(status, id).run();
    }
  });

  it('finds the routes (guards the discovery itself)', () => {
    expect(literalRoutes.length).toBeGreaterThan(20);
    expect(literalRoutes).toContain('/api/feed');
    expect(literalRoutes).toContain('/api/posts');
    expect(literalRoutes).toContain('/api/me');
  });

  it('positive control: the same session works while the account is active', async () => {
    const cookie = await seedUser(env, 'usr_c', 'control_one');
    expect((await call(prod, 'GET', '/api/me', { cookie })).status).toBe(200);
    expect((await call(prod, 'GET', '/api/feed', { cookie })).status).toBe(200);
  });

  for (const name of ['suspended_one', 'banned_one']) {
    it(`${name}: every other route refuses a live session`, async () => {
      const failures: string[] = [];
      for (const path of [...literalRoutes, ...patternRoutes]) {
        for (const method of METHODS) {
          const res = await worker.fetch(
            new Request(`${BASE}${path}`, {
              method,
              headers: { Cookie: cookies[name]!, 'Content-Type': 'application/json' },
              body: method === 'GET' ? undefined : JSON.stringify({}),
            }),
            prod
          );
          // 401/403 refuse; 404/405 mean there is no such route for that method. Anything else did some work.
          if (![401, 403, 404, 405].includes(res.status)) failures.push(`${method} ${path} -> ${res.status}`);
        }
      }
      expect(failures).toEqual([]);
    });

    it(`${name}: the appeal ticket opens only the appeal routes`, async () => {
      const start = await worker.fetch(new Request(`${BASE}/api/auth/google?intent=login&mock=true&as=${name}`), env);
      const state = (start.headers.get('Set-Cookie') || '').split(';')[0]!;
      const loc = new URL(start.headers.get('Location')!, BASE);
      const back = await worker.fetch(new Request(`${BASE}${loc.pathname}${loc.search}`, { headers: { Cookie: state } }), env);
      expect(back.headers.get('Set-Cookie')).not.toContain('session_id=');
      const ticket = /appeal_ticket=[^;]+/.exec(back.headers.get('Set-Cookie') || '')?.[0] ?? '';
      expect(ticket).toBeTruthy();

      const failures: string[] = [];
      for (const path of [...literalRoutes, ...patternRoutes]) {
        for (const method of METHODS) {
          const res = await worker.fetch(
            new Request(`${BASE}${path}`, { method, headers: { Cookie: ticket, 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify({}) }),
            prod
          );
          if (![401, 403, 404, 405].includes(res.status)) failures.push(`${method} ${path} -> ${res.status}`);
        }
      }
      expect(failures).toEqual([]);

      const sent = await call(prod, 'POST', '/api/appeals', { cookie: ticket, json: { message: 'Please look at this again.' } });
      expect(sent.status).toBe(201);
    });
  }
});
