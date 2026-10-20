import { describe, it, expect, beforeEach } from 'vitest';
import { makeEnv, call, seedUser, startSignup } from './_helpers.ts';
import type { Env } from '../worker/types.ts';

async function addCampus(env: Env, id: string, name: string, city: string, status: 'approved' | 'pending' = 'approved') {
  await env.DB.prepare(
    'INSERT INTO campuses (id, name, name_normalized, city, city_normalized, status, created_at) VALUES (?,?,?,?,?,?,?)'
  )
    .bind(id, name, name.toLowerCase(), city, city.toLowerCase(), status, new Date().toISOString())
    .run();
}

describe('Campuses', () => {
  let env: Env;
  let alice: string;
  let bob: string;

  beforeEach(async () => {
    env = await makeEnv();
    alice = await seedUser(env, 'usr_alice', 'alice');
    bob = await seedUser(env, 'usr_bob', 'bob');
    await addCampus(env, 'c1', 'Central Campus', 'Lahore');
    await addCampus(env, 'c2', 'North Central College', 'Karachi');
    await addCampus(env, 'c3', 'Riverside Campus', 'Lahore');
    await addCampus(env, 'c4', 'Hilltop Institute', 'Central Valley');
  });

  it('requires a session or a sign-up ticket', async () => {
    expect((await call(env, 'GET', '/api/campuses')).status).toBe(401);
    expect((await call(env, 'GET', '/api/campuses/cities')).status).toBe(401);
    expect((await call(env, 'POST', '/api/campuses', { json: { name: 'Nowhere Campus' } })).status).toBe(401);
  });

  it('positive control: lists campuses with no query', async () => {
    const res = await call(env, 'GET', '/api/campuses', { cookie: alice });
    expect(res.status).toBe(200);
    // alphabetical by name
    expect(res.json.campuses.map((c: any) => c.id)).toEqual(['c1', 'c4', 'c2', 'c3']);
  });

  it('ranks name prefix first, then name contains, then city-only matches', async () => {
    const res = await call(env, 'GET', '/api/campuses?q=central', { cookie: alice });
    expect(res.status).toBe(200);
    // c1 starts with "central", c2 contains it, c4 only matches through its city
    expect(res.json.campuses.map((c: any) => c.id)).toEqual(['c1', 'c2', 'c4']);
  });

  it('ignores case and extra spaces in the query', async () => {
    const res = await call(env, 'GET', `/api/campuses?q=${encodeURIComponent('  RIVERSIDE   camp ')}`, { cookie: alice });
    expect(res.json.campuses.map((c: any) => c.id)).toEqual(['c3']);
  });

  it('treats LIKE wildcards literally', async () => {
    expect((await call(env, 'GET', '/api/campuses?q=%25', { cookie: alice })).json.campuses).toEqual([]);
    expect((await call(env, 'GET', '/api/campuses?q=_', { cookie: alice })).json.campuses).toEqual([]);
    expect((await call(env, 'GET', `/api/campuses?q=${encodeURIComponent("' OR 1=1 --")}`, { cookie: alice })).json.campuses).toEqual([]);
  });

  it('filters by city and still applies the text query (bind order regression)', async () => {
    const res = await call(env, 'GET', '/api/campuses?q=campus&city=Lahore', { cookie: alice });
    expect(res.json.campuses.map((c: any) => c.id).sort()).toEqual(['c1', 'c3']);
    const none = await call(env, 'GET', '/api/campuses?q=campus&city=Karachi', { cookie: alice });
    expect(none.json.campuses).toEqual([]);
  });

  it('caps results at 20 and never returns more than the limit asked for', async () => {
    for (let i = 0; i < 30; i++) await addCampus(env, `bulk${i}`, `Bulk College ${String(i).padStart(2, '0')}`, 'Multan');
    const res = await call(env, 'GET', '/api/campuses?q=bulk', { cookie: alice });
    expect(res.json.campuses).toHaveLength(20);
    const small = await call(env, 'GET', '/api/campuses?q=bulk&limit=3', { cookie: alice });
    expect(small.json.campuses).toHaveLength(3);
  });

  it('lists each city once for the city filter', async () => {
    const res = await call(env, 'GET', '/api/campuses/cities', { cookie: alice });
    expect(res.json.cities).toEqual(['Central Valley', 'Karachi', 'Lahore']);
  });

  describe('requesting a campus that is not listed', () => {
    it('creates a pending campus visible only to the requester', async () => {
      const res = await call(env, 'POST', '/api/campuses', { cookie: alice, json: { name: '  Green   Valley College ', city: 'Multan' } });
      expect(res.status).toBe(201);
      expect(res.json.campus).toMatchObject({ name: 'Green Valley College', city: 'Multan', status: 'pending' });
      const id = res.json.campus.id;

      const mine = await call(env, 'GET', '/api/campuses?q=green', { cookie: alice });
      expect(mine.json.campuses.map((c: any) => c.id)).toEqual([id]);
      const theirs = await call(env, 'GET', '/api/campuses?q=green', { cookie: bob });
      expect(theirs.json.campuses).toEqual([]);
      // not in the city list either
      expect((await call(env, 'GET', '/api/campuses/cities', { cookie: bob })).json.cities).not.toContain('Multan');
    });

    it('returns the existing campus for a duplicate (normalized) instead of creating another', async () => {
      const first = await call(env, 'POST', '/api/campuses', { cookie: alice, json: { name: 'Green Valley College', city: 'Multan' } });
      const dup = await call(env, 'POST', '/api/campuses', { cookie: alice, json: { name: 'green  valley college', city: 'MULTAN' } });
      expect(dup.status).toBe(200);
      expect(dup.json.existing).toBe(true);
      expect(dup.json.campus.id).toBe(first.json.campus.id);
      const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM campuses WHERE name_normalized = 'green valley college'").first<{ n: number }>();
      expect(n?.n).toBe(1);
    });

    it('lets a second student join an existing pending request', async () => {
      const first = await call(env, 'POST', '/api/campuses', { cookie: alice, json: { name: 'Green Valley College', city: 'Multan' } });
      const second = await call(env, 'POST', '/api/campuses', { cookie: bob, json: { name: 'Green Valley College', city: 'Multan' } });
      expect(second.json.campus.id).toBe(first.json.campus.id);
      const seen = await call(env, 'GET', '/api/campuses?q=green', { cookie: bob });
      expect(seen.json.campuses).toHaveLength(1);
    });

    it('returns an approved campus as-is when the name matches one on the list', async () => {
      const res = await call(env, 'POST', '/api/campuses', { cookie: alice, json: { name: 'central campus', city: 'lahore' } });
      expect(res.status).toBe(200);
      expect(res.json.campus).toMatchObject({ id: 'c1', status: 'approved' });
    });

    it('rejects bad names', async () => {
      for (const body of [
        { name: 'x' },
        { name: 'a'.repeat(81) },
        { name: 'Campus<script>' },
        { name: 'Bad\u0007Name' },
        { name: 'Fine Name', city: 'c'.repeat(61) },
        { name: 123 },
        { name: 'Fine Name', extra: true },
      ]) {
        await env.DB.prepare('DELETE FROM rate_limits').run(); // validation, not the limiter, is under test
        const res = await call(env, 'POST', '/api/campuses', { cookie: alice, json: body });
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      await env.DB.prepare('DELETE FROM rate_limits').run();
      expect((await call(env, 'POST', '/api/campuses', { cookie: alice, raw: '{nope', headers: { 'Content-Type': 'application/json' } })).status).toBe(400);
    });

    it('rate limits requests (5 per hour)', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) {
        statuses.push((await call(env, 'POST', '/api/campuses', { cookie: alice, json: { name: `Request Campus ${i}`, city: 'Multan' } })).status);
      }
      expect(statuses.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
      expect(statuses.slice(5)).toEqual([429, 429]);
    });

    it('works during sign-up with only a ticket, and the request moves to the new account', async () => {
      const { cookie } = await startSignup(env);
      const created = await call(env, 'POST', '/api/campuses', { cookie, json: { name: 'Hill Side College', city: 'Quetta' } });
      expect(created.status).toBe(201);
      const row = await env.DB.prepare('SELECT actor_key FROM campus_requests WHERE campus_id = ?').bind(created.json.campus.id).first<{ actor_key: string }>();
      expect(row?.actor_key).toMatch(/^ticket:tkt_/);

      const done = await call(env, 'POST', '/api/signup/complete', {
        cookie,
        json: { real_name: 'Stu Dent', username: 'stu_dent', campus_id: created.json.campus.id, class_id: 'cls_2026', roll_last3: '123' },
      });
      expect(done.status).toBe(201);
      const after = await env.DB.prepare('SELECT actor_key FROM campus_requests WHERE campus_id = ?').bind(created.json.campus.id).first<{ actor_key: string }>();
      expect(after?.actor_key).toMatch(/^usr_/);
    });
  });

  describe('choosing a campus on a profile', () => {
    it('accepts approved campuses, own pending ones, and null to clear', async () => {
      const ok = await call(env, 'PATCH', '/api/me', { cookie: alice, json: { campus_id: 'c1' } });
      expect(ok.status).toBe(200);
      expect(ok.json.profile.campus_id).toBe('c1');
      expect(ok.json.profile.campus_name).toBe('Central Campus');

      const created = await call(env, 'POST', '/api/campuses', { cookie: alice, json: { name: 'Green Valley College', city: 'Multan' } });
      expect((await call(env, 'PATCH', '/api/me', { cookie: alice, json: { campus_id: created.json.campus.id } })).status).toBe(200);

      const cleared = await call(env, 'PATCH', '/api/me', { cookie: alice, json: { campus_id: null } });
      expect(cleared.json.profile.campus_id).toBeNull();
    });

    it("rejects someone else's pending campus and unknown ids", async () => {
      const created = await call(env, 'POST', '/api/campuses', { cookie: alice, json: { name: 'Green Valley College', city: 'Multan' } });
      expect((await call(env, 'PATCH', '/api/me', { cookie: bob, json: { campus_id: created.json.campus.id } })).status).toBe(400);
      expect((await call(env, 'PATCH', '/api/me', { cookie: bob, json: { campus_id: 'cmp_missing' } })).status).toBe(400);
      expect((await call(env, 'PATCH', '/api/me', { cookie: bob, json: { campus_id: "x'; DROP TABLE campuses; --" } })).status).toBe(400);
    });

    it("hides a pending campus name on other people's profile pages", async () => {
      const created = await call(env, 'POST', '/api/campuses', { cookie: alice, json: { name: 'Green Valley College', city: 'Multan' } });
      await call(env, 'PATCH', '/api/me', { cookie: alice, json: { campus_id: created.json.campus.id } });
      const asBob = await call(env, 'GET', '/api/users/alice', { cookie: bob });
      expect(asBob.json.campus_name).toBeNull();
      const asSelf = await call(env, 'GET', '/api/users/alice', { cookie: alice });
      expect(asSelf.json.campus_name).toBe('Green Valley College');
    });
  });

  describe('admin moderation', () => {
    let prod: Env;
    const secret = { 'x-admin-secret': 's3cret-value' };

    beforeEach(async () => {
      prod = { ...env, ENVIRONMENT: 'production', ADMIN_SECRET: 's3cret-value' };
      await call(prod, 'POST', '/api/campuses', { cookie: alice, json: { name: 'Green Valley College', city: 'Multan' } });
      await call(prod, 'POST', '/api/campuses', { cookie: bob, json: { name: 'green valley college', city: 'Multan' } });
    });

    it('rejects missing and wrong secrets', async () => {
      expect((await call(prod, 'GET', '/api/admin/campuses')).status).toBe(401);
      expect((await call(prod, 'GET', '/api/admin/campuses', { headers: { 'x-admin-secret': 'nope' } })).status).toBe(403);
      expect((await call(prod, 'PATCH', '/api/admin/campuses/c1', { cookie: alice, json: { action: 'reject' } })).status).toBe(401);
      expect((await call({ ...prod, ADMIN_SECRET: undefined }, 'GET', '/api/admin/campuses')).status).toBe(401);
    });

    it('lists pending campuses with how many people asked', async () => {
      const res = await call(prod, 'GET', '/api/admin/campuses', { headers: secret });
      expect(res.status).toBe(200);
      expect(res.json.campuses).toHaveLength(1);
      expect(res.json.campuses[0]).toMatchObject({ name: 'Green Valley College', status: 'pending', requesters: 2 });
      expect((await call(prod, 'GET', '/api/admin/campuses?status=bogus', { headers: secret })).status).toBe(400);
    });

    it('approve makes the campus visible to everyone', async () => {
      const id = (await call(prod, 'GET', '/api/admin/campuses', { headers: secret })).json.campuses[0].id;
      const carol = await seedUser(prod, 'usr_carol', 'carol');
      expect((await call(prod, 'GET', '/api/campuses?q=green', { cookie: carol })).json.campuses).toEqual([]);
      expect((await call(prod, 'PATCH', `/api/admin/campuses/${id}`, { headers: secret, json: { action: 'approve' } })).status).toBe(200);
      const seen = await call(prod, 'GET', '/api/campuses?q=green', { cookie: carol });
      expect(seen.json.campuses).toEqual([{ id, name: 'Green Valley College', city: 'Multan', status: 'approved' }]);
    });

    it('merge moves students to an approved campus and removes the duplicate', async () => {
      const id = (await call(prod, 'GET', '/api/admin/campuses', { headers: secret })).json.campuses[0].id;
      await call(prod, 'PATCH', '/api/me', { cookie: alice, json: { campus_id: id } });

      expect((await call(prod, 'PATCH', `/api/admin/campuses/${id}`, { headers: secret, json: { action: 'merge', into: id } })).status).toBe(400);
      const pendingTarget = await call(prod, 'POST', '/api/campuses', { cookie: bob, json: { name: 'Other New College' } });
      expect((await call(prod, 'PATCH', `/api/admin/campuses/${id}`, { headers: secret, json: { action: 'merge', into: pendingTarget.json.campus.id } })).status).toBe(400);

      const res = await call(prod, 'PATCH', `/api/admin/campuses/${id}`, { headers: secret, json: { action: 'merge', into: 'c1' } });
      expect(res.status).toBe(200);
      const me = await call(prod, 'GET', '/api/me', { cookie: alice });
      expect(me.json.profile.campus_id).toBe('c1');
      const gone = await env.DB.prepare('SELECT 1 FROM campuses WHERE id = ?').bind(id).first();
      expect(gone).toBeNull();
    });

    it('reject deletes the request and clears it from profiles', async () => {
      const id = (await call(prod, 'GET', '/api/admin/campuses', { headers: secret })).json.campuses[0].id;
      await call(prod, 'PATCH', '/api/me', { cookie: alice, json: { campus_id: id } });
      expect((await call(prod, 'PATCH', `/api/admin/campuses/${id}`, { headers: secret, json: { action: 'reject' } })).status).toBe(200);
      expect((await call(prod, 'GET', '/api/me', { cookie: alice })).json.profile.campus_id).toBeNull();
      expect((await call(prod, 'PATCH', `/api/admin/campuses/${id}`, { headers: secret, json: { action: 'approve' } })).status).toBe(404);
      expect((await call(prod, 'PATCH', '/api/admin/campuses/c1', { headers: secret, json: { action: 'explode' } })).status).toBe(400);
    });
  });
});
