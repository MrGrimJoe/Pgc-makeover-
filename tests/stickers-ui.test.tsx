// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { StickerView } from '../src/components/StickerView.tsx';
import { PickerPanel } from '../src/components/chat/PickerPanel.tsx';
import { PostCard } from '../src/components/PostCard.tsx';
import { CommentModal } from '../src/components/CommentModal.tsx';
import { PostComposerPage } from '../src/pages/PostComposerPage.tsx';
import { MessageBubble } from '../src/components/chat/MessageBubble.tsx';
import { pushRecent, loadRecent, saveRecent, RECENT_MAX } from '../src/lib/recent-stickers.ts';
import { STICKER_PACKS } from '../shared/stickers.ts';
import { appKey, bundledUrl } from '../shared/sticker-keys.ts';
import { mount, click, typeInto, flush, byLabel, byText, axeViolations, installFetch, json, stubMatchMedia, type Mounted } from './_ui.tsx';
import type { PostItem, MessageItem } from '../shared/schema.ts';

let m: Mounted | null = null;
const restores: Array<() => void> = [];
afterEach(() => { m?.unmount(); m = null; restores.splice(0).forEach((r) => r()); document.body.innerHTML = ''; localStorage.clear(); });

const pack = STICKER_PACKS[0]!;
const still = pack.items.find((i) => i.kind === 'sticker')!;
const loop = pack.items.find((i) => i.kind === 'gif')!;
const STILL_KEY = appKey(pack.id, still.number);
const LOOP_KEY = appKey(pack.id, loop.number);

describe('recent stickers (device only)', () => {
  it('puts the newest first, removes duplicates, caps the list, and ignores uploaded keys', () => {
    expect(pushRecent(['app:a/1', 'app:a/2'], 'app:a/2')).toEqual(['app:a/2', 'app:a/1']);
    expect(pushRecent(['app:a/1'], 'usr:med_x')).toEqual(['app:a/1']);
    const many = Array.from({ length: 40 }, (_, i) => `app:a/${i + 1}`);
    expect(pushRecent(many, 'app:b/1')).toHaveLength(RECENT_MAX);
  });
  it('is kept in localStorage per person, and a corrupt value is ignored', () => {
    saveRecent('u1', 'app:a/1'); saveRecent('u1', 'app:a/2');
    expect(loadRecent('u1')).toEqual(['app:a/2', 'app:a/1']);
    expect(loadRecent('u2')).toEqual([]);
    localStorage.setItem('recent-stickers:u1', '{"not":"a list"}');
    expect(loadRecent('u1')).toEqual([]);
    localStorage.setItem('recent-stickers:u1', JSON.stringify(['app:a/1', 'javascript:alert(1)', 5, 'usr:med_x']));
    expect(loadRecent('u1')).toEqual(['app:a/1']);
    expect(loadRecent('u1', null)).toEqual([]);
  });
});

describe('StickerView', () => {
  it('shows a bundled sticker from the static path with the versioned URL and its alt text', async () => {
    m = await mount(<StickerView stickerKey={STILL_KEY} size={160} />);
    const img = m.container.querySelector('img')!;
    expect(img.getAttribute('src')).toBe(bundledUrl(pack, still));
    expect(img.getAttribute('alt')).toBe(still.alt);
    expect(img.width).toBe(160);
  });

  it('shows an uploaded sticker from /api/media, and an uploaded loop as video', async () => {
    m = await mount(<StickerView stickerKey="usr:med_abc" />);
    expect(m.container.querySelector('img')!.getAttribute('src')).toBe('/api/media/med_abc');
    m.unmount();
    m = await mount(<StickerView stickerKey="usr:med_abc" media={[{ id: 'med_abc', object_key: 'k', mime_type: 'video/mp4', size_bytes: 1, kind: 'gif' }]} />);
    expect(m.container.querySelector('video')!.getAttribute('src')).toBe('/api/media/med_abc');
  });

  it('shows a placeholder for retired, unknown or malformed keys instead of breaking', async () => {
    for (const key of ['app:placeholder/99999', 'app:nope/1', 'garbage', '', 'usr:../x']) {
      m = await mount(<StickerView stickerKey={key} />);
      expect(m.container.querySelector('[aria-label="Sticker unavailable"]'), key).not.toBeNull();
      expect(m.container.querySelector('img')).toBeNull();
      m.unmount();
    }
    // positive control: a real key does not show the placeholder
    m = await mount(<StickerView stickerKey={STILL_KEY} />);
    expect(m.container.querySelector('[aria-label="Sticker unavailable"]')).toBeNull();
  });

  it('falls back to the placeholder when an uploaded file fails to load', async () => {
    m = await mount(<StickerView stickerKey="usr:med_gone" />);
    await act(async () => { m!.container.querySelector('img')!.dispatchEvent(new Event('error')); });
    expect(m.container.querySelector('[aria-label="Sticker unavailable"]')).not.toBeNull();
  });

  it('bundled GIFs autoplay, and wait behind a play button with reduced motion', async () => {
    m = await mount(<StickerView stickerKey={LOOP_KEY} />);
    expect(m.container.querySelector('img')!.getAttribute('src')).toBe(bundledUrl(pack, loop));
    m.unmount();
    restores.push(stubMatchMedia((q) => q.includes('prefers-reduced-motion')));
    m = await mount(<StickerView stickerKey={LOOP_KEY} />);
    expect(m.container.querySelector('img')).toBeNull();
    await click(m.container.querySelector('button'));
    expect(m.container.querySelector('img')).not.toBeNull();
  });
});

describe('PickerPanel', () => {
  const library = { 'GET /api/stickers/library': () => json({ items: [{ media_id: 'med_mine', kind: 'sticker', mime_type: 'image/webp', width: 512, height: 512 }, { media_id: 'med_loop', kind: 'gif', mime_type: 'image/gif', width: 100, height: 100 }] }) };
  beforeEach(() => { const net = installFetch(library); restores.push(net.restore); });

  it('has Stickers and GIFs tabs, Mine, and a chip for each bundled pack (the placeholder pack is named as such)', async () => {
    m = await mount(<PickerPanel userId="u1" onPick={() => undefined} onAddFiles={() => undefined} />);
    await flush();
    expect(byText(m.container, '[role="tab"]', 'Stickers')?.getAttribute('aria-selected')).toBe('true');
    expect(byText(m.container, '[role="radio"]', 'Mine')).not.toBeNull();
    expect(byText(m.container, '[role="radio"]', pack.name)).not.toBeNull();
    expect(byText(m.container, '[role="radio"]', 'Recent')).toBeNull(); // nothing used yet
  });

  it('sends the key of a bundled sticker, remembers it as recent on this device, and shows Recent next time', async () => {
    const onPick = vi.fn();
    m = await mount(<PickerPanel userId="u1" onPick={onPick} onAddFiles={() => undefined} />);
    await flush();
    await click(byText(m.container, '[role="radio"]', pack.name));
    await click(byLabel(m.container, `Send ${still.alt}`));
    expect(onPick).toHaveBeenCalledWith(STILL_KEY, 'sticker');
    expect(loadRecent('u1')).toEqual([STILL_KEY]);
    expect(byText(m.container, '[role="radio"]', 'Recent')).not.toBeNull();
    expect(loadRecent('u2')).toEqual([]); // recents never leave the person
  });

  it('GIFs tab lists bundled GIFs and uploaded GIFs, and sends their keys', async () => {
    const onPick = vi.fn();
    m = await mount(<PickerPanel userId="u1" initialTab="gifs" onPick={onPick} onAddFiles={() => undefined} />);
    await flush();
    await click(byText(m.container, '[role="radio"]', 'Mine'));
    await click(byLabel(m.container, 'Send GIF'));
    expect(onPick).toHaveBeenCalledWith('usr:med_loop', 'gif');
    await click(byText(m.container, '[role="radio"]', pack.name));
    await click(byLabel(m.container, `Send ${loop.alt}`));
    expect(onPick).toHaveBeenLastCalledWith(LOOP_KEY, 'gif');
  });

  it('Mine only offers Manage when there is something to manage, and Manage removes an upload', async () => {
    const net = installFetch({ ...library, 'DELETE /api/stickers/library/med_mine': () => json({ success: true }) }); restores.push(net.restore);
    m = await mount(<PickerPanel userId="u1" onPick={() => undefined} onAddFiles={() => undefined} />);
    await flush();
    await click(byText(m.container, '[role="radio"]', 'Mine'));
    expect(byText(m.container, 'button', 'Manage')).not.toBeNull();
    await click(byText(m.container, 'button', 'Manage'));
    await click(byLabel(m.container, 'Remove Sticker'));
    await flush();
    expect(net.calls.find((c) => c.method === 'DELETE')?.url).toBe('/api/stickers/library/med_mine');
    expect(byText(m.container, 'button', 'Manage')).toBeNull(); // nothing left to manage
    expect(m.container.textContent).toContain('No stickers yet');
  });

  it('with reduced motion bundled GIFs are a still "GIF" tile until sent', async () => {
    restores.push(stubMatchMedia((q) => q.includes('prefers-reduced-motion')));
    m = await mount(<PickerPanel userId="u1" initialTab="gifs" onPick={() => undefined} onAddFiles={() => undefined} />);
    await flush();
    await click(byText(m.container, '[role="radio"]', pack.name));
    expect(m.container.querySelector(`button[aria-label="Send ${loop.alt}"] img`)).toBeNull();
    expect(m.container.querySelector(`button[aria-label="Send ${loop.alt}"]`)?.textContent).toBe('GIF');
  });

  it('Add from phone passes the chosen files up (the preview handles the rest), and there are no axe violations', async () => {
    const onAdd = vi.fn();
    m = await mount(<PickerPanel userId="u1" onPick={() => undefined} onAddFiles={onAdd} />);
    await flush();
    expect(await axeViolations(m.container)).toBe('');
    const input = m.container.querySelector<HTMLInputElement>('[data-testid="library-input"]')!;
    const file = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' });
    await act(async () => { Object.defineProperty(input, 'files', { configurable: true, value: [file] }); input.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(onAdd).toHaveBeenCalledWith([file]);
  });
});

describe('stickers on posts, comments and messages', () => {
  const post = (over: Partial<PostItem> = {}): PostItem => ({
    id: 'p1', author_id: 'u2', author_username: 'zed', author_display_name: 'Zed', author_avatar_media_id: null, body: 'hello #cricket',
    created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString(), status: 'active', media: [], likes_count: 0, has_liked: false, comments_count: 0, ...over,
  });

  it('a post card shows its sticker under the text, and an uploaded sticker is not drawn as a full-bleed photo', async () => {
    m = await mount(<PostCard post={post({ sticker_key: STILL_KEY })} currentUserId="u1" />);
    expect(m.container.querySelector(`img[src="${bundledUrl(pack, still)}"]`)).not.toBeNull();
    m.unmount();
    const attached = { id: 'med_u', object_key: 'k', mime_type: 'image/webp', size_bytes: 1, kind: 'sticker' };
    m = await mount(<PostCard post={post({ sticker_key: 'usr:med_u', media: [attached] })} currentUserId="u1" />);
    expect(m.container.querySelector('img[alt^="Photo post"]')).toBeNull();
    expect(m.container.querySelector('img[src="/api/media/med_u"]')).not.toBeNull();
    m.unmount();
    // positive control: a real photo is still shown as a photo
    m = await mount(<PostCard post={post({ media: [{ id: 'med_p', object_key: 'k', mime_type: 'image/webp', size_bytes: 1, kind: 'photo' }] })} currentUserId="u1" />);
    expect(m.container.querySelector('img[alt^="Photo post"]')).not.toBeNull();
  });

  it('a message bubble shows a bundled sticker without a bubble and an uploaded one only once', async () => {
    const base: MessageItem = { id: 'm1', conversation_id: 'c', sender_id: 'u2', sender_username: 'zed', sender_display_name: 'Zed', body: '', sent_at: '', expires_at: new Date(Date.now() + 86_400_000).toISOString(), media: [] };
    m = await mount(<MessageBubble msg={{ ...base, sticker_key: STILL_KEY }} isSelf={false} onOpenMedia={() => undefined} />);
    expect(m.container.querySelector(`img[src="${bundledUrl(pack, still)}"]`)).not.toBeNull();
    expect(m.container.querySelector('[class*="rounded-[16px]"]')).toBeNull();
    m.unmount();
    const row = { id: 'med_u', object_key: 'k', mime_type: 'image/webp', size_bytes: 1, kind: 'sticker' };
    m = await mount(<MessageBubble msg={{ ...base, sticker_key: 'usr:med_u', media: [row] }} isSelf={false} onOpenMedia={() => undefined} />);
    expect(m.container.querySelectorAll('img[src="/api/media/med_u"]').length).toBe(1);
  });

  describe('comments', () => {
    const comments = { comments: [
      { id: 'c1', post_id: 'p1', author_id: 'u2', author_username: 'zed', author_display_name: 'Zed', body: 'nice', sticker_key: null, created_at: new Date().toISOString() },
      { id: 'c2', post_id: 'p1', author_id: 'u3', author_username: 'amy', author_display_name: 'Amy', body: '', sticker_key: STILL_KEY, created_at: new Date().toISOString() },
    ] };

    it('shows sticker comments, and offers Report on other people’s comments only', async () => {
      const net = installFetch({ 'GET /api/posts/p1/comments': () => json(comments) }); restores.push(net.restore);
      m = await mount(<CommentModal postId="p1" currentUserId="u2" onClose={() => undefined} />);
      await flush(); await flush();
      expect(m.container.querySelector(`img[src="${bundledUrl(pack, still)}"]`)).not.toBeNull();
      expect(m.container.querySelectorAll('[aria-label="Report this comment"]').length).toBe(1); // only Amy's; Zed is me
      await click(byLabel(m.container, 'Report this comment'));
      expect(m.container.textContent).toContain('Report');
    });

    it('picks a sticker, shows it before sending, and sends text and/or the key; a sticker alone is enough', async () => {
      const net = installFetch({
        'GET /api/posts/p1/comments': () => json({ comments: [] }),
        'GET /api/stickers/library': () => json({ items: [] }),
        'POST /api/posts/p1/comments': (b) => json({ id: 'cNew', post_id: 'p1', author_id: 'u2', author_username: 'zed', author_display_name: 'Zed', body: (b as { body: string }).body, sticker_key: (b as { sticker_key?: string }).sticker_key ?? null, created_at: new Date().toISOString() }, 201),
      }); restores.push(net.restore);
      m = await mount(<CommentModal postId="p1" currentUserId="u2" onClose={() => undefined} />);
      await flush();
      expect((byLabel(m.container, 'Send') as HTMLButtonElement).disabled).toBe(true);
      await click(byLabel(m.container, 'Stickers and GIFs'));
      await flush();
      await click(byText(m.container, '[role="radio"]', pack.name));
      await click(byLabel(m.container, `Send ${still.alt}`));
      expect(m.container.querySelector('[aria-label="Remove sticker"]')).not.toBeNull();
      expect((byLabel(m.container, 'Send') as HTMLButtonElement).disabled).toBe(false); // sticker alone
      await click(byLabel(m.container, 'Send')); await flush();
      expect(net.calls.find((c) => c.method === 'POST' && c.url.includes('comments'))?.body).toEqual({ body: '', sticker_key: STILL_KEY });
      expect(m.container.querySelector('[aria-label="Remove sticker"]')).toBeNull(); // cleared after sending
    });
  });

  describe('New post page', () => {
    it('offers photos or one sticker, never both: choosing one disables the other', async () => {
      const net = installFetch({ 'GET /api/stickers/library': () => json({ items: [] }) }); restores.push(net.restore);
      m = await mount(<PostComposerPage currentUserId="u1" onPostCreated={() => undefined} />);
      expect((byLabel(m.container, 'Add photo') as HTMLButtonElement).disabled).toBe(false);
      await click(byLabel(m.container, 'Add sticker or GIF'));
      await flush();
      await click(byText(m.container, '[role="radio"]', pack.name));
      await click(byLabel(m.container, `Send ${still.alt}`));
      expect((byLabel(m.container, 'Add photo') as HTMLButtonElement).disabled).toBe(true);
      await click(byLabel(m.container, 'Remove sticker'));
      expect((byLabel(m.container, 'Add photo') as HTMLButtonElement).disabled).toBe(false);
    });

    it('posts text with the sticker key (and no media ids)', async () => {
      const net = installFetch({
        'GET /api/stickers/library': () => json({ items: [] }),
        'POST /api/posts': () => json({ id: 'p9' }, 201),
      }); restores.push(net.restore);
      const onCreated = vi.fn();
      m = await mount(<PostComposerPage currentUserId="u1" onPostCreated={onCreated} />);
      await typeInto(m.container.querySelector('textarea')!, 'with a sticker');
      await click(byLabel(m.container, 'Add sticker or GIF'));
      await flush();
      await click(byText(m.container, '[role="radio"]', pack.name));
      await click(byLabel(m.container, `Send ${still.alt}`));
      await click(byText(m.container, 'button', 'Post')); await flush();
      expect(net.calls.find((c) => c.url === '/api/posts')?.body).toEqual({ body: 'with a sticker', media_ids: [], sticker_key: STILL_KEY });
      expect(onCreated).toHaveBeenCalled();
    });

    it('the sticker sheet has no axe violations and closes on Escape', async () => {
      const net = installFetch({ 'GET /api/stickers/library': () => json({ items: [] }) }); restores.push(net.restore);
      m = await mount(<PostComposerPage currentUserId="u1" onPostCreated={() => undefined} />);
      await click(byLabel(m.container, 'Add sticker or GIF'));
      await flush();
      expect(await axeViolations(m.container)).toBe('');
      await act(async () => { m!.container.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      expect(m.container.querySelector('[role="dialog"]')).toBeNull();
    });
  });
});
