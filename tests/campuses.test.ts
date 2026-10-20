import { describe, it, expect, beforeEach } from 'vitest';
import { makeEnv, call, seedUser, CAMPUS_X, CAMPUS_Y } from './_helpers.ts';
import { createSqliteD1 } from '../worker/db/sqlite-d1.ts';
import { runMigrations, ALL_MIGRATIONS } from '../worker/db/migrate.ts';
import { CAMPUSES } from '../shared/campuses.ts';
import { findCampus, campusName, cleanCampusOther } from '../shared/campus.ts';
import type { Env } from '../worker/types.ts';

describe('Bundled campuses', () => {
  let env: Env;
  let alice: string;
  let bob: string;

  beforeEach(async () => {
    env = await makeEnv();
    alice = await seedUser(env, 'usr_alice', 'alice', { classId: 'cls_2026' });
    bob = await seedUser(env, 'usr_bob', 'bob', { classId: 'cls_2026' });
  });

  describe('the list', () => {
    it('has unique ids and unique name+city pairs, and findCampus resolves each one', () => {
      expect(CAMPUSES.length).toBeGreaterThan(100);
      expect(new Set(CAMPUSES.map((c) => c.id)).size).toBe(CAMPUSES.length);
      expect(new Set(CAMPUSES.map((c) => `${c.name}|${c.city}`)).size).toBe(CAMPUSES.length);
      for (const c of CAMPUSES) expect(findCampus(c.id)?.name).toBe(c.name);
    });

    it('unknown, empty and null ids resolve to no campus', () => {
      expect(findCampus('cmp_nope')).toBeUndefined();
      expect(findCampus(null)).toBeUndefined();
      expect(campusName('')).toBeNull();
      expect(campusName(CAMPUS_X)).toBe(findCampus(CAMPUS_X)!.name);
    });

    it('cleans free-text campuses and rejects markup, control characters and bad lengths', () => {
      expect(cleanCampusOther('  Green   Valley  College ')).toBe('Green Valley College');
      for (const bad of ['a', 'x'.repeat(81), '<b>Green</b>', 'Bell\u0007', 42, null, undefined]) {
        expect(cleanCampusOther(bad)).toBeNull();
      }
    });
  });

  describe('removed routes and tables', () => {
    it('no campus table exists and the campus routes are gone (positive control: a live route answers)', async () => {
      expect((await call(env, 'GET', '/api/people/suggested', { cookie: alice })).status).toBe(200);
      const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
      const names = (tables.results ?? []).map((t) => t.name);
      expect(names).not.toContain('campuses');
      expect(names).not.toContain('campus_requests');
      for (const [m, path] of [['GET', '/api/campuses'], ['GET', '/api/campuses/cities'], ['POST', '/api/campuses'], ['GET', '/api/admin/campuses'], ['PATCH', '/api/admin/campuses/x']] as const) {
        const res = await call(env, m, path, { cookie: alice, json: m === 'GET' ? undefined : { name: 'X' } });
        expect(res.status, `${m} ${path}`).toBe(404);
      }
    });
  });

  describe('choosing a campus on a profile', () => {
    it('accepts a listed campus and null to clear (positive control)', async () => {
      const set = await call(env, 'PATCH', '/api/me', { cookie: alice, json: { campus_id: CAMPUS_X } });
      expect(set.status).toBe(200);
      const me = await call(env, 'GET', '/api/me', { cookie: alice });
      expect(me.json.profile.campus_id).toBe(CAMPUS_X);
      expect(me.json.profile.campus_name).toBe(campusName(CAMPUS_X));
      expect((await call(env, 'PATCH', '/api/me', { cookie: alice, json: { campus_id: null } })).status).toBe(200);
      expect((await call(env, 'GET', '/api/me', { cookie: alice })).json.profile.campus_id).toBeNull();
    });

    it('rejects unknown ids', async () => {
      for (const id of ['cmp_nope', 'c1', '../x']) {
        expect((await call(env, 'PATCH', '/api/me', { cookie: alice, json: { campus_id: id } })).status).toBe(400);
      }
    });

    it('campus_other and campus_id are mutually exclusive: setting one clears the other', async () => {
      await call(env, 'PATCH', '/api/me', { cookie: alice, json: { campus_id: CAMPUS_X } });
      const other = await call(env, 'PATCH', '/api/me', { cookie: alice, json: { campus_other: 'Green  Valley College' } });
      expect(other.status).toBe(200);
      let p = (await call(env, 'GET', '/api/me', { cookie: alice })).json.profile;
      expect(p).toMatchObject({ campus_id: null, campus_name: null, campus_other: 'Green Valley College' });

      await call(env, 'PATCH', '/api/me', { cookie: alice, json: { campus_id: CAMPUS_Y } });
      p = (await call(env, 'GET', '/api/me', { cookie: alice })).json.profile;
      expect(p).toMatchObject({ campus_id: CAMPUS_Y, campus_other: null });
    });

    it('rejects sending both, markup, and bad lengths', async () => {
      const both = await call(env, 'PATCH', '/api/me', { cookie: alice, json: { campus_id: CAMPUS_X, campus_other: 'Green Valley' } });
      expect(both.status).toBe(400);
      for (const bad of ['<script>', 'x', 'y'.repeat(81)]) {
        expect((await call(env, 'PATCH', '/api/me', { cookie: alice, json: { campus_other: bad } })).status).toBe(400);
      }
      // nothing was stored by the rejected requests
      expect((await call(env, 'GET', '/api/me', { cookie: alice })).json.profile.campus_other).toBeNull();
    });

    it('shows campus_other on the profile page, but it never drives the campus search scope', async () => {
      await call(env, 'PATCH', '/api/me', { cookie: alice, json: { campus_id: CAMPUS_X } });
      await call(env, 'PATCH', '/api/me', { cookie: bob, json: { campus_other: 'Green Valley College' } });
      const view = await call(env, 'GET', '/api/users/bob', { cookie: alice });
      expect(view.json.campus_other).toBe('Green Valley College');
      expect(view.json.campus_id).toBeNull();

      expect((await call(env, 'POST', '/api/posts', { cookie: bob, json: { body: 'hello from bob' } })).status).toBe(201);
      // positive control: bob's post is found when the scope is everyone
      const all = await call(env, 'GET', '/api/search?q=hello&scope=all', { cookie: alice });
      expect(all.json.posts.map((p: any) => p.author_username)).toContain('bob');
      const scoped = await call(env, 'GET', '/api/search?q=hello&scope=campus', { cookie: alice });
      expect(scoped.status).toBe(200);
      expect(scoped.json.posts.map((p: any) => p.author_username)).not.toContain('bob');
    });
  });

  describe('old data', () => {
    it('a profile whose campus id is no longer in the list reads as "no campus" without crashing', async () => {
      await env.DB.prepare('UPDATE profiles SET campus_id = ? WHERE user_id = ?').bind('cmp_removed', 'usr_bob').run();
      const me = await call(env, 'GET', '/api/me', { cookie: bob });
      expect(me.status).toBe(200);
      expect(me.json.profile.campus_id).toBeNull();
      expect(me.json.profile.campus_name).toBeNull();
      const view = await call(env, 'GET', '/api/users/bob', { cookie: alice });
      expect(view.status).toBe(200);
      expect(view.json.campus_name).toBeNull();
    });

    it('migration 006 keeps profile data and campus ids, and drops the campus tables', async () => {
      const db = createSqliteD1(':memory:');
      await runMigrations(db, ALL_MIGRATIONS.filter((m) => m.name < '006'));
      const now = new Date().toISOString();
      await db.prepare("INSERT INTO campuses (id, name, name_normalized, city, city_normalized, status, created_at) VALUES ('cmp_old','Old','old','L','l','approved',?)").bind(now).run();
      await db.prepare("INSERT INTO users (id, provider_subject, created_at, status) VALUES ('u1','s1',?, 'active')").bind(now).run();
      await db.prepare("INSERT INTO profiles (user_id, username, username_normalized, display_name, class_id, campus_id, real_name) VALUES ('u1','ann','ann','Ann','cls_2026','cmp_old','Ann Real')").run();
      await runMigrations(db, ALL_MIGRATIONS);
      const row = await db.prepare('SELECT username, class_id, campus_id, campus_other, real_name FROM profiles WHERE user_id = ?').bind('u1').first<any>();
      expect(row).toEqual({ username: 'ann', class_id: 'cls_2026', campus_id: 'cmp_old', campus_other: null, real_name: 'Ann Real' });
      const t = await db.prepare("SELECT name FROM sqlite_master WHERE name IN ('campuses','campus_requests')").all();
      expect(t.results).toHaveLength(0);
      // the DB-level check rejects a row that has both
      await expect(db.prepare("UPDATE profiles SET campus_other = 'Other' WHERE user_id = 'u1'").run()).rejects.toThrow();
    });
  });
});
