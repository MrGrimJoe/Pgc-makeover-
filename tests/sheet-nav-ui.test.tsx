// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { BottomSheet, SHEET_CLOSE_MS } from '../src/components/BottomSheet.tsx';
import { CommentModal } from '../src/components/CommentModal.tsx';
import App from '../src/App.tsx';
import { mount, click, flush, byLabel, byText, axeViolations, installFetch, json, type Mounted } from './_ui.tsx';

let m: Mounted | null = null;
const restores: Array<() => void> = [];
afterEach(async () => {
  m?.unmount(); m = null; restores.splice(0).forEach((r) => r()); document.body.innerHTML = ''; document.body.style.overflow = ''; vi.restoreAllMocks();
  // A closing sheet calls history.back() on unmount; let it land before the next test starts
  await new Promise((r) => setTimeout(r, 60));
  window.history.replaceState(null, '', '/');
});

const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const panel = () => document.querySelector<HTMLElement>('[role="dialog"]');
const backdrop = () => document.querySelector<HTMLElement>('.sheet-backdrop');
const sheetEntry = () => (window.history.state as { sheet?: string } | null)?.sheet;

describe('BottomSheet', () => {
  const open = async (onClose = vi.fn()) => {
    m = await mount(<BottomSheet label="Demo" onClose={onClose}>{({ requestClose }) => <button type="button" onClick={requestClose}>Close it</button>}</BottomSheet>);
    return onClose;
  };

  it('slides up on open: dialog with the slide-in class, page scroll locked, one history entry added', async () => {
    const before = window.history.length;
    await open();
    expect(panel()!.classList.contains('sheet-panel')).toBe(true);
    expect(panel()!.getAttribute('aria-modal')).toBe('true');
    expect(panel()!.dataset.closing).toBe('false');
    expect(document.body.style.overflow).toBe('hidden');
    expect(window.history.length).toBe(before + 1);
    expect(sheetEntry()).toBeTruthy();
    expect(await axeViolations(m!.container)).toBe('');
  });

  it('a tap on the backdrop slides it down first, then closes once (not instantly)', async () => {
    const onClose = await open();
    await act(async () => { backdrop()!.click(); });
    expect(panel()!.dataset.closing).toBe('true');
    expect(backdrop()!.dataset.closing).toBe('true');
    await wait(SHEET_CLOSE_MS / 2);
    expect(onClose).not.toHaveBeenCalled(); // still sliding down halfway through the animation
    await wait(SHEET_CLOSE_MS + 80);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a tap inside the sheet does not close it (positive control for the backdrop test)', async () => {
    const onClose = await open();
    await act(async () => { panel()!.click(); });
    await wait(SHEET_CLOSE_MS + 80);
    expect(panel()!.dataset.closing).toBe('false');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('the Close button and Escape both slide it down', async () => {
    let onClose = await open();
    await click(byText(document.body, 'button', 'Close it'));
    expect(panel()!.dataset.closing).toBe('true');
    await wait(SHEET_CLOSE_MS + 80);
    expect(onClose).toHaveBeenCalledTimes(1);
    m!.unmount(); m = null;

    onClose = await open();
    await act(async () => { panel()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(panel()!.dataset.closing).toBe('true');
    await wait(SHEET_CLOSE_MS + 80);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the phone/browser Back button closes it with the slide-down, and leaves no extra history entry', async () => {
    const base = sheetEntry();
    const onClose = await open();
    expect(sheetEntry()).toBeTruthy();
    expect(sheetEntry()).not.toBe(base);
    await act(async () => { window.history.back(); await new Promise((r) => setTimeout(r, 30)); });
    expect(panel()!.dataset.closing).toBe('true');
    await wait(SHEET_CLOSE_MS + 80);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(sheetEntry()).toBe(base);
  });

  it('closing with the button removes the history entry it added (so Back does not need a second press)', async () => {
    const base = sheetEntry();
    await open();
    expect(sheetEntry()).toBeTruthy();
    await click(byText(document.body, 'button', 'Close it'));
    await wait(SHEET_CLOSE_MS + 80);
    m!.unmount(); m = null;
    await wait(60); // history.back() settles
    expect(sheetEntry()).toBe(base);
    expect(document.body.style.overflow).toBe('');
  });

  it('dragging the top bar down far enough closes it; a short drag springs back', async () => {
    const drag = async (dy: number) => {
      const handle = document.querySelector<HTMLElement>('[data-sheet-handle]')!;
      const ev = (type: string, y: number) => { const e = new Event(type, { bubbles: true }); Object.assign(e, { clientY: y, pointerId: 1 }); return e; };
      await act(async () => { handle.dispatchEvent(ev('pointerdown', 100)); handle.dispatchEvent(ev('pointermove', 100 + dy)); handle.dispatchEvent(ev('pointerup', 100 + dy)); });
    };
    const onClose = await open();
    await drag(30);
    await wait(SHEET_CLOSE_MS + 80);
    expect(panel()!.dataset.closing).toBe('false');
    expect(onClose).not.toHaveBeenCalled();
    await drag(220);
    expect(panel()!.dataset.closing).toBe('true');
    await wait(SHEET_CLOSE_MS + 80);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('comments as a sheet', () => {
  it('opens as a dialog named Comments and the X slides it down before calling onClose', async () => {
    const net = installFetch({ 'GET /api/posts/p1/comments': () => json({ comments: [] }) }); restores.push(net.restore);
    const onClose = vi.fn();
    m = await mount(<CommentModal postId="p1" currentUserId="u1" onClose={onClose} />);
    await flush();
    expect(panel()!.getAttribute('aria-label')).toBe('Comments');
    await click(byLabel(document.body, 'Close'));
    expect(panel()!.dataset.closing).toBe('true');
    expect(onClose).not.toHaveBeenCalled();
    await wait(SHEET_CLOSE_MS + 80);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('app navigation and the Back button', () => {
  const me = { user: { id: 'u1', created_at: '', status: 'active' }, profile: { username: 'mia', username_normalized: 'mia', display_name: 'Mia', bio: '', avatar_media_id: null, class_id: null, campus_id: null }, settings: { dm_policy: 'everyone', feed_preferences: 'for_you' } };
  const boot = async () => {
    window.history.replaceState(null, '', '/');
    const net = installFetch({
      'GET /api/me': () => json(me),
      'GET /api/feed': () => json({ items: [], posts: [], next_cursor: null }),
      'GET /api/classes': () => json({ classes: [] }),
      'GET /api/blocks': () => json({ blocks: [] }),
      'GET /api/me/interests': () => json({ interests: [] }),
      'GET /api/stickers/library': () => json({ items: [] }),
      'GET /api/users/mia': () => json({ ...me.profile, id: 'u1', followers_count: 0, following_count: 0, posts: [] }),
    }); restores.push(net.restore);
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    m = await mount(<App />);
    await flush(); await flush();
  };
  const tab = (label: string) => byLabel(m!.container, label) as HTMLButtonElement;
  const current = () => [...m!.container.querySelectorAll('nav button[aria-current="page"]')].map((b) => b.getAttribute('aria-label'));
  const idx = () => (window.history.state as { idx?: number } | null)?.idx;
  const back = () => act(async () => { window.history.back(); await new Promise((r) => setTimeout(r, 30)); });

  it('each screen is a history entry and Back walks them in reverse', async () => {
    await boot();
    expect(current()).toEqual(['Feed']);
    expect(idx()).toBe(0);
    await click(tab('Search'));
    await click(tab('New post'));
    expect(current()).toEqual(['New post']);
    expect(idx()).toBe(2);
    await back();
    expect(current()).toEqual(['Search']);
    await back();
    expect(current()).toEqual(['Feed']);
    expect(idx()).toBe(0);
  });

  it('tapping the tab you are on scrolls to the top and adds no history entry', async () => {
    await boot();
    await click(tab('Search'));
    const before = idx();
    await click(tab('Search'));
    expect(idx()).toBe(before);
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    // positive control: a different tab does add an entry
    await click(tab('Feed'));
    expect(idx()).toBe(before! + 1);
  });

  it('pages get a transition class: slide for deeper pages, fade for tabs, and the other way on Back', async () => {
    await boot();
    const wrapper = () => m!.container.querySelector('main > div')!.className;
    await click(tab('Search'));
    expect(wrapper()).toBe('page-fade');
    await click(tab('Profile'));
    // open settings from the profile page
    const settingsBtn = m!.container.querySelector('[aria-label="Settings"]') as HTMLElement | null;
    expect(settingsBtn, 'profile page has a Settings button').not.toBeNull();
    await click(settingsBtn!);
    await flush();
    expect(wrapper()).toBe('page-forward');
    expect(m!.container.querySelectorAll('header').length).toBe(1); // the app bar is hidden on Settings
    await back();
    expect(wrapper()).toBe('page-back');
  });

  it('Settings Back button uses history: it returns to where you came from', async () => {
    await boot();
    await click(tab('Search'));
    await click(tab('Profile'));
    const settingsBtn = m!.container.querySelector('[aria-label="Settings"]') as HTMLElement | null;
    expect(settingsBtn, 'profile page has a Settings button').not.toBeNull();
    await click(settingsBtn!);
    await flush();
    expect(m!.container.querySelector('h1')?.textContent).toBe('Settings');
    await act(async () => { (byLabel(m!.container, 'Back') as HTMLElement).click(); await new Promise((r) => setTimeout(r, 30)); });
    await flush();
    expect(m!.container.querySelector('h1')?.textContent).not.toBe('Settings');
    expect(current()).toEqual(['Profile']);
  });
});
