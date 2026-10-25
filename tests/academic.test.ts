import { describe, it, expect, beforeEach } from 'vitest';
import { makeEnv, call, seedClassCampus, startSignup, CAMPUS_X } from './_helpers.ts';
import { confirmationDue, cleanSection, isValidSession, PROGRAMS } from '../shared/academic.ts';
import type { Env } from '../worker/types.ts';

const base = { real_name: 'Ayesha Khan', username: 'ayesha_k', campus_id: CAMPUS_X, class_id: 'cls_2026', program: 'fsc_pre_medical', session: '2024-2026', section: 'B', roll_number: '2024-0907', card: { barcode: '20240907' } };

describe('academic rules', () => {
  it('lists the seven programs', () => expect(PROGRAMS.map((p) => p.id)).toHaveLength(7));
  it('sessions are two years one to four apart', () => {
    expect(['2024-2026', '2025-2026', '2023-2027'].every(isValidSession)).toBe(true);
    expect(['2024', '2026-2024', '2024-2024', '2024-2030', '1999-2001', '2024/2026', '<b>'].some(isValidSession)).toBe(false);
  });
  it('sections', () => {
    expect(cleanSection('  a ')).toBe('a');
    expect(cleanSection('')).toBe('');
    expect(['<b>', 'x'.repeat(11), '-a'].map(cleanSection)).toEqual([null, null, null]);
  });
  it('renewal is due after the configured time, never for graduates', () => {
    const day = 86400000, now = Date.now();
    expect(confirmationDue('current', null, now, 365)).toBe(true);
    expect(confirmationDue('current', new Date(now - 364 * day).toISOString(), now, 365)).toBe(false);
    expect(confirmationDue('current', new Date(now - 366 * day).toISOString(), now, 365)).toBe(true);
    expect(confirmationDue('current', new Date(now - 40 * day).toISOString(), now, 30)).toBe(true);
    expect(confirmationDue('graduated', null, now, 365)).toBe(false);
  });
});

describe('academic details', () => {
  let env: Env;
  let cookie: string;
  beforeEach(async () => {
    env = await makeEnv();
    await seedClassCampus(env);
    const t = await startSignup(env);
    const r = await call(env, 'POST', '/api/signup/complete', { cookie: t.cookie, json: base });
    expect(r.status).toBe(201);
    cookie = `session_id=${/session_id=([^;]+)/.exec(r.headers.get('set-cookie') || '')![1]}`;
  });

  it('sign-up needs a valid program and session; section is optional', async () => {
    const e2 = await makeEnv();
    for (const bad of [{ program: 'astronomy' }, { program: undefined }, { session: '2024' }, { session: undefined }, { section: '<b>' }]) {
      const t = await startSignup(e2);
      expect((await call(e2, 'POST', '/api/signup/complete', { cookie: t.cookie, json: { ...base, ...bad } })).status).toBe(400);
    }
    const t = await startSignup(e2);
    const { section: _s, ...noSection } = base;
    expect((await call(e2, 'POST', '/api/signup/complete', { cookie: t.cookie, json: noSection })).status).toBe(201);
  });

  it('shows the details given at sign-up and does not ask for confirmation yet', async () => {
    const r = await call(env, 'GET', '/api/me/academic', { cookie });
    expect(r.json).toMatchObject({ program: 'fsc_pre_medical', program_name: 'F.Sc. Pre-Medical', session: '2024-2026', section: 'B', class_id: 'cls_2026', status: 'current', confirm_due: false, renewal_days: 365 });
  });

  it('is private to the signed-in person', async () => {
    expect((await call(env, 'GET', '/api/me/academic')).status).toBe(401);
    expect((await call(env, 'PUT', '/api/me/academic', { json: {} })).status).toBe(401);
    const me = await call(env, 'GET', '/api/me', { cookie });
    expect(me.text).not.toMatch(/fsc_pre_medical|2024-2026/);
  });

  it('moving up changes class, session and section together and restarts the clock', async () => {
    await env.DB.prepare("UPDATE user_private SET academic_confirmed_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await call(env, 'GET', '/api/me/academic', { cookie })).json.confirm_due).toBe(true);
    const r = await call(env, 'PUT', '/api/me/academic', { cookie, json: { program: 'fsc_pre_medical', session: '2024-2026', class_id: 'cls_2027', section: 'A' } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ class_id: 'cls_2027', section: 'A', confirm_due: false });
    expect((await call(env, 'GET', '/api/me', { cookie })).json.profile.class_id).toBe('cls_2027');
  });

  it('refuses bad updates and changes nothing', async () => {
    for (const bad of [{ class_id: 'cls_nope' }, { session: '2030' }, { program: 'x' }, { section: '<i>' }, { extra: 1 }]) {
      const r = await call(env, 'PUT', '/api/me/academic', { cookie, json: { program: 'fsc_pre_medical', session: '2024-2026', class_id: 'cls_2027', ...bad } });
      expect(r.status).toBe(400);
    }
    expect((await call(env, 'GET', '/api/me/academic', { cookie })).json.class_id).toBe('cls_2026');
  });

  it('confirming restarts the clock without changing anything else', async () => {
    await env.DB.prepare("UPDATE user_private SET academic_confirmed_at = '2000-01-01T00:00:00.000Z'").run();
    const r = await call(env, 'POST', '/api/me/academic/confirm', { cookie });
    expect(r.json).toMatchObject({ confirm_due: false, section: 'B', class_id: 'cls_2026' });
  });

  it('the renewal period is configurable', async () => {
    const short = { ...env, ACADEMIC_RENEWAL_DAYS: '30' } as Env;
    await env.DB.prepare("UPDATE user_private SET academic_confirmed_at = ?").bind(new Date(Date.now() - 40 * 86400000).toISOString()).run();
    expect((await call(short, 'GET', '/api/me/academic', { cookie })).json).toMatchObject({ confirm_due: true, renewal_days: 30 });
    expect((await call(env, 'GET', '/api/me/academic', { cookie })).json.confirm_due).toBe(false);
  });

  it('a graduate keeps the account and every post, becomes alumni, and is no longer asked to renew', async () => {
    const post = await call(env, 'POST', '/api/posts', { cookie, json: { body: 'my last post' } });
    expect(post.status).toBe(201);
    const g = await call(env, 'POST', '/api/me/academic/graduate', { cookie });
    expect(g.json).toMatchObject({ status: 'graduated', class_id: 'cls_alumni', confirm_due: false });
    expect((await call(env, 'GET', '/api/me', { cookie })).status).toBe(200);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM posts').first<{ n: number }>())?.n).toBe(1);
    expect((await call(env, 'PUT', '/api/me/academic', { cookie, json: { program: 'ics', session: '2024-2026', class_id: 'cls_2026' } })).status).toBe(409);
    expect((await call(env, 'POST', '/api/me/academic/graduate', { cookie })).status).toBe(409);
  });

  it('a person who signed up before these fields existed is asked once, and can answer', async () => {
    await env.DB.prepare('UPDATE user_private SET program = NULL, session = NULL, section = NULL, academic_confirmed_at = NULL').run();
    const r = await call(env, 'GET', '/api/me/academic', { cookie });
    expect(r.json).toMatchObject({ program: null, confirm_due: true });
    const put = await call(env, 'PUT', '/api/me/academic', { cookie, json: { program: 'ics', session: '2025-2027', class_id: 'cls_2027' } });
    expect(put.json).toMatchObject({ program: 'ics', section: null, confirm_due: false });
  });
});
