import type { Env } from './types.ts';
import { canReadMedia, type MediaReadRow } from './media.ts';
import { bundledKind, parseStickerKey, resolveBundled } from '../shared/sticker-keys.ts';

export type StickerKeyCheck =
  | { ok: true; key: string; mediaId: string | null; kind: 'sticker' | 'gif' }
  | { ok: false; status: number; error: string };

/**
 * Validates a sticker key sent by `userId`.
 *  - app:<pack>/<number> must exist in the shipped manifest. Retired numbers still display in old messages but cannot be sent.
 *  - usr:<mediaId> must be a sticker or GIF the sender can read. The caller attaches the media row so retention and read rules apply.
 * Nothing is written for bundled stickers: only the key is stored.
 */
export async function validateStickerKey(env: Env, key: unknown, userId: string): Promise<StickerKeyCheck> {
  const parsed = parseStickerKey(key);
  if (!parsed) return { ok: false, status: 400, error: 'Invalid sticker key' };

  if (parsed.kind === 'app') {
    const r = resolveBundled(parsed.pack, parsed.number);
    if (r.status === 'retired') return { ok: false, status: 400, error: 'This sticker is no longer available' };
    if (r.status !== 'ok') return { ok: false, status: 400, error: 'Unknown sticker' };
    return { ok: true, key: key as string, mediaId: null, kind: bundledKind(key as string) ?? 'sticker' };
  }

  const media = await env.DB.prepare('SELECT id, owner_id, object_key, thumb_object_key, mime_type, size_bytes, kind FROM media WHERE id = ?')
    .bind(parsed.mediaId)
    .first<MediaReadRow>();
  // The same answer for "does not exist" and "you cannot read it", so media ids cannot be probed
  if (!media || !(await canReadMedia(env, media, userId))) return { ok: false, status: 400, error: 'Unknown sticker' };
  if (media.kind !== 'sticker' && media.kind !== 'gif') return { ok: false, status: 400, error: 'That file is not a sticker or GIF' };
  return { ok: true, key: key as string, mediaId: media.id, kind: media.kind };
}
