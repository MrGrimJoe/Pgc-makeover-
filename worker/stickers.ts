import type { Env } from './types.ts';
import { canReadMedia, liveBytes, randomId, type MediaReadRow } from './media.ts';
import { jsonResponse } from './http.ts';
import { checkRateLimit } from './rate-limit.ts';
import { MEDIA_QUOTA_BYTES, MEDIA_RATE_WINDOW_MS, STICKER_LIBRARY_MAX } from '../shared/media-rules.ts';
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

// ---------------- favorites ----------------

export const FAVORITES_MAX = 200;
const FAVORITE_RATE_PER_HOUR = 60;

/** GET /api/stickers/favorites: the bundled stickers the person starred. Their saved copies of other people's uploads come with the library. */
export async function listFavoriteKeys(env: Env, userId: string): Promise<Response> {
  const rows = await env.DB.prepare('SELECT sticker_key FROM sticker_favorites WHERE user_id = ? ORDER BY created_at DESC, sticker_key LIMIT ?')
    .bind(userId, FAVORITES_MAX)
    .all<{ sticker_key: string }>();
  // A bundled sticker that was retired from the app is not offered any more
  const keys = (rows.results || []).map((r) => r.sticker_key).filter((k) => bundledKind(k) !== null);
  return jsonResponse({ keys, max: FAVORITES_MAX });
}

/**
 * POST /api/stickers/favorites { sticker_key }.
 *  - app:<pack>/<number>: only the key is stored, nothing goes to R2.
 *  - usr:<mediaId>: the person must be able to see it where it was shared. The file is copied on the server into
 *    their own media row (their quota, per-owner dedupe) and added to their library as a favorite, so it keeps
 *    working after the original post or message expires or the other person deletes theirs.
 * Answers with the key to use from now on (for a copy, the key of the person's own copy).
 */
export async function addFavorite(env: Env, userId: string, stickerKey: unknown): Promise<Response> {
  const parsed = parseStickerKey(stickerKey);
  if (!parsed) return jsonResponse({ error: 'Invalid sticker key' }, 400);

  const rate = await checkRateLimit(env.DB, `favorite:${userId}`, FAVORITE_RATE_PER_HOUR, MEDIA_RATE_WINDOW_MS);
  if (!rate.allowed) {
    return jsonResponse({ error: `Favorite limit reached: at most ${FAVORITE_RATE_PER_HOUR} per hour. Try again later.` }, 429, { 'Retry-After': String(rate.retryAfterSeconds) });
  }
  const now = new Date().toISOString();

  if (parsed.kind === 'app') {
    const r = resolveBundled(parsed.pack, parsed.number);
    if (r.status !== 'ok') return jsonResponse({ error: r.status === 'retired' ? 'This sticker is no longer available' : 'Unknown sticker' }, 400);
    const key = stickerKey as string;
    const have = await env.DB.prepare('SELECT 1 FROM sticker_favorites WHERE user_id = ? AND sticker_key = ?').bind(userId, key).first();
    if (have) return jsonResponse({ success: true, already: true, key, kind: r.item.kind }, 200);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM sticker_favorites WHERE user_id = ?').bind(userId).first<{ n: number }>();
    if ((count?.n ?? 0) >= FAVORITES_MAX) return jsonResponse({ error: `Your favorites are full (${FAVORITES_MAX}). Remove one first.` }, 409);
    await env.DB.prepare('INSERT OR IGNORE INTO sticker_favorites (user_id, sticker_key, created_at) VALUES (?, ?, ?)').bind(userId, key, now).run();
    return jsonResponse({ success: true, key, kind: r.item.kind }, 201);
  }

  const src = await env.DB.prepare(
    'SELECT id, owner_id, object_key, thumb_object_key, mime_type, size_bytes, kind, width, height, duration_ms, sha256, thumb_size_bytes FROM media WHERE id = ?'
  )
    .bind(parsed.mediaId)
    .first<MediaReadRow & { width: number | null; height: number | null; duration_ms: number | null; sha256: string | null; thumb_size_bytes: number }>();
  // The same answer for "does not exist" and "you cannot see it", so media ids cannot be probed
  if (!src || !(await canReadMedia(env, src, userId))) return jsonResponse({ error: 'Unknown sticker' }, 404);
  if (src.kind !== 'sticker' && src.kind !== 'gif') return jsonResponse({ error: 'Only stickers and GIFs can be added to favorites' }, 400);

  const library = async (mediaId: string): Promise<Response | null> => {
    const have = await env.DB.prepare('SELECT 1 FROM sticker_library WHERE user_id = ? AND media_id = ?').bind(userId, mediaId).first();
    if (have) return null;
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM sticker_library WHERE user_id = ?').bind(userId).first<{ n: number }>();
    if ((count?.n ?? 0) >= STICKER_LIBRARY_MAX) return jsonResponse({ error: `Your library is full (${STICKER_LIBRARY_MAX}). Remove one first.` }, 409);
    await env.DB.prepare("INSERT INTO sticker_library (user_id, media_id, created_at, source) VALUES (?, ?, ?, 'favorite')").bind(userId, mediaId, now).run();
    return null;
  };

  // Their own file: it only needs to be in the library
  if (src.owner_id === userId) {
    const full = await library(src.id);
    return full ?? jsonResponse({ success: true, key: `usr:${src.id}`, media_id: src.id, kind: src.kind }, 200);
  }

  // Someone else's file: the person's own copy, reused when they already have the same bytes
  const mine = src.sha256
    ? await env.DB.prepare('SELECT id FROM media WHERE owner_id = ? AND sha256 = ? AND kind = ? LIMIT 1').bind(userId, src.sha256, src.kind).first<{ id: string }>()
    : null;
  if (mine) {
    const full = await library(mine.id);
    return full ?? jsonResponse({ success: true, key: `usr:${mine.id}`, media_id: mine.id, kind: src.kind, already: true }, 200);
  }

  const incoming = src.size_bytes + (src.thumb_size_bytes ?? 0);
  if ((await liveBytes(env.DB, userId)) + incoming > MEDIA_QUOTA_BYTES) {
    return jsonResponse({ error: `Storage full: you can keep ${Math.round(MEDIA_QUOTA_BYTES / (1024 * 1024))} MB of media. Delete old stickers or wait for old messages to expire.` }, 413);
  }
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM sticker_library WHERE user_id = ?').bind(userId).first<{ n: number }>();
  if ((count?.n ?? 0) >= STICKER_LIBRARY_MAX) return jsonResponse({ error: `Your library is full (${STICKER_LIBRARY_MAX}). Remove one first.` }, 409);

  if (!env.MEDIA_BUCKET) return jsonResponse({ error: 'Storage unavailable' }, 503);
  const obj = await env.MEDIA_BUCKET.get(src.object_key);
  if (!obj) return jsonResponse({ error: 'That file is no longer available' }, 404);
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const newId = `med_${randomId(16)}`;
  const newKey = `media_${randomId(24)}`;
  let thumbKey: string | null = null;
  let thumbSize = 0;
  await env.MEDIA_BUCKET.put(newKey, bytes, { httpMetadata: { contentType: src.mime_type } });
  if (src.thumb_object_key) {
    const t = await env.MEDIA_BUCKET.get(src.thumb_object_key);
    if (t) {
      const tb = new Uint8Array(await t.arrayBuffer());
      thumbKey = `thumb_${randomId(24)}`;
      thumbSize = tb.length;
      await env.MEDIA_BUCKET.put(thumbKey, tb, { httpMetadata: { contentType: t.httpMetadata?.contentType ?? 'image/webp' } });
    }
  }
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO media (id, owner_id, object_key, mime_type, size_bytes, created_at, expires_at, kind, width, height, duration_ms, sha256, thumb_object_key, thumb_size_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(newId, userId, newKey, src.mime_type, bytes.length, now, expiresAt, src.kind, src.width, src.height, src.duration_ms, src.sha256, thumbKey, thumbSize),
      env.DB.prepare("INSERT INTO sticker_library (user_id, media_id, created_at, source) VALUES (?, ?, ?, 'favorite')").bind(userId, newId, now),
    ]);
  } catch (err) {
    // Do not leave files behind that no row points to
    await env.MEDIA_BUCKET.delete(newKey).catch(() => undefined);
    if (thumbKey) await env.MEDIA_BUCKET.delete(thumbKey).catch(() => undefined);
    throw err;
  }
  return jsonResponse({ success: true, key: `usr:${newId}`, media_id: newId, kind: src.kind }, 201);
}

/** DELETE /api/stickers/favorites/:key for a bundled key. Copies of uploads are removed through the library route. */
export async function removeFavoriteKey(env: Env, userId: string, rawKey: string): Promise<Response> {
  let key: string;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    return jsonResponse({ error: 'Invalid sticker key' }, 400);
  }
  if (parseStickerKey(key)?.kind !== 'app') return jsonResponse({ error: 'Invalid sticker key' }, 400);
  const res = await env.DB.prepare('DELETE FROM sticker_favorites WHERE user_id = ? AND sticker_key = ?').bind(userId, key).run();
  if (!res.meta || res.meta.changes === 0) return jsonResponse({ error: 'Not in your favorites' }, 404);
  return jsonResponse({ success: true });
}
