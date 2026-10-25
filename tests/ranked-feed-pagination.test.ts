import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../worker/index.ts';
import { createSqliteD1 } from '../worker/db/sqlite-d1.ts';
import { createMemoryR2Bucket } from '../worker/db/r2-shim.ts';
import { runMigrations, ALL_MIGRATIONS } from '../worker/db/migrate.ts';
import { clearRateLimits } from '../worker/rate-limit.ts';
import type { Env } from '../worker/types.ts';
import type { PostItem } from '../shared/schema.ts';

/**
 * Regression: mode=for_you / mode=ranked always answered next_cursor null and has_more false, so the
 * For You feed dead-ended after one page. It now paginates through the ranked candidate pool.
 */
describe('Ranked feed pagination', () => {
  let env: Env;
  const AUTHORS = 12;
  let viewerCookie = '';

  beforeEach(async () => {
    clearRateLimits();
    const db = createSqliteD1(':memory:');
    await runMigrations(db, ALL_MIGRATIONS);
    env = {
      DB: db,
      MEDIA_BUCKET: createMemoryR2Bucket(),
      APP_URL: 'http://localhost:3000',
      GOOGLE_CLIENT_ID: 'test-google-client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
      ENVIRONMENT: 'development',
    };
    const now = new Date().toISOString();
    const expiry = new Date(Date.now() + 86400000).toISOString();
    const seed = async (id: string, username: string) => {
      await env.DB.prepare('INSERT INTO users (id, provider_subject, created_at, status) VALUES (?, ?, ?, ?)').bind(id, `sub_${id}`, now, 'active').run();
      await env.DB.prepare('INSERT INTO profiles (user_id, username, username_normalized, display_name, bio, class_id) VALUES (?, ?, ?, ?, ?, ?)').bind(id, username, username.toLowerCase(), username, 'bio', 'cls_2026').run();
      await env.DB.prepare('INSERT INTO user_settings (user_id, dm_policy) VALUES (?, ?)').bind(id, 'everyone').run();
      await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').bind(`sess_${id}`, id, expiry).run();
      return `session_id=sess_${id}`;
    };
    viewerCookie = await seed('usr_viewer', 'viewer');
    // 12 authors x 3 posts = 36 posts, so the max-2-per-author cap forces several pages.
    for (let a = 0; a < AUTHORS; a++) {
      const cookie = await seed(`usr_a${a}`, `author${a}`);
      for (let n = 0; n < 3; n++) {
        const res = await worker.fetch(
          new Request('http://localhost:3000/api/posts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ body: `post ${a}-${n} #topic${a % 4}` }),
          }),
          env
        );
        expect(res.status).toBe(201);
      }
    }
  });

  const page = async (cursor: string | null, limit = 10) => {
    const qs = new URLSearchParams({ mode: 'for_you', limit: String(limit) });
    if (cursor) qs.set('cursor', cursor);
    const res = await worker.fetch(new Request(`http://localhost:3000/api/feed?${qs}`, { headers: { Cookie: viewerCookie } }), env);
    expect(res.status).toBe(200);
    return (await res.json()) as { posts: PostItem[]; next_cursor: string | null; has_more: boolean };
  };

  it('walks every post exactly once across pages, then reports the end', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const data = await page(cursor);
      seen.push(...data.posts.map((p) => p.id));
      cursor = data.next_cursor;
      expect(data.has_more).toBe(cursor !== null);
      pages++;
    } while (cursor && pages < 20);
    expect(pages).toBeGreaterThan(1);
    expect(pages).toBeLessThan(20);
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
    expect(seen).toHaveLength(AUTHORS * 3); // nothing dropped
  });

  it('page 0 is unchanged: no cursor and cursor=0 return the same posts', async () => {
    const a = await page(null);
    const b = await page('0');
    expect(b.posts.map((p) => p.id)).toEqual(a.posts.map((p) => p.id));
    expect(a.has_more).toBe(true);
  });

  it('ignores a garbage cursor instead of failing', async () => {
    const a = await page(null);
    const b = await page('not-a-number');
    expect(b.posts.map((p) => p.id)).toEqual(a.posts.map((p) => p.id));
  });
});
