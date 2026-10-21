import type { MediaItem } from '../../shared/schema.ts';
import { MEDIA_SIZE_CAPS, sniffMime, type MediaKind } from '../../shared/media-rules.ts';
import {
  browserMediaEnv, compressPhoto, makeSticker, cropForAspect, planFile, canConvertGif,
  type CropAspect, type MediaEnv, type SendAs,
} from './media.ts';

/** One picked file with the choices made in the preview. */
export interface PickedItem {
  file: File;
  sendAs: SendAs;
  rotate: number;
  aspect: CropAspect;
  /** 0 to 1 slide of the crop frame along each axis. */
  ox: number;
  oy: number;
}

export interface UploadedMedia extends MediaItem {
  kind: MediaKind;
}

/** Reads the first bytes of a file (enough to identify its type). */
export async function readHead(file: Blob, n = 32): Promise<Uint8Array> {
  const part = file.slice(0, n);
  if (typeof part.arrayBuffer === 'function') return new Uint8Array(await part.arrayBuffer());
  // Older browsers and test environments without Blob.arrayBuffer
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsArrayBuffer(part);
  });
}

export async function uploadBlob(
  blob: Blob,
  kind: MediaKind,
  extra: { width?: number; height?: number; thumb?: Blob | null } = {},
  fetchImpl: typeof fetch = fetch
): Promise<UploadedMedia> {
  const form = new FormData();
  form.append('file', blob, 'upload');
  form.append('kind', kind);
  if (extra.width) form.append('width', String(extra.width));
  if (extra.height) form.append('height', String(extra.height));
  if (extra.thumb) form.append('thumb', extra.thumb, 'thumb');
  const res = await fetchImpl('/api/media/uploads', { method: 'POST', body: form });
  const data = (await res.json().catch(() => ({}))) as UploadedMedia & { error?: string };
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

/**
 * Prepares one picked item (nothing is uploaded before this runs) and uploads it with the right kind.
 * Photos and stickers are re-encoded on the device; GIFs and clips go as they are within their cap.
 */
export async function prepareAndUpload(item: PickedItem, env: MediaEnv = browserMediaEnv(), fetchImpl: typeof fetch = fetch): Promise<UploadedMedia> {
  const head = await readHead(item.file);
  const mime = sniffMime(head);
  if (!mime) throw new Error('This file type is not supported. Use JPEG, PNG, WebP, GIF, MP4 or WebM.');
  const isImage = mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/webp';

  if (item.sendAs === 'gif') {
    const plan = planFile('gif', item.file.size, head, { canConvertGif: canConvertGif() });
    if (!plan.ok) throw new Error(plan.error);
    if (plan.action === 'offer-convert') throw new Error(`This GIF is over ${(MEDIA_SIZE_CAPS.gif / 1048576).toFixed(0)} MB. Trim it to under 3 MB.`);
    return uploadBlob(item.file, 'gif', {}, fetchImpl);
  }

  if (item.sendAs === 'sticker') {
    if (!isImage) {
      // A GIF used as a sticker stays animated and must fit the sticker cap as it is
      if (item.file.size > MEDIA_SIZE_CAPS.sticker) throw new Error('A sticker can be at most 300 KB. Send it as a GIF instead.');
      return uploadBlob(item.file, 'sticker', {}, fetchImpl);
    }
    const img = await env.decode(item.file);
    img.close?.();
    const crop = cropForAspect(img.width, img.height, item.aspect, item.rotate, item.ox, item.oy) ?? undefined;
    const prepared = await makeSticker(item.file, env, crop);
    return uploadBlob(prepared.blob, 'sticker', { width: prepared.width, height: prepared.height }, fetchImpl);
  }

  if (!isImage) throw new Error('Choose a JPEG, PNG or WebP picture to send as a photo.');
  const dims = await env.decode(item.file);
  dims.close?.();
  const crop = cropForAspect(dims.width, dims.height, item.aspect, item.rotate, item.ox, item.oy) ?? undefined;
  const prepared = await compressPhoto(item.file, env, { crop, rotate90: item.rotate });
  return uploadBlob(prepared.blob, 'photo', { width: prepared.width, height: prepared.height, thumb: prepared.thumb }, fetchImpl);
}
