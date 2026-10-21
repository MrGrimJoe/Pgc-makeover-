/**
 * Media rules shared by the Worker and the browser: kinds, size caps, rate limits, quota and file-type sniffing.
 * Everything here is pure so it can be unit tested and reused by src/lib/media.ts.
 */

export const MEDIA_KINDS = ['photo', 'sticker', 'gif', 'video', 'background'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const KB = 1024;
export const MB = 1024 * 1024;

/** Largest accepted file per kind, in bytes. */
export const MEDIA_SIZE_CAPS: Record<MediaKind, number> = {
  photo: Math.floor(2.5 * MB),
  sticker: 300 * KB,
  gif: 3 * MB,
  background: 400 * KB,
  video: 8 * MB,
};
export const THUMBNAIL_MAX_BYTES = 80 * KB;

/** Uploads allowed per hour per user. Stickers and GIFs share one budget. */
export const MEDIA_RATE_LIMITS = {
  photo: { key: 'photo', max: 60 },
  sticker: { key: 'sticker-gif', max: 120 },
  gif: { key: 'sticker-gif', max: 120 },
  video: { key: 'photo', max: 60 },
  background: { key: 'background', max: 10 },
} as const satisfies Record<MediaKind, { key: string; max: number }>;
export const MEDIA_RATE_WINDOW_MS = 60 * 60 * 1000;

/** Live storage each person may hold (main files plus thumbnails). */
export const MEDIA_QUOTA_BYTES = 200 * MB;
/** Stickers and GIFs a person can keep in their library. */
export const STICKER_LIBRARY_MAX = 200;

export type SniffedType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'video/mp4' | 'video/webm';

/** Identifies a file from its first bytes. Returns null for anything not allowed (SVG, HTML, ...). */
export function sniffMime(b: Uint8Array): SniffedType | null {
  const at = (i: number, s: string) => s.split('').every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 4 && b[0] === 0x89 && at(1, 'PNG')) return 'image/png';
  if (b.length >= 12 && at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  if (b.length >= 6 && (at(0, 'GIF87a') || at(0, 'GIF89a'))) return 'image/gif';
  if (b.length >= 12 && at(4, 'ftyp')) return 'video/mp4';
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  return null;
}

/** Which file types each kind may hold. */
export const KIND_TYPES: Record<MediaKind, readonly SniffedType[]> = {
  photo: ['image/jpeg', 'image/png', 'image/webp'],
  sticker: ['image/webp', 'image/png', 'image/gif'],
  gif: ['image/gif', 'image/webp', 'video/mp4', 'video/webm'],
  background: ['image/webp', 'image/jpeg', 'image/png'],
  video: ['video/mp4', 'video/webm'],
};

export type KindCheck = { ok: true } | { ok: false; error: string };

/** Checks type and size for a kind. Pure, so the client can give the same message before uploading. */
export function checkKindFile(kind: MediaKind, declared: string, bytes: Uint8Array | { length: number }, sniffed: SniffedType | null): KindCheck {
  const cap = mediaCap(kind);
  if (bytes.length === 0) return { ok: false, error: 'File is empty' };
  if (!ALL_TYPES.includes(declared as SniffedType)) return { ok: false, error: `Unsupported file type "${declared}". Use JPEG, PNG, WebP, GIF, MP4 or WebM.` };
  if (bytes.length > cap) return { ok: false, error: sizeMessage(kind, bytes.length, declared) };
  if (sniffed !== declared) return { ok: false, error: `File magic bytes do not match declared ${declared}` };
  if (!KIND_TYPES[kind].includes(sniffed)) {
    return { ok: false, error: `A ${kind} cannot be ${sniffed}. Allowed: ${KIND_TYPES[kind].join(', ')}.` };
  }
  return { ok: true };
}

const ALL_TYPES: readonly SniffedType[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm'];

function mediaCap(kind: MediaKind): number {
  return MEDIA_SIZE_CAPS[kind];
}

/** The "too big" message, shared so the client and the server say the same thing. */
export function sizeMessage(kind: MediaKind, length: number, declared = ''): string {
  const loop = declared === 'image/gif' || declared.startsWith('video/');
  return `File is ${(length / MB).toFixed(2)} MB; a ${kind} can be at most ${(MEDIA_SIZE_CAPS[kind] / MB).toFixed(2)} MB.${loop ? ' Trim it to under ' + (MEDIA_SIZE_CAPS[kind] / MB).toFixed(0) + ' MB.' : ''}`;
}

export function isMediaKind(v: unknown): v is MediaKind {
  return typeof v === 'string' && (MEDIA_KINDS as readonly string[]).includes(v);
}
