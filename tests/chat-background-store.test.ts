// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { Blob as NodeBlob } from 'node:buffer';
import { loadChatBackground, saveChatBackgroundPreset, saveChatBackgroundImage, resetChatBackground, CHAT_BG_MAX_BYTES } from '../src/lib/chat-background.ts';
import type { MediaEnv } from '../src/lib/media.ts';

function fakeEnv(width: number, height: number, bytesPerPixel = 0.05) {
  const sizes: Array<{ width: number; height: number }> = [];
  const env: MediaEnv = {
    async decode() { return { width, height, source: 'bmp' }; },
    async encode(draw, size, mime, quality) {
      draw({ clear: () => undefined, drawImage: () => undefined });
      sizes.push(size);
      // Node's Blob survives fake-indexeddb's structured clone (jsdom's Blob does not); real browsers store either
      return new NodeBlob([new Uint8Array(Math.max(1, Math.round(size.width * size.height * bytesPerPixel * (quality + 0.2))))], { type: mime }) as unknown as Blob;
    },
  };
  return { env, sizes };
}

describe('chat background store (IndexedDB, on the phone only)', () => {
  let idb: IDBFactory;
  beforeEach(() => { idb = new IDBFactory(); });

  it('defaults to Plain when nothing is saved, and when storage is unavailable', async () => {
    expect(await loadChatBackground('u1', idb)).toEqual({ kind: 'preset', id: 'plain' });
    expect(await loadChatBackground('u1', null)).toEqual({ kind: 'preset', id: 'plain' });
  });

  it('saves a preset and loads it back; choices are per user', async () => {
    await saveChatBackgroundPreset('u1', 'mint', idb);
    expect(await loadChatBackground('u1', idb)).toEqual({ kind: 'preset', id: 'mint' });
    expect(await loadChatBackground('u2', idb)).toEqual({ kind: 'preset', id: 'plain' });
  });

  it('downscales an imported image to at most 1280 px and 300 KB before keeping it, and loads the blob back', async () => {
    const { env, sizes } = fakeEnv(4000, 3000);
    const stored = await saveChatBackgroundImage('u1', new Blob(['x']), { env, idb });
    expect(Math.max(sizes[0]!.width, sizes[0]!.height)).toBe(1280);
    expect(stored.size).toBeLessThanOrEqual(CHAT_BG_MAX_BYTES);
    const loaded = await loadChatBackground('u1', idb);
    expect(loaded.kind).toBe('image');
    expect(loaded.kind === 'image' && loaded.blob.size).toBe(stored.size);
  });

  it('refuses a picture that cannot be shrunk under the limit, and keeps the previous choice', async () => {
    await saveChatBackgroundPreset('u1', 'sky', idb);
    await expect(saveChatBackgroundImage('u1', new Blob(['x']), { env: fakeEnv(4000, 3000, 20).env, idb })).rejects.toThrow(/Try a simpler picture/);
    expect(await loadChatBackground('u1', idb)).toEqual({ kind: 'preset', id: 'sky' });
  });

  it('reset returns to Plain, and a corrupt record is ignored', async () => {
    await saveChatBackgroundPreset('u1', 'night', idb);
    await resetChatBackground('u1', idb);
    expect(await loadChatBackground('u1', idb)).toEqual({ kind: 'preset', id: 'plain' });
    await saveChatBackgroundPreset('u1', 'night', idb);
    const db: IDBDatabase = await new Promise((res) => { const r = idb.open('student-network-local', 1); r.onsuccess = () => res(r.result); });
    await new Promise<void>((res) => { const t = db.transaction('chat-background', 'readwrite'); t.objectStore('chat-background').put({ kind: 'preset', id: '../evil' }, 'bg:u1'); t.oncomplete = () => res(); });
    db.close();
    expect(await loadChatBackground('u1', idb)).toEqual({ kind: 'preset', id: 'plain' });
  });
});
