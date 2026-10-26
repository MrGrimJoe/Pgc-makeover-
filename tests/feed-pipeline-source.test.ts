// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FeedFrameManager, MODERATED_LAYOUT, type Frame } from '../src/feed-engine/index.ts';
import {
  FeedCacheManager,
  FeedUnavailableError,
  LocalPersonalization,
  attachHistoryTracking,
  createLocalImpressionSender,
  createPipelineFeedSource,
  type StorageLike,
} from '../src/feed-pipeline/index.ts';
import type { PipelinePost } from '../shared/feed-pipeline.ts';
import { FakeFeedServer, makePost, T0 } from './_pipeline.ts';

let clock: { t: number };
let server: FakeFeedServer;
let online: boolean;
const toClean: Array<{ destroy(): unknown }> = [];

const memStorage = (): StorageLike => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};

function setup(opts: { layout?: typeof MODERATED_LAYOUT; frameSize?: number; userId?: string; storage?: StorageLike } = {}) {
  const cache = new FeedCacheManager({
    userId: opts.userId ?? 'u1',
    mode: 'for_you',
    fetchBatch: server.fetcher,
    now: () => clock.t,
    isOnline: () => online,
    batchSize: 30,
    retryBackoffMs: 0,
  });
  const personalization = new LocalPersonalization({ userId: opts.userId ?? 'u1', storage: opts.storage ?? memStorage(), now: () => clock.t });
  const source = createPipelineFeedSource({ cache, personalization });
  const manager = new FeedFrameManager<PipelinePost>({ source, layout: opts.layout, frameSize: opts.frameSize ?? 8 });
  toClean.push(cache);
  return { cache, personalization, source, manager };
}

const ids = (f: Frame<PipelinePost> | undefined) => (f?.items ?? []).map((p) => p.id);
/** Builds frames 0..n-1 the way scrolling would. */
async function buildFrames(m: FeedFrameManager<PipelinePost>, n: number) {
  await m.focus(n - 1);
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  clock = { t: T0 };
  online = true;
  server = new FakeFeedServer(Array.from({ length: 100 }, (_, i) => makePost(i + 1)));
});
afterEach(async () => {
  await Promise.all(toClean.splice(0).map((c) => c.destroy()));
});

describe('the frame engine fed by the pipeline', () => {
  it('builds SAFE frames from a server batch (default layout: no WILD, no Mid-Frame)', async () => {
    server.posts = Array.from({ length: 60 }, (_, i) => makePost(i + 1, { wild: i % 4 === 3 }));
    const { manager } = setup();
    await buildFrames(manager, 3);
    for (let i = 0; i < 3; i++) {
      const f = manager.getFrame(i)!;
      expect(f.kind).toBe('SAFE');
      expect(f.items).toHaveLength(8);
      expect(f.items.every((p) => !p.meta.isWild)).toBe(true);
    }
    manager.destroy();
  });

  it('with the moderated layout, SAFE frames hold only SAFE posts and WILD frames only WILD posts', async () => {
    server.posts = Array.from({ length: 100 }, (_, i) => makePost(i + 1, { wild: i % 3 === 0 }));
    const { manager } = setup({ layout: MODERATED_LAYOUT });
    await buildFrames(manager, 6);
    const kinds = new Set<string>();
    for (let i = 0; i < manager.getFrameCount(); i++) {
      const f = manager.getFrame(i)!;
      kinds.add(f.kind);
      if (f.kind === 'SAFE') expect(f.items.every((p) => !p.meta.isWild && p.moderation === 'SAFE')).toBe(true);
      if (f.kind === 'WILD') expect(f.items.length > 0 && f.items.every((p) => p.meta.isWild && p.moderation === 'WILD')).toBe(true);
      if (f.kind === 'MID') expect(f.items).toEqual([]);
    }
    expect([...kinds].sort()).toEqual(['MID', 'SAFE', 'WILD']);
    manager.destroy();
  });

  it('re-ranks the cached batch with local preferences before framing, using the one bootstrap call', async () => {
    const { manager, personalization } = setup();
    // posts 21..30 are 21+ minutes old (inside the first batch of 30) and carry a tag the person likes
    server.posts = Array.from({ length: 80 }, (_, i) => makePost(i + 1, { tags: i >= 20 && i < 30 ? ['sports'] : ['misc'], author: `a${i}` }));
    for (let i = 0; i < 4; i++) personalization.recordTagClick('sports');
    await manager.focus(0);
    expect(server.calls.filter((c) => c.kind === 'bootstrap')).toHaveLength(1);
    const first = manager.getFrame(0)!;
    expect(first.items.filter((p) => p.meta.tags.includes('sports')).length).toBeGreaterThanOrEqual(7); // liked tag floods the top
    expect(ids(first)).not.toEqual(Array.from({ length: 8 }, (_, i) => `p${String(i + 1).padStart(3, '0')}`)); // not plain newest-first
    manager.destroy();
  });

  it('puts a newly arrived batch through the same ranking', async () => {
    const { source, personalization, cache } = setup();
    server.posts = Array.from({ length: 100 }, (_, i) => makePost(i + 1, { tags: i >= 45 && i < 55 ? ['music'] : ['misc'], author: `a${i}` }));
    const first = await source.load('SAFE', 8);
    expect(first.items.some((p) => p.meta.tags.includes('music'))).toBe(false); // batch 1 has none
    await cache.markViewed(first.items.map((p) => p.id));
    personalization.recordTagClick('music');
    personalization.recordTagClick('music');
    await cache.loadMore(); // batch 2 (posts 31..60) holds the music posts
    const next = await source.load('SAFE', 8);
    expect(next.items.filter((p) => p.meta.tags.includes('music')).length).toBeGreaterThanOrEqual(6);
  });

  it('serves every post exactly once across frames', async () => {
    server.posts = Array.from({ length: 90 }, (_, i) => makePost(i + 1));
    const { manager } = setup();
    await buildFrames(manager, 12);
    const all = Array.from({ length: manager.getFrameCount() }, (_, i) => ids(manager.getFrame(i))).flat();
    expect(all).toHaveLength(90);
    expect(new Set(all).size).toBe(90);
    manager.destroy();
  });
});

describe('history while scrolling', () => {
  it('frames that take focus become history, and scrolling back up reads it from IndexedDB with no network', async () => {
    const { manager, cache } = setup();
    attachHistoryTracking(manager, cache);
    await manager.focus(0);
    await manager.focus(1);
    await manager.focus(2);
    await vi.waitFor(async () => expect((await cache.getStats()).viewed).toBe(24));
    server.calls = [];

    const frames = await cache.getHistoryFrames({ frameSize: 8, frames: 3 });
    expect(frames.map((f) => f.items.map((p) => p.id))).toEqual([ids(manager.getFrame(2)), ids(manager.getFrame(1)), ids(manager.getFrame(0))]);
    expect(server.calls).toHaveLength(0);

    // a "reload": a brand new manager still has the history and still needs no server for it
    const reloaded = new FeedCacheManager({ userId: 'u1', mode: 'for_you', fetchBatch: server.fetcher, now: () => clock.t, isOnline: () => false });
    toClean.push(reloaded);
    expect((await reloaded.getHistoryFrames({ frameSize: 8, frames: 3 })).length).toBe(3);
    expect(server.calls).toHaveLength(0);
    manager.destroy();
  });

  it('Mid-Frames are not history', async () => {
    const { manager, cache } = setup({ layout: MODERATED_LAYOUT });
    attachHistoryTracking(manager, cache);
    await manager.focus(2); // frame 2 is the MID slot in SAFE, SAFE, MID, WILD
    await manager.focus(manager.getFrameCount() - 1);
    await vi.waitFor(async () => expect((await cache.getStats()).viewed).toBeGreaterThan(0));
    expect((await cache.getHistory({ limit: 100 })).every((e) => e.post.id.startsWith('p'))).toBe(true);
    manager.destroy();
  });
});

describe('background pre-fetch while scrolling', () => {
  it('asks for the next batch before the stock runs out, without the page waiting for it', async () => {
    const { manager, cache } = setup({ frameSize: 4 });
    attachHistoryTracking(manager, cache);
    await manager.focus(0); // frames 0 and 1 built: 8 of 30 served, 22 left (above the mark of 15)
    expect(server.nextCalls).toBe(0);
    await manager.focus(3); // 16 or more served: below the mark
    await vi.waitFor(() => expect(server.nextCalls).toBe(1));
    await vi.waitFor(async () => expect((await cache.getStats()).total).toBe(60));
    manager.destroy();
  });

  it('keeps going to the end of the feed and reports that it ended', async () => {
    server.posts = Array.from({ length: 70 }, (_, i) => makePost(i + 1));
    const { manager } = setup();
    let ended = false;
    manager.on('feedEnd', () => (ended = true));
    for (let i = 0; i < 12 && !ended; i++) await manager.focus(manager.getFrameCount());
    expect(ended).toBe(true);
    const all = Array.from({ length: manager.getFrameCount() }, (_, i) => ids(manager.getFrame(i))).flat();
    expect(new Set(all).size).toBe(70);
    manager.destroy();
  });
});

describe('offline', () => {
  it('opens from the phone with no connection: unseen posts first', async () => {
    const first = setup();
    await first.manager.focus(0);
    first.manager.destroy();

    online = false;
    server.failWith = new TypeError('Failed to fetch');
    server.calls = [];
    const again = setup();
    await again.manager.focus(1);
    expect(again.manager.getFrame(0)!.items).toHaveLength(8);
    expect(server.calls).toHaveLength(0);
    again.manager.destroy();
  });

  it('when the unseen stock is used up offline, falls back to history instead of showing an empty feed', async () => {
    server.posts = Array.from({ length: 30 }, (_, i) => makePost(i + 1));
    const a = setup();
    attachHistoryTracking(a.manager, a.cache);
    for (let i = 0; i < 4; i++) await a.manager.focus(i); // 30 posts: 8+8+8+6, all viewed
    await vi.waitFor(async () => expect((await a.cache.getStats()).viewed).toBe(30));
    a.manager.destroy();

    online = false;
    server.failWith = new TypeError('Failed to fetch');
    const b = setup();
    await b.manager.focus(0);
    expect(b.manager.getFrame(0)!.items.length).toBeGreaterThan(0);
    expect(b.manager.getStatus().error).toBeNull();
    b.manager.destroy();
  });

  it('online, after the person has seen everything the server has, a reload still shows posts (not an empty feed)', async () => {
    server.posts = Array.from({ length: 30 }, (_, i) => makePost(i + 1));
    const a = setup();
    attachHistoryTracking(a.manager, a.cache);
    for (let i = 0; i < 4; i++) await a.manager.focus(i);
    await vi.waitFor(async () => expect((await a.cache.getStats()).viewed).toBe(30));
    a.manager.destroy();

    // reload with the network up: the server has nothing the person has not seen
    const b = setup();
    await b.manager.focus(0);
    expect(b.manager.getFrame(0)!.items.length).toBeGreaterThan(0);
    expect(b.manager.getStatus().error).toBeNull();
    b.manager.destroy();
  });

  it('shows the normal error (with Try again) when offline and nothing is stored', async () => {
    online = false;
    const { manager } = setup();
    await expect(manager.focus(0)).rejects.toBeInstanceOf(FeedUnavailableError);
    expect(manager.getStatus().error).toBeInstanceOf(FeedUnavailableError);
    online = true;
    await manager.retry();
    expect(manager.getFrame(0)!.items).toHaveLength(8);
    manager.destroy();
  });

  it('a failed background batch while scrolling never breaks the frames already there', async () => {
    const { manager, cache } = setup();
    attachHistoryTracking(manager, cache);
    await manager.focus(1);
    server.failWith = new TypeError('Failed to fetch');
    await manager.focus(2);
    expect(manager.getFrame(2)!.items).toHaveLength(8);
    manager.destroy();
  });
});

describe('learning from impressions', () => {
  it('feeds on-screen time to local preferences and the history, and tolerates the upstream failing', async () => {
    const { cache, personalization, source, manager } = setup();
    await manager.focus(0);
    const post = manager.getFrame(0)!.items[0]!;
    const upstream = vi.fn().mockRejectedValue(new Error('offline'));
    const send = createLocalImpressionSender({ personalization, cache, getPost: source.getPost, upstream });
    post.meta.tags.push('exams');

    await send([
      { post_id: post.id, position: 0, duration_ms: 9000 },
      { post_id: 'unknown', position: 1, duration_ms: 9000 },
    ]);
    expect(upstream).toHaveBeenCalledOnce();
    expect(personalization.getTagWeights().exams).toBeGreaterThan(0.1);
    await vi.waitFor(async () => expect((await cache.getHistory()).map((h) => h.post.id)).toContain(post.id));
    manager.destroy();
  });
});

describe('isolation between people on one phone', () => {
  it('a second person gets their own cache and preferences', async () => {
    const a = setup({ userId: 'alice' });
    await a.manager.focus(0);
    await a.cache.markViewed(ids(a.manager.getFrame(0)));
    const b = setup({ userId: 'bob' });
    await b.manager.focus(0);
    expect((await b.cache.getHistory()).length).toBe(0);
    const bobBefore = (await b.cache.getStats()).total;
    expect(bobBefore).toBeGreaterThan(0);
    await a.cache.clear();
    expect((await a.cache.getStats()).total).toBe(0);
    expect((await b.cache.getStats()).total).toBe(bobBefore);
    a.manager.destroy();
    b.manager.destroy();
  });
});
