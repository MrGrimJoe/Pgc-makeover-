import { describe, it, expect, beforeEach } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import worker from '../worker/index.ts';
import { makeEnv } from './_helpers.ts';
import { clearRateLimits } from '../worker/rate-limit.ts';
import type { Env } from '../worker/types.ts';
import type { PostItem } from '../shared/schema.ts';

/**
 * Cloudflare D1 refuses a query with more than 100 bound parameters; the local SQLite used by the tests does not.
 * This wraps the database so the tests fail the way production would.
 */
const MAX_BOUND = 100;
function enforceD1ParameterLimit(db: D1Database): D1Database {
  const guard = (sql: string, args: unknown[]) => {
    if (args.length > MAX_BOUND) throw new Error(`D1 allows ${MAX_BOUND} bound parameters per query, got ${args.length}: ${sql.slice(0, 80)}`);
  };
  return new Proxy(db, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (key !== 'prepare') return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      return (sql: string) => {
        const stmt = target.prepare(sql);
        return new Proxy(stmt, {
          get(st, k) {
            if (k === 'bind') {
              return (...args: unknown[]) => {
                guard(sql, args);
                return st.bind(...args);
              };
            }
            const v = Reflect.get(st, k) as unknown;
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(st) : v;
          },
        });
      };
    },
  });
}

describe('ranked feed stays inside the D1 bound-parameter limit', () => {
  let env: Env;
  const viewer = 'session_id=sess_usr_viewer';

  const addUser = async (id: string, username: string, withSession = false) => {
    await env.DB.prepare('INSERT INTO users (id, provider_subject, created_at, status) VALUES (?,?,?,?)').bind(id, `sub_${id}`, new Date().toISOString(), 'active').run();
    await env.DB.prepare('INSERT INTO profiles (user_id, username, username_normalized, display_name, bio) VALUES (?,?,?,?,?)').bind(id, username, username, username, '').run();
    await env.DB.prepare('INSERT INTO user_settings (user_id, dm_policy) VALUES (?,?)').bind(id, 'everyone').run();
    if (withSession) {
      await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)').bind(`sess_${id}`, id, new Date(Date.now() + 86_400_000).toISOString()).run();
    }
  };
  const addPost = async (id: string, authorId: string, ageMs: number, topic?: string) => {
    const created = new Date(Date.now() - ageMs).toISOString();
    const expires = new Date(Date.now() + 5 * 86_400_000).toISOString();
    await env.DB.prepare('INSERT INTO posts (id, author_id, body, created_at, expires_at, status) VALUES (?,?,?,?,?,?)').bind(id, authorId, `post ${id}`, created, expires, 'active').run();
    if (topic) {
      await env.DB.prepare('INSERT OR IGNORE INTO topics (id, slug, display_name) VALUES (?,?,?)').bind(`top_${topic}`, topic, topic).run();
      await env.DB.prepare('INSERT INTO post_topics (post_id, topic_id, confidence) VALUES (?,?,1.0)').bind(id, `top_${topic}`).run();
    }
  };
  const feedIds = async (): Promise<string[]> => {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 40; i++) {
      const qs = new URLSearchParams({ mode: 'for_you', limit: '20' });
      if (cursor) qs.set('cursor', cursor);
      const res = await worker.fetch(new Request(`http://localhost:3000/api/feed?${qs}`, { headers: { Cookie: viewer } }), env);
      expect(res.status, await res.clone().text()).toBe(200);
      const page = (await res.json()) as { posts: PostItem[]; next_cursor: string | null };
      ids.push(...page.posts.map((p) => p.id));
      if (!page.next_cursor || page.posts.length === 0) break;
      cursor = page.next_cursor;
    }
    return ids;
  };

  beforeEach(async () => {
    clearRateLimits();
    const base = await makeEnv();
    env = { ...base, DB: enforceD1ParameterLimit(base.DB) };
    await addUser('usr_viewer', 'viewer', true);
    await addUser('usr_author', 'author');
  });

  it('positive control: the wrapper really rejects a 101-parameter query', () => {
    const ids = Array.from({ length: 101 }, (_, i) => `x${i}`);
    expect(() => env.DB.prepare(`SELECT 1 WHERE 1 IN (${ids.map(() => '?').join(',')})`).bind(...ids)).toThrow(/bound parameters/);
  });

  it('a viewer with 150 blocks (some each way) still gets a full feed without the blocked authors', async () => {
    for (let i = 0; i < 150; i++) {
      await addUser(`usr_b${i}`, `blocked${i}`);
      const [a, b] = i % 3 === 0 ? [`usr_b${i}`, 'usr_viewer'] : ['usr_viewer', `usr_b${i}`];
      await env.DB.prepare('INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?,?,?)').bind(a, b, new Date().toISOString()).run();
    }
    for (let i = 0; i < 30; i++) await addPost(`ok-${i}`, 'usr_author', 60_000 + i * 1000);
    for (let i = 0; i < 6; i++) await addPost(`bad-${i}`, `usr_b${i}`, 30_000 + i * 1000);
    const ids = await feedIds();
    expect(ids.length).toBeGreaterThanOrEqual(30);
    expect(ids.filter((id) => id.startsWith('ok-')).length).toBe(30);
    expect(ids.filter((id) => id.startsWith('bad-'))).toEqual([]);
  });

  it('a candidate pool over 100 posts (newest 100 plus older interest matches) does not break the topic lookup', async () => {
    for (let i = 0; i < 120; i++) await addPost(`noise-${i}`, 'usr_author', 60_000 + i * 1000, 'noise');
    for (let i = 0; i < 6; i++) await addPost(`old-${i}`, 'usr_author', 3 * 86_400_000 + i * 1000, 'cooking');
    await env.DB.prepare('INSERT INTO user_topic_signals (user_id, topic_id, weight, updated_at) VALUES (?,?,?,?)').bind('usr_viewer', 'top_cooking', 6, new Date().toISOString()).run();
    const ids = await feedIds();
    expect(ids.some((id) => id.startsWith('old-'))).toBe(true);
    expect(ids.length).toBeGreaterThanOrEqual(100);
  });
});
