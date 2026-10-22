// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { SettingsPage } from '../src/pages/SettingsPage.tsx';
import { ProfileEditPage } from '../src/pages/ProfileEditPage.tsx';
import { ChatScreen } from '../src/components/chat/ChatScreen.tsx';
import { ChatBackground } from '../src/components/chat/ChatBackground.tsx';
import { loadChatBackground, saveChatBackgroundPreset } from '../src/lib/chat-background.ts';
import { IMAGE_SCRIM_ALPHA } from '../shared/chat-background.ts';
import { mount, click, typeInto, flush, byLabel, byText, axeViolations, installFetch, json, pngFile, stubObjectUrls, type Mounted } from './_ui.tsx';
import type { MeResponse, ConversationItem } from '../shared/schema.ts';

vi.mock('../src/lib/media-upload.ts', async (orig) => {
  const real = await orig<typeof import('../src/lib/media-upload.ts')>();
  // Canvas work cannot run in jsdom: pretend the upload worked and return a media row
  return { ...real, prepareAndUpload: vi.fn(async (item: { sendAs: string }) => ({ id: `med_${item.sendAs}`, object_key: 'k', mime_type: 'image/webp', size_bytes: 5, kind: item.sendAs })) };
});

let m: Mounted | null = null;
const restores: Array<() => void> = [];
afterEach(() => { m?.unmount(); m = null; restores.splice(0).forEach((r) => r()); document.body.innerHTML = ''; });
beforeEach(() => { restores.push(stubObjectUrls()); });

const me: MeResponse = {
  user: { id: 'usr_me', created_at: '', status: 'active' },
  profile: { username: 'mia', username_normalized: 'mia', display_name: 'Mia', bio: '', avatar_media_id: null, class_id: null, campus_id: null },
  settings: { dm_policy: 'everyone', feed_preferences: 'for_you' },
} as MeResponse;

const baseRoutes = {
  'GET /api/blocks': () => json({ blocks: [{ user_id: 'usr_b', username: 'bob', display_name: 'Bob' }] }),
  'GET /api/me/interests': () => json({ interests: [{ topic_id: 't1', slug: 'cricket' }] }),
  'GET /api/stickers/library': () => json({ items: [{ media_id: 'med_s1', kind: 'sticker', mime_type: 'image/webp', width: 512, height: 512 }] }),
};

describe('Settings page', () => {
  it('has every section from the page map, and no axe violations', async () => {
    const net = installFetch(baseRoutes); restores.push(net.restore);
    m = await mount(<SettingsPage currentUser={me} onProfileUpdated={() => undefined} onAccountDeleted={() => undefined} onLogout={() => undefined} onBack={() => undefined} />);
    await flush(); await flush();
    for (const h of ['Chat background', 'Who can message you', 'Blocked people', 'Interests', 'My stickers & GIFs', 'Account']) {
      expect([...m.container.querySelectorAll('h2')].some((e) => e.textContent === h), h).toBe(true);
    }
    expect(byText(m.container, 'button', 'Sign out')).not.toBeNull();
    expect(byText(m.container, 'button', 'Delete account')).not.toBeNull();
    expect(m.container.querySelector('[data-testid="bg-preview"]')?.textContent).toContain('Hello!');
    expect(await axeViolations(m.container)).toBe('');
  });

  it('choosing a preset updates the live preview and is kept on the phone; Reset returns to Plain', async () => {
    const net = installFetch(baseRoutes); restores.push(net.restore);
    m = await mount(<SettingsPage currentUser={me} onProfileUpdated={() => undefined} onAccountDeleted={() => undefined} onLogout={() => undefined} onBack={() => undefined} />);
    await flush();
    expect(byText(m.container, '[role="radio"]', 'Plain')?.getAttribute('aria-checked')).toBe('true');
    await click(byText(m.container, '[role="radio"]', 'Mint'));
    await flush();
    expect(byText(m.container, '[role="radio"]', 'Mint')?.getAttribute('aria-checked')).toBe('true');
    expect(await loadChatBackground('usr_me')).toEqual({ kind: 'preset', id: 'mint' });
    expect(net.calls.some((c) => c.method !== 'GET')).toBe(false); // nothing was sent to the server
    await click(byText(m.container, 'button', 'Reset'));
    await flush();
    expect(await loadChatBackground('usr_me')).toEqual({ kind: 'preset', id: 'plain' });
  });

  it('saves who can message you, and puts the old value back if saving fails', async () => {
    let status = 200;
    const net = installFetch({ ...baseRoutes, 'PATCH /api/me': () => json({}, status), 'GET /api/me': () => json(me) }); restores.push(net.restore);
    m = await mount(<SettingsPage currentUser={me} onProfileUpdated={() => undefined} onAccountDeleted={() => undefined} onLogout={() => undefined} onBack={() => undefined} />);
    await flush();
    const select = m.container.querySelector('#dm-policy-select') as unknown as HTMLSelectElement;
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    await act(async () => { set.call(select, 'none'); select.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    expect(net.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ dm_policy: 'none' });
    expect(select.value).toBe('none');
    status = 500;
    await act(async () => { set.call(select, 'following'); select.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush(); await flush();
    expect(select.value).toBe('none'); // rolled back
    expect(m.container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('unblocks, removes an interest and removes a sticker from the library', async () => {
    const net = installFetch({
      ...baseRoutes,
      'DELETE /api/blocks/usr_b': () => json({ success: true }),
      'DELETE /api/me/interests/t1': () => json({ success: true }),
      'DELETE /api/stickers/library/med_s1': () => json({ success: true }),
    }); restores.push(net.restore);
    m = await mount(<SettingsPage currentUser={me} onProfileUpdated={() => undefined} onAccountDeleted={() => undefined} onLogout={() => undefined} onBack={() => undefined} />);
    await flush(); await flush();
    expect(m.container.textContent).toContain('@bob');
    await click(byLabel(m.container, 'Unblock @bob')); await flush();
    expect(m.container.textContent).toContain('No blocked people');
    await click(byLabel(m.container, 'Remove #cricket')); await flush();
    expect(m.container.textContent).not.toContain('#cricket');
    await click(byLabel(m.container, 'Remove sticker')); await flush();
    expect(m.container.textContent).toContain('No stickers yet');
  });

  it('deleting the account needs the username typed exactly (positive control: it then deletes)', async () => {
    const onDeleted = vi.fn();
    const net = installFetch({ ...baseRoutes, 'DELETE /api/me': () => json({ success: true }) }); restores.push(net.restore);
    m = await mount(<SettingsPage currentUser={me} onProfileUpdated={() => undefined} onAccountDeleted={onDeleted} onLogout={() => undefined} onBack={() => undefined} />);
    await flush();
    await click(byText(m.container, 'button', 'Delete account'));
    const confirm = byText(m.container, 'button', 'Delete permanently') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    const input = byLabel(m.container, 'Confirm username to delete account') as HTMLInputElement;
    await typeInto(input, 'wrong');
    expect(confirm.disabled).toBe(true);
    await typeInto(input, 'mia');
    expect(confirm.disabled).toBe(false);
    await click(confirm); await flush();
    expect(onDeleted).toHaveBeenCalled();
  });

  it('adding from the phone opens the preview in library mode and uploads only after Add', async () => {
    const net = installFetch({ ...baseRoutes, 'POST /api/stickers/library': () => json({ success: true }, 201) }); restores.push(net.restore);
    m = await mount(<SettingsPage currentUser={me} onProfileUpdated={() => undefined} onAccountDeleted={() => undefined} onLogout={() => undefined} onBack={() => undefined} />);
    await flush();
    const input = m.container.querySelector<HTMLInputElement>('[data-testid="settings-library-input"]')!;
    await act(async () => { Object.defineProperty(input, 'files', { configurable: true, value: [pngFile()] }); input.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush(); await flush();
    expect(m.container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Add to my stickers and GIFs');
    expect(net.calls.some((c) => c.method === 'POST')).toBe(false);
    await click(byText(m.container, 'button', 'Add')); await flush(); await flush();
    expect(net.calls.find((c) => c.method === 'POST')?.body).toEqual({ media_id: 'med_sticker' });
  });
});

describe('Edit profile no longer holds the moved controls', () => {
  it('has no message policy, blocked list, interests, sign out or delete (positive control: Settings has them)', async () => {
    const net = installFetch({ ...baseRoutes, 'GET /api/classes': () => json({ classes: [] }) }); restores.push(net.restore);
    m = await mount(<ProfileEditPage currentUser={me} onProfileUpdated={() => undefined} onViewPublicProfile={() => undefined} onCancel={() => undefined} />);
    await flush();
    const text = m.container.textContent ?? '';
    for (const gone of ['Direct Messages', 'Blocked users', 'Interests', 'Log out', 'Sign out', 'Delete account']) expect(text, gone).not.toContain(gone);
    expect(m.container.querySelector('#dm-policy-select')).toBeNull();
    expect(text).toContain('Profile style'); // identity and look are still here
    expect(net.calls.some((c) => c.url.startsWith('/api/blocks') || c.url.startsWith('/api/me/interests'))).toBe(false);
  });
});

describe('Chat background behind messages', () => {
  it('an imported image sits under a scrim in the surface color at the tested opacity; presets have none', async () => {
    m = await mount(<ChatBackground choice={{ kind: 'image', blob: new Blob(['x'], { type: 'image/webp' }) }}><p>hi</p></ChatBackground>);
    const scrim = m.container.querySelector<HTMLElement>('[data-testid="chat-scrim"]')!;
    expect(scrim.style.opacity).toBe(String(IMAGE_SCRIM_ALPHA));
    m.unmount();
    m = await mount(<ChatBackground choice={{ kind: 'preset', id: 'mint' }}><p>hi</p></ChatBackground>);
    expect(m.container.querySelector('[data-testid="chat-scrim"]')).toBeNull();
    expect(m.container.querySelector<HTMLElement>('[data-testid="chat-background"]')!.style.backgroundColor).not.toBe('');
  });
});

describe('Chat screen flow', () => {
  const conv: ConversationItem = { id: 'conv_1', created_at: '', other_user: { id: 'usr_z', username: 'zed', display_name: 'Zed', avatar_media_id: 'med_av' }, last_message: null };
  const sentMessage = (body: string, ids: string[]) => ({ id: `m_${Math.random()}`, conversation_id: 'conv_1', sender_id: 'usr_me', sender_username: 'mia', sender_display_name: 'Mia', body, sent_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString(), media: ids.map((id) => ({ id, object_key: 'k', mime_type: 'image/webp', size_bytes: 5, kind: id.replace('med_', '') })) });
  const routes = () => ({
    'GET /api/conversations/conv_1/messages': () => json({ messages: [] }),
    'POST /api/conversations/conv_1/messages': (b: unknown) => json({ message: sentMessage((b as { body: string }).body, (b as { media_ids: string[] }).media_ids) }, 201),
    'GET /api/stickers/library': () => json({ items: [{ media_id: 'med_sticker', kind: 'sticker', mime_type: 'image/webp', width: 512, height: 512 }] }),
    'POST /api/blocks': () => json({ success: true }),
  });
  const open = () => mount(<ChatScreen conversation={conv} currentUserId="usr_me" onBack={() => undefined} onViewProfile={() => undefined} onSent={() => undefined} />);

  it('shows the other person’s picture in the header, and sends a typed message', async () => {
    const net = installFetch(routes()); restores.push(net.restore);
    m = await open(); await flush();
    expect(m.container.querySelector('header img[src="/api/media/med_av"]')).not.toBeNull();
    await typeInto(byLabel(m.container, 'Message') as HTMLTextAreaElement, 'hello zed');
    await click(byLabel(m.container, 'Send')); await flush();
    expect(net.calls.find((c) => c.method === 'POST')?.body).toEqual({ body: 'hello zed', media_ids: [] });
    expect(m.container.textContent).toContain('hello zed');
  });

  it('gallery files go through the preview; nothing is uploaded until Send, then the message carries the media ids and the caption', async () => {
    const { prepareAndUpload } = await import('../src/lib/media-upload.ts');
    (prepareAndUpload as ReturnType<typeof vi.fn>).mockClear();
    const net = installFetch(routes()); restores.push(net.restore);
    m = await open(); await flush();
    await click(byLabel(m.container, 'Attach'));
    const input = m.container.querySelector<HTMLInputElement>('[data-testid="gallery-input"]')!;
    await act(async () => { Object.defineProperty(input, 'files', { configurable: true, value: [pngFile()] }); input.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush(); await flush();
    expect(m.container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Preview before sending');
    expect(prepareAndUpload).not.toHaveBeenCalled();
    expect(net.calls.filter((c) => c.method === 'POST')).toEqual([]);
    await typeInto(m.container.querySelector<HTMLInputElement>('#preview-caption')!, 'nice');
    await click(byText(m.container, 'button', 'Send')); await flush(); await flush();
    expect(prepareAndUpload).toHaveBeenCalledTimes(1);
    expect(net.calls.find((c) => c.method === 'POST')?.body).toEqual({ body: 'nice', media_ids: ['med_photo'] });
    expect(m.container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('picking from the sticker panel sends that library item by key', async () => {
    const net = installFetch(routes()); restores.push(net.restore);
    m = await open(); await flush();
    await click(byLabel(m.container, 'Stickers and GIFs')); await flush(); await flush();
    expect(m.container.querySelector('[data-testid="picker-panel"]')).not.toBeNull();
    await click(byLabel(m.container, 'Send Sticker')); await flush();
    expect(net.calls.find((c) => c.method === 'POST' && c.url.includes('messages'))?.body).toEqual({ body: '', media_ids: [], sticker_key: 'usr:med_sticker' });
  });

  it('the menu offers Block and Report', async () => {
    const net = installFetch(routes()); restores.push(net.restore);
    m = await open(); await flush();
    await click(byLabel(m.container, 'Chat menu'));
    expect(byText(m.container, '[role="menuitem"]', 'Block @zed')).not.toBeNull();
    expect(byText(m.container, '[role="menuitem"]', 'Report @zed')).not.toBeNull();
  });

  it('applies the saved background behind the messages', async () => {
    await saveChatBackgroundPreset('usr_me', 'sky');
    const net = installFetch(routes()); restores.push(net.restore);
    m = await open(); await flush(); await flush();
    expect(m.container.querySelector('[data-testid="chat-background"]')?.getAttribute('data-kind')).toBe('preset');
    expect(m.container.querySelector<HTMLElement>('[data-testid="chat-background"]')!.style.backgroundColor).toBe('rgb(220, 235, 250)');
  });
});
