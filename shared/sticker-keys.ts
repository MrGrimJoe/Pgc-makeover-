/**
 * Sticker and GIF keys. Messages, posts and comments refer to a sticker by key only; the screen looks it up.
 *   app:<pack>/<number>   a bundled sticker (shipped with the app, permanently numbered; nothing is stored in R2)
 *   usr:<mediaId>         a sticker or GIF the person uploaded (stored in R2 and referenced through `media`)
 */
import { STICKER_PACKS, type BundledSticker, type StickerPack } from './stickers.ts';

export const STICKER_KEY_MAX_LENGTH = 60;
export const APP_KEY_RE = /^app:([a-z0-9][a-z0-9-]{0,31})\/([1-9][0-9]{0,5})$/;
export const USR_KEY_RE = /^usr:(med_[a-z0-9]{1,40})$/;

export type ParsedStickerKey = { kind: 'app'; pack: string; number: number } | { kind: 'usr'; mediaId: string };

/** Parses a key. Returns null for anything that is not exactly one of the two forms. */
export function parseStickerKey(key: unknown): ParsedStickerKey | null {
  if (typeof key !== 'string' || key.length > STICKER_KEY_MAX_LENGTH) return null;
  const app = APP_KEY_RE.exec(key);
  if (app) return { kind: 'app', pack: app[1]!, number: Number(app[2]) };
  const usr = USR_KEY_RE.exec(key);
  if (usr) return { kind: 'usr', mediaId: usr[1]! };
  return null;
}

export function appKey(pack: string, number: number): string {
  return `app:${pack}/${number}`;
}

export type BundledResolution =
  | { status: 'ok'; pack: StickerPack; item: BundledSticker }
  | { status: 'retired' }
  | { status: 'unknown' };

/** Looks a bundled sticker up. Retired numbers are told apart from numbers that never existed. */
export function resolveBundled(pack: string, number: number, packs: readonly StickerPack[] = STICKER_PACKS): BundledResolution {
  const p = packs.find((x) => x.id === pack);
  if (!p) return { status: 'unknown' };
  const item = p.items.find((i) => i.number === number);
  if (item) return { status: 'ok', pack: p, item };
  return p.retired.includes(number) ? { status: 'retired' } : { status: 'unknown' };
}

/** Static URL of a bundled sticker. The hash in the query keeps long-lived caches from serving a replaced file. */
export function bundledUrl(pack: StickerPack | string, item: BundledSticker): string {
  const id = typeof pack === 'string' ? pack : pack.id;
  return `/stickers/${id}/${encodeURIComponent(item.file)}?v=${item.v}`;
}

/** Kind (sticker or gif) of a bundled key, or null when it cannot be resolved. */
export function bundledKind(key: string): 'sticker' | 'gif' | null {
  const parsed = parseStickerKey(key);
  if (!parsed || parsed.kind !== 'app') return null;
  const r = resolveBundled(parsed.pack, parsed.number);
  return r.status === 'ok' ? r.item.kind : null;
}
