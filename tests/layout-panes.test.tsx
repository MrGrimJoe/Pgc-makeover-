// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import App from '../src/App.tsx';
import { LayoutProvider } from '../src/lib/layout.ts';
import { MessagesPage } from '../src/pages/MessagesPage.tsx';
import { SettingsPage } from '../src/pages/SettingsPage.tsx';
import { ProfileViewPage } from '../src/pages/ProfileViewPage.tsx';
import { installViewport } from './_viewport.ts';
import { mount, click, flush, byLabel, byText, axeViolations, installFetch, json, type Mounted } from './_ui.tsx';
import type { ConversationItem, MeResponse } from '../shared/schema.ts';

let m: Mounted | null = null;
const cleanups: Array<() => void> = [];
afterEach(async () => {
  m?.unmount(); m = null; cleanups.splice(0).forEach((c) => c()); document.body.innerHTML = '';
  await new Promise((r) => setTimeout(r, 60));
  window.history.replaceState(null, '', '/');
});

const me = {
  user: { id: 'usr_me', created_at: '', status: 'active' },
  profile: { username: 'mia', username_normalized: 'mia', display_name: 'Mia', bio: '', avatar_media_id: null, class_id: null, campus_id: null },
  settings: { dm_policy: 'everyone', feed_preferences: 'for_you' },
} as MeResponse;

const conv: ConversationItem = { id: 'conv_1', created_at: '', other_user: { id: 'u9', username: 'zed', display_name: 'Zed', avatar_media_id: null }, last_message: null };
const baseRoutes = () => ({
  'GET /api/conversations/conv_1/messages': () => json({ messages: [] }),
  'GET /api/conversations': () => json({ conversations: [conv] }),
  'GET /api/blocks': () => json({ blocks: [] }),
  'GET /api/me/interests': () => json({ interests: [] }),
  'GET /api/stickers/library': () => json({ items: [] }),
});

const open = async (width: number, el: React.ReactElement) => {
  const net = installFetch(baseRoutes()); cleanups.push(net.restore);
  const vp = installViewport(width); cleanups.push(vp.restore);
  window.scrollTo = (() => undefined) as unknown as typeof window.scrollTo;
  m = await mount(<LayoutProvider>{el}</LayoutProvider>);
  await flush(); await flush();
  return vp;
};
const messages = () => <MessagesPage currentUserId="usr_me" onBack={() => undefined} onViewAuthorProfile={() => undefined} />;
const rowZed = () => document.querySelector<HTMLElement>('li button'); // the one conversation row in the list
const backToList = () => byLabel(document.body, 'Back to conversations');
const emptyHint = () => [...document.querySelectorAll('div')].some((d) => d.textContent === 'Choose a conversation to start chatting.');

describe('Messages: one pane on phones, two panes on tablets and desktops', () => {
  it('phone: the list first, then the chat on its own, with a Back button', async () => {
    await open(390, messages());
    expect(rowZed()).not.toBeNull();
    expect(emptyHint()).toBe(false);
    await click(rowZed());
    await flush();
    expect(backToList()).not.toBeNull();
    expect(rowZed()).toBeNull(); // the list is gone, only the chat remains
    await click(backToList());
    expect(rowZed()).not.toBeNull();
  });

  for (const width of [820, 1280]) {
    it(`${width}px: list and chat are side by side, no Back button, the open row is marked`, async () => {
      await open(width, messages());
      expect(rowZed()).not.toBeNull();
      expect(emptyHint()).toBe(true); // nothing open yet
      await click(rowZed());
      await flush();
      expect(emptyHint()).toBe(false);
      expect(backToList()).toBeNull();
      expect(byLabel(document.body, 'Chat menu')).not.toBeNull(); // the chat header is there
      expect(rowZed()?.getAttribute('aria-current')).toBe('true'); // the list is still there and shows which chat is open
      expect(await axeViolations(document.body)).toBe('');
    });
  }

  it('resizing from desktop to phone keeps the open conversation (and the chat is not remounted)', async () => {
    const vp = await open(1280, messages());
    await click(rowZed());
    await flush();
    const chatMenu = byLabel(document.body, 'Chat menu');
    expect(chatMenu).not.toBeNull();
    await act(async () => { vp.resizeTo(390); });
    await flush();
    expect(byLabel(document.body, 'Chat menu')).toBe(chatMenu); // same DOM node: nothing was rebuilt, so unsent text would survive
    expect(backToList()).not.toBeNull(); // now it is the phone design, with Back
    await act(async () => { vp.resizeTo(1280); });
    await flush();
    expect(backToList()).toBeNull();
    expect(byLabel(document.body, 'Chat menu')).toBe(chatMenu);
  });
});

describe('Settings: one page, and on desktop a section list with one section at a time', () => {
  const settings = () => <SettingsPage currentUser={me} onProfileUpdated={() => undefined} onAccountDeleted={() => undefined} onLogout={() => undefined} onBack={() => undefined} />;
  const h2s = () => [...document.querySelectorAll('h2')].map((e) => e.textContent);
  const sectionMenu = () => document.querySelector('[role="group"][aria-label="Settings sections"]');

  for (const width of [390, 820]) {
    it(`${width}px: every section on one scrolling page, no section list`, async () => {
      await open(width, settings());
      expect(sectionMenu()).toBeNull();
      for (const h of ['Chat background', 'Who can message you', 'Blocked people', 'Interests', 'My stickers & GIFs', 'Account']) expect(h2s(), h).toContain(h);
    });
  }

  it('1280px: a list of the four sections, the first one shown, the others one click away', async () => {
    await open(1280, settings());
    const menu = sectionMenu()!;
    expect(menu).not.toBeNull();
    expect([...menu.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Privacy and safety', 'Appearance', 'Your content', 'Account']);
    expect(h2s()).toContain('Who can message you');
    expect(h2s()).not.toContain('Chat background');
    await click(byText(menu as HTMLElement, 'button', 'Appearance'));
    expect(h2s()).toContain('Chat background');
    expect(h2s()).not.toContain('Who can message you');
    expect(byText(menu as HTMLElement, 'button', 'Appearance')?.getAttribute('aria-current')).toBe('true');
    await click(byText(menu as HTMLElement, 'button', 'Account'));
    expect(byText(document.body, 'button', 'Sign out')).not.toBeNull();
    expect(document.querySelectorAll('nav').length).toBe(0); // the section list is a group, not a second navigation landmark
    expect(await axeViolations(document.body)).toBe('');
  });

  it('resizing to desktop and back keeps all sections reachable', async () => {
    const vp = await open(390, settings());
    await act(async () => { vp.resizeTo(1280); });
    await flush();
    expect(sectionMenu()).not.toBeNull();
    await act(async () => { vp.resizeTo(390); });
    await flush();
    expect(sectionMenu()).toBeNull();
    expect(h2s()).toContain('Chat background');
  });
});

describe('Profile header is roomier on wider screens', () => {
  const profile = { id: 'usr_me', user_id: 'usr_me', username: 'mia', display_name: 'Mia', bio: 'hi', avatar_media_id: null, followers_count: 1, following_count: 2, posts_count: 0, is_following: false };
  const avatarSize = async (width: number) => {
    const net = installFetch({ 'GET /api/users/mia/posts': () => json({ posts: [] }), 'GET /api/users/mia': () => json(profile), ...baseRoutes() }); cleanups.push(net.restore);
    const vp = installViewport(width); cleanups.push(vp.restore);
    m = await mount(<LayoutProvider><ProfileViewPage initialUsername="mia" currentUserId="usr_me" currentUsername="mia" /></LayoutProvider>);
    await flush(); await flush();
    const grid = document.querySelector('.grid-cols-3')!;
    return { grid: grid.className, header: document.querySelector('[data-wallpaper] > div')!.className };
  };
  it('phone keeps the original spacing, tablet and desktop get more', async () => {
    const phone = await avatarSize(390);
    expect(phone.header).toContain('p-4');
    expect(phone.grid).toContain('gap-[2px]');
    m!.unmount(); m = null; cleanups.splice(0).forEach((c) => c());
    await new Promise((r) => setTimeout(r, 60));
    const desktop = await avatarSize(1280);
    expect(desktop.header).toContain('p-6');
    expect(desktop.grid).toContain('gap-1');
  });
});

describe('Sign-in on wider screens is a centered card', () => {
  it('phone: unchanged full page; tablet: card styles are present on the sign-in panel', async () => {
    const net = installFetch({ 'GET /api/me': () => json({ error: 'no' }, 401) }); cleanups.push(net.restore);
    const vp = installViewport(820); cleanups.push(vp.restore);
    window.scrollTo = (() => undefined) as unknown as typeof window.scrollTo;
    m = await mount(<LayoutProvider><App /></LayoutProvider>);
    await flush(); await flush();
    const panel = document.querySelector<HTMLElement>('h1')!.closest<HTMLElement>('.max-w-\\[360px\\]')!;
    expect(panel.className).toContain('tablet:rounded-[16px]');
    expect(panel.className).toContain('tablet:border');
    expect(document.querySelector('nav[aria-label="Navigation"]')).toBeNull(); // no navigation before signing in
    expect(document.documentElement.dataset.layout).toBe('tablet');
    expect(await axeViolations(document.body)).toBe('');
  });
});

describe('the wide column is defined and really reaches the built CSS', () => {
  it('index.css defines --wide-w and the max-w-wide utility source', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/index.css', 'utf8');
    expect(css).toMatch(/--wide-w:\s*960px/);
    expect(css).toMatch(/--container-wide:\s*var\(--wide-w\)/);
  });
});

describe('keyboard: arrow keys move between rows and sections', () => {
  const press = async (el: Element, key: string) => { await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); }); };

  it('Messages list: Down and Up move focus between conversations, Home and End jump', async () => {
    const two: ConversationItem = { ...conv, id: 'conv_2', other_user: { id: 'u8', username: 'amy', display_name: 'Amy', avatar_media_id: null } };
    const net = installFetch({ ...baseRoutes(), 'GET /api/conversations': () => json({ conversations: [conv, two] }) }); cleanups.push(net.restore);
    const vp = installViewport(1280); cleanups.push(vp.restore);
    m = await mount(<LayoutProvider>{messages()}</LayoutProvider>);
    await flush(); await flush();
    const rows = [...document.querySelectorAll<HTMLElement>('li button')];
    expect(rows.length).toBe(2);
    rows[0]!.focus();
    await press(rows[0]!, 'ArrowDown');
    expect(document.activeElement).toBe(rows[1]);
    await press(rows[1]!, 'ArrowDown');
    expect(document.activeElement).toBe(rows[1]); // stays on the last row
    await press(rows[1]!, 'ArrowUp');
    expect(document.activeElement).toBe(rows[0]);
    await press(rows[0]!, 'End');
    expect(document.activeElement).toBe(rows[1]);
    await press(rows[1]!, 'Home');
    expect(document.activeElement).toBe(rows[0]);
  });

  it('Settings sections on desktop: Down moves focus to the next section button', async () => {
    await open(1280, <SettingsPage currentUser={me} onProfileUpdated={() => undefined} onAccountDeleted={() => undefined} onLogout={() => undefined} onBack={() => undefined} />);
    const buttons = [...document.querySelectorAll<HTMLElement>('[role="group"][aria-label="Settings sections"] button')];
    buttons[0]!.focus();
    await press(buttons[0]!, 'ArrowDown');
    expect(document.activeElement).toBe(buttons[1]);
  });
});

describe('overlays sit over the column, not over the whole screen', () => {
  it('--nav-w is the navigation width per layout and SideNav and the overlays use it', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/index.css', 'utf8');
    expect(css).toMatch(/:root\[data-layout="tablet"\]\s*\{\s*--nav-w:\s*72px/);
    expect(css).toMatch(/:root\[data-layout="desktop"\]\s*\{\s*--nav-w:\s*240px/);
    expect(css).toMatch(/--nav-w:\s*0px/); // phones have no side navigation
    expect(readFileSync('src/components/SideNav.tsx', 'utf8')).toContain('w-[var(--nav-w)]');
    for (const f of ['chat/ForwardPicker', 'chat/AttachSheet', 'chat/MediaViewer', 'chat/MediaPreview', 'BottomSheet']) {
      expect(readFileSync(`src/components/${f}.tsx`, 'utf8'), f).toContain('var(--nav-w,0px)');
    }
    expect(readFileSync('src/pages/PostComposerPage.tsx', 'utf8')).toContain('var(--nav-w,0px)');
  });
});
