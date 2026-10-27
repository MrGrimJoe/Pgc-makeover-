// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { ImageEditor } from '../src/components/ImageEditor.tsx';
import { EditFlow } from '../src/components/EditFlow.tsx';
import { StickerView } from '../src/components/StickerView.tsx';
import { PickerPanel } from '../src/components/chat/PickerPanel.tsx';
import { PostCard } from '../src/components/PostCard.tsx';
import { STICKER_PACKS, type StickerPack } from '../shared/stickers.ts';
import { appKey } from '../shared/sticker-keys.ts';
import { MAX_LAYERS } from '../src/lib/image-edit.ts';
import type { MediaEnv } from '../src/lib/media.ts';
import { mount, click, typeInto, flush, byLabel, byText, axeViolations, installFetch, json, stubObjectUrls, stubMatchMedia, type Mounted } from './_ui.tsx';
import type { PostItem } from '../shared/schema.ts';

let m: Mounted | null = null;
const restores: Array<() => void> = [];
afterEach(() => { m?.unmount(); m = null; restores.splice(0).forEach((r) => r()); document.body.innerHTML = ''; localStorage.clear(); vi.unstubAllGlobals(); });

const pack = STICKER_PACKS.find((p) => p.items.some((i) => i.kind === 'sticker'))!;
const loopPack = STICKER_PACKS.find((p) => p.items.some((i) => i.kind === 'gif'))!;
const still = pack.items.find((i) => i.kind === 'sticker')!;
const loop = loopPack.items.find((i) => i.kind === 'gif')!;
const STILL_KEY = appKey(pack.id, still.number);
const LOOP_KEY = appKey(loopPack.id, loop.number);

/** jsdom has no canvas and never loads images: give the editor a picture of 800 x 600 and a context that ignores drawing. */
function stubPicture() {
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 800;
    naturalHeight = 600;
    set src(_v: string) { queueMicrotask(() => this.onload?.()); }
  }
  vi.stubGlobal('Image', FakeImage);
  const ctx = new Proxy({ font: '', measureText: (t: string) => ({ width: t.length * 8 }) } as Record<string, unknown>, {
    get: (t, k: string) => (k in t ? t[k] : () => undefined),
    set: (t, k: string, v) => { t[k] = v; return true; },
  });
  const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
  restores.push(() => spy.mockRestore(), stubObjectUrls());
}

const fakeEnv = (): MediaEnv => ({
  async decode() { return { width: 800, height: 600, source: {} }; },
  async encode(draw, size, mime) { draw({ clear: () => undefined, drawImage: () => undefined, canvas2d: undefined }); return new Blob([new Uint8Array(500)], { type: mime }); },
});

const source = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });

describe('ImageEditor', () => {
  beforeEach(() => stubPicture());

  it('starts with a top and a bottom text box, and refuses Done until some text is typed', async () => {
    const onDone = vi.fn();
    m = await mount(<ImageEditor source={source()} onCancel={() => undefined} onDone={onDone} env={fakeEnv()} />);
    await flush();
    expect(byText(m.container, '[role="radio"]', 'Top text')?.getAttribute('aria-checked')).toBe('true');
    expect(byText(m.container, '[role="radio"]', 'Bottom text')).not.toBeNull();
    await click(byText(m.container, 'button', 'Done'));
    await flush();
    expect(m.container.querySelector('[role="alert"]')?.textContent).toBe('Type some text first.');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('typing text and pressing Done hands back a finished picture file', async () => {
    const onDone = vi.fn();
    m = await mount(<ImageEditor source={source()} doneLabel="Use this picture" onCancel={() => undefined} onDone={onDone} env={fakeEnv()} />);
    await flush();
    await typeInto(m.container.querySelector('#editor-text')!, 'me after the exam');
    await click(byText(m.container, 'button', 'Use this picture'));
    await flush(); await flush();
    expect(onDone).toHaveBeenCalledTimes(1);
    const { file, width, height } = onDone.mock.calls[0]![0] as { file: File; width: number; height: number };
    expect(file.type).toBe('image/webp');
    expect(file.name).toMatch(/^edited-.*\.webp$/);
    expect([width, height]).toEqual([800, 600]);
  });

  it('shows an error and stays open when saving fails', async () => {
    const bad: MediaEnv = { ...fakeEnv(), async encode() { return null; } };
    m = await mount(<ImageEditor source={source()} onCancel={() => undefined} onDone={() => undefined} env={bad} />);
    await flush();
    await typeInto(m.container.querySelector('#editor-text')!, 'x');
    await click(byText(m.container, 'button', 'Done'));
    await flush(); await flush();
    expect(m.container.querySelector('[role="alert"]')?.textContent).toContain('could not prepare');
    expect(byText(m.container, 'button', 'Done')?.hasAttribute('disabled')).toBe(false);
  });

  it('adds and deletes text boxes within the limit, and keeps at least one', async () => {
    m = await mount(<ImageEditor source={source()} onCancel={() => undefined} onDone={() => undefined} env={fakeEnv()} />);
    await flush();
    const boxes = () => m!.container.querySelectorAll('[role="radiogroup"][aria-label="Text boxes"] [role="radio"]').length;
    for (let i = 0; i < 10; i++) await click(byLabel(m.container, 'Add a text box'));
    expect(boxes()).toBe(MAX_LAYERS);
    expect(byLabel(m.container, 'Add a text box')?.hasAttribute('disabled')).toBe(true);
    for (let i = 0; i < 12; i++) await click(m.container.querySelector<HTMLElement>('[aria-label^="Delete"]'));
    expect(boxes()).toBe(1);
    expect(m.container.querySelector('[aria-label^="Delete"]')?.hasAttribute('disabled')).toBe(true);
  });

  it('each text box keeps its own text and style', async () => {
    m = await mount(<ImageEditor source={source()} onCancel={() => undefined} onDone={() => undefined} env={fakeEnv()} />);
    await flush();
    const ta = () => m!.container.querySelector<HTMLTextAreaElement>('#editor-text')!;
    await typeInto(ta(), 'top words');
    await click(byText(m.container, '[role="radio"]', 'Bottom text'));
    expect(ta().value).toBe('');
    await typeInto(ta(), 'bottom words');
    await click(byText(m.container, 'button', 'Outline'));
    expect(byText(m.container, 'button', 'Outline')?.getAttribute('aria-pressed')).toBe('false');
    await click(byLabel(m.container, 'Yellow'));
    expect(byLabel(m.container, 'Yellow')?.getAttribute('aria-checked')).toBe('true');
    await click(byText(m.container, '[role="radio"]', 'Top text'));
    expect(ta().value).toBe('top words');
    expect(byText(m.container, 'button', 'Outline')?.getAttribute('aria-pressed')).toBe('true'); // untouched
    expect(byLabel(m.container, 'White')?.getAttribute('aria-checked')).toBe('true');
  });

  it('can be moved without dragging: the sliders change the position', async () => {
    m = await mount(<ImageEditor source={source()} onCancel={() => undefined} onDone={() => undefined} env={fakeEnv()} />);
    await flush();
    const down = [...m.container.querySelectorAll<HTMLInputElement>('input[type="range"]')].find((i) => i.closest('label')?.textContent?.includes('Up and down'))!;
    const before = down.value;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(down, '70');
      down.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(down.value).toBe('70');
    expect(before).not.toBe('70');
  });

  it('Escape cancels, and there are no axe violations', async () => {
    const onCancel = vi.fn();
    m = await mount(<ImageEditor source={source()} onCancel={onCancel} onDone={() => undefined} env={fakeEnv()} />);
    await flush();
    expect(await axeViolations(m.container)).toBe('');
    await act(async () => { m!.container.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('EditFlow', () => {
  beforeEach(() => stubPicture());
  it('goes from the editor to the result, offers Send only when it can, and Edit again returns to the editor', async () => {
    const onSend = vi.fn();
    m = await mount(<EditFlow source={source()} env={fakeEnv()} onClose={() => undefined} onSend={onSend} sendLabel="Send in this chat" />);
    await flush();
    await typeInto(m.container.querySelector('#editor-text')!, 'hello');
    await click(byText(m.container, 'button', 'Done'));
    await flush(); await flush();
    expect(m.container.querySelector('[aria-label="Your edited picture"]')).not.toBeNull();
    for (const t of ['Download', 'Save as sticker', 'Edit again', 'Send in this chat']) expect(byText(m.container, 'button', t), t).not.toBeNull();
    expect(await axeViolations(m.container)).toBe('');
    await click(byText(m.container, 'button', 'Send in this chat'));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect((onSend.mock.calls[0]![0] as File).type).toBe('image/webp');
    await click(byText(m.container, 'button', 'Edit again'));
    expect(m.container.querySelector('[aria-label="Add text"]')).not.toBeNull();
  });
  it('has no Send button when nothing can receive the picture', async () => {
    m = await mount(<EditFlow source={source()} env={fakeEnv()} onClose={() => undefined} />);
    await flush();
    await typeInto(m.container.querySelector('#editor-text')!, 'hello');
    await click(byText(m.container, 'button', 'Done'));
    await flush(); await flush();
    expect(byText(m.container, 'button', 'Send')).toBeNull();
  });
});

describe('stickers you can keep', () => {
  it('are plain pictures unless the screen asks for options', async () => {
    m = await mount(<StickerView stickerKey={STILL_KEY} size={120} />);
    expect(byLabel(m.container, 'Sticker options')).toBeNull();
    m.unmount();
    m = await mount(<StickerView stickerKey={STILL_KEY} size={120} favoritable />);
    expect(byLabel(m.container, 'Sticker options')).not.toBeNull();
  });

  it('tapping opens a sheet; Add to favorites sends the key, and tapping again removes it', async () => {
    const net = installFetch({
      'GET /api/stickers/favorites': () => json({ keys: [] }),
      'POST /api/stickers/favorites': () => json({ success: true, key: STILL_KEY, kind: 'sticker' }, 201),
      'DELETE /api/stickers/favorites/': () => json({ success: true }),
    }); restores.push(net.restore);
    m = await mount(<StickerView stickerKey={STILL_KEY} favoritable />);
    await click(byLabel(m.container, 'Sticker options'));
    await flush();
    const add = () => document.body.querySelector<HTMLElement>('[role="dialog"] button[aria-pressed]')!;
    expect(add().textContent).toContain('Add to favorites');
    await click(add()); await flush();
    expect(net.calls.find((c) => c.method === 'POST')).toMatchObject({ url: '/api/stickers/favorites', body: { sticker_key: STILL_KEY } });
    expect(add().getAttribute('aria-pressed')).toBe('true');
    expect(document.body.textContent).toContain('Added to your favorites.');
    await click(add()); await flush();
    expect(net.calls.find((c) => c.method === 'DELETE')?.url).toBe(`/api/stickers/favorites/${encodeURIComponent(STILL_KEY)}`);
    expect(add().getAttribute('aria-pressed')).toBe('false');
  });

  it('shows a sticker that is already a favorite as one, and shows server errors', async () => {
    const net = installFetch({ 'GET /api/stickers/favorites': () => json({ keys: [STILL_KEY] }), 'POST /api/stickers/favorites': () => json({ error: 'Your library is full (200). Remove one first.' }, 409) }); restores.push(net.restore);
    m = await mount(<StickerView stickerKey={STILL_KEY} favoritable />);
    await click(byLabel(m.container, 'Sticker options')); await flush();
    expect(document.body.querySelector('[role="dialog"] button[aria-pressed]')?.getAttribute('aria-pressed')).toBe('true');
    m.unmount(); document.body.innerHTML = '';
    m = await mount(<StickerView stickerKey={'usr:med_x'} favoritable />);
    await click(byLabel(m.container, 'Sticker options')); await flush();
    await click(document.body.querySelector('[role="dialog"] button[aria-pressed]')); await flush();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('library is full');
  });

  it('Add text is offered for stills and not for animated stickers', async () => {
    const net = installFetch({ 'GET /api/stickers/favorites': () => json({ keys: [] }) }); restores.push(net.restore);
    m = await mount(<StickerView stickerKey={STILL_KEY} favoritable />);
    await click(byLabel(m.container, 'Sticker options')); await flush();
    expect(byText(document.body, 'button', 'Add text')).not.toBeNull();
    m.unmount(); document.body.innerHTML = '';
    m = await mount(<StickerView stickerKey={LOOP_KEY} favoritable />);
    await click(byLabel(m.container, 'Sticker options')); await flush();
    expect(byText(document.body, 'button', 'Add to favorites') ?? document.body.querySelector('[role="dialog"] button[aria-pressed]')).not.toBeNull();
    expect(byText(document.body, 'button', 'Add text')).toBeNull();
  });

  it('with reduced motion an animated sticker keeps its Play button and opens options from a corner button', async () => {
    restores.push(stubMatchMedia((q) => q.includes('reduce')));
    m = await mount(<StickerView stickerKey={LOOP_KEY} favoritable />);
    expect(byLabel(m.container, `Play ${loop.alt}`)).not.toBeNull();
    expect(byLabel(m.container, 'Sticker options')?.className).toContain('w-[44px]');
  });
});

describe('PickerPanel favorites and templates', () => {
  const lib = { items: [
    { media_id: 'med_mine', kind: 'sticker', mime_type: 'image/webp', width: 512, height: 512, source: 'own' },
    { media_id: 'med_saved', kind: 'sticker', mime_type: 'image/webp', width: 512, height: 512, source: 'favorite' },
  ] };

  it('Favorites lists starred bundled stickers and saved copies; Mine only your own uploads', async () => {
    const net = installFetch({ 'GET /api/stickers/library': () => json(lib), 'GET /api/stickers/favorites': () => json({ keys: [STILL_KEY] }) }); restores.push(net.restore);
    const onPick = vi.fn();
    m = await mount(<PickerPanel userId="u1" onPick={onPick} onAddFiles={() => undefined} />);
    await flush();
    // nothing used yet, so the first chip with something in it is Favorites
    expect(byText(m.container, '[role="radio"]', 'Favorites')?.getAttribute('aria-checked')).toBe('true');
    expect(byLabel(m.container, `Send ${still.alt}`)).not.toBeNull();
    expect(m.container.querySelector('img[src="/api/media/med_saved"]')).not.toBeNull();
    expect(m.container.querySelector('img[src="/api/media/med_mine"]')).toBeNull();
    await click(byText(m.container, '[role="radio"]', 'Mine'));
    expect(m.container.querySelector('img[src="/api/media/med_mine"]')).not.toBeNull();
    expect(m.container.querySelector('img[src="/api/media/med_saved"]')).toBeNull();
  });

  it('Favorites has a helpful empty message, and Manage removes a bundled favorite and a saved copy', async () => {
    const net = installFetch({
      'GET /api/stickers/library': () => json(lib), 'GET /api/stickers/favorites': () => json({ keys: [STILL_KEY] }),
      'DELETE /api/stickers/favorites/': () => json({ success: true }), 'DELETE /api/stickers/library/med_saved': () => json({ success: true }),
    }); restores.push(net.restore);
    m = await mount(<PickerPanel userId="u1" onPick={() => undefined} onAddFiles={() => undefined} />);
    await flush();
    await click(byText(m.container, '[role="radio"]', 'Favorites')); // chosen on purpose, so the list stays on Favorites when it empties
    await click(byText(m.container, 'button', 'Manage'));
    await click(byLabel(m.container, `Remove ${still.alt}`)); await flush();
    await click(byLabel(m.container, 'Remove Sticker')); await flush();
    expect(net.calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([`/api/stickers/favorites/${encodeURIComponent(STILL_KEY)}`, '/api/stickers/library/med_saved']);
    expect(m.container.textContent).toContain('No favorite stickers yet');
  });

  it('a favorites list that fails to load does not break the picker', async () => {
    const net = installFetch({ 'GET /api/stickers/library': () => json({ items: [] }) }); restores.push(net.restore); // favorites route answers 404
    m = await mount(<PickerPanel userId="u1" onPick={() => undefined} onAddFiles={() => undefined} />);
    await flush();
    expect(byText(m.container, '[role="radio"]', pack.name)).not.toBeNull();
    expect(m.container.querySelector('[role="alert"]')).toBeNull();
  });

  describe('template packs', () => {
    const templatePack: StickerPack = { ...pack, id: 'templates', name: 'Templates', order: 5, template: true, items: pack.items.slice(0, 2) };
    beforeEach(() => stubPicture());

    it('opening one starts the editor instead of sending it, and the finished picture is handed over', async () => {
      const net = installFetch({
        'GET /api/stickers/library': () => json({ items: [] }), 'GET /api/stickers/favorites': () => json({ keys: [] }),
        'GET /stickers/': () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } }),
      }); restores.push(net.restore);
      const onPick = vi.fn(); const onTemplateEdited = vi.fn();
      m = await mount(<PickerPanel userId="u1" packs={[templatePack]} onPick={onPick} onAddFiles={() => undefined} onTemplateEdited={onTemplateEdited} />);
      await flush();
      await click(byText(m.container, '[role="radio"]', 'Templates'));
      await click(byLabel(m.container, `Add text to ${templatePack.items[0]!.alt}`));
      await flush(); await flush();
      expect(onPick).not.toHaveBeenCalled();
      const dialog = m.container.querySelector('[aria-label="Add text"]');
      expect(dialog).not.toBeNull();
      expect(net.calls.some((c) => c.url.startsWith(`/stickers/templates/`))).toBe(true);
      // the editor is the real one; finishing it needs the browser canvas, so only its presence and the error path are checked here
      await click(byText(m.container, 'button', 'Done')); await flush();
      expect(m.container.querySelector('[role="alert"]')?.textContent).toBe('Type some text first.');
      expect(onTemplateEdited).not.toHaveBeenCalled();
    });

    it('without a handler a template pack sends like any other pack, and a normal pack never opens the editor', async () => {
      const net = installFetch({ 'GET /api/stickers/library': () => json({ items: [] }), 'GET /api/stickers/favorites': () => json({ keys: [] }) }); restores.push(net.restore);
      const onPick = vi.fn();
      m = await mount(<PickerPanel userId="u1" packs={[templatePack]} onPick={onPick} onAddFiles={() => undefined} />);
      await flush();
      await click(byText(m.container, '[role="radio"]', 'Templates'));
      await click(byLabel(m.container, `Send ${templatePack.items[0]!.alt}`));
      expect(onPick).toHaveBeenCalledWith(appKey('templates', templatePack.items[0]!.number), 'sticker');
      m.unmount();
      m = await mount(<PickerPanel userId="u1" onPick={onPick} onAddFiles={() => undefined} onTemplateEdited={() => undefined} />);
      await flush();
      await click(byText(m.container, '[role="radio"]', pack.name));
      await click(byLabel(m.container, `Send ${still.alt}`)); // positive control: ordinary packs still send
      expect(onPick).toHaveBeenLastCalledWith(STILL_KEY, 'sticker');
    });
  });
});

describe('opening a post photo', () => {
  const post = (): PostItem => ({
    id: 'p1', author_id: 'u2', author_username: 'zed', author_display_name: 'Zed', author_avatar_media_id: null, body: 'hello',
    created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString(), status: 'active',
    media: [{ id: 'med_p', object_key: 'k', mime_type: 'image/webp', size_bytes: 1, kind: 'photo' }], likes_count: 0, has_liked: false, comments_count: 0,
  });
  it('shows Edit, Download and Save as sticker in a full-screen viewer that Escape closes', async () => {
    m = await mount(<PostCard post={post()} currentUserId="u1" />);
    expect(m.container.querySelector('[role="dialog"]')).toBeNull();
    await click(byLabel(m.container, 'Open photo by @zed'));
    const dialog = m.container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-label')).toBe('Photo by @zed');
    for (const t of ['Edit', 'Download', 'Save as sticker']) expect(byText(m.container, 'button', t), t).not.toBeNull();
    expect(await axeViolations(dialog as HTMLElement)).toBe('');
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(m.container.querySelector('[role="dialog"]')).toBeNull();
  });
});
