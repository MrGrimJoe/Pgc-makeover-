import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../worker/index.ts';
import { call, makeEnv, seedUser } from './_helpers.ts';
import type { Env } from '../worker/types.ts';
import type { FeedBatchResponse } from '../shared/feed-pipeline.ts';

const BASE = 'http://localhost:3000';
const DAY = 86_400_000;

let env: Env;
let me: string;
let bo: string;

interface SeedPost {
  id: string;
  author: string;
  body?: string;
  ageMin?: number;
  expiresInMs?: number;
  status?: string;
}

async function insertPost(p: SeedPost): Promise<void> {
  const created = new Date(Date.now() - (p.ageMin ?? 1) * 60_000).toISOString();
  const expires = new Date(Date.now() + (p.expiresInMs ?? 10 * DAY)).toISOString();
  await env.DB.prepare('INSERT INTO posts (id, author_id, body, created_at, expires_at, status) VALUES (?,?,?,?,?,?)')
    .bind(p.id, p.author, p.body ?? `hello from ${p.id}`, created, expires, p.status ?? 'active')
    .run();
}

async function seedMany(n: number, author = 'ana', prefix = 'pst'): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `${prefix}_${String(i).padStart(3, '0')}`;
    await insertPost({ id, author, ageMin: i + 1 });
    ids.push(id);
  }
  return ids;
}

const get = (path: string, cookie = me) => call(env, 'GET', path, { cookie });
const batchOf = (r: { json: unknown }) => (r.json as FeedBatchResponse).batch;
const idsOf = (r: { json: unknown }) => batchOf(r).posts.map((p) => p.id);

async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

beforeEach(async () => {
  env = await makeEnv();
  me = await seedUser(env, 'usr_me', 'me');
  await seedUser(env, 'ana', 'ana');
  bo = await seedUser(env, 'bo', 'bo');
});

describe('GET /api/v1/feed/bootstrap', () => {
  it('requires a signed-in user', async () => {
    const res = await call(env, 'GET', '/api/v1/feed/bootstrap');
    expect(res.status).toBe(401);
  });

  it('returns one batch with the pipeline metadata on every post', async () => {
    await seedMany(3);
    const res = await get('/api/v1/feed/bootstrap');
    expect(res.status).toBe(200);
    const body = res.json as FeedBatchResponse;
    expect(body).toMatchObject({ version: 1, mode: 'for_you', kind: 'bootstrap' });
    expect(body.config).toMatchObject({ lowWaterMark: 15, batchSize: 40 });
    expect(body.batch.posts).toHaveLength(3);
    expect(body.batch.counts).toEqual({ safe: 3, wild: 0 });
    for (const p of body.batch.posts) {
      expect(p.meta).toMatchObject({ isWild: false, safetyScore: 1, likesCount: 0, tags: [] });
      expect(p.meta.timestamp).toBe(Date.parse(p.created_at));
      expect(p.meta.trendingScore).toBeGreaterThanOrEqual(0);
      expect(p.moderation).toBe('SAFE');
      expect(p.author_username).toBe('ana');
    }
    expect(body.batch.posts.map((p) => p.id)).toEqual(['pst_000', 'pst_001', 'pst_002']); // newest first
    expect(body.batch.hasMore).toBe(false);
    expect(body.batch.nextCursor).toBeNull();
  });

  it('is never cacheable by a shared cache', async () => {
    const res = await get('/api/v1/feed/bootstrap');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Vary')).toContain('Accept-Encoding');
  });

  it('rejects an unknown mode', async () => {
    expect((await get('/api/v1/feed/bootstrap?mode=chronological')).status).toBe(400);
  });

  it('ignores other methods', async () => {
    const res = await call(env, 'POST', '/api/v1/feed/bootstrap', { cookie: me, json: {} });
    expect(res.status).not.toBe(200);
  });
});

describe('batch size and paging', () => {
  it('clamps the requested size into 30..50 and defaults to 40', async () => {
    await seedMany(60);
    expect(batchOf(await get('/api/v1/feed/bootstrap')).posts).toHaveLength(40);
    expect(batchOf(await get('/api/v1/feed/bootstrap?size=5')).posts).toHaveLength(30);
    expect(batchOf(await get('/api/v1/feed/bootstrap?size=999')).posts).toHaveLength(50);
  });

  it('next continues exactly where bootstrap stopped: no repeats, no gaps, until hasMore is false', async () => {
    const all = await seedMany(95);
    const first = await get('/api/v1/feed/bootstrap?size=40');
    expect(batchOf(first).hasMore).toBe(true);
    const seen = [...idsOf(first)];
    let cursor = batchOf(first).nextCursor;
    let guard = 0;
    while (cursor && guard++ < 10) {
      const next = await get(`/api/v1/feed/next?size=40&cursor=${encodeURIComponent(cursor)}`);
      expect(next.status).toBe(200);
      expect((next.json as FeedBatchResponse).kind).toBe('next');
      seen.push(...idsOf(next));
      cursor = batchOf(next).nextCursor;
    }
    expect(seen).toEqual(all); // positive control: everything came back, in order, exactly once
    expect(new Set(seen).size).toBe(95);
  });

  it('keeps posts with the same timestamp in a stable order across the page boundary', async () => {
    const created = new Date(Date.now() - 60_000).toISOString();
    const expires = new Date(Date.now() + 5 * DAY).toISOString();
    for (let i = 0; i < 35; i++) {
      await env.DB.prepare('INSERT INTO posts (id, author_id, body, created_at, expires_at, status) VALUES (?,?,?,?,?,?)')
        .bind(`same_${String(i).padStart(2, '0')}`, 'ana', 'x', created, expires, 'active')
        .run();
    }
    const first = await get('/api/v1/feed/bootstrap?size=30');
    const next = await get(`/api/v1/feed/next?size=30&cursor=${encodeURIComponent(batchOf(first).nextCursor!)}`);
    expect([...idsOf(first), ...idsOf(next)]).toHaveLength(35);
    expect(new Set([...idsOf(first), ...idsOf(next)]).size).toBe(35);
  });

  it('next needs a valid cursor', async () => {
    expect((await get('/api/v1/feed/next')).status).toBe(400);
    expect((await get('/api/v1/feed/next?cursor=garbage')).status).toBe(400);
  });
});

describe('who can see what', () => {
  it('hides posts of blocked users in both directions, but still returns everyone else (positive control)', async () => {
    await insertPost({ id: 'p_ana', author: 'ana' });
    await insertPost({ id: 'p_bo', author: 'bo' });
    await env.DB.prepare('INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?,?,?)')
      .bind('usr_me', 'ana', new Date().toISOString())
      .run();
    expect(idsOf(await get('/api/v1/feed/bootstrap'))).toEqual(['p_bo']);

    await env.DB.prepare('DELETE FROM blocks').run();
    await env.DB.prepare('INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?,?,?)')
      .bind('bo', 'usr_me', new Date().toISOString())
      .run();
    expect(idsOf(await get('/api/v1/feed/bootstrap'))).toEqual(['p_ana']);
  });

  it('leaves out expired and removed posts and posts the viewer marked not interested', async () => {
    await insertPost({ id: 'ok', author: 'ana', ageMin: 5 });
    await insertPost({ id: 'expired', author: 'ana', expiresInMs: -1000 });
    await insertPost({ id: 'removed', author: 'ana', status: 'removed' });
    await insertPost({ id: 'nope', author: 'ana' });
    await env.DB.prepare('INSERT INTO feedback (id, user_id, post_id, type, created_at) VALUES (?,?,?,?,?)')
      .bind('f1', 'usr_me', 'nope', 'not_interested', new Date().toISOString())
      .run();
    expect(idsOf(await get('/api/v1/feed/bootstrap'))).toEqual(['ok']);
  });

  it('following mode returns only the viewer and the people they follow', async () => {
    await insertPost({ id: 'mine', author: 'usr_me', ageMin: 3 });
    await insertPost({ id: 'ana1', author: 'ana', ageMin: 2 });
    await insertPost({ id: 'bo1', author: 'bo', ageMin: 1 });
    await env.DB.prepare('INSERT INTO follows (follower_id, followed_id, created_at) VALUES (?,?,?)')
      .bind('usr_me', 'ana', new Date().toISOString())
      .run();
    const res = await get('/api/v1/feed/bootstrap?mode=following');
    expect((res.json as FeedBatchResponse).mode).toBe('following');
    expect(idsOf(res)).toEqual(['ana1', 'mine']);
    expect(idsOf(await get('/api/v1/feed/bootstrap?mode=for_you'))).toEqual(['bo1', 'ana1', 'mine']);
  });
});

describe('SAFE and WILD tagging', () => {
  it('puts reported and spam-like posts in the WILD pool next to the SAFE ones, and ignores dismissed reports', async () => {
    await insertPost({ id: 'clean', author: 'ana', ageMin: 1 });
    await insertPost({ id: 'one_report', author: 'ana', ageMin: 2 });
    await insertPost({ id: 'two_reports', author: 'ana', ageMin: 3 });
    await insertPost({ id: 'dismissed', author: 'ana', ageMin: 4 });
    await insertPost({ id: 'spammy', author: 'ana', ageMin: 5, body: 'FREE MONEY click here www.a.xyz www.b.xyz' });
    const report = async (id: string, post: string, reporter: string, status = 'pending') =>
      env.DB.prepare('INSERT INTO reports (id, reporter_id, target_type, target_id, reason, status, created_at) VALUES (?,?,?,?,?,?,?)')
        .bind(id, reporter, 'post', post, 'spam', status, new Date().toISOString())
        .run();
    await report('r1', 'one_report', 'bo');
    await report('r2', 'two_reports', 'bo');
    await report('r3', 'two_reports', 'usr_me');
    await report('r4', 'dismissed', 'bo', 'dismissed');
    await report('r5', 'dismissed', 'usr_me', 'dismissed');
    await report('r6', 'two_reports', 'bo'); // same person twice still counts once

    const res = await get('/api/v1/feed/bootstrap');
    const byId = new Map(batchOf(res).posts.map((p) => [p.id, p]));
    expect(byId.get('clean')!.meta).toMatchObject({ isWild: false, safetyScore: 1 });
    expect(byId.get('one_report')!.meta.isWild).toBe(false);
    expect(byId.get('one_report')!.meta.safetyScore).toBe(0.75);
    expect(byId.get('two_reports')!.meta.isWild).toBe(true);
    expect(byId.get('two_reports')!.moderation).toBe('WILD');
    expect(byId.get('dismissed')!.meta.isWild).toBe(false);
    expect(byId.get('spammy')!.meta.isWild).toBe(true);
    expect(batchOf(res).counts).toEqual({ safe: 3, wild: 2 }); // both pools are in the same batch
  });

  it('reports on comments, users or other posts do not affect a post', async () => {
    await insertPost({ id: 'p1', author: 'ana' });
    await env.DB.prepare('INSERT INTO reports (id, reporter_id, target_type, target_id, reason, status, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind('r1', 'bo', 'user', 'p1', 'x', 'pending', new Date().toISOString())
      .run();
    expect(batchOf(await get('/api/v1/feed/bootstrap')).posts[0]!.meta.isWild).toBe(false);
  });
});

describe('engagement, tags and trending', () => {
  it('reports likes, topic tags and a trending score that rises with a hot topic', async () => {
    await insertPost({ id: 'hot', author: 'ana', ageMin: 30 });
    await insertPost({ id: 'cold', author: 'ana', ageMin: 30 });
    await env.DB.prepare("INSERT INTO topics (id, slug, display_name) VALUES ('t1','exams','Exams')").run();
    await env.DB.prepare("INSERT INTO post_topics (post_id, topic_id, confidence) VALUES ('hot','t1',1)").run();
    await env.DB.prepare("INSERT INTO trend_snapshots (id, topic_id, window, window_start, score) VALUES ('s1','t1','24h',?,5)")
      .bind(new Date().toISOString())
      .run();
    for (const u of ['ana', 'bo', 'usr_me']) {
      await env.DB.prepare("INSERT INTO post_reactions (post_id, user_id, type, created_at) VALUES ('hot',?,'like',?)")
        .bind(u, new Date().toISOString())
        .run();
    }
    const res = await get('/api/v1/feed/bootstrap');
    const byId = new Map(batchOf(res).posts.map((p) => [p.id, p]));
    expect(byId.get('hot')!.meta).toMatchObject({ likesCount: 3, tags: ['exams'] });
    expect(byId.get('hot')!.likes_count).toBe(3);
    expect(byId.get('hot')!.meta.trendingScore).toBeGreaterThan(byId.get('cold')!.meta.trendingScore);
    expect(byId.get('cold')!.meta.tags).toEqual([]);
    expect((res.json as FeedBatchResponse).trending).toEqual({ exams: 1 });
  });
});

describe('compression', () => {
  const raw = (path: string, headers: Record<string, string> = {}) =>
    worker.fetch(new Request(`${BASE}${path}`, { headers: { Cookie: me, ...headers } }), env);

  it('gzips a big batch when the caller accepts gzip, and the body decodes to the same JSON', async () => {
    await seedMany(45);
    const plain = await raw('/api/v1/feed/bootstrap?size=40');
    expect(plain.headers.get('Content-Encoding')).toBeNull();
    const plainText = await plain.text();

    const zipped = await raw('/api/v1/feed/bootstrap?size=40', { 'Accept-Encoding': 'gzip, deflate, br' });
    expect(zipped.headers.get('Content-Encoding')).toBe('gzip');
    const bytes = new Uint8Array(await zipped.arrayBuffer());
    expect(Number(zipped.headers.get('Content-Length'))).toBe(bytes.byteLength);
    expect(bytes.byteLength).toBeLessThan(plainText.length / 2);
    expect(Number(zipped.headers.get('X-Uncompressed-Bytes'))).toBe(new TextEncoder().encode(plainText).byteLength);

    const a = JSON.parse(await gunzip(bytes)) as FeedBatchResponse;
    const b = JSON.parse(plainText) as FeedBatchResponse;
    expect(a.batch.posts.map((p) => p.id)).toEqual(b.batch.posts.map((p) => p.id));
    expect(a.batch.posts).toHaveLength(40);
  });

  it('does not bother compressing a tiny batch', async () => {
    const res = await raw('/api/v1/feed/bootstrap', { 'Accept-Encoding': 'gzip' });
    expect(res.headers.get('Content-Encoding')).toBeNull();
    expect(((await res.json()) as FeedBatchResponse).batch.posts).toEqual([]);
  });
});

describe('rate limit', () => {
  it('answers 429 with Retry-After after 30 requests in a minute', async () => {
    for (let i = 0; i < 30; i++) expect((await get('/api/v1/feed/bootstrap')).status).toBe(200);
    const res = await get('/api/v1/feed/bootstrap');
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    // another person is not affected
    expect((await get('/api/v1/feed/bootstrap', bo)).status).toBe(200);
  });
});

describe('the existing /api/feed is untouched', () => {
  it('still answers', async () => {
    await insertPost({ id: 'p1', author: 'ana' });
    const res = await get('/api/feed?mode=for_you');
    expect(res.status).toBe(200);
    expect(res.json.posts).toHaveLength(1);
    expect(res.json.posts[0].meta).toBeUndefined();
  });
});
