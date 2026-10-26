// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FeedCacheManager, FeedHttpError, FeedUnavailableError, type FeedCacheOptions } from '../src/feed-pipeline/FeedCacheManager.ts';
import { FakeFeedServer, makePost, T0 } from './_pipeline.ts';

const MIN = 60_000;
let clock: { t: number };
let server: FakeFeedServer;
const managers: FeedCacheManager[] = [];

function make(over: Partial<FeedCacheOptions> = {}): FeedCacheManager {
  const m = new FeedCacheManager({
    userId: 'u1',
    mode: 'for_you',
    fetchBatch: server.fetcher,
    now: () => clock.t,
    isOnline: () => true,
    batchSize: 30,
    ...over,
  });
  managers.push(m);
  return m;
}

const ids = (posts: Array<{ id: string }>) => posts.map((p) => p.id);
const posts = (n: number) => Array.from({ length: n }, (_, i) => makePost(i + 1));

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory(); // a brand new empty database for every test
  clock = { t: T0 };
  server = new FakeFeedServer(posts(100));
});
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.destroy()));
});

describe('writing and reading batches', () => {
  it('a cold start asks the server once and stores the whole batch, newest first', async () => {
    const m = make();
    expect(await m.start()).toEqual({ source: 'network', stale: false });
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]).toMatchObject({ kind: 'bootstrap', params: { mode: 'for_you', cursor: null, size: 30 } });
    const pool = await m.getPool();
    expect(ids(pool)).toEqual(ids(posts(30)));
    expect(await m.getStats()).toMatchObject({ unviewed: 30, viewed: 0, total: 30, backend: 'indexeddb', hasMore: true });
  });

  it('really lands in IndexedDB: a second manager (a reload) sees it with no server call', async () => {
    await make().start();
    server.calls = [];
    const again = make();
    expect(await again.start()).toEqual({ source: 'cache', stale: false });
    expect(server.calls).toHaveLength(0);
    expect((await again.getPool()).length).toBe(30);
  });

  it('keeps what the person already did when the same post arrives again, but takes the fresh data', async () => {
    const m = make();
    await m.start();
    await m.markViewed(['p001', 'p002']);
    const refreshed = posts(100).map((p) => ({ ...p, likes_count: 9, has_liked: true }));
    server.posts = refreshed;
    await m.bootstrap();
    const history = await m.getHistory();
    expect(ids(history.map((h) => h.post))).toEqual(['p002', 'p001']);
    expect(history[0]!.post.likes_count).toBe(9); // fresh data
    expect(history.map((h) => h.viewSeq)).toEqual([2, 1]); // old history
    expect(ids(await m.getPool())).not.toContain('p001');
  });

  it('loadMore continues from the stored cursor and ends cleanly', async () => {
    const m = make();
    await m.start();
    expect(await m.loadMore()).toBe(30);
    expect(await m.loadMore()).toBe(30);
    expect(await m.loadMore()).toBe(10);
    expect(await m.hasMore()).toBe(false);
    server.calls = [];
    expect(await m.loadMore()).toBe(0);
    expect(server.calls).toHaveLength(0);
    expect(ids(await m.getPool())).toEqual(ids(posts(100)));
  });

  it('stores the trending weights from the batch', async () => {
    server.trending = { exams: 1, sports: 0.4 };
    const m = make();
    await m.start();
    expect(await m.getTrending()).toEqual({ exams: 1, sports: 0.4 });
  });

  it('refuses a response for another feed mode', async () => {
    const m = make({ mode: 'following' });
    await expect(m.bootstrap()).rejects.toThrow(/different feed/);
    expect((await m.getStats()).total).toBe(0);
  });
});

describe('viewed state and history', () => {
  it('numbers posts in the order they were first viewed, and later views do not renumber them', async () => {
    const m = make();
    await m.start();
    expect(await m.markViewed(['p003', 'p001', 'nope'])).toBe(2);
    await m.markViewed(['p001', 'p002']);
    const h = await m.getHistory();
    expect(h.map((e) => [e.post.id, e.viewSeq])).toEqual([['p002', 3], ['p001', 2], ['p003', 1]]);
    const stats = await m.getStats();
    expect(stats).toMatchObject({ viewed: 3, unviewed: 27 });
    expect(await m.markViewed([])).toBe(0);
  });

  it('dwell time is added without counting as another view', async () => {
    const m = make();
    await m.start();
    await m.markViewed(['p001']);
    await m.recordDwell([{ id: 'p001', dwellMs: 4000 }, { id: 'p002', dwellMs: 2500 }]);
    const h = await m.getHistory();
    expect(ids(h.map((e) => e.post))).toEqual(['p002', 'p001']); // p002 became viewed by its dwell
  });

  it('scrolling back up reads whole frames from the phone with NO network call, nearest first', async () => {
    const m = make();
    await m.start();
    await m.markViewed(ids(posts(8)));
    await m.markViewed(ids(posts(16).slice(8)));
    await m.markViewed(ids(posts(24).slice(16)));
    server.calls = [];

    const first = await m.getHistoryFrames({ frameSize: 8, frames: 2 });
    expect(first).toHaveLength(2);
    expect(ids(first[0]!.items)).toEqual(ids(posts(24).slice(16))); // the frame just above, in the order it was shown
    expect(ids(first[1]!.items)).toEqual(ids(posts(16).slice(8)));

    const rest = await m.getHistoryFrames({ frameSize: 8, frames: 2, beforeSeq: first[1]!.firstSeq });
    expect(rest).toHaveLength(1);
    expect(ids(rest[0]!.items)).toEqual(ids(posts(8)));
    expect(await m.getHistoryFrames({ frameSize: 8, beforeSeq: rest[0]!.firstSeq })).toEqual([]);
    expect(server.calls).toHaveLength(0);
  });

  it('survives a reload: history is still there for a new manager', async () => {
    const a = make();
    await a.start();
    await a.markViewed(['p005', 'p006']);
    const b = make();
    expect(ids((await b.getHistory()).map((e) => e.post))).toEqual(['p006', 'p005']);
  });

  it('concurrent writes never lose a view (a batch landing while posts are being marked)', async () => {
    const m = make();
    await m.start();
    await Promise.all([m.markViewed(['p001']), m.loadMore(), m.markViewed(['p002']), m.bootstrap(), m.markViewed(['p003'])]);
    expect((await m.getHistory()).map((e) => e.post.id).sort()).toEqual(['p001', 'p002', 'p003']);
  });
});

describe('background pre-fetch', () => {
  it('does nothing while enough unseen posts are stored', async () => {
    const m = make();
    await m.start();
    expect(await m.prefetchIfLow()).toBe(false);
    expect(server.nextCalls).toBe(0);
  });

  it('fetches the next batch once the unseen stock drops below the low-water mark, and only one at a time', async () => {
    const m = make({ lowWaterMark: 15 });
    await m.start();
    await m.markViewed(ids(posts(20))); // 10 left
    const [a, b, c] = await Promise.all([m.prefetchIfLow(), m.prefetchIfLow(), m.prefetchIfLow()]);
    expect([a, b, c]).toEqual([true, true, true]); // they share one attempt
    expect(server.nextCalls).toBe(1);
    expect(server.calls.at(-1)!.params.cursor).not.toBeNull();
    expect((await m.getPool()).length).toBe(40);
    expect(await m.prefetchIfLow()).toBe(false); // stocked again
  });

  it('uses the caller\'s own count when it has one', async () => {
    const m = make();
    await m.start();
    expect(await m.prefetchIfLow(3)).toBe(true);
    expect(server.nextCalls).toBe(1);
  });

  it('stops when the server has nothing older', async () => {
    server.posts = posts(30);
    const m = make();
    await m.start();
    await m.markViewed(ids(posts(30)));
    expect(await m.prefetchIfLow()).toBe(false);
    expect(server.nextCalls).toBe(0);
  });

  it('does not call the server while offline', async () => {
    let online = true;
    const m = make({ isOnline: () => online });
    await m.start();
    await m.markViewed(ids(posts(25)));
    online = false;
    expect(await m.prefetchIfLow()).toBe(false);
    expect(server.nextCalls).toBe(0);
    await expect(m.loadMore()).rejects.toBeInstanceOf(FeedUnavailableError);
  });

  it('backs off after a failure instead of hammering, then tries again', async () => {
    const m = make({ retryBackoffMs: 15_000 });
    await m.start();
    await m.markViewed(ids(posts(25)));
    server.failWith = new TypeError('Failed to fetch');
    expect(await m.prefetchIfLow()).toBe(false);
    expect(server.nextCalls).toBe(1);
    expect(await m.prefetchIfLow()).toBe(false);
    expect(server.nextCalls).toBe(1); // inside the backoff window: no new request
    clock.t += 16_000;
    server.failWith = null;
    expect(await m.prefetchIfLow()).toBe(true);
    expect(server.nextCalls).toBe(2);
  });

  it('catches up when the connection comes back', async () => {
    let online = false;
    const m = make({ isOnline: () => online });
    server.failWith = null;
    await m.start().catch(() => undefined); // offline: cannot bootstrap (nothing stored)
    expect(server.calls).toHaveLength(0);
    online = true;
    await m.bootstrap();
    await m.markViewed(ids(posts(25)));
    online = false;
    const stop = m.watchConnectivity();
    online = true;
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(server.nextCalls).toBe(1));
    stop();
  });
});

describe('offline', () => {
  it('serves what is stored when the server cannot be reached, flagged stale', async () => {
    await make().start();
    clock.t += 10 * MIN; // older than the 5 minute freshness window
    server.failWith = new TypeError('Failed to fetch');
    const m = make();
    expect(await m.start()).toEqual({ source: 'cache', stale: true });
    expect((await m.getPool()).length).toBe(30);
  });

  it('with only history stored it still starts', async () => {
    const a = make();
    await a.start();
    await a.markViewed(ids(posts(30)));
    server.failWith = new TypeError('Failed to fetch');
    const b = make();
    expect(await b.start()).toEqual({ source: 'cache', stale: true });
    const offline = await b.readOffline();
    expect(offline.unviewed).toEqual([]);
    expect(offline.history).toHaveLength(30);
    expect(offline.history[0]!.id).toBe('p030'); // most recently first-viewed first
  });

  it('throws a clear error when offline and nothing is stored', async () => {
    server.failWith = new TypeError('Failed to fetch');
    await expect(make().start()).rejects.toBeInstanceOf(FeedUnavailableError);
    await expect(make({ isOnline: () => false }).start()).rejects.toThrow(/offline/i);
  });

  it('passes a signed-out response through instead of hiding it behind the cache', async () => {
    await make().start();
    clock.t += 10 * MIN;
    server.failWith = new FeedHttpError(401, 'Unauthorized');
    const m = make();
    // stale cache is still served (the person is only refreshing in the background)...
    expect((await m.start()).source).toBe('cache');
    // ...but a cold start with a 401 is an error, not an empty "offline" feed
    await expect(make({ userId: 'someone-else' }).start()).rejects.toMatchObject({ status: 401 });
  });
});

describe('a stale cache', () => {
  it('is used immediately and refreshed in the background', async () => {
    await make().start();
    server.calls = [];
    clock.t += 6 * MIN;
    const m = make();
    expect(await m.start()).toEqual({ source: 'cache', stale: true });
    await vi.waitFor(() => expect(server.calls.filter((c) => c.kind === 'bootstrap')).toHaveLength(1));
  });
});

describe('expiry, sign-out and isolation', () => {
  it('never stores an already-expired post and forgets posts when they expire', async () => {
    server.posts = [
      makePost(1, { expiresInDays: -1 }),
      makePost(2, { expiresInDays: 1 }),
      makePost(3, { expiresInDays: 10 }),
      makePost(4, { expiresInDays: 1 }),
    ];
    const m = make();
    await m.start();
    expect(ids(await m.getPool())).toEqual(['p002', 'p003', 'p004']); // p001 was never stored
    await m.markViewed(['p002']); // p002 is history, p004 is still unseen

    clock.t += 2 * 86_400_000;
    expect(ids(await m.getPool())).toEqual(['p003']); // the unseen one is hidden the moment it expires...
    expect(await m.getHistory()).toEqual([]); // ...and so is the viewed one
    expect((await m.readOffline()).unviewed.map((p) => p.id)).toEqual(['p003']);
    expect(await m.purgeExpired()).toBe(2); // both deleted on the next purge
    expect((await m.getStats()).total).toBe(1);
  });

  it('clear() forgets one person completely and leaves another person on the same phone alone', async () => {
    const a = make({ userId: 'alice' });
    const b = make({ userId: 'bob' });
    await a.start();
    await b.start();
    await a.markViewed(['p001']);
    await b.markViewed(['p002']);

    await a.clear();
    expect(await a.getStats()).toMatchObject({ total: 0, bootstrappedAt: null });
    expect(await a.getHistory()).toEqual([]);
    expect(ids((await b.getHistory()).map((e) => e.post))).toEqual(['p002']);
    expect((await b.getPool()).length).toBe(29);
  });

  it('keeps For you and Following apart, even for the same post', async () => {
    const forYou = make({ mode: 'for_you' });
    const followingServer = new FakeFeedServer(posts(40), 'following');
    const following = make({ mode: 'following', fetchBatch: followingServer.fetcher });
    await forYou.start();
    await following.start();
    await forYou.markViewed(['p001']);
    expect((await following.getHistory()).length).toBe(0);
    expect(ids(await following.getPool())).toContain('p001');
    await forYou.clear(); // clears every mode for this person
    expect((await following.getStats()).total).toBe(0);
  });
});

describe('limits and failure modes', () => {
  it('bounds history by evicting the oldest viewed posts, never the unseen ones', async () => {
    server.posts = posts(60);
    const m = make({ maxRecords: 40, batchSize: 30 });
    await m.start();
    await m.markViewed(ids(posts(30)));
    await m.loadMore(); // 60 stored, cap 40: 20 oldest viewed go
    const stats = await m.getStats();
    expect(stats.total).toBe(40);
    expect(stats.unviewed).toBe(30); // every unseen post is still there
    const history = await m.getHistory();
    expect(history).toHaveLength(10);
    expect(history[0]!.post.id).toBe('p030'); // the newest views were kept
  });

  it('falls back to memory when IndexedDB cannot be opened, and keeps working', async () => {
    globalThis.indexedDB = {
      open() {
        throw new Error('SecurityError: storage disabled');
      },
    } as unknown as IDBFactory;
    const m = make();
    expect(await m.start()).toEqual({ source: 'network', stale: false });
    await m.markViewed(['p001']);
    expect(await m.getStats()).toMatchObject({ backend: 'memory', viewed: 1, unviewed: 29 });
  });

  it('works with no IndexedDB at all', async () => {
    const m = make({ storage: 'memory' });
    await m.start();
    expect((await m.getStats()).backend).toBe('memory');
    expect((await m.getPool()).length).toBe(30);
  });

  it('switches to memory instead of failing when a write throws', async () => {
    const m = make();
    await m.start();
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    await m.markViewed(['p001']);
    spy.mockRestore();
    expect((await m.getStats()).backend).toBe('memory');
  });
});
