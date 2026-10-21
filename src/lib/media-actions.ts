import type { MediaItem } from '../../shared/schema.ts';
import { MEDIA_SIZE_CAPS } from '../../shared/media-rules.ts';
import { browserMediaEnv, makeSticker, type MediaEnv } from './media.ts';
import { uploadBlob } from './media-upload.ts';

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm',
};

export function fileNameFor(media: Pick<MediaItem, 'id' | 'mime_type'>): string {
  return `${media.id}.${EXT[media.mime_type] ?? 'bin'}`;
}

export async function fetchMediaBlob(id: string, fetchImpl: typeof fetch = fetch): Promise<Blob> {
  const res = await fetchImpl(`/api/media/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error('Could not load this file.');
  return res.blob();
}

/** Saves a blob through a temporary link. */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** True when this browser can hand a file to the phone's share sheet. The Share button is hidden otherwise. */
export function canShareFiles(file: File, nav: { canShare?: (d: ShareData) => boolean; share?: unknown } = typeof navigator === 'undefined' ? {} : navigator): boolean {
  return typeof nav.share === 'function' && typeof nav.canShare === 'function' && nav.canShare({ files: [file] });
}

/**
 * Puts a picture from a chat into the person's own library. Their own stickers and GIFs are added by id. Anything
 * else is copied through their device and uploaded as their own file (the library only holds files they own).
 */
export async function saveAsSticker(
  media: MediaItem,
  ownedByMe: boolean,
  deps: { env?: MediaEnv; fetchImpl?: typeof fetch } = {}
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const addToLibrary = (id: string) =>
    fetchImpl('/api/stickers/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ media_id: id }) });

  // Own sticker or GIF: add by id. Forwarded files belong to someone else, so a refusal falls through to copying.
  if (ownedByMe && (media.kind === 'sticker' || media.kind === 'gif')) {
    const res = await addToLibrary(media.id);
    if (res.ok) return;
    if (res.status !== 403 && res.status !== 404) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || 'Could not save to your stickers.');
    }
  }

  const blob = await fetchMediaBlob(media.id, fetchImpl);
  let uploaded;
  if (media.mime_type === 'image/gif' || media.mime_type.startsWith('video/')) {
    const asSticker = media.mime_type === 'image/gif' && blob.size <= MEDIA_SIZE_CAPS.sticker;
    uploaded = await uploadBlob(blob, asSticker ? 'sticker' : 'gif', {}, fetchImpl);
  } else {
    const prepared = await makeSticker(blob, deps.env ?? browserMediaEnv());
    uploaded = await uploadBlob(prepared.blob, 'sticker', { width: prepared.width, height: prepared.height }, fetchImpl);
  }
  const res = await addToLibrary(uploaded.id);
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || 'Could not save to your stickers.');
  }
}
