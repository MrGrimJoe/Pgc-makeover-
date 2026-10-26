import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeEnv, call } from './_helpers.ts';
import { clearRateLimits } from '../worker/rate-limit.ts';
import { cleanImpressions, MAX_IMPRESSIONS_PER_REQUEST } from '../worker/impressions.ts';
import type { Env } from '../worker/types.ts';

/**
 * Cloudflare free plan: at most 50 D1 queries per Worker run and 100,000 rows written per day. The old
 * impressions loop used 2 to 9 queries per post, so a normal batch of views stopped half way.
 */
describe('POST /api/impressions on the free plan', () => {
  let env: Env;
  let cookie = '';
  const POSTS = 30;
  const now = () => new Date().toISOString();

  beforeEach(async () => {
    clearRateLimits();
    env = await makeEnv();
    const expiry = new Date(Date.now() + 86_400_000).toISOString();
    for (const id of ['usr_viewer', 'usr_author']) {
      await env.DB.prepare('INSERT INTO users (id, provider_subject, created_at, status) VALUES (?, ?, ?, ?)').bind(id, `sub_${id}`, now(), 'active').run();
      await env.DB.prepare('INSERT INTO profiles (user_id, username, username_normalized, display_name, bio, class_id) VALUES (?, ?, ?, ?, ?, ?)').bind(id, id, id, id, 'bio', 'cls_2026').run();
      await env.DB.prepare('INSERT INTO user_settings (user_id, dm_policy) VALUES (?, ?)').bind(id, 'everyone').run();
    }
    await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').bind('sess_viewer', 'usr_viewer', expiry).run();
    cookie = 'session_id=sess_viewer';
    for (const t of ['t1', 't2', 't3']) await env.DB.prepare('INSERT INTO topics (id, slug, display_name) VALUES (?, ?, ?)').bind(`top_${t}`, t, t).run();
    for (let i = 0; i < POSTS; i++) {
      await env.DB.prepare('INSERT INTO posts (id, author_id, body, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?)').bind(`post_${i}`, 'usr_author', `post ${i}`, now(), expiry, 'active').run();
      // every post has all three topics
      for (const t of ['t1', 't2', 't3']) await env.DB.prepare('INSERT INTO post_topics (post_id, topic_id) VALUES (?, ?)').bind(`post_${i}`, `top_${t}`).run();
    }
  });

  const send = (impressions: unknown) => call(env, 'POST', '/api/impressions', { cookie, json: { impressions } });
  const rows = async () => Number((await env.DB.prepare('SELECT COUNT(*) AS c FROM impressions').first<{ c: number }>())?.c);
  const counter = async (id: string) => Number((await env.DB.prepare('SELECT impressions_count AS c FROM posts WHERE id = ?').bind(id).first<{ c: number }>())?.c);

  it('records a view, bumps the post counter, and does not log the same post twice within the hour', async () => {
    const first = await send([{ post_id: 'post_0', position: 2, duration_ms: 1500 }]);
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ success: true, recorded: 1 });
    expect(await rows()).toBe(1);
    expect(await counter('post_0')).toBe(1);

    await send([{ post_id: 'post_0', position: 2, duration_ms: 1500 }]);
    expect(await rows()).toBe(1);
    expect(await counter('post_0')).toBe(1);
  });

  it('keeps at most 20 posts per request, and counts a post repeated in one batch once', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ post_id: `post_${i % POSTS}`, duration_ms: 1200 }));
    const res = await send(many);
    expect(res.status).toBe(200);
    expect(await rows()).toBeLessThanOrEqual(MAX_IMPRESSIONS_PER_REQUEST);
    expect(cleanImpressions(many).length).toBeLessThanOrEqual(MAX_IMPRESSIONS_PER_REQUEST);
    expect(cleanImpressions([{ post_id: 'a', duration_ms: 1000 }, { post_id: 'a', duration_ms: 4000 }])).toEqual([{ postId: 'a', position: 0, durationMs: 4000 }]);
  });

  it('ignores junk and posts that do not exist (no error, nothing written)', async () => {
    const res = await send([{ post_id: 'post_nope', duration_ms: 5000 }, { post_id: 42 }, null, 'x', { post_id: '' }]);
    expect(res.status).toBe(200);
    expect(await rows()).toBe(0);
    expect((await send('not an array')).status).toBe(200);
    expect((await call(env, 'POST', '/api/impressions', { cookie, raw: '{bad json' })).status).toBe(400);
    expect((await call(env, 'POST', '/api/impressions', { json: { impressions: [] } })).status).toBe(401);
  });

  it('a view of 3 seconds or more strengthens the post topics once per post and topic', async () => {
    await send([{ post_id: 'post_0', duration_ms: 3500 }, { post_id: 'post_1', duration_ms: 3000 }, { post_id: 'post_2', duration_ms: 900 }]);
    const sig = await env.DB.prepare('SELECT topic_id, weight FROM user_topic_signals WHERE user_id = ? ORDER BY topic_id').bind('usr_viewer').all<{ topic_id: string; weight: number }>();
    expect((sig.results || []).map((r) => r.topic_id)).toEqual(['top_t1', 'top_t2', 'top_t3']);
    // two long views x +0.1; the short view adds nothing
    for (const r of sig.results || []) expect(r.weight).toBeCloseTo(0.2, 5);
  });

  it('uses the same few D1 round trips for 1 post or for 20 (the old loop used up to 9 per post)', async () => {
    const trips = { n: 0 };
    const realBatch = env.DB.batch.bind(env.DB);
    const realPrepare = env.DB.prepare.bind(env.DB);
    (env.DB as any).prepare = (sql: string) => {
      const st = realPrepare(sql);
      const wrap = (s: any): any =>
        new Proxy(s, {
          get(target, prop) {
            if (prop === 'bind') return (...a: unknown[]) => wrap(target.bind(...a));
            if (prop === 'first' || prop === 'all' || prop === 'run' || prop === 'raw') return (...a: unknown[]) => { trips.n++; return target[prop](...a); };
            const v = target[prop];
            return typeof v === 'function' ? v.bind(target) : v;
          },
        });
      return wrap(st);
    };
    (env.DB as any).batch = (stmts: any[]) => { trips.n++; return realBatch(stmts); };

    const batch = Array.from({ length: 20 }, (_, i) => ({ post_id: `post_${i}`, duration_ms: 4000 }));
    const before = trips.n;
    const res = await send(batch);
    expect(res.status).toBe(200);
    const used = trips.n - before;
    // session + profile + settings for sign-in checks, then 1 dedupe lookup, 1 insert batch, topics lookup, signals lookup, 1 upsert batch
    expect(used).toBeLessThanOrEqual(12);
    expect(used).toBeLessThan(50); // the free plan's cap per Worker run
    expect(await rows()).toBe(20);
  });

  it('the feed no longer counts the impressions table once per candidate post', () => {
    const src = readFileSync('worker/index.ts', 'utf8');
    expect(src).not.toMatch(/SELECT COUNT\(\*\) FROM impressions WHERE post_id/);
    expect(src).toContain('p.impressions_count AS impressions_count');
  });

  it('migration 016 backfills the counter from existing impression rows', async () => {
    // the counter column exists and a post that was viewed shows it
    await send([{ post_id: 'post_3', duration_ms: 1100 }]);
    expect(await counter('post_3')).toBe(1);
    const sqlFile = readFileSync('migrations/016_impression_counter.sql', 'utf8');
    expect(sqlFile).toContain('ADD COLUMN impressions_count');
    expect(sqlFile).toContain('UPDATE posts SET impressions_count');
  });
});
