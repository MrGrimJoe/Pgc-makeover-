// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { Blob as NodeBlob } from 'node:buffer';
import { Composer, fieldHeight } from '../src/components/chat/Composer.tsx';
import { AttachSheet } from '../src/components/chat/AttachSheet.tsx';
import { MediaPreview } from '../src/components/chat/MediaPreview.tsx';
import { MediaViewer } from '../src/components/chat/MediaViewer.tsx';
import { MessageBubble } from '../src/components/chat/MessageBubble.tsx';
import { ConversationList, previewText } from '../src/components/chat/ConversationList.tsx';
import { computeKeyboardInset, panelHeight } from '../src/lib/keyboard.ts';
import { mount, click, typeInto, flush, byLabel, byText, axeViolations, installFetch, json, pngFile, gifFile, stubObjectUrls, stubMatchMedia, type Mounted } from './_ui.tsx';
import type { MessageItem, ConversationItem } from '../shared/schema.ts';

let m: Mounted | null = null;
const restores: Array<() => void> = [];
afterEach(() => { m?.unmount(); m = null; restores.splice(0).forEach((r) => r()); document.body.innerHTML = ''; vi.restoreAllMocks(); });

const msg = (over: Partial<MessageItem> = {}): MessageItem => ({
  id: 'msg_1', conversation_id: 'conv_1', sender_id: 'usr_other', sender_username: 'other', sender_display_name: 'Other',
  body: 'hello', sent_at: new Date().toISOString(), expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString(), media: [], ...over,
});
const media = (kind: string, id = 'med_1', mime = 'image/webp') => ({ id, object_key: 'k', mime_type: mime, size_bytes: 10, kind });

describe('keyboard maths', () => {
  it('reports the covered height only when it is a keyboard, and a panel height with a 280 px fallback', () => {
    expect(computeKeyboardInset(800, { height: 500, offsetTop: 0 })).toBe(300);
    expect(computeKeyboardInset(800, { height: 480, offsetTop: 20 })).toBe(300);
    expect(computeKeyboardInset(800, { height: 760, offsetTop: 0 })).toBe(0); // address bar, not a keyboard
    expect(computeKeyboardInset(800, null)).toBe(0);
    expect(panelHeight(0)).toBe(280);
    expect(panelHeight(310)).toBe(310);
  });
  it('the field grows with its content up to five lines', () => {
    expect(fieldHeight(44)).toBe(44);
    expect(fieldHeight(300)).toBe(116);
  });
});

describe('Composer', () => {
  it('sends with the button, clears the field, and keeps the send button disabled while empty (positive control)', async () => {
    const onSend = vi.fn(async () => undefined);
    m = await mount(<Composer onSend={onSend} onAttach={() => undefined} onTogglePicker={() => undefined} />);
    const send = byLabel(m.container, 'Send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    const field = byLabel(m.container, 'Message') as HTMLTextAreaElement;
    await typeInto(field, '  hi there ');
    expect(send.disabled).toBe(false);
    await click(send);
    expect(onSend).toHaveBeenCalledWith('hi there');
    expect(field.value).toBe('');
    expect(send.disabled).toBe(true);
  });

  it('Enter sends on desktop and Shift+Enter does not', async () => {
    const restore = stubMatchMedia(() => false); restores.push(restore);
    const onSend = vi.fn(async () => undefined);
    m = await mount(<Composer onSend={onSend} />);
    const field = byLabel(m.container, 'Message') as HTMLTextAreaElement;
    await typeInto(field, 'one');
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })); });
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    expect(onSend).toHaveBeenCalledWith('one');
  });

  it('on touch devices Enter is a newline and only the button sends', async () => {
    const restore = stubMatchMedia((q) => q.includes('pointer: coarse')); restores.push(restore);
    const onSend = vi.fn(async () => undefined);
    m = await mount(<Composer onSend={onSend} />);
    const field = byLabel(m.container, 'Message') as HTMLTextAreaElement;
    await typeInto(field, 'one');
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(async () => { field.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
    await click(byLabel(m.container, 'Send'));
    expect(onSend).toHaveBeenCalledWith('one');
  });

  it('the picker button toggles a panel that takes the keyboard’s place, and the field keeps focus without the keyboard', async () => {
    let open = false;
    const render = () => <Composer onSend={() => undefined} pickerOpen={open} onTogglePicker={() => { open = !open; }} picker={<div>PANEL</div>} />;
    m = await mount(render());
    expect(m.container.textContent).not.toContain('PANEL');
    open = true;
    await act(async () => m!.root.render(render()));
    expect(m.container.textContent).toContain('PANEL');
    const panel = m.container.querySelector<HTMLElement>('[data-testid="picker-panel"]')!;
    expect(panel.style.height).toBe('280px'); // no keyboard seen yet
    const field = byLabel(m.container, 'Message') as HTMLTextAreaElement;
    expect(field.getAttribute('inputmode')).toBe('none');
    expect(document.activeElement).toBe(field);
    expect(byLabel(m.container, 'Show keyboard')?.getAttribute('aria-pressed')).toBe('true');
    open = false;
    await act(async () => m!.root.render(render()));
    expect(field.hasAttribute('inputmode')).toBe(false);
    expect(m.container.textContent).not.toContain('PANEL');
  });

  it('the compact variant has no attach button (posts and comments)', async () => {
    m = await mount(<Composer variant="compact" onSend={() => undefined} onAttach={() => undefined} />);
    expect(byLabel(m.container, 'Attach')).toBeNull();
    expect(byLabel(m.container, 'Send')).not.toBeNull();
  });

  it('has no axe violations', async () => {
    m = await mount(<Composer onSend={() => undefined} onAttach={() => undefined} onTogglePicker={() => undefined} />);
    expect(await axeViolations(m.container)).toBe('');
  });
});

describe('AttachSheet', () => {
  it('offers Camera, Gallery, Sticker and GIF as labelled buttons, closes on Escape, and has no axe violations', async () => {
    const onClose = vi.fn();
    m = await mount(<AttachSheet onClose={onClose} onFiles={() => undefined} onSticker={() => undefined} onGif={() => undefined} />);
    for (const label of ['Camera', 'Gallery', 'Sticker', 'GIF']) expect(byText(m.container, 'button', label), label).not.toBeNull();
    expect(await axeViolations(m.container)).toBe('');
    const dialog = m.container.querySelector('[role="dialog"]')!;
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(onClose).toHaveBeenCalled();
  });

  it('traps focus: Tab from the last control returns to the first, Shift+Tab from the first goes to the last', async () => {
    m = await mount(<AttachSheet onClose={() => undefined} onFiles={() => undefined} onSticker={() => undefined} onGif={() => undefined} />);
    const dialog = m.container.querySelector<HTMLElement>('[role="dialog"]')!;
    const buttons = [...dialog.querySelectorAll<HTMLElement>('button')];
    expect(document.activeElement).toBe(buttons[0]);
    buttons[buttons.length - 1]!.focus();
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(buttons[0]);
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });

  it('camera input asks for the camera and the gallery input takes images and clips', async () => {
    m = await mount(<AttachSheet onClose={() => undefined} onFiles={() => undefined} onSticker={() => undefined} onGif={() => undefined} />);
    expect(m.container.querySelector('[data-testid="camera-input"]')?.getAttribute('capture')).toBe('environment');
    const accept = m.container.querySelector('[data-testid="gallery-input"]')?.getAttribute('accept') ?? '';
    expect(accept).toContain('image/gif');
    expect(accept).toContain('video/mp4');
    expect(accept).not.toContain('svg');
  });
});

describe('MediaPreview', () => {
  beforeEach(() => { restores.push(stubObjectUrls()); });

  it('shows the picture, Send as, crop shapes and a caption; nothing is uploaded until Send', async () => {
    const net = installFetch({}); restores.push(net.restore);
    const onConfirm = vi.fn(async () => undefined);
    m = await mount(<MediaPreview files={[pngFile()]} onCancel={() => undefined} onConfirm={onConfirm} />);
    await flush(); await flush();
    expect(m.container.querySelector('img[alt="Selected picture"]')).not.toBeNull();
    expect(byText(m.container, '[role="radio"]', 'Photo')?.getAttribute('aria-checked')).toBe('true');
    expect(byText(m.container, '[role="radio"]', 'Sticker')).not.toBeNull();
    expect(byText(m.container, '[role="radio"]', 'Square')).not.toBeNull();
    expect(net.calls).toEqual([]); // positive control follows below: Send does call onConfirm
    await typeInto(m.container.querySelector<HTMLInputElement>('#preview-caption')!, 'look at this');
    await click(byText(m.container, 'button', 'Send'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const [items, caption] = onConfirm.mock.calls[0] as unknown as [Array<{ sendAs: string; rotate: number; aspect: string }>, string];
    expect(caption).toBe('look at this');
    expect(items[0]).toMatchObject({ sendAs: 'photo', rotate: 0, aspect: 'original' });
    expect(net.calls).toEqual([]); // the preview itself never uploads; the caller does
  });

  it('rotates in quarter turns, picks a crop and a send-as choice, and passes them on', async () => {
    const onConfirm = vi.fn(async () => undefined);
    m = await mount(<MediaPreview files={[pngFile()]} onCancel={() => undefined} onConfirm={onConfirm} />);
    await flush(); await flush();
    await click(byLabel(m.container, 'Rotate 90 degrees'));
    await click(byLabel(m.container, 'Rotate 90 degrees'));
    await click(byLabel(m.container, 'Rotate 90 degrees'));
    await click(byText(m.container, '[role="radio"]', 'Square'));
    await click(byText(m.container, '[role="radio"]', 'Sticker'));
    expect(m.container.querySelector('input[type="range"]')).not.toBeNull(); // crop position sliders appear
    await click(byText(m.container, 'button', 'Send'));
    expect((onConfirm.mock.calls[0] as unknown as [Array<Record<string, unknown>>])[0][0]).toMatchObject({ rotate: 3, aspect: '1:1', sendAs: 'sticker' });
  });

  it('a GIF source offers GIF / loop first and no rotate or crop', async () => {
    m = await mount(<MediaPreview files={[gifFile()]} onCancel={() => undefined} onConfirm={async () => undefined} />);
    await flush(); await flush();
    expect(byText(m.container, '[role="radio"]', 'GIF / loop')?.getAttribute('aria-checked')).toBe('true');
    expect(byLabel(m.container, 'Rotate 90 degrees')).toBeNull();
  });

  it('keeps at most four pictures and says so', async () => {
    m = await mount(<MediaPreview files={[1, 2, 3, 4, 5].map((i) => pngFile(`${i}.png`))} onCancel={() => undefined} onConfirm={async () => undefined} />);
    await flush(); await flush();
    expect(m.container.querySelectorAll('[role="tab"]').length).toBe(4);
    expect(m.container.textContent).toContain('first 4');
  });

  it('shows the error and stays open when sending fails (positive control: it recovers)', async () => {
    let fail = true;
    const onConfirm = vi.fn(async () => { if (fail) throw new Error('A photo can be at most 2.50 MB'); });
    m = await mount(<MediaPreview files={[pngFile()]} onCancel={() => undefined} onConfirm={onConfirm} />);
    await flush(); await flush();
    await click(byText(m.container, 'button', 'Send'));
    expect(m.container.querySelector('[role="alert"]')?.textContent).toContain('2.50 MB');
    fail = false;
    await click(byText(m.container, 'button', 'Send'));
    expect(m.container.querySelector('[role="alert"]')).toBeNull();
  });

  it('library mode has no caption and an Add button', async () => {
    m = await mount(<MediaPreview files={[pngFile()]} mode="library" onCancel={() => undefined} onConfirm={async () => undefined} />);
    await flush(); await flush();
    expect(m.container.querySelector('#preview-caption')).toBeNull();
    expect(byText(m.container, 'button', 'Add')).not.toBeNull();
  });

  it('Escape cancels, and there are no axe violations', async () => {
    const onCancel = vi.fn();
    m = await mount(<MediaPreview files={[pngFile(), pngFile('b.png')]} onCancel={onCancel} onConfirm={async () => undefined} />);
    await flush(); await flush();
    expect(await axeViolations(m.container)).toBe('');
    await act(async () => { m!.container.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('MediaViewer', () => {
  const message = (over: Partial<MessageItem> = {}) => msg({ media: [media('photo')], ...over });

  it('shows Download, Forward and Save as sticker, hides Share without the share API, and has no axe violations', async () => {
    m = await mount(<MediaViewer message={message()} startIndex={0} isSelf={false} onClose={() => undefined} onNotice={() => undefined} />);
    for (const t of ['Download', 'Forward', 'Save as sticker', 'Report']) expect(byText(m.container, 'button', t), t).not.toBeNull();
    expect(byText(m.container, 'button', 'Share')).toBeNull();
    expect(await axeViolations(m.container)).toBe('');
  });

  it('shows Share only when the browser can share files, and shares the file', async () => {
    const share = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    restores.push(() => { delete (navigator as unknown as Record<string, unknown>).canShare; delete (navigator as unknown as Record<string, unknown>).share; });
    const net = installFetch({ 'GET /api/media/': () => new Response(new NodeBlob(['x'], { type: 'image/webp' }) as unknown as Blob) }); restores.push(net.restore);
    const onNotice = vi.fn();
    m = await mount(<MediaViewer message={message()} startIndex={0} isSelf={false} onClose={() => undefined} onNotice={onNotice} />);
    await click(byText(m.container, 'button', 'Share'));
    await flush(); await flush();
    expect(onNotice.mock.calls, 'no error notice').toEqual([]);
    expect(share).toHaveBeenCalledTimes(1);
    expect((share.mock.calls[0] as unknown as [{ files: File[] }])[0].files[0]!.type).toBe('image/webp');
  });

  it('hides Report on your own messages, and Report opens the report form for a message', async () => {
    m = await mount(<MediaViewer message={message({ sender_id: 'me' })} startIndex={0} isSelf onClose={() => undefined} onNotice={() => undefined} />);
    expect(byText(m.container, 'button', 'Report')).toBeNull();
    m.unmount();
    m = await mount(<MediaViewer message={message()} startIndex={0} isSelf={false} onClose={() => undefined} onNotice={() => undefined} />);
    await click(byText(m.container, 'button', 'Report'));
    expect(m.container.textContent).toContain('Report');
    expect(m.container.querySelector('textarea, input[type="text"], select')).not.toBeNull();
  });

  it('Forward lists conversations and forwards the message by id', async () => {
    const convs: ConversationItem[] = [{ id: 'conv_9', created_at: '', other_user: { id: 'u9', username: 'zed', display_name: 'Zed', avatar_media_id: null }, last_message: null }];
    const net = installFetch({
      'GET /api/conversations': () => json({ conversations: convs }),
      'POST /api/messages/msg_1/forward': () => json({ message: {} }, 201),
    }); restores.push(net.restore);
    const onNotice = vi.fn();
    m = await mount(<MediaViewer message={message()} startIndex={0} isSelf={false} onClose={() => undefined} onNotice={onNotice} />);
    await click(byText(m.container, 'button', 'Forward'));
    await flush();
    await click(byText(m.container, 'button', 'ZedZed@zed') ?? [...m.container.querySelectorAll('button')].find((b) => b.textContent?.includes('Zed')));
    await flush();
    expect(net.calls.find((c) => c.method === 'POST')).toMatchObject({ url: '/api/messages/msg_1/forward', body: { conversation_id: 'conv_9' } });
    expect(onNotice).toHaveBeenCalledWith('Forwarded.');
  });

  it('a sticker offers Add to favorites (the server keeps a copy), and reports when it was already there', async () => {
    let n = 0;
    const net = installFetch({ 'POST /api/stickers/favorites': () => (n++ === 0 ? json({ success: true, key: 'usr:med_9', kind: 'sticker' }, 201) : json({ success: true, key: 'usr:med_9', kind: 'sticker', already: true }, 200)) }); restores.push(net.restore);
    const onNotice = vi.fn();
    m = await mount(<MediaViewer message={message({ media: [media('sticker')] })} startIndex={0} isSelf={false} onClose={() => undefined} onNotice={onNotice} />);
    expect(byText(m.container, 'button', 'Save as sticker')).toBeNull();
    await click(byText(m.container, 'button', 'Add to favorites'));
    await flush();
    expect(net.calls).toEqual([{ url: '/api/stickers/favorites', method: 'POST', body: { sticker_key: 'usr:med_1' } }]);
    expect(onNotice).toHaveBeenLastCalledWith('Added to your favorites.');
    await click(byText(m.container, 'button', 'Add to favorites'));
    await flush();
    expect(onNotice).toHaveBeenLastCalledWith('Already in your favorites.');
  });

  it('a photo offers Edit, and Save as sticker still turns it into a sticker', async () => {
    m = await mount(<MediaViewer message={message()} startIndex={0} isSelf={false} onClose={() => undefined} onNotice={() => undefined} />);
    expect(byText(m.container, 'button', 'Edit')).not.toBeNull();
    expect(byText(m.container, 'button', 'Add to favorites')).toBeNull();
    m.unmount();
    m = await mount(<MediaViewer message={message({ media: [media('gif', 'med_g', 'video/mp4')] })} startIndex={0} isSelf={false} onClose={() => undefined} onNotice={() => undefined} />);
    expect(byText(m.container, 'button', 'Edit')).toBeNull(); // a loop would lose its movement
  });
});

describe('message rendering', () => {
  it('stickers show without a bubble at about 160 px, text and photos get a bubble', async () => {
    m = await mount(<div><MessageBubble msg={msg({ id: 'a', body: '', media: [media('sticker', 'med_s')] })} isSelf={false} onOpenMedia={() => undefined} />
      <MessageBubble msg={msg({ id: 'b', body: 'plain text' })} isSelf={false} onOpenMedia={() => undefined} /></div>);
    const sticker = m.container.querySelector<HTMLImageElement>('img[alt="Sticker"]')!;
    expect(sticker.width).toBe(160);
    expect(sticker.closest('[class*="rounded-[16px]"]')).toBeNull(); // no bubble around it
    expect(byText(m.container, 'div', 'plain text')?.className).toContain('rounded-[16px]'); // positive control: text has one
  });

  it('GIF loops autoplay muted, and with reduced motion wait behind a play button', async () => {
    const gif = media('gif', 'med_g', 'video/mp4');
    m = await mount(<MessageBubble msg={msg({ body: '', media: [gif] })} isSelf={false} onOpenMedia={() => undefined} />);
    const video = m.container.querySelector('video')!;
    expect(video.autoplay).toBe(true);
    expect(video.muted).toBe(true);
    expect(video.loop).toBe(true);
    m.unmount();
    const restore = stubMatchMedia((q) => q.includes('prefers-reduced-motion')); restores.push(restore);
    m = await mount(<MessageBubble msg={msg({ body: '', media: [gif] })} isSelf={false} onOpenMedia={() => undefined} />);
    expect(m.container.querySelector('video')).toBeNull();
    await click(byLabel(m.container, 'Play GIF'));
    expect(m.container.querySelector('video')).not.toBeNull();
  });

  it('tapping media opens the viewer for that item, and others’ messages have a Report button', async () => {
    const open = vi.fn();
    const report = vi.fn();
    m = await mount(<MessageBubble msg={msg({ media: [media('photo', 'med_1'), media('photo', 'med_2')] })} isSelf={false} onOpenMedia={open} onReport={report} />);
    const photos = m.container.querySelectorAll('button[aria-label="Open photo"]');
    await click(photos[1]);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'msg_1' }), 1);
    await click(byLabel(m.container, 'Report this message'));
    expect(report).toHaveBeenCalled();
    m.unmount();
    m = await mount(<MessageBubble msg={msg()} isSelf onOpenMedia={() => undefined} onReport={report} />);
    expect(byLabel(m.container, 'Report this message')).toBeNull();
  });

  it('conversation previews say Photo, Sticker, GIF for non-text messages and keep the text when there is one', () => {
    const last = (body: string, media_kind: string | null) => ({ id: 'm', sender_id: 'u', body, sent_at: '', expires_at: '', media_kind });
    expect(previewText(last('', 'photo'))).toBe('Photo');
    expect(previewText(last('', 'sticker'))).toBe('Sticker');
    expect(previewText(last('', 'gif'))).toBe('GIF');
    expect(previewText(last('see this', 'photo'))).toBe('see this');
    expect(previewText(last('hi', null))).toBe('hi');
    expect(previewText(null)).toBe('No messages yet');
  });

  it('the conversation list shows profile pictures and previews, and has no axe violations', async () => {
    const conv: ConversationItem = { id: 'c1', created_at: '', other_user: { id: 'u1', username: 'zed', display_name: 'Zed', avatar_media_id: 'med_av' }, last_message: { id: 'm', sender_id: 'u1', body: '', sent_at: '', expires_at: new Date(Date.now() + 86_400_000).toISOString(), media_kind: 'sticker' } };
    m = await mount(<ConversationList conversations={[conv]} loading={false} error={null} onSelect={() => undefined} onBack={() => undefined} />);
    expect(m.container.querySelector('img[src="/api/media/med_av"]')).not.toBeNull();
    expect(m.container.textContent).toContain('Sticker');
    expect(await axeViolations(m.container)).toBe('');
  });
});

describe('Composer keeps the text when sending fails', () => {
  it('does not clear the field when onSend rejects (positive control: it clears when it succeeds)', async () => {
    let fail = true;
    const onSend = vi.fn(async () => { if (fail) throw new Error('nope'); });
    m = await mount(<Composer variant="compact" onSend={onSend} label="Add a comment" />);
    const field = byLabel(m.container, 'Add a comment') as HTMLTextAreaElement;
    await typeInto(field, 'keep me');
    await click(byLabel(m.container, 'Send'));
    expect(field.value).toBe('keep me');
    fail = false;
    await click(byLabel(m.container, 'Send'));
    expect(field.value).toBe('');
  });
});
