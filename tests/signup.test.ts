import { describe, it, expect, beforeEach } from 'vitest';
import { makeEnv, call, seedUser, seedClassCampus, startSignup, deepKeys } from './_helpers.ts';
import type { Env } from '../worker/types.ts';

const VALID = {
  real_name: 'Ayesha Khan',
  username: 'ayesha_k',
  campus_id: 'cmp_x',
  class_id: 'cls_2026',
  roll_last3: '907',
};

describe('Sign up and log in', () => {
  let env: Env;

  beforeEach(async () => {
    env = await makeEnv();
    await seedClassCampus(env);
  });

  describe('sign-up ticket', () => {
    it('is issued by the callback and describes the Google account', async () => {
      const { cookie, location } = await startSignup(env, { name: 'Ayesha K', email: 'ayesha@gmail.com' });
      expect(location).toBe('/?signup=1');
      const res = await call(env, 'GET', '/api/signup/session', { cookie });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ valid: true, suggested_name: 'Ayesha K', email: 'ayesha@gmail.com' });
    });

    it('is rejected when missing, forged, expired or already used', async () => {
      expect((await call(env, 'GET', '/api/signup/session')).status).toBe(401);
      expect((await call(env, 'GET', '/api/signup/session', { cookie: 'signup_ticket=tkt_forged' })).status).toBe(401);
      expect((await call(env, 'POST', '/api/signup/complete', { cookie: 'signup_ticket=tkt_forged', json: VALID })).status).toBe(401);

      const expired = await startSignup(env, { sub: 'exp' });
      await env.DB.prepare('UPDATE signup_tickets SET expires_at = ? WHERE id = ?').bind(new Date(Date.now() - 1000).toISOString(), expired.ticketId).run();
      expect((await call(env, 'GET', '/api/signup/session', { cookie: expired.cookie })).status).toBe(401);
      expect((await call(env, 'POST', '/api/signup/complete', { cookie: expired.cookie, json: VALID })).status).toBe(401);

      const used = await startSignup(env, { sub: 'used' });
      expect((await call(env, 'POST', '/api/signup/complete', { cookie: used.cookie, json: VALID })).status).toBe(201);
      // replaying the same ticket cookie fails
      expect((await call(env, 'POST', '/api/signup/complete', { cookie: used.cookie, json: { ...VALID, username: 'other_name' } })).status).toBe(401);
      expect((await call(env, 'GET', '/api/signup/session', { cookie: used.cookie })).status).toBe(401);
    });

    it('a new sign-up for the same Google account replaces its earlier unused ticket', async () => {
      const first = await startSignup(env, { sub: 'same' });
      const second = await startSignup(env, { sub: 'same' });
      expect((await call(env, 'GET', '/api/signup/session', { cookie: first.cookie })).status).toBe(401);
      expect((await call(env, 'GET', '/api/signup/session', { cookie: second.cookie })).status).toBe(200);
    });
  });

  describe('completing sign-up', () => {
    it('creates the account, a session and the private record in one go', async () => {
      const { cookie } = await startSignup(env, { email: 'ayesha@gmail.com' });
      const res = await call(env, 'POST', '/api/signup/complete', { cookie, json: VALID });
      expect(res.status).toBe(201);

      const setCookie = res.headers.get('Set-Cookie') ?? '';
      expect(setCookie).toContain('session_id=sess_');
      expect(setCookie).toMatch(/signup_ticket=;/); // ticket cleared

      expect(res.json.me.profile).toMatchObject({
        username: 'ayesha_k',
        real_name: 'Ayesha Khan',
        campus_id: 'cmp_x',
        campus_name: 'Central Campus',
        class_id: 'cls_2026',
      });
      // until a nickname is chosen the display name is the username, never the real name
      expect(res.json.me.profile.display_name).toBe('ayesha_k');

      const priv = await env.DB.prepare('SELECT email, roll_last3 FROM user_private').first<{ email: string; roll_last3: string }>();
      expect(priv).toEqual({ email: 'ayesha@gmail.com', roll_last3: '907' });

      const sessionCookie = /session_id=([^;]+)/.exec(setCookie)![1]!;
      const me = await call(env, 'GET', '/api/me', { cookie: `session_id=${sessionCookie}` });
      expect(me.status).toBe(200);
      expect(me.json.profile.username).toBe('ayesha_k');
    });

    it('rejects invalid input with a 400 and creates nothing', async () => {
      const { cookie } = await startSignup(env);
      const bad: Array<[string, Record<string, unknown>]> = [
        ['roll with 2 digits', { roll_last3: '90' }],
        ['roll with 4 digits', { roll_last3: '9071' }],
        ['roll with letters', { roll_last3: '9a7' }],
        ['roll as number', { roll_last3: 907 }],
        ['short real name', { real_name: 'A' }],
        ['real name with markup', { real_name: '<b>Ayesha</b>' }],
        ['uppercase username', { username: 'Ayesha_K' }],
        ['short username', { username: 'ab' }],
        ['username with double underscore', { username: 'aye__sha' }],
        ['missing campus', { campus_id: undefined }],
        ['missing class', { class_id: undefined }],
        ['extra field (mass assignment)', { status: 'admin', user_id: 'usr_x' }],
      ];
      for (const [label, patch] of bad) {
        await env.DB.prepare('DELETE FROM rate_limits').run();
        const res = await call(env, 'POST', '/api/signup/complete', { cookie, json: { ...VALID, ...patch } });
        expect(res.status, label).toBe(400);
      }
      await env.DB.prepare('DELETE FROM rate_limits').run();
      expect((await call(env, 'POST', '/api/signup/complete', { cookie, raw: '{nope', headers: { 'Content-Type': 'application/json' } })).status).toBe(400);
      expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n).toBe(0);
    });

    it('rejects reserved usernames, unknown classes and unknown or foreign campuses', async () => {
      const { cookie } = await startSignup(env);
      for (const patch of [{ username: 'admin' }, { username: 'support' }, { class_id: 'cls_nope' }, { campus_id: 'cmp_nope' }]) {
        await env.DB.prepare('DELETE FROM rate_limits').run();
        expect((await call(env, 'POST', '/api/signup/complete', { cookie, json: { ...VALID, ...patch } })).status).toBe(400);
      }

      // another student's pending campus cannot be picked
      const other = await seedUser(env, 'usr_other', 'other');
      const pending = await call(env, 'POST', '/api/campuses', { cookie: other, json: { name: 'Secret Pending College' } });
      await env.DB.prepare('DELETE FROM rate_limits').run();
      expect((await call(env, 'POST', '/api/signup/complete', { cookie, json: { ...VALID, campus_id: pending.json.campus.id } })).status).toBe(400);
    });

    it('returns 409 when the username is taken or the Google account already has an account', async () => {
      await seedUser(env, 'usr_taken', 'ayesha_k');
      const { cookie } = await startSignup(env);
      expect((await call(env, 'POST', '/api/signup/complete', { cookie, json: VALID })).status).toBe(409);

      // the same Google account signs up in another tab while this ticket is still open
      const dup = await startSignup(env, { sub: 'dupsub' });
      await env.DB.prepare('INSERT INTO users (id, provider_subject, created_at, status) VALUES (?,?,?,?)')
        .bind('usr_dup', 'mock-google-sub-dupsub', new Date().toISOString(), 'active').run();
      const res = await call(env, 'POST', '/api/signup/complete', { cookie: dup.cookie, json: { ...VALID, username: 'fresh_name' } });
      expect(res.status).toBe(409);
      expect(res.json.error).toContain('Log in');
    });

    it('username race: exactly one winner, the loser gets 409 and can try again', async () => {
      const a = await startSignup(env, { sub: 'a' });
      const b = await startSignup(env, { sub: 'b' });
      const [ra, rb] = await Promise.all([
        call(env, 'POST', '/api/signup/complete', { cookie: a.cookie, json: VALID }),
        call(env, 'POST', '/api/signup/complete', { cookie: b.cookie, json: VALID }),
      ]);
      expect([ra.status, rb.status].sort()).toEqual([201, 409]);
      expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n).toBe(1);

      const loser = ra.status === 409 ? a : b;
      const retry = await call(env, 'POST', '/api/signup/complete', { cookie: loser.cookie, json: { ...VALID, username: 'ayesha_k2' } });
      expect(retry.status).toBe(201);
    });

    it('double submit of one ticket creates one account', async () => {
      const { cookie } = await startSignup(env);
      const results = await Promise.all([
        call(env, 'POST', '/api/signup/complete', { cookie, json: VALID }),
        call(env, 'POST', '/api/signup/complete', { cookie, json: VALID }),
        call(env, 'POST', '/api/signup/complete', { cookie, json: VALID }),
      ]);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.every((r) => r.status < 500)).toBe(true);
      expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n).toBe(1);
      expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>())?.n).toBe(1);
    });

    it('rate limits attempts per ticket', async () => {
      const { cookie } = await startSignup(env);
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        statuses.push((await call(env, 'POST', '/api/signup/complete', { cookie, json: { ...VALID, roll_last3: 'x' } })).status);
      }
      expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
      expect(statuses.slice(10)).toEqual([429, 429]);
    });
  });

  describe('privacy', () => {
    it('never returns the roll number or email from any endpoint', async () => {
      const { cookie } = await startSignup(env, { email: 'ayesha.private@gmail.com' });
      const done = await call(env, 'POST', '/api/signup/complete', { cookie, json: VALID });
      const mine = `session_id=${/session_id=([^;]+)/.exec(done.headers.get('Set-Cookie') ?? '')![1]}`;
      const viewer = await seedUser(env, 'usr_viewer', 'viewer', { classId: 'cls_2026', campusId: 'cmp_x' });

      await call(env, 'POST', '/api/posts', { cookie: mine, json: { body: 'hello from ayesha #study' } });

      const responses = [
        done,
        await call(env, 'GET', '/api/me', { cookie: mine }),
        await call(env, 'PATCH', '/api/me', { cookie: mine, json: { bio: 'hi' } }),
        await call(env, 'GET', '/api/users/ayesha_k', { cookie: viewer }),
        await call(env, 'GET', '/api/users/ayesha_k', { cookie: mine }),
        await call(env, 'GET', '/api/feed', { cookie: viewer }),
        await call(env, 'GET', '/api/search?q=hello', { cookie: viewer }),
        await call(env, 'GET', '/api/people/suggested', { cookie: viewer }),
      ];
      for (const r of responses) {
        const keys = deepKeys(r.json);
        expect(keys.has('roll_last3')).toBe(false);
        expect(keys.has('email')).toBe(false);
        expect(r.text).not.toContain('ayesha.private@gmail.com');
        expect(r.text).not.toContain('"907"');
      }
    });

    it('shows the real name on the profile page only', async () => {
      const { cookie } = await startSignup(env);
      const done = await call(env, 'POST', '/api/signup/complete', { cookie, json: VALID });
      const mine = `session_id=${/session_id=([^;]+)/.exec(done.headers.get('Set-Cookie') ?? '')![1]}`;
      const viewer = await seedUser(env, 'usr_viewer', 'viewer', { classId: 'cls_2026', campusId: 'cmp_x' });
      await call(env, 'POST', '/api/posts', { cookie: mine, json: { body: 'hello world' } });

      const profile = await call(env, 'GET', '/api/users/ayesha_k', { cookie: viewer });
      expect(profile.json.real_name).toBe('Ayesha Khan');

      for (const path of ['/api/feed', '/api/search?q=hello', '/api/people/suggested']) {
        const res = await call(env, 'GET', path, { cookie: viewer });
        expect(res.status, path).toBe(200);
        expect(res.text, path).not.toContain('Ayesha Khan');
      }
      // positive control: the post is found, and its author shows as the username
      const found = await call(env, 'GET', '/api/search?q=hello', { cookie: viewer });
      expect(found.json.posts).toHaveLength(1);
      expect(found.json.posts[0].author_display_name).toBe('ayesha_k');
    });

    it('does not accept email or roll_last3 through PATCH /api/me', async () => {
      const mine = await seedUser(env, 'usr_me', 'me_user');
      for (const body of [{ email: 'x@y.com' }, { roll_last3: '111' }]) {
        expect((await call(env, 'PATCH', '/api/me', { cookie: mine, json: body })).status).toBe(400);
      }
    });

    it('deleting the account removes the private record', async () => {
      const { cookie } = await startSignup(env);
      const done = await call(env, 'POST', '/api/signup/complete', { cookie, json: VALID });
      const mine = `session_id=${/session_id=([^;]+)/.exec(done.headers.get('Set-Cookie') ?? '')![1]}`;
      expect((await call(env, 'DELETE', '/api/me', { cookie: mine })).status).toBe(200);
      expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM user_private').first<{ n: number }>())?.n).toBe(0);
      expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n).toBe(0);
    });
  });

  describe('log in', () => {
    async function oauth(intent: 'login' | 'signup', sub: string) {
      const init = await call(env, 'GET', `/api/auth/google?mock=true&intent=${intent}&mock_sub=${sub}`);
      const location = init.headers.get('Location')!;
      const state = /oauth_state=([^;]+)/.exec(init.headers.get('Set-Cookie') ?? '')![1];
      return call(env, 'GET', location, { cookie: `oauth_state=${state}` });
    }

    it('an existing account logs in with either button', async () => {
      const { cookie } = await startSignup(env, { sub: 'returning' });
      await call(env, 'POST', '/api/signup/complete', { cookie, json: VALID });

      for (const intent of ['login', 'signup'] as const) {
        const res = await oauth(intent, 'returning');
        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe('/');
        expect(res.headers.get('Set-Cookie')).toContain('session_id=sess_');
      }
      // no extra ticket was created for the existing account
      expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM signup_tickets WHERE used_at IS NULL').first<{ n: number }>())?.n).toBe(0);
    });

    it('an unknown account on Log in is sent back with a message and nothing is created', async () => {
      const res = await oauth('login', 'stranger');
      expect(res.headers.get('Location')).toBe('/?auth=no_account');
      expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n).toBe(0);
    });

    it('stores the verified email for accounts that predate it', async () => {
      await seedUser(env, 'usr_old', 'old_user');
      await env.DB.prepare('UPDATE users SET provider_subject = ? WHERE id = ?').bind('mock-google-sub-oldsub', 'usr_old').run();
      const init = await call(env, 'GET', '/api/auth/google?mock=true&intent=login&mock_sub=oldsub&mock_email=old%40gmail.com');
      const state = /oauth_state=([^;]+)/.exec(init.headers.get('Set-Cookie') ?? '')![1];
      await call(env, 'GET', init.headers.get('Location')!, { cookie: `oauth_state=${state}` });
      const priv = await env.DB.prepare('SELECT email FROM user_private WHERE user_id = ?').bind('usr_old').first<{ email: string }>();
      expect(priv?.email).toBe('old@gmail.com');
    });

    it('mock sign-in stays disabled in production', async () => {
      const prod = { ...env, ENVIRONMENT: 'production' as const };
      expect((await call(prod, 'GET', '/api/auth/google?mock=true&intent=signup&mock_sub=x')).status).toBe(400);
      expect((await call(prod, 'GET', '/api/auth/callback?code=mock_code&state=s&mock=true&intent=signup&mock_sub=x')).status).toBe(400);
    });
  });

  describe('username availability', () => {
    it('requires a ticket or session', async () => {
      expect((await call(env, 'GET', '/api/username-available?u=free_name')).status).toBe(401);
    });

    it('reports invalid, reserved, taken and free names', async () => {
      await seedUser(env, 'usr_t', 'taken_name');
      const { cookie } = await startSignup(env);
      const check = async (u: string) => (await call(env, 'GET', `/api/username-available?u=${encodeURIComponent(u)}`, { cookie })).json;
      expect(await check('free_name')).toEqual({ available: true });
      expect(await check('Taken_Name')).toMatchObject({ available: false, reason: 'invalid' });
      expect(await check('taken_name')).toMatchObject({ available: false, reason: 'taken' });
      expect(await check('admin')).toMatchObject({ available: false, reason: 'reserved' });
      expect(await check('a')).toMatchObject({ available: false, reason: 'invalid' });
      expect(await check('')).toMatchObject({ available: false, reason: 'invalid' });
    });

    it('treats the signed-in persons own username as available, and rate limits checks', async () => {
      const mine = await seedUser(env, 'usr_me', 'my_name');
      expect((await call(env, 'GET', '/api/username-available?u=my_name', { cookie: mine })).json).toEqual({ available: true });
      const statuses: number[] = [];
      for (let i = 0; i < 32; i++) statuses.push((await call(env, 'GET', '/api/username-available?u=some_name', { cookie: mine })).status);
      expect(statuses.slice(0, 29).every((s) => s === 200)).toBe(true);
      expect(statuses.slice(-2)).toEqual([429, 429]);
    });

    it('reserved usernames cannot be taken from the profile screen either', async () => {
      const mine = await seedUser(env, 'usr_me', 'my_name');
      expect((await call(env, 'PATCH', '/api/me', { cookie: mine, json: { username: 'support' } })).status).toBe(400);
      expect((await call(env, 'PATCH', '/api/me', { cookie: mine, json: { username: 'my_name' } })).status).toBe(200);
    });
  });
});
