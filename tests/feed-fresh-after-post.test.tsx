// @vitest-environment jsdom
// The bug: a brand-new post did not appear in your own For You feed, even after a reload, because the stored feed was
// trusted for 5 minutes. Posting now marks the stored feed stale, and the viewer's own fresh posts lead their feed.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FeedCacheManager, LocalPersonalization, createPipelineFeedSource, invalidateFeedFor, OWN_POST_LEAD_MS, type StorageLike } from '../src/feed-pipeline/index.ts';
import { PostComposerPage } from '../src/pages/PostComposerPage.tsx';
import { mount, click, typeInto, byText, installFetch, json, type Mounted } from './_ui.tsx';
import { FakeFeedServer, makePost, T0 } from './_pipeline.ts';

let clock: { t: number };
let server: FakeFeedServer;
const open: FeedCacheManager[] = [];
let m: Mounted | null = null;
const restores: Array<() => void> = [];

const memStorage = (): StorageLike => {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
};
function cache(userId = 'me', mode: 'for_you' | 'following' = 'for_you'): FeedCacheManager {
  const c = new FeedCacheManager({ userId, mode, fetchBatch: server.fetcher, now: () => clock.t, isOnline: () => true, batchSize: 30 });
  open.push(c);
  return c;
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  clock = { t: T0 };
  server = new FakeFeedServer(Array.from({ length: 40 }, (_, i) => makePost(i + 1)));
});
afterEach(async () => {
  m?.unmount();
  m = null;
  restores.splice(0).forEach((r) => r());
  document.body.innerHTML = '';
  await Promise.all(open.splice(0).map((c) => c.destroy()));
});

describe('invalidateFeedFor', () => {
  it('marks both feed modes stale, so the next start asks the server even a few seconds later', async () => {
    await cache('me', 'for_you').start();
    server.mode = 'following';
    await cache('me', 'following').start();
    server.mode = 'for_you';
    await invalidateFeedFor('me');
    for (const mode of ['for_you', 'following'] as const) {
      server.mode = mode;
      server.calls = [];
      clock.t += 3_000; // young, and 40 unseen posts stored: only the owed refresh can ask the server
      await cache('me', mode).start();
      expect(server.calls.filter((c) => c.kind === 'bootstrap')).toHaveLength(1);
    }
  });

  it('does not touch another person on the same device', async () => {
    await cache('other').start();
    await invalidateFeedFor('me');
    server.calls = [];
    clock.t += 3_000;
    await cache('other').start();
    expect(server.calls).toHaveLength(0); // nothing was owed to the other person
  });
});

describe('posting from the composer', () => {
  it('marks the stored feed stale before going back to the feed, and the new post is then fetched and first', async () => {
    await cache('me').start();
    const created = vi.fn();
    const net = installFetch({ 'POST /api/posts': () => json({ id: 'new' }, 201) });
    restores.push(net.restore);
    m = await mount(<PostComposerPage currentUserId="me" onPostCreated={created} />);
    await typeInto(m.container.querySelector('textarea')!, 'hello');
    await click(byText(m.container, 'button', 'Post') as HTMLButtonElement);
    await vi.waitFor(() => expect(created).toHaveBeenCalled(), { timeout: 3000 }); // after the feed is marked as owing a refresh

    // the feed opens a few seconds later: it must ask the server, and show the new post first
    server.posts = [makePost(0, { author: 'me', ageMin: 0 }), ...server.posts];
    clock.t += 4_000;
    const reopened = cache('me');
    const source = createPipelineFeedSource({ cache: reopened, personalization: new LocalPersonalization({ userId: 'me', storage: memStorage(), now: () => clock.t }) });
    const { items } = await source.load('SAFE', 8);
    expect(items[0]!.id).toBe('p000');
  });
});

describe('the viewer\'s own new post leads their feed', () => {
  const rankOf = async (posts: ReturnType<typeof makePost>[], nowMs: number) => {
    server = new FakeFeedServer(posts);
    clock.t = nowMs;
    const personalization = new LocalPersonalization({ userId: 'me', storage: memStorage(), now: () => nowMs });
    const source = createPipelineFeedSource({ cache: cache('me'), personalization });
    return (await source.load('SAFE', 8)).items.map((p) => p.id);
  };

  it('an own post from the last 10 minutes comes first even when other posts would rank above it', async () => {
    const mine = makePost(1, { author: 'me', ageMin: 5, likes: 0 });
    const hot = Array.from({ length: 6 }, (_, i) => makePost(10 + i, { author: `a${i}`, ageMin: 1, likes: 50, trending: 1 }));
    const order = await rankOf([...hot, mine], T0);
    expect(order[0]).toBe(mine.id);
  });

  it('an older own post gets no special place', async () => {
    const mine = makePost(1, { author: 'me', ageMin: Math.round(OWN_POST_LEAD_MS / 60_000) + 30, likes: 0 });
    const hot = Array.from({ length: 6 }, (_, i) => makePost(10 + i, { author: `a${i}`, ageMin: 1, likes: 50, trending: 1 }));
    const order = await rankOf([...hot, mine], T0);
    expect(order[0]).not.toBe(mine.id);
  });
});
