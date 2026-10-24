import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../worker/index.ts';
import { makeEnv, call, seedUser } from './_helpers.ts';
import type { Env } from '../worker/types.ts';

const BASE = 'http://localhost:3000';

async function signIn(env: Env, username: string): Promise<Response> {
  const start = await worker.fetch(new Request(`${BASE}/api/auth/google?intent=login&mock=true&as=${username}`), env);
  const state = (start.headers.get('Set-Cookie') || '').split(';')[0]!;
  const loc = new URL(start.headers.get('Location')!, BASE);
  return worker.fetch(new Request(`${BASE}${loc.pathname}${loc.search}`, { headers: { Cookie: state } }), env);
}
const ticketCookie = (res: Response) => /appeal_ticket=[^;]+/.exec(res.headers.get('Set-Cookie') || '')?.[0] ?? '';

describe('appeals', () => {
  let env: Env;
  let admin: string;
  let master: string;
  beforeEach(async () => {
    env = await makeEnv();
    admin = await seedUser(env, 'usr_admin', 'admin_one');
    master = await seedUser(env, 'usr_master', 'master_one');
    await seedUser(env, 'usr_s', 'suspended_one');
    await seedUser(env, 'usr_b', 'banned_one');
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = 'usr_admin'"),
      env.DB.prepare("UPDATE users SET role = 'master' WHERE id = 'usr_master'"),
      env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = 'usr_s'"),
      env.DB.prepare("UPDATE users SET status = 'banned' WHERE id = 'usr_b'"),
    ]);
  });

  it('a blocked sign-in gets no session, only a ticket that can send an appeal', async () => {
    const res = await signIn(env, 'suspended_one');
    expect(res.headers.get('Location')).toBe('/?auth=suspended');
    expect(res.headers.get('Set-Cookie')).not.toContain('session_id=');
    const cookie = ticketCookie(res);
    expect(cookie).toBeTruthy();
    // the ticket opens nothing else
    expect((await call(env, 'GET', '/api/me', { cookie })).status).toBe(401);
    expect((await call(env, 'GET', '/api/feed', { cookie })).status).toBe(401);
  });

  it('an active account gets no appeal ticket', async () => {
    await seedUser(env, 'usr_ok', 'fine_one');
    expect(ticketCookie(await signIn(env, 'fine_one'))).toBe('');
  });

  it('needs a ticket, validates the message, and allows one open appeal', async () => {
    expect((await call(env, 'POST', '/api/appeals', { json: { message: 'please' } })).status).toBe(401);
    const cookie = ticketCookie(await signIn(env, 'suspended_one'));
    for (const bad of [{ message: '' }, { message: '   ' }, { message: 'x'.repeat(501) }, { message: '<b>hi</b>' }, { message: 'hi', status: 'active' }, { message: 5 }]) {
      expect((await call(env, 'POST', '/api/appeals', { cookie, json: bad })).status).toBe(400);
    }
    expect((await call(env, 'POST', '/api/appeals', { cookie, json: { message: 'It was a mistake, I was hacked.' } })).status).toBe(201);
    expect((await call(env, 'POST', '/api/appeals', { cookie, json: { message: 'again' } })).status).toBe(409);
    const mine = await call(env, 'GET', '/api/appeals/mine', { cookie });
    expect(mine.json.appeal.status).toBe('open');
  });

  it('an expired ticket is refused', async () => {
    const cookie = ticketCookie(await signIn(env, 'suspended_one'));
    await env.DB.prepare("UPDATE appeal_tickets SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await call(env, 'POST', '/api/appeals', { cookie, json: { message: 'hello' } })).status).toBe(401);
  });

  it('admins see appeals; ordinary students and signed-out visitors cannot', async () => {
    const cookie = ticketCookie(await signIn(env, 'suspended_one'));
    await call(env, 'POST', '/api/appeals', { cookie, json: { message: 'sorry' } });
    expect((await call(env, 'GET', '/api/admin/appeals')).status).toBe(401);
    const plain = await seedUser(env, 'usr_plain', 'plain_one');
    expect((await call(env, 'GET', '/api/admin/appeals', { cookie: plain })).status).toBe(403);
    const list = await call(env, 'GET', '/api/admin/appeals', { cookie: admin });
    expect(list.json.appeals).toHaveLength(1);
    expect(list.json.appeals[0]).toMatchObject({ username: 'suspended_one', message: 'sorry', status: 'open' });
  });

  it('granting a suspension reinstates the student, who can then sign in; the decision is logged', async () => {
    const cookie = ticketCookie(await signIn(env, 'suspended_one'));
    await call(env, 'POST', '/api/appeals', { cookie, json: { message: 'sorry' } });
    const id = (await env.DB.prepare('SELECT id FROM appeals').first<{ id: string }>())!.id;
    expect((await call(env, 'POST', `/api/admin/appeals/${id}/decide`, { cookie: admin, json: { decision: 'maybe' } })).status).toBe(400);
    const ok = await call(env, 'POST', `/api/admin/appeals/${id}/decide`, { cookie: admin, json: { decision: 'granted', note: 'First offence' } });
    expect(ok.status).toBe(200);
    expect((await env.DB.prepare("SELECT status FROM users WHERE id = 'usr_s'").first<{ status: string }>())?.status).toBe('active');
    expect((await signIn(env, 'suspended_one')).headers.get('Set-Cookie')).toContain('session_id=');
    expect((await call(env, 'POST', `/api/admin/appeals/${id}/decide`, { cookie: admin, json: { decision: 'denied' } })).status).toBe(409);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'appeal:granted'").first<{ n: number }>())?.n).toBe(1);
  });

  it('denying keeps the account blocked and lets them see the answer', async () => {
    const cookie = ticketCookie(await signIn(env, 'suspended_one'));
    await call(env, 'POST', '/api/appeals', { cookie, json: { message: 'sorry' } });
    const id = (await env.DB.prepare('SELECT id FROM appeals').first<{ id: string }>())!.id;
    await call(env, 'POST', `/api/admin/appeals/${id}/decide`, { cookie: admin, json: { decision: 'denied', note: 'Repeated spam' } });
    expect((await env.DB.prepare("SELECT status FROM users WHERE id = 'usr_s'").first<{ status: string }>())?.status).toBe('suspended');
    const mine = await call(env, 'GET', '/api/appeals/mine', { cookie: ticketCookie(await signIn(env, 'suspended_one')) });
    expect(mine.json.appeal).toMatchObject({ status: 'denied', decision_note: 'Repeated spam' });
  });

  it('only the master can reinstate a banned account through an appeal', async () => {
    const cookie = ticketCookie(await signIn(env, 'banned_one'));
    await call(env, 'POST', '/api/appeals', { cookie, json: { message: 'please' } });
    const id = (await env.DB.prepare('SELECT id FROM appeals').first<{ id: string }>())!.id;
    expect((await call(env, 'POST', `/api/admin/appeals/${id}/decide`, { cookie: admin, json: { decision: 'granted' } })).status).toBe(403);
    expect((await env.DB.prepare("SELECT status FROM users WHERE id = 'usr_b'").first<{ status: string }>())?.status).toBe('banned');
    expect((await call(env, 'POST', `/api/admin/appeals/${id}/decide`, { cookie: master, json: { decision: 'granted' } })).status).toBe(200);
    expect((await env.DB.prepare("SELECT status FROM users WHERE id = 'usr_b'").first<{ status: string }>())?.status).toBe('active');
  });
});
