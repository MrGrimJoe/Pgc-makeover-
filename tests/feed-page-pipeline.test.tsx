// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flush, click, type Mounted } from './_ui.tsx';
import { FeedPage } from '../src/pages/FeedPage.tsx';
import { FeedCacheManager, forgetFeedDataFor } from '../src/feed-pipeline/index.ts';
import { FakeFeedServer, makePost } from './_pipeline.ts';
import { getScrollDirection, resetScrollDirection } from '../src/feed-engine/scrollDirection.ts';

class FakeIO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let server: FakeFeedServer;
let urls: string[];
let m: Mounted | undefined;

function installFetch(opts: { offline?: boolean } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      urls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if (opts.offline) throw new TypeError('Failed to fetch');
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      const m = /^\/api\/v1\/feed\/(bootstrap|next)$/.exec(url.pathname);
      if (m) {
        return json(
          await server.fetcher(m[1] as 'bootstrap' | 'next', {
            mode: url.searchParams.get('mode') as 'for_you',
            cursor: url.searchParams.get('cursor'),
            size: Number(url.searchParams.get('size')),
          }),
        );
      }
      if (url.pathname === '/api/feed') return json({ posts: [makePost(900)], next_cursor: null, has_more: false });
      if (/\/api\/posts\/[^/]+\/likes$/.test(url.pathname)) return json({ success: true, has_liked: true, likes_count: 1 });
      return json({});
    }),
  );
}

/** Flushes (inside act) until the condition holds; IndexedDB answers on its own timers. */
async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 100 && !cond(); i++) await flush();
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
}

const render = async () => {
  m = await mount(<FeedPage currentUserId="u1" onNavigateToCompose={() => {}} onViewAuthorProfile={() => {}} localFirst />);
  await until(() => (m!.container.textContent ?? '').includes('hello') || (m!.container.textContent ?? '').includes('offline'), 'the first frame');
};
const text = () => m!.container.textContent ?? '';
const calls = (path: RegExp) => urls.filter((u) => path.test(u));

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  vi.stubGlobal('IntersectionObserver', FakeIO);
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  resetScrollDirection();
  getScrollDirection();
  urls = [];
  server = new FakeFeedServer(Array.from({ length: 60 }, (_, i) => makePost(i + 1, { tags: ['sports'], author: `a${i}` })));
  server.posts.forEach((p, i) => (p.body = `hello ${i} #sports`));
  installFetch();
});
afterEach(() => {
  m?.unmount();
  m = undefined;
  vi.unstubAllGlobals();
});

describe('FeedPage with localFirst', () => {
  it('shows the first frame from the packaged batch, never touches /api/feed, and caches the batch on the phone', async () => {
    await render();
    expect(text()).toContain('hello');
    expect(calls(/\/api\/v1\/feed\/bootstrap/)).toHaveLength(1);
    expect(calls(/^GET \/api\/feed$/)).toHaveLength(0);
    const peek = new FeedCacheManager({ userId: 'u1', mode: 'for_you' });
    expect((await peek.getStats()).total).toBeGreaterThanOrEqual(30);
    await peek.destroy();
  });

  it('is off by default: the page still uses /api/feed and stores nothing', async () => {
    m = await mount(<FeedPage currentUserId="u1" onNavigateToCompose={() => {}} onViewAuthorProfile={() => {}} />);
    await until(() => (m!.container.textContent ?? '').includes('post 900'), 'the default feed');
    expect(calls(/^GET \/api\/feed$/).length).toBeGreaterThan(0);
    expect(calls(/\/api\/v1\//)).toHaveLength(0);
    const peek = new FeedCacheManager({ userId: 'u1', mode: 'for_you' });
    expect((await peek.getStats()).total).toBe(0);
    await peek.destroy();
  });

  it('opens again with no network call at all (offline or not), straight from IndexedDB', async () => {
    await render();
    m!.unmount();
    m = undefined;
    urls = [];
    installFetch({ offline: true });
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    await render();
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    expect(text()).toContain('hello');
    expect(urls.filter((u) => u.includes('/api/v1/'))).toHaveLength(0);
  });

  it('learns locally: tapping a #tag and liking a post are saved as this person\'s preferences', async () => {
    await render();
    const tag = [...m!.container.querySelectorAll('span')].find((s) => s.textContent === '#sports');
    await click(tag);
    await click(m!.container.querySelector('button[aria-label="Like"]'));
    const stored = JSON.parse(localStorage.getItem('pgc:feed-prefs:v1:u1')!);
    expect(stored.tags.sports[0]).toBeCloseTo(1.5 + 1, 2); // tag click + like
  });

  it('sign-out forgets the cache and the preferences', async () => {
    await render();
    await click([...m!.container.querySelectorAll('span')].find((s) => s.textContent === '#sports'));
    m!.unmount();
    m = undefined;
    await forgetFeedDataFor('u1');
    const peek = new FeedCacheManager({ userId: 'u1', mode: 'for_you' });
    expect(await peek.getStats()).toMatchObject({ total: 0, bootstrappedAt: null });
    await peek.destroy();
    expect(localStorage.getItem('pgc:feed-prefs:v1:u1')).toBeNull();
  });
});
