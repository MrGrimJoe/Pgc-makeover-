// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import App from '../src/App.tsx';
import { LayoutProvider, type Layout } from '../src/lib/layout.ts';
import { BottomSheet } from '../src/components/BottomSheet.tsx';
import { CommentModal } from '../src/components/CommentModal.tsx';
import { installViewport } from './_viewport.ts';
import { mount, click, flush, byLabel, axeViolations, installFetch, json, type Mounted } from './_ui.tsx';

let m: Mounted | null = null;
const cleanups: Array<() => void> = [];
afterEach(async () => {
  m?.unmount(); m = null; cleanups.splice(0).forEach((c) => c()); document.body.innerHTML = '';
  await new Promise((r) => setTimeout(r, 60));
  window.history.replaceState(null, '', '/');
});

const me = { user: { id: 'u1', created_at: '', status: 'active' }, profile: { username: 'mia', username_normalized: 'mia', display_name: 'Mia', bio: '', avatar_media_id: null, class_id: null, campus_id: null }, settings: { dm_policy: 'everyone', feed_preferences: 'for_you' } };
const routes = () => ({
  'GET /api/me': () => json(me),
  'GET /api/feed': () => json({ items: [], posts: [], next_cursor: null }),
  'GET /api/classes': () => json({ classes: [] }),
  'GET /api/posts/p1/comments': () => json({ comments: [] }),
  'GET /api/conversations': () => json({ conversations: [] }),
});
const boot = async (width: number, force?: Layout) => {
  window.history.replaceState(null, '', '/');
  const net = installFetch(routes()); cleanups.push(net.restore);
  const vp = installViewport(width); cleanups.push(vp.restore);
  window.scrollTo = (() => undefined) as unknown as typeof window.scrollTo;
  m = await mount(<LayoutProvider force={force}><App /></LayoutProvider>);
  await flush(); await flush();
  return vp;
};
const navs = () => [...document.querySelectorAll<HTMLElement>('nav[aria-label="Navigation"]')];

const CASES: Array<{ width: number; layout: Layout; nav: string; appBar: boolean }> = [
  { width: 390, layout: 'phone', nav: 'bottom', appBar: true },
  { width: 820, layout: 'tablet', nav: 'rail', appBar: false },
  { width: 1280, layout: 'desktop', nav: 'sidebar', appBar: false },
];

describe('the intended design is used on each screen size', () => {
  for (const c of CASES) {
    it(`${c.width}px gets the ${c.layout} design: ${c.nav} navigation, ${c.appBar ? 'with' : 'without'} the phone app bar`, async () => {
      await boot(c.width);
      expect(document.documentElement.dataset.layout).toBe(c.layout);
      expect(navs().map((n) => n.dataset.nav)).toEqual([c.nav]); // exactly one navigation landmark, of the right kind
      expect(document.querySelectorAll('header').length).toBe(c.appBar ? 1 : 0);
      expect(byLabel(document.body, 'Feed')?.getAttribute('aria-current')).toBe('page');
      const labels = navs()[0]!.textContent ?? '';
      expect(labels.includes('Messages')).toBe(c.nav === 'sidebar'); // labels only in the sidebar
      expect(!!byLabel(document.body, 'Settings')).toBe(c.layout !== 'phone');
      expect(await axeViolations(document.body)).toBe('');
    });
  }

  it('navigation works the same way in every layout (Search, then Messages)', async () => {
    for (const c of CASES) {
      await boot(c.width);
      await click(byLabel(navs()[0]!, 'Search'));
      expect(byLabel(navs()[0]!, 'Search')?.getAttribute('aria-current')).toBe('page');
      if (c.layout !== 'phone') {
        await click(byLabel(navs()[0]!, 'Messages'));
        await flush();
        expect(byLabel(navs()[0]!, 'Messages')?.getAttribute('aria-current')).toBe('page');
      }
      m!.unmount(); m = null; cleanups.splice(0).forEach((x) => x());
      await new Promise((r) => setTimeout(r, 60));
    }
  });

  it('resizing across a breakpoint switches the design and keeps where you are', async () => {
    const vp = await boot(390);
    await click(byLabel(navs()[0]!, 'Search'));
    expect(navs()[0]!.dataset.nav).toBe('bottom');
    await act(async () => { vp.resizeTo(1280); });
    await flush();
    expect(document.documentElement.dataset.layout).toBe('desktop');
    expect(navs().map((n) => n.dataset.nav)).toEqual(['sidebar']);
    expect(byLabel(navs()[0]!, 'Search')?.getAttribute('aria-current')).toBe('page'); // still on Search
    await act(async () => { vp.resizeTo(700); });
    await flush();
    expect(navs().map((n) => n.dataset.nav)).toEqual(['rail']);
    await act(async () => { vp.resizeTo(500); });
    await flush();
    expect(navs().map((n) => n.dataset.nav)).toEqual(['bottom']);
  });

  it('a forced layout wins over the window width (dev switch)', async () => {
    await boot(390, 'desktop');
    expect(document.documentElement.dataset.layout).toBe('desktop');
    expect(navs()[0]!.dataset.nav).toBe('sidebar');
  });
});

describe('overlays follow the layout', () => {
  const variantAt = async (width: number, el: React.ReactElement) => {
    const vp = installViewport(width); cleanups.push(vp.restore);
    m = await mount(<LayoutProvider>{el}</LayoutProvider>);
    await flush();
    return document.querySelector<HTMLElement>('[role="dialog"]')!;
  };

  it('a plain sheet is a bottom sheet on phones and a centered dialog on tablets and desktops', async () => {
    const el = <BottomSheet label="Demo" onClose={() => undefined}><p>x</p></BottomSheet>;
    expect((await variantAt(390, el)).dataset.variant).toBe('sheet');
    expect(document.querySelector('[data-sheet-handle]')).not.toBeNull();
    m!.unmount(); m = null; cleanups.splice(0).forEach((x) => x());
    await new Promise((r) => setTimeout(r, 60));
    expect((await variantAt(820, el)).dataset.variant).toBe('dialog');
    expect(document.querySelector('[data-sheet-handle]')).toBeNull(); // nothing to drag on a dialog
    m!.unmount(); m = null; cleanups.splice(0).forEach((x) => x());
    await new Promise((r) => setTimeout(r, 60));
    expect((await variantAt(1280, el)).dataset.variant).toBe('dialog');
  });

  it('comments are a sheet on phones and tablets and a side drawer on desktop', async () => {
    const net = installFetch(routes()); cleanups.push(net.restore);
    const el = <CommentModal postId="p1" currentUserId="u1" onClose={() => undefined} />;
    for (const [w, v] of [[390, 'sheet'], [820, 'sheet'], [1280, 'drawer']] as const) {
      expect((await variantAt(w, el)).dataset.variant, `${w}px`).toBe(v);
      m!.unmount(); m = null; cleanups.splice(0, 1).forEach((x) => x());
      await new Promise((r) => setTimeout(r, 60));
    }
  });

  it('an open sheet changes look when the window is resized, without closing', async () => {
    const vp = installViewport(390); cleanups.push(vp.restore);
    m = await mount(<LayoutProvider><BottomSheet label="Demo" onClose={() => undefined}><p>x</p></BottomSheet></LayoutProvider>);
    expect(document.querySelector<HTMLElement>('[role="dialog"]')!.dataset.variant).toBe('sheet');
    await act(async () => { vp.resizeTo(1280); });
    expect(document.querySelector<HTMLElement>('[role="dialog"]')!.dataset.variant).toBe('dialog');
    expect(document.querySelector<HTMLElement>('[role="dialog"]')!.dataset.closing).toBe('false');
  });
});

describe('the desktop sidebar can be collapsed to the rail', () => {
  it('Collapse sidebar turns it into the rail, Expand sidebar brings it back, and --nav-w follows', async () => {
    await boot(1280);
    expect(navs()[0]!.dataset.nav).toBe('sidebar');
    await click(byLabel(navs()[0]!, 'Collapse sidebar'));
    expect(navs().map((n) => n.dataset.nav)).toEqual(['rail']);
    expect(document.documentElement.dataset.navCollapsed).toBe('true');
    expect(byLabel(navs()[0]!, 'Feed')?.getAttribute('aria-current')).toBe('page'); // still where you were
    await click(byLabel(navs()[0]!, 'Expand sidebar'));
    expect(navs().map((n) => n.dataset.nav)).toEqual(['sidebar']);
    expect(document.documentElement.dataset.navCollapsed).toBeUndefined();
  });

  it('the tablet rail has no toggle (it is already as small as it gets)', async () => {
    await boot(820);
    expect(byLabel(navs()[0]!, 'Collapse sidebar')).toBeFalsy();
    expect(byLabel(navs()[0]!, 'Expand sidebar')).toBeFalsy();
  });
});
