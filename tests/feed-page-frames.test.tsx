// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { mount, flush, type Mounted } from './_ui.tsx';
import { FeedPage } from '../src/pages/FeedPage.tsx';
import type { PostItem } from '../shared/schema.ts';
import { MODERATED_LAYOUT } from '../src/feed-engine/index.ts';
import { getScrollDirection, resetScrollDirection } from '../src/feed-engine/scrollDirection.ts';

const post = (n: number, moderation?: 'SAFE' | 'WILD'): PostItem => ({
  id: `post-${n}`,
  author_id: 'a1',
  author_username: 'ali',
  author_display_name: 'Ali',
  author_avatar_media_id: null,
  body: `body ${n}`,
  created_at: '2026-10-01T00:00:00.000Z',
  expires_at: '2026-10-08T00:00:00.000Z',
  status: 'active',
  media: [],
  moderation,
  likes_count: 0,
  has_liked: false,
  comments_count: 0,
});

/** 15 pages of 10 posts, every 4th post tagged WILD. */
function installFeedApi() {
  const TOTAL = 150;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const start = Number(url.searchParams.get('cursor') ?? 0);
    const posts = Array.from({ length: Math.min(10, TOTAL - start) }, (_, i) =>
      post(start + i, (start + i) % 4 === 3 ? 'WILD' : undefined),
    );
    const next = start + 10;
    return new Response(JSON.stringify({ posts, next_cursor: next < TOTAL ? String(next) : null, has_more: next < TOTAL }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** jsdom has no IntersectionObserver: record targets so a test can "scroll" a frame to the midline. */
const observed = new Map<Element, () => void>();
class FakeIO {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(el: Element) {
    observed.set(el, () => this.cb([{ isIntersecting: true, target: el } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
  }
  unobserve(el: Element) { observed.delete(el); }
  disconnect() {}
}

const frameEls = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[data-frame-index]')];
const frameIndexes = (c: HTMLElement) => frameEls(c).map((e) => Number(e.dataset.frameIndex));

async function scrollToFrame(c: HTMLElement, index: number) {
  const el = frameEls(c).find((e) => Number(e.dataset.frameIndex) === index);
  if (!el) throw new Error(`frame ${index} is not mounted`);
  await act(async () => { observed.get(el)?.(); });
  await flush();
}

/** jsdom has no scrolling, so move window.scrollY and fire the scroll event the way a browser would. */
let scrollPos = 1000;
function nudgeScroll(dir: 'up' | 'down') {
  scrollPos += dir === 'down' ? 20 : -20;
  Object.defineProperty(window, 'scrollY', { value: scrollPos, configurable: true });
  window.dispatchEvent(new Event('scroll'));
}

/** The user scrolled past the last (bottom) or above the first (top) mounted frame. */
async function scrollPast(c: HTMLElement, edge: 'top' | 'bottom') {
  nudgeScroll(edge === 'bottom' ? 'down' : 'up'); // sentinels only act in the direction of travel
  const el = c.querySelector<HTMLElement>(`[data-frame-sentinel="${edge}"]`);
  if (!el) throw new Error(`no ${edge} sentinel`);
  await act(async () => { observed.get(el)?.(); });
  await flush();
}

describe('FeedPage frame architecture', () => {
  it('ignores the bottom sentinel while the viewer scrolls up, and the top sentinel while they scroll down', async () => {
    observed.clear();
    vi.stubGlobal('IntersectionObserver', FakeIO);
    installFeedApi();
    const mm = await mount(<FeedPage currentUserId="u1" onNavigateToCompose={() => {}} onViewAuthorProfile={() => {}} frameLayout={MODERATED_LAYOUT} />);
    await flush();
    await flush();
    scrollPos = 1000;
    Object.defineProperty(window, 'scrollY', { value: scrollPos, configurable: true });
    resetScrollDirection();
    getScrollDirection();
    await scrollToFrame(mm.container, 1);
    await scrollToFrame(mm.container, 2); // Mid-Frame focused, WILD held back
    const before = frameEls(mm.container).map((e) => e.dataset.frameKind);
    // scrolling UP with the bottom sentinel in view must not advance onto the WILD frame
    nudgeScroll('up');
    const bottom = mm.container.querySelector<HTMLElement>('[data-frame-sentinel="bottom"]')!;
    await act(async () => { observed.get(bottom)?.(); });
    await flush();
    expect(frameEls(mm.container).map((e) => e.dataset.frameKind)).toEqual(before);
    // scrolling DOWN does
    nudgeScroll('down');
    await act(async () => { observed.get(bottom)?.(); });
    await flush();
    expect(frameEls(mm.container).map((e) => e.dataset.frameKind)).toContain('WILD');
    mm.unmount();
    vi.unstubAllGlobals();
  });

  let m: Mounted;

  beforeEach(() => {
    observed.clear();
    vi.stubGlobal('IntersectionObserver', FakeIO);
    scrollPos = 1000;
    Object.defineProperty(window, 'scrollY', { value: scrollPos, configurable: true });
    resetScrollDirection();
    getScrollDirection(); // attach the listener
  });
  afterEach(() => {
    m?.unmount();
    vi.unstubAllGlobals();
  });

  const render = async () => {
    m = await mount(<FeedPage currentUserId="u1" onNavigateToCompose={() => {}} onViewAuthorProfile={() => {}} frameLayout={MODERATED_LAYOUT} />);
    await flush();
    await flush();
  };

  it('renders the first frames, not a single endless list', async () => {
    installFeedApi();
    await render();
    expect(frameIndexes(m.container)).toEqual([0, 1]);
    expect(m.container.textContent).toContain('body 0');
    expect(m.container.textContent).toContain('body 8'); // frame size 8: frame 1 starts at post 8
  });

  it('never keeps more than 3 frames in the DOM and destroys frames that leave the window', async () => {
    installFeedApi();
    await render();
    await scrollToFrame(m.container, 1);
    await scrollToFrame(m.container, 2);
    await scrollPast(m.container, 'bottom'); // past the Mid-Frame onto the WILD frame
    await scrollToFrame(m.container, 4);
    await scrollToFrame(m.container, 5);
    expect(frameIndexes(m.container)).toEqual([4, 5, 6]);
    expect(m.container.textContent).not.toContain('body 0');
  });

  it('removes the Mid-Frame from the DOM before the WILD frame appears, and swaps back going up', async () => {
    installFeedApi();
    await render();
    await scrollToFrame(m.container, 1);
    await scrollToFrame(m.container, 2); // Mid-Frame focused: the WILD frame below is held back
    expect(frameEls(m.container).map((e) => e.dataset.frameKind)).toEqual(['SAFE', 'MID']);

    await scrollPast(m.container, 'bottom'); // user scrolled past the Mid-Frame
    expect(frameEls(m.container).map((e) => e.dataset.frameKind)).toEqual(['SAFE', 'WILD', 'SAFE']);
    expect(m.container.querySelector('[data-frame-kind="MID"]')).toBeNull();

    await scrollPast(m.container, 'top'); // and back up: the WILD frame goes before the Mid-Frame returns
    const kinds = frameEls(m.container).map((e) => e.dataset.frameKind);
    expect(kinds).toContain('MID');
    expect(kinds).not.toContain('WILD');
  });

  it('keeps the page height steady with a spacer standing in for destroyed frames', async () => {
    installFeedApi();
    await render();
    const spacer = () => Number((m.container.querySelector<HTMLElement>('[data-frame-spacer="top"]')?.style.height ?? '0px').replace('px', ''));
    expect(spacer()).toBe(0);
    for (const i of [1, 2]) await scrollToFrame(m.container, i);
    await scrollPast(m.container, 'bottom');
    // jsdom has no layout (heights are 0), so assert the spacer is wired to the first mounted frame
    expect(frameIndexes(m.container)[0]).toBe(1); // frame 0 left the window; frame 1 stays behind the WILD frame
    expect(m.container.querySelector('[data-frame-spacer="top"]')).not.toBeNull();
    expect(m.container.querySelector('[data-frame-spacer="bottom"]')).not.toBeNull(); // mirrors the top one
  });

  it('keeps like state when a frame is destroyed and rebuilt', async () => {
    installFeedApi();
    const base = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes('/likes') ? Promise.resolve(new Response('{}', { status: 200 })) : base(input, init),
    );
    await render();
    const like = m.container.querySelector<HTMLButtonElement>('[data-frame-index="0"] [aria-label="Like"]');
    expect(like).not.toBeNull();
    await act(async () => { like?.click(); });
    expect(m.container.querySelector('[data-frame-index="0"] [aria-label="Unlike"]')).not.toBeNull();

    await scrollToFrame(m.container, 1);
    await scrollToFrame(m.container, 2);
    await scrollPast(m.container, 'bottom');
    await scrollToFrame(m.container, 4);
    expect(frameIndexes(m.container)).not.toContain(0);

    await scrollToFrame(m.container, 3); // back up onto the WILD frame: nothing above it is mounted
    await scrollPast(m.container, 'top'); // scrolled above it: Mid-Frame and the SAFE frame before it return
    await scrollToFrame(m.container, 1);
    await scrollToFrame(m.container, 0);
    expect(frameIndexes(m.container)).toContain(0);
    expect(m.container.querySelector('[data-frame-index="0"] [aria-label="Unlike"]')).not.toBeNull();
  });

  it('shows an error with a retry that recovers', async () => {
    let fail = true;
    vi.stubGlobal('fetch', vi.fn(async () =>
      fail
        ? new Response(JSON.stringify({ error: 'Failed to load posts' }), { status: 500 })
        : new Response(JSON.stringify({ posts: [post(0)], next_cursor: null, has_more: false }), { status: 200 }),
    ));
    await render();
    expect(m.container.querySelector('[role="alert"]')?.textContent).toContain('Failed to load posts');
    fail = false;
    const retry = [...m.container.querySelectorAll('button')].find((b) => b.textContent === 'Try again');
    await act(async () => { retry?.click(); });
    await flush();
    expect(m.container.querySelector('[role="alert"]')).toBeNull();
    expect(m.container.textContent).toContain('body 0');
  });

  it('shows the empty state for an empty feed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ posts: [], next_cursor: null, has_more: false }), { status: 200 })));
    await render();
    expect(m.container.textContent).toContain('No posts in this feed yet.');
  });
});

describe('Mid-Frame slot', () => {
  it('adds no visible gap: it is an empty zero-height element', async () => {
    observed.clear();
    vi.stubGlobal('IntersectionObserver', FakeIO);
    installFeedApi();
    const m = await mount(<FeedPage currentUserId="u1" onNavigateToCompose={() => {}} onViewAuthorProfile={() => {}} frameLayout={MODERATED_LAYOUT} />);
    await flush();
    await flush();
    await scrollToFrame(m.container, 1);
    const mid = m.container.querySelector<HTMLElement>('[data-frame-kind="MID"]');
    expect(mid).not.toBeNull();
    expect(mid?.style.minHeight ?? '').toBe('');
    expect(mid?.childElementCount).toBe(0);
    m.unmount();
    vi.unstubAllGlobals();
  });
});

describe('FeedPage default layout', () => {
  it('is one continuous run of SAFE frames with no Mid-Frame slots', async () => {
    observed.clear();
    vi.stubGlobal('IntersectionObserver', FakeIO);
    installFeedApi();
    const m = await mount(<FeedPage currentUserId="u1" onNavigateToCompose={() => {}} onViewAuthorProfile={() => {}} />);
    await flush();
    await flush();
    for (const i of [1, 2, 3]) await scrollToFrame(m.container, i);
    expect(m.container.querySelector('[data-frame-kind="MID"]')).toBeNull();
    expect(m.container.querySelector('[data-frame-kind="WILD"]')).toBeNull();
    expect(frameIndexes(m.container)).toEqual([2, 3, 4]);
    m.unmount();
    vi.unstubAllGlobals();
  });
});
