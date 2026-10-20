import { describe, it, expect, beforeEach } from 'vitest';
import { makeEnv, call, seedUser, seedClassCampus } from './_helpers.ts';
import type { Env } from '../worker/types.ts';

/**
 * alice: class 2026, campus X      bob:   class 2026, campus X
 * carol: class 2027, campus X      dave:  class 2027, campus Y
 * erin:  no class, no campus
 */
describe('Search scope and suggested people', () => {
  let env: Env;
  let alice: string, bob: string, carol: string, dave: string, erin: string;

  const usernames = (res: { json: any }) => res.json.posts.map((p: any) => p.author_username).sort();

  beforeEach(async () => {
    env = await makeEnv();
    await seedClassCampus(env);
    alice = await seedUser(env, 'usr_alice', 'alice', { classId: 'cls_2026', campusId: 'cmp_x', realName: 'Alice Real' });
    bob = await seedUser(env, 'usr_bob', 'bob', { classId: 'cls_2026', campusId: 'cmp_x', realName: 'Bob Real' });
    carol = await seedUser(env, 'usr_carol', 'carol', { classId: 'cls_2027', campusId: 'cmp_x' });
    dave = await seedUser(env, 'usr_dave', 'dave', { classId: 'cls_2027', campusId: 'cmp_y' });
    erin = await seedUser(env, 'usr_erin', 'erin');
    for (const [cookie, name] of [[alice, 'alice'], [bob, 'bob'], [carol, 'carol'], [dave, 'dave'], [erin, 'erin']] as const) {
      const res = await call(env, 'POST', '/api/posts', { cookie, json: { body: `hello from ${name}` } });
      expect(res.status).toBe(201);
    }
  });

  describe('GET /api/search?scope=', () => {
    it('everyone (default) returns all authors', async () => {
      expect(usernames(await call(env, 'GET', '/api/search?q=hello', { cookie: alice }))).toEqual(['alice', 'bob', 'carol', 'dave', 'erin']);
      expect(usernames(await call(env, 'GET', '/api/search?q=hello&scope=all', { cookie: alice }))).toEqual(['alice', 'bob', 'carol', 'dave', 'erin']);
    });

    it('class returns only the callers own class', async () => {
      expect(usernames(await call(env, 'GET', '/api/search?q=hello&scope=class', { cookie: alice }))).toEqual(['alice', 'bob']);
      expect(usernames(await call(env, 'GET', '/api/search?q=hello&scope=class', { cookie: dave }))).toEqual(['carol', 'dave']);
    });

    it('campus returns only the callers own campus', async () => {
      expect(usernames(await call(env, 'GET', '/api/search?q=hello&scope=campus', { cookie: alice }))).toEqual(['alice', 'bob', 'carol']);
      expect(usernames(await call(env, 'GET', '/api/search?q=hello&scope=campus', { cookie: dave }))).toEqual(['dave']);
    });

    it('says what is missing when the caller has no class or campus, instead of searching everyone', async () => {
      const cls = await call(env, 'GET', '/api/search?q=hello&scope=class', { cookie: erin });
      expect(cls.status).toBe(200);
      expect(cls.json).toEqual({ posts: [], total: 0, scope_missing: 'class' });
      expect((await call(env, 'GET', '/api/search?q=hello&scope=campus', { cookie: erin })).json.scope_missing).toBe('campus');
    });

    it('rejects an unknown scope', async () => {
      expect((await call(env, 'GET', '/api/search?q=hello&scope=world', { cookie: alice })).status).toBe(400);
      expect((await call(env, 'GET', "/api/search?q=hello&scope=class'--", { cookie: alice })).status).toBe(400);
    });

    it('still applies blocks inside a scope (bind order regression: scope value then blocked ids then limit)', async () => {
      await call(env, 'POST', '/api/blocks/usr_bob', { cookie: alice, json: { user_id: 'usr_bob' } });
      expect(usernames(await call(env, 'GET', '/api/search?q=hello&scope=class', { cookie: alice }))).toEqual(['alice']);
      expect(usernames(await call(env, 'GET', '/api/search?q=hello&scope=campus', { cookie: alice }))).toEqual(['alice', 'carol']);
      // the blocked person does not see alice either
      expect(usernames(await call(env, 'GET', '/api/search?q=hello&scope=class', { cookie: bob }))).toEqual(['bob']);
      // limit is still honoured with a scope and blocks together
      const limited = await call(env, 'GET', '/api/search?q=hello&scope=campus&limit=1', { cookie: alice });
      expect(limited.json.posts).toHaveLength(1);
    });
  });

  describe('GET /api/people/suggested', () => {
    it('requires a session', async () => {
      expect((await call(env, 'GET', '/api/people/suggested')).status).toBe(401);
    });

    it('lists classmates first, then campus mates, and nobody else or yourself', async () => {
      const res = await call(env, 'GET', '/api/people/suggested', { cookie: alice });
      expect(res.status).toBe(200);
      expect(res.json.people.map((p: any) => [p.username, p.relation])).toEqual([
        ['bob', 'class'],
        ['carol', 'campus'],
      ]);
      expect(res.json.people[0]).toMatchObject({ class_name: expect.any(String), campus_name: 'Central Campus' });
    });

    it('excludes people already followed', async () => {
      await call(env, 'POST', '/api/users/bob/follow', { cookie: alice });
      const res = await call(env, 'GET', '/api/people/suggested', { cookie: alice });
      expect(res.json.people.map((p: any) => p.username)).toEqual(['carol']);
    });

    it('excludes blocked people in both directions', async () => {
      await call(env, 'POST', '/api/blocks/usr_bob', { cookie: alice, json: { user_id: 'usr_bob' } });
      expect((await call(env, 'GET', '/api/people/suggested', { cookie: alice })).json.people.map((p: any) => p.username)).toEqual(['carol']);
      expect((await call(env, 'GET', '/api/people/suggested', { cookie: bob })).json.people.map((p: any) => p.username)).toEqual(['carol']);
    });

    it('works with only a campus, and returns an empty list when neither is set', async () => {
      await env.DB.prepare('UPDATE profiles SET class_id = NULL WHERE user_id = ?').bind('usr_alice').run();
      const campusOnly = await call(env, 'GET', '/api/people/suggested', { cookie: alice });
      expect(campusOnly.json.people.map((p: any) => [p.username, p.relation]).sort()).toEqual([['bob', 'campus'], ['carol', 'campus']]);
      expect((await call(env, 'GET', '/api/people/suggested', { cookie: erin })).json).toEqual({ people: [] });
    });

    it('respects the limit', async () => {
      const res = await call(env, 'GET', '/api/people/suggested?limit=1', { cookie: alice });
      expect(res.json.people).toHaveLength(1);
      expect(res.json.people[0].username).toBe('bob');
    });

    it('never includes the real name, email or roll number', async () => {
      const res = await call(env, 'GET', '/api/people/suggested', { cookie: alice });
      expect(res.text).not.toContain('Bob Real');
      expect(res.text).not.toContain('real_name');
    });

    it('does not suggest suspended accounts and hides pending campus names', async () => {
      await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").bind('usr_bob').run();
      const pending = await call(env, 'POST', '/api/campuses', { cookie: carol, json: { name: 'Pending College' } });
      await call(env, 'PATCH', '/api/me', { cookie: carol, json: { campus_id: pending.json.campus.id } });
      const res = await call(env, 'GET', '/api/people/suggested', { cookie: alice });
      expect(res.json.people.map((p: any) => p.username)).not.toContain('bob');
      // carol moved to a pending campus, so she is no longer on alice's campus
      expect(res.json.people).toEqual([]);
    });
  });
});
