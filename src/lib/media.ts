/**
 * Client-side media preparation. This is the main bandwidth saver: photos are scaled and re-encoded on the phone
 * before upload (re-encoding also drops EXIF), stickers are normalised to 512x512, and files over the caps are
 * refused with a clear message instead of being sent. No dependency on Cloudflare Image Transformations (a
 * documented future option only, see docs/operations.md).
 */
import {
  MEDIA_SIZE_CAPS,
  THUMBNAIL_MAX_BYTES,
  checkKindFile,
  sizeMessage,
  sniffMime,
  type MediaKind,
  type SniffedType,
} from '../../shared/media-rules.ts';

export const PHOTO_MAX_EDGE = 1600;
export const THUMB_MAX_EDGE = 320;
export const STICKER_SIZE = 512;
export const BACKGROUND_MAX_EDGE = 1280;
export const WEBP_QUALITY = 0.8;
export const JPEG_QUALITY = 0.82;

export interface Size {
  width: number;
  height: number;
}

/** Scales (width, height) so the long edge is at most maxEdge. Never enlarges. Always at least 1 px. */
export function scaleToLongEdge(width: number, height: number, maxEdge: number): Size {
  if (!(width > 0) || !(height > 0)) throw new Error('Image has no size');
  const long = Math.max(width, height);
  if (long <= maxEdge) return { width: Math.round(width), height: Math.round(height) };
  const k = maxEdge / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** Contain-fit inside a square box: the whole image shows, centred, with transparent padding. */
export function containFit(width: number, height: number, box: number): { x: number; y: number; width: number; height: number } {
  if (!(width > 0) || !(height > 0)) throw new Error('Image has no size');
  const k = Math.min(box / width, box / height);
  const w = Math.max(1, Math.round(width * k));
  const h = Math.max(1, Math.round(height * k));
  return { x: Math.round((box - w) / 2), y: Math.round((box - h) / 2), width: w, height: h };
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Clamps a crop to the image bounds. Returns null when nothing is left. */
export function clampCrop(crop: CropRect, width: number, height: number): CropRect | null {
  const x = Math.max(0, Math.min(width, crop.x));
  const y = Math.max(0, Math.min(height, crop.y));
  const w = Math.min(width - x, crop.width - (x - crop.x));
  const h = Math.min(height - y, crop.height - (y - crop.y));
  if (!(w >= 1) || !(h >= 1)) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
}

/** Which encoding to ask the canvas for: WebP when the browser can encode it, JPEG otherwise (never PNG for photos). */
export function chooseEncoding(webpSupported: boolean): { mime: 'image/webp' | 'image/jpeg'; quality: number } {
  return webpSupported ? { mime: 'image/webp', quality: WEBP_QUALITY } : { mime: 'image/jpeg', quality: JPEG_QUALITY };
}

export type FilePlan =
  | { ok: true; action: 'compress-photo' | 'make-sticker' | 'upload-as-is' | 'offer-convert'; kind: MediaKind; mime: SniffedType }
  | { ok: false; error: string };

/**
 * Decides what to do with a picked file. `head` is the first bytes of the file (no need to read it all).
 * Photos are always re-encoded. GIFs and short clips are uploaded as they are when within the cap; a GIF over the
 * cap can be converted when WebCodecs is available, otherwise it is refused with a "trim it" message.
 */
export function planFile(kind: MediaKind, size: number, head: Uint8Array, opts: { canConvertGif?: boolean } = {}): FilePlan {
  const mime = sniffMime(head);
  if (!mime) return { ok: false, error: 'This file type is not supported. Use JPEG, PNG, WebP, GIF, MP4 or WebM.' };
  if (kind === 'photo' || kind === 'background') {
    if (!mime.startsWith('image/') || mime === 'image/gif') return { ok: false, error: 'Choose a JPEG, PNG or WebP picture.' };
    return { ok: true, action: 'compress-photo', kind, mime };
  }
  if (kind === 'sticker' && (mime === 'image/png' || mime === 'image/webp' || mime === 'image/jpeg')) {
    return { ok: true, action: 'make-sticker', kind, mime };
  }
  if (kind === 'gif' || kind === 'video') {
    const cap = MEDIA_SIZE_CAPS[kind];
    if (size <= cap) return { ok: true, action: 'upload-as-is', kind, mime };
    if (mime === 'image/gif' && opts.canConvertGif) return { ok: true, action: 'offer-convert', kind, mime };
    return { ok: false, error: mime === 'image/gif' ? `This GIF is ${(size / 1048576).toFixed(1)} MB. Trim it to under ${(cap / 1048576).toFixed(0)} MB.` : sizeMessage(kind, size, mime) };
  }
  const check = checkKindFile(kind, mime, { length: size }, mime);
  return check.ok ? { ok: true, action: 'upload-as-is', kind, mime } : { ok: false, error: check.error };
}

/** The browser pieces compressPhoto and makeSticker need. Injected so tests can run without a canvas. */
export interface MediaEnv {
  decode(file: Blob): Promise<{ width: number; height: number; close?: () => void; source: unknown }>;
  /** Draws onto a canvas of the given size and encodes it. Returns null when the type is not supported. */
  encode(
    draw: (ctx: { drawImage: (source: unknown, ...args: number[]) => void; clear: () => void }) => void,
    size: Size,
    mime: string,
    quality: number
  ): Promise<Blob | null>;
}

export interface PreparedImage {
  blob: Blob;
  width: number;
  height: number;
  thumb: Blob | null;
  mime: string;
}

async function encodeBest(env: MediaEnv, draw: Parameters<MediaEnv['encode']>[0], size: Size): Promise<Blob> {
  const webp = chooseEncoding(true);
  let blob = await env.encode(draw, size, webp.mime, webp.quality);
  // Some browsers silently answer PNG when they cannot encode WebP; treat that as unsupported
  if (!blob || blob.type !== 'image/webp') {
    const jpeg = chooseEncoding(false);
    blob = await env.encode(draw, size, jpeg.mime, jpeg.quality);
  }
  if (!blob) throw new Error('This browser could not prepare the picture. Try a different one.');
  return blob;
}

/**
 * Decodes, scales to at most 1600 px on the long edge, and encodes WebP at about 0.8 (JPEG as a fallback).
 * Also makes a 320 px thumbnail. Re-encoding strips EXIF. Throws a readable error when the result is still too big.
 */
export async function compressPhoto(file: Blob, env: MediaEnv, opts: { maxEdge?: number; maxBytes?: number; kind?: 'photo' | 'background'; crop?: CropRect; rotate90?: number } = {}): Promise<PreparedImage> {
  const kind = opts.kind ?? 'photo';
  const cap = opts.maxBytes ?? MEDIA_SIZE_CAPS[kind];
  const img = await env.decode(file);
  try {
    const turns = (((opts.rotate90 ?? 0) % 4) + 4) % 4;
    const srcW = opts.crop ? opts.crop.width : img.width;
    const srcH = opts.crop ? opts.crop.height : img.height;
    const rotW = turns % 2 ? srcH : srcW;
    const rotH = turns % 2 ? srcW : srcH;
    const size = scaleToLongEdge(rotW, rotH, opts.maxEdge ?? (kind === 'background' ? BACKGROUND_MAX_EDGE : PHOTO_MAX_EDGE));
    const drawAt = (target: Size) => (ctx: Parameters<Parameters<MediaEnv['encode']>[0]>[0]) => {
      const c = opts.crop ?? { x: 0, y: 0, width: img.width, height: img.height };
      ctx.clear();
      // The canvas is drawn pre-rotated by the env; rotation is passed through as a transform argument
      ctx.drawImage(img.source, c.x, c.y, c.width, c.height, 0, 0, target.width, target.height, turns);
    };
    let blob = await encodeBest(env, drawAt(size), size);
    let outSize = size;
    // Still over the cap (rare, very detailed photos): step the size down a few times before giving up
    for (let i = 0; i < 3 && blob.size > cap; i++) {
      outSize = scaleToLongEdge(outSize.width, outSize.height, Math.round(Math.max(outSize.width, outSize.height) * 0.75));
      blob = await encodeBest(env, drawAt(outSize), outSize);
    }
    if (blob.size > cap) throw new Error(opts.maxBytes ? `The picture is still ${(blob.size / 1024).toFixed(0)} KB after shrinking. Try a simpler picture.` : sizeMessage(kind, blob.size));
    const thumbSize = scaleToLongEdge(outSize.width, outSize.height, THUMB_MAX_EDGE);
    let thumb: Blob | null = await encodeBest(env, drawAt(thumbSize), thumbSize);
    if (thumb.size > THUMBNAIL_MAX_BYTES) thumb = null; // a missing thumbnail is fine; the server never requires one
    return { blob, width: outSize.width, height: outSize.height, thumb, mime: blob.type };
  } finally {
    img.close?.();
  }
}

/** 512x512 sticker: contain-fit with transparent padding, WebP. An optional crop is applied first. */
export async function makeSticker(file: Blob, env: MediaEnv, crop?: CropRect): Promise<PreparedImage> {
  const img = await env.decode(file);
  try {
    const c = crop ? clampCrop(crop, img.width, img.height) : { x: 0, y: 0, width: img.width, height: img.height };
    if (!c) throw new Error('The crop is empty. Drag the corners to select part of the picture.');
    const fit = containFit(c.width, c.height, STICKER_SIZE);
    const size = { width: STICKER_SIZE, height: STICKER_SIZE };
    const draw = (ctx: Parameters<Parameters<MediaEnv['encode']>[0]>[0]) => {
      ctx.clear(); // transparent padding
      ctx.drawImage(img.source, c.x, c.y, c.width, c.height, fit.x, fit.y, fit.width, fit.height, 0);
    };
    // Stickers keep transparency, so WebP only (no JPEG fallback)
    let blob = await env.encode(draw, size, 'image/webp', WEBP_QUALITY);
    for (const q of [0.7, 0.55, 0.4]) {
      if (blob && blob.size <= MEDIA_SIZE_CAPS.sticker) break;
      blob = await env.encode(draw, size, 'image/webp', q);
    }
    if (!blob || blob.type !== 'image/webp') throw new Error('This browser cannot make stickers (no WebP support).');
    if (blob.size > MEDIA_SIZE_CAPS.sticker) throw new Error(sizeMessage('sticker', blob.size));
    return { blob, width: STICKER_SIZE, height: STICKER_SIZE, thumb: null, mime: 'image/webp' };
  } finally {
    img.close?.();
  }
}

/** True when this browser can convert a GIF to a looping clip (WebCodecs ImageDecoder + VideoEncoder). Never required. */
export function canConvertGif(g: { ImageDecoder?: unknown; VideoEncoder?: unknown } = globalThis as never): boolean {
  return typeof g.ImageDecoder === 'function' && typeof g.VideoEncoder === 'function';
}

/** The real browser implementation of MediaEnv (createImageBitmap + canvas). Not used in unit tests. */
export function browserMediaEnv(): MediaEnv {
  return {
    async decode(file) {
      const bmp = await createImageBitmap(file);
      return { width: bmp.width, height: bmp.height, close: () => bmp.close(), source: bmp };
    },
    async encode(draw, size, mime, quality) {
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      draw({
        clear: () => ctx.clearRect(0, 0, size.width, size.height),
        drawImage: (source, ...a) => {
          const turns = a.length === 9 ? (a[8] as number) : 0;
          if (turns) {
            ctx.save();
            ctx.translate(size.width / 2, size.height / 2);
            ctx.rotate((turns * Math.PI) / 2);
            // After a quarter turn the drawn rectangle has swapped width and height
            const w = turns % 2 ? size.height : size.width;
            const h = turns % 2 ? size.width : size.height;
            ctx.drawImage(source as CanvasImageSource, a[0]!, a[1]!, a[2]!, a[3]!, -w / 2, -h / 2, w, h);
            ctx.restore();
          } else {
            ctx.drawImage(source as CanvasImageSource, a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!, a[6]!, a[7]!);
          }
        },
      });
      return new Promise((resolve) => canvas.toBlob((b) => resolve(b), mime, quality));
    },
  };
}
