import { describe, it, expect, beforeEach } from 'vitest';
import { createSqliteD1 } from '../worker/db/sqlite-d1.ts';
import { runMigrations } from '../worker/db/migrate.ts';
import { bootstrapReadSql, bootstrapSql, planBootstrap, USER_ID_PATTERN } from '../worker/db/bootstrap-master.ts';
import type { D1Database } from '@cloudflare/workers-types';

const NOW = '2026-10-24T10:00:00.000Z';

describe('master admin bootstrap', () => {
  let db: D1Database;
  const addUser = (id: string, status = 'active', role = 'user') =>
    db.prepare('INSERT INTO users (id, provider_subject, created_at, status, role) VALUES (?, ?, ?, ?, ?)').bind(id, `sub_${id}`, NOW, status, role).run();
  const masters = async () => ((await db.prepare("SELECT id FROM users WHERE role = 'master'").all<{ id: string }>()).results || []).map((r) => r.id);
  // what the script does with the two SQL strings: run each statement in order
  const runSql = async (sql: string) => { await db.exec(sql.replace(/\n/g, ' ')); };

  beforeEach(async () => {
    db = createSqliteD1(':memory:');
    await runMigrations(db);
    await addUser('usr_me');
    await addUser('usr_other');
  });

  describe('planBootstrap', () => {
    const me = { id: 'usr_me', status: 'active', role: 'user' };
    it('promotes an active account when nobody is master', () => {
      expect(planBootstrap('usr_me', me, [])).toEqual({ action: 'promote' });
    });
    it('does nothing when that account is already the master (safe to run again)', () => {
      expect(planBootstrap('usr_me', { ...me, role: 'master' }, ['usr_me'])).toEqual({ action: 'already_master' });
    });
    it('refuses when a different account is already master, even if the target looks fine', () => {
      expect(planBootstrap('usr_me', me, ['usr_other'])).toMatchObject({ action: 'refuse', reason: 'other_master' });
    });
    it('refuses a missing account, a suspended or banned one, and a malformed id', () => {
      expect(planBootstrap('usr_me', null, [])).toMatchObject({ action: 'refuse', reason: 'no_such_user' });
      expect(planBootstrap('usr_me', { ...me, status: 'suspended' }, [])).toMatchObject({ action: 'refuse', reason: 'not_active' });
      expect(planBootstrap('usr_me', { ...me, status: 'banned' }, [])).toMatchObject({ action: 'refuse', reason: 'not_active' });
      for (const bad of ['', 'me', "usr_x'; DROP TABLE users;--", 'usr_', 'usr_a b', 'USR_abc', 'usr_' + 'a'.repeat(65)]) {
        expect(planBootstrap(bad, me, []), bad).toMatchObject({ action: 'refuse', reason: 'invalid_id' });
      }
    });
    it('only accepts ids shaped like real account ids', () => {
      expect(USER_ID_PATTERN.test('usr_aB3-_x9')).toBe(true);
      expect(USER_ID_PATTERN.test("usr_a'b")).toBe(false);
    });
  });

  describe('the SQL', () => {
    it('refuses to build SQL from a bad id or timestamp', () => {
      expect(() => bootstrapSql("usr_x'; DROP TABLE users;--", NOW)).toThrow();
      expect(() => bootstrapSql('usr_me', "2026'; --")).toThrow();
      expect(() => bootstrapReadSql("usr_x' OR '1'='1")).toThrow();
    });

    it('promotes the account and writes one audit line', async () => {
      await runSql(bootstrapSql('usr_me', NOW));
      expect(await masters()).toEqual(['usr_me']);
      const log = await db.prepare("SELECT actor_id, action, target_id FROM admin_actions").all();
      expect(log.results).toEqual([{ actor_id: 'usr_me', action: 'bootstrap:master', target_id: 'usr_me' }]);
    });

    it('running it again changes nothing and logs nothing more', async () => {
      await runSql(bootstrapSql('usr_me', NOW));
      await runSql(bootstrapSql('usr_me', '2026-10-25T10:00:00.000Z'));
      expect(await masters()).toEqual(['usr_me']);
      expect(((await db.prepare('SELECT COUNT(*) AS n FROM admin_actions').first<{ n: number }>())!.n)).toBe(1);
    });

    it('cannot replace an existing master, even if the script check were skipped', async () => {
      await runSql(bootstrapSql('usr_me', NOW));
      await runSql(bootstrapSql('usr_other', NOW)); // the guard in the statement itself
      expect(await masters()).toEqual(['usr_me']);
      expect((await db.prepare("SELECT role FROM users WHERE id = 'usr_other'").first<{ role: string }>())!.role).toBe('user');
      expect(((await db.prepare('SELECT COUNT(*) AS n FROM admin_actions').first<{ n: number }>())!.n)).toBe(1);
    });

    it('does not promote a suspended account, or one that does not exist', async () => {
      await addUser('usr_susp', 'suspended');
      await runSql(bootstrapSql('usr_susp', NOW));
      await runSql(bootstrapSql('usr_ghost', NOW));
      expect(await masters()).toEqual([]);
      expect(((await db.prepare('SELECT COUNT(*) AS n FROM admin_actions').first<{ n: number }>())!.n)).toBe(0);
    });

    it('an appointed admin can become the master, and the appointment record is cleared', async () => {
      await db.prepare("UPDATE users SET role = 'admin', appointed_by = 'usr_other', appointed_at = ? WHERE id = 'usr_me'").bind(NOW).run();
      await runSql(bootstrapSql('usr_me', NOW));
      const row = await db.prepare("SELECT role, appointed_by FROM users WHERE id = 'usr_me'").first<{ role: string; appointed_by: string | null }>();
      expect(row).toEqual({ role: 'master', appointed_by: null });
    });

    it('the read queries find the account and the current masters', async () => {
      await runSql(bootstrapSql('usr_me', NOW));
      const [a, b] = bootstrapReadSql('usr_me').split('\n');
      expect(await db.prepare(a!).first()).toEqual({ id: 'usr_me', status: 'active', role: 'master' });
      expect((await db.prepare(b!).all()).results).toEqual([{ id: 'usr_me' }]);
    });
  });
});
