import { describe, it, expect, beforeEach } from 'vitest';
import { makeEnv, call, seedClassCampus, startSignup, seedUser, CAMPUS_X } from './_helpers.ts';
import type { Env } from '../worker/types.ts';

const base = { real_name: 'Ayesha Khan', username: 'ayesha_k', campus_id: CAMPUS_X, class_id: 'cls_2026', program: 'fsc_pre_engineering', session: '2024-2026', roll_number: '2024-0907', card: { barcode: '20240907' } };

describe('sign-up help requests (admin)', () => {
  let env: Env;
  let adminCookie: string;
  let userCookie: string;
  beforeEach(async () => {
    env = await makeEnv();
    await seedClassCampus(env);
    adminCookie = await seedUser(env, 'usr_admin', 'admin_one');
    userCookie = await seedUser(env, 'usr_plain', 'plain_one');
    await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = 'usr_admin'").run();
    const first = await startSignup(env, { sub: 'first' });
    expect((await call(env, 'POST', '/api/signup/complete', { cookie: first.cookie, json: base })).status).toBe(201);
    const second = await startSignup(env, { sub: 'second', email: 'second@gmail.com' });
    expect((await call(env, 'POST', '/api/signup/complete', { cookie: second.cookie, json: { ...base, username: 'second_one' } })).status).toBe(409);
  });

  it('is closed to everyone who is not an admin', async () => {
    expect((await call(env, 'GET', '/api/admin/disputes')).status).toBe(401);
    expect((await call(env, 'GET', '/api/admin/disputes', { cookie: userCookie })).status).toBe(403);
    const id = (await env.DB.prepare('SELECT id FROM registration_disputes').first<{ id: string }>())!.id;
    expect((await call(env, 'POST', `/api/admin/disputes/${id}/resolve`, { cookie: userCookie, json: {} })).status).toBe(403);
    expect((await call(env, 'POST', `/api/admin/disputes/${id}/resolve`, { json: {} })).status).toBe(401);
    // the old shared secret does not open these either
    expect((await call(env, 'GET', '/api/admin/disputes', { headers: { 'x-admin-secret': 'anything' } })).status).toBe(401);
  });

  it('shows who asked and which account holds the roll number, and nothing private', async () => {
    const res = await call(env, 'GET', '/api/admin/disputes', { cookie: adminCookie });
    expect(res.status).toBe(200);
    expect(res.json.disputes).toHaveLength(1);
    expect(res.json.disputes[0]).toMatchObject({ email: 'second@gmail.com', status: 'open', holder_username: 'ayesha_k' });
    expect(res.text).not.toMatch(/roll_key|campus_key|20240907|0907/);
  });

  it('never names the master as the holder', async () => {
    await env.DB.prepare("UPDATE users SET role = 'master' WHERE id = (SELECT user_id FROM profiles WHERE username = 'ayesha_k')").run();
    const res = await call(env, 'GET', '/api/admin/disputes', { cookie: adminCookie });
    expect(res.json.disputes[0].holder_username).toBeNull();
  });

  it('marks a request handled once, and the action is logged', async () => {
    const id = (await env.DB.prepare('SELECT id FROM registration_disputes').first<{ id: string }>())!.id;
    const ok = await call(env, 'POST', `/api/admin/disputes/${id}/resolve`, { cookie: adminCookie, json: { note: 'Checked with the campus office' } });
    expect(ok.status).toBe(200);
    expect((await call(env, 'POST', `/api/admin/disputes/${id}/resolve`, { cookie: adminCookie, json: {} })).status).toBe(404);
    const row = await env.DB.prepare('SELECT status, note, resolved_by FROM registration_disputes').first<Record<string, string>>();
    expect(row).toEqual({ status: 'resolved', note: 'Checked with the campus office', resolved_by: 'usr_admin' });
    const log = await env.DB.prepare("SELECT action FROM admin_actions WHERE action = 'dispute:resolved'").all();
    expect(log.results).toHaveLength(1);
  });

  it('an unknown id is a 404, not an error', async () => {
    expect((await call(env, 'POST', '/api/admin/disputes/dsp_nope/resolve', { cookie: adminCookie, json: {} })).status).toBe(404);
  });
});
