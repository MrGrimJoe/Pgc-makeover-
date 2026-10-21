import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { Env } from './types.ts';
import { jsonResponse } from './http.ts';
import { checkRateLimit } from './rate-limit.ts';
import { isBlockedBetween, canSendDmTo } from './permissions.ts';
import {
  MEDIA_QUOTA_BYTES,
  MEDIA_SIZE_CAPS,
  sizeMessage,
  MEDIA_RATE_LIMITS,
  MEDIA_RATE_WINDOW_MS,
  STICKER_LIBRARY_MAX,
  THUMBNAIL_MAX_BYTES,
  checkKindFile,
  isMediaKind,
  sniffMime,
  type MediaKind,
} from '../shared/media-rules.ts';

const MESSAGE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;

function randomId(len: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => (b % 36).toString(36)).join('');
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Removes metadata segments from a JPEG by walking its markers: APP1 (EXIF, XMP, GPS) and APP13 (IPTC) and
 * comments are dropped, everything else is copied. Returns null when the structure is not a valid JPEG.
 */
export function stripJpegMetadata(b: Uint8Array): Uint8Array | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const kept: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    const segStart = i;
    while (i < b.length && b[i] === 0xff) i++; // fill bytes
    if (i >= b.length) return null;
    const marker = b[i++]!;
    if (marker === 0xd9) {
      kept.push(b.subarray(segStart, i));
      return join(kept);
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      kept.push(b.subarray(segStart, i));
      continue;
    }
    if (i + 2 > b.length) return null;
    const len = (b[i]! << 8) | b[i + 1]!;
    if (len < 2 || i + len > b.length) return null;
    if (marker === 0xda) {
      // Start of scan: the entropy-coded data runs to the end of the file and is copied untouched
      kept.push(b.subarray(segStart));
      return join(kept);
    }
    const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe; // APP1 (EXIF/XMP), APP13 (IPTC), comment
    if (!drop) kept.push(b.subarray(segStart, i + len));
    i += len;
  }
  return null; // no scan data found
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Tables that may hold references to a media row. message_media and sticker_library exist only after their migrations. */
async function existingTables(db: D1Database): Promise<Set<string>> {
  const r = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
  return new Set((r.results || []).map((t) => t.name));
}

/** SQL fragment that is true when nothing references the media row aliased as `m`. */
function unreferencedSql(tables: Set<string>): string {
  const parts = [
    'NOT EXISTS (SELECT 1 FROM post_media x WHERE x.media_id = m.id)',
    'NOT EXISTS (SELECT 1 FROM profiles x WHERE x.avatar_media_id = m.id)',
  ];
  if (tables.has('message_media')) parts.push('NOT EXISTS (SELECT 1 FROM message_media x WHERE x.media_id = m.id)');
  if (tables.has('sticker_library')) parts.push('NOT EXISTS (SELECT 1 FROM sticker_library x WHERE x.media_id = m.id)');
  if (tables.has('comment_media')) parts.push('NOT EXISTS (SELECT 1 FROM comment_media x WHERE x.media_id = m.id)');
  return parts.join(' AND ');
}

/**
 * Deletes media rows and their R2 objects, but only those that nothing references. Returns how many were deleted.
 * An R2 failure keeps the row so the next run retries.
 */
export async function deleteMediaIfUnreferenced(env: Env, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const tables = await existingTables(env.DB);
  const where = unreferencedSql(tables);
  let deleted = 0;
  for (const id of ids) {
    const row = await env.DB.prepare(`SELECT m.id, m.object_key, m.thumb_object_key FROM media m WHERE m.id = ? AND ${where}`)
      .bind(id)
      .first<{ id: string; object_key: string; thumb_object_key: string | null }>();
    if (!row) continue;
    if (env.MEDIA_BUCKET) {
      try {
        await env.MEDIA_BUCKET.delete(row.object_key);
        if (row.thumb_object_key) await env.MEDIA_BUCKET.delete(row.thumb_object_key);
      } catch (err) {
        console.error(`Failed to delete R2 object for media ${row.id}:`, err);
        continue;
      }
    }
    await env.DB.prepare('DELETE FROM media WHERE id = ?').bind(row.id).run();
    deleted++;
  }
  return deleted;
}

/** Orphan cleanup: unreferenced media older than 24 hours. Library items, avatars and attachments are never touched. */
export async function pruneOrphanMedia(env: Env, referenceTime: number): Promise<number> {
  const tables = await existingTables(env.DB);
  const cutoff = new Date(referenceTime - ORPHAN_AGE_MS).toISOString();
  const rows = await env.DB.prepare(`SELECT m.id FROM media m WHERE m.created_at <= ? AND ${unreferencedSql(tables)}`)
    .bind(cutoff)
    .all<{ id: string }>();
  return deleteMediaIfUnreferenced(env, (rows.results || []).map((r) => r.id));
}

export interface MediaReadRow {
  id: string;
  owner_id: string;
  object_key: string;
  thumb_object_key: string | null;
  mime_type: string;
  size_bytes: number;
  kind: MediaKind;
}

/**
 * Who may read a media file: the owner; people who can see a post or message it is attached to (a post's author
 * must not be blocked with the viewer; only members of the conversation can see message media); signed-in people
 * who are not blocked with the owner when it is a profile picture. Library items are private to the owner.
 */
export async function canReadMedia(env: Env, media: MediaReadRow, viewerId: string): Promise<boolean> {
  if (media.owner_id === viewerId) return true;
  const tables = await existingTables(env.DB);

  const posts = await env.DB.prepare('SELECT p.author_id FROM post_media pm JOIN posts p ON p.id = pm.post_id WHERE pm.media_id = ?')
    .bind(media.id)
    .all<{ author_id: string }>();
  for (const p of posts.results || []) {
    if (!(await isBlockedBetween(env.DB, viewerId, p.author_id))) return true;
  }

  if (tables.has('message_media')) {
    const member = await env.DB.prepare(
      `SELECT 1 FROM message_media mm
       JOIN messages msg ON msg.id = mm.message_id
       JOIN conversation_members cm ON cm.conversation_id = msg.conversation_id AND cm.user_id = ?
       WHERE mm.media_id = ? LIMIT 1`
    )
      .bind(viewerId, media.id)
      .first();
    if (member) return true;
  }

  const avatarOwner = await env.DB.prepare('SELECT user_id FROM profiles WHERE avatar_media_id = ?').bind(media.id).first<{ user_id: string }>();
  if (avatarOwner && !(await isBlockedBetween(env.DB, viewerId, avatarOwner.user_id))) return true;
  return false;
}

async function liveBytes(db: D1Database, ownerId: string): Promise<number> {
  const r = await db.prepare('SELECT COALESCE(SUM(size_bytes + thumb_size_bytes), 0) AS n FROM media WHERE owner_id = ?').bind(ownerId).first<{ n: number }>();
  return r?.n ?? 0;
}

/**
 * POST /api/media/uploads. multipart fields: file, kind (default photo), width, height, duration_ms, thumb (optional file).
 * A raw body with a Content-Type is also accepted for photos, as before.
 */
export async function handleUpload(request: Request, env: Env, userId: string): Promise<Response> {
  const contentType = request.headers.get('Content-Type') || '';
  const isForm = contentType.includes('multipart/form-data');

  let kind: MediaKind = 'photo';
  let declared = '';
  let bytes: Uint8Array;
  let thumb: Uint8Array | null = null;
  let thumbType = '';
  let width: number | null = null;
  let height: number | null = null;
  let durationMs: number | null = null;

  // Cheap rejection before reading the body. A raw body is always a photo; a form may carry any kind (video is the largest).
  const declaredLength = Number(request.headers.get('content-length') || 0);
  const biggestAllowed = isForm ? MEDIA_SIZE_CAPS.video + 512 * 1024 : MEDIA_SIZE_CAPS.photo;
  if (declaredLength > biggestAllowed) {
    return jsonResponse({ error: isForm ? sizeMessage('video', declaredLength) : sizeMessage('photo', declaredLength) }, 413);
  }

  if (isForm) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return jsonResponse({ error: 'Invalid form data' }, 400);
    }
    const file = form.get('file');
    if (!file || typeof file === 'string') return jsonResponse({ error: 'Missing file field in form data' }, 400);
    const k = form.get('kind');
    if (k !== null) {
      if (!isMediaKind(k)) return jsonResponse({ error: 'Unknown media kind' }, 400);
      kind = k;
    }
    declared = (file as File).type;
    bytes = new Uint8Array(await (file as File).arrayBuffer());
    const t = form.get('thumb');
    if (t && typeof t !== 'string') {
      thumbType = (t as File).type;
      thumb = new Uint8Array(await (t as File).arrayBuffer());
    }
    const num = (v: FormDataEntryValue | null, max: number) => {
      if (typeof v !== 'string' || !/^\d{1,9}$/.test(v)) return null;
      const n = Number(v);
      return n >= 1 && n <= max ? n : null;
    };
    width = num(form.get('width'), 20000);
    height = num(form.get('height'), 20000);
    durationMs = num(form.get('duration_ms'), 600_000);
  } else {
    declared = contentType.split(';')[0]!.trim();
    bytes = new Uint8Array(await request.arrayBuffer());
  }

  // Type and size checks come before any rate-limit charge so a rejected file never costs the person an upload
  const sniffed = sniffMime(bytes);
  const check = checkKindFile(kind, declared, bytes, sniffed);
  if (!check.ok) return jsonResponse({ error: check.error }, check.error.includes('can be at most') ? 413 : 400);

  if (thumb) {
    const tSniff = sniffMime(thumb);
    if (!tSniff || thumbType !== tSniff || (tSniff !== 'image/webp' && tSniff !== 'image/jpeg')) {
      return jsonResponse({ error: 'Thumbnail must be a WebP or JPEG image' }, 400);
    }
    if (thumb.length > THUMBNAIL_MAX_BYTES) return jsonResponse({ error: 'Thumbnail is larger than 80 KB' }, 413);
    if (tSniff === 'image/jpeg') {
      const cleanThumb = stripJpegMetadata(thumb);
      if (!cleanThumb) return jsonResponse({ error: 'Thumbnail is not a valid JPEG' }, 400);
      thumb = cleanThumb;
    }
  }

  if (sniffed === 'image/jpeg') {
    const clean = stripJpegMetadata(bytes);
    if (!clean) return jsonResponse({ error: 'File is not a valid JPEG' }, 400);
    bytes = clean;
  }

  const limit = MEDIA_RATE_LIMITS[kind];
  const rate = await checkRateLimit(env.DB, `upload:${limit.key}:${userId}`, limit.max, MEDIA_RATE_WINDOW_MS);
  if (!rate.allowed) {
    return jsonResponse({ error: `Upload limit reached: at most ${limit.max} per hour. Try again later.` }, 429, { 'Retry-After': String(rate.retryAfterSeconds) });
  }

  const hash = await sha256Hex(bytes);
  const now = new Date().toISOString();

  // Same bytes from the same owner reuse the existing row (dedupe is per owner only)
  const existing = await env.DB.prepare(
    'SELECT id, object_key, mime_type, size_bytes, kind, width, height, duration_ms, created_at FROM media WHERE owner_id = ? AND sha256 = ? AND kind = ? LIMIT 1'
  )
    .bind(userId, hash, kind)
    .first<{ id: string; object_key: string; mime_type: string; size_bytes: number; kind: string; width: number | null; height: number | null; duration_ms: number | null; created_at: string }>();
  if (existing) {
    await env.DB.prepare('UPDATE media SET created_at = ? WHERE id = ?').bind(now, existing.id).run();
    return jsonResponse({ id: existing.id, object_key: existing.object_key, mime_type: existing.mime_type, size_bytes: existing.size_bytes, kind: existing.kind, width: existing.width, height: existing.height, duration_ms: existing.duration_ms, created_at: now, deduplicated: true }, 200);
  }

  const used = await liveBytes(env.DB, userId);
  const incoming = bytes.length + (thumb?.length ?? 0);
  if (used + incoming > MEDIA_QUOTA_BYTES) {
    return jsonResponse({ error: `Storage full: you can keep ${Math.round(MEDIA_QUOTA_BYTES / (1024 * 1024))} MB of media. Delete old stickers or wait for old messages to expire.` }, 413);
  }

  const mediaId = `med_${randomId(16)}`;
  const objectKey = `media_${randomId(24)}`;
  const thumbKey = thumb ? `thumb_${randomId(24)}` : null;
  if (env.MEDIA_BUCKET) {
    await env.MEDIA_BUCKET.put(objectKey, bytes, { httpMetadata: { contentType: sniffed! } });
    if (thumb && thumbKey) await env.MEDIA_BUCKET.put(thumbKey, thumb, { httpMetadata: { contentType: thumbType } });
  }
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO media (id, owner_id, object_key, mime_type, size_bytes, created_at, expires_at, kind, width, height, duration_ms, sha256, thumb_object_key, thumb_size_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(mediaId, userId, objectKey, sniffed, bytes.length, now, expiresAt, kind, width, height, durationMs, hash, thumbKey, thumb?.length ?? 0)
    .run();

  return jsonResponse({ id: mediaId, object_key: objectKey, mime_type: sniffed, size_bytes: bytes.length, kind, width, height, duration_ms: durationMs, has_thumb: !!thumb, created_at: now }, 201);
}

/** GET /api/media/:id (and /api/media/:id/thumb). Serves with nosniff, a private cache and an ETag. */
export async function serveMedia(request: Request, env: Env, viewerId: string, mediaId: string, wantThumb: boolean): Promise<Response> {
  const media = await env.DB.prepare('SELECT id, owner_id, object_key, thumb_object_key, mime_type, size_bytes, kind FROM media WHERE id = ?')
    .bind(mediaId)
    .first<MediaReadRow>();
  if (!media) return jsonResponse({ error: 'Media not found' }, 404);
  if (!(await canReadMedia(env, media, viewerId))) return jsonResponse({ error: 'Forbidden' }, 403);
  if (!env.MEDIA_BUCKET) return jsonResponse({ error: 'Storage unavailable' }, 503);

  const key = wantThumb ? media.thumb_object_key : media.object_key;
  if (!key) return jsonResponse({ error: 'Thumbnail not available' }, 404);
  const etag = `"${media.id}${wantThumb ? '-t' : ''}"`;
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=86400',
    ETag: etag,
  };
  if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers });

  const obj = await env.MEDIA_BUCKET.get(key);
  if (!obj) return jsonResponse({ error: 'Media file missing from storage' }, 404);
  // Thumbnails are WebP or JPEG; the stored object carries its own type
  headers['Content-Type'] = wantThumb ? (obj.httpMetadata?.contentType ?? 'image/webp') : media.mime_type;
  return new Response(obj.body as any, { headers });
}

/** DELETE /api/media/:id. Owner only. Refuses while the file is still used somewhere, so nothing breaks. */
export async function deleteOwnMedia(env: Env, userId: string, mediaId: string): Promise<Response> {
  const media = await env.DB.prepare('SELECT id, owner_id FROM media WHERE id = ?').bind(mediaId).first<{ id: string; owner_id: string }>();
  if (!media) return jsonResponse({ error: 'Media not found' }, 404);
  if (media.owner_id !== userId) return jsonResponse({ error: 'Forbidden: You can only delete your own media' }, 403);
  // Leaving the library first means a sticker the person removes can be deleted when nothing else uses it
  if ((await existingTables(env.DB)).has('sticker_library')) {
    await env.DB.prepare('DELETE FROM sticker_library WHERE media_id = ? AND user_id = ?').bind(mediaId, userId).run();
  }
  const n = await deleteMediaIfUnreferenced(env, [mediaId]);
  if (n === 0) return jsonResponse({ error: 'This file is still used by a post, message or profile picture' }, 409);
  return jsonResponse({ success: true, message: 'Media deleted successfully' });
}

// ---------------- sticker library ----------------

export async function listLibrary(env: Env, userId: string): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT m.id AS media_id, m.kind, m.mime_type, m.width, m.height, m.duration_ms, m.size_bytes, sl.created_at
     FROM sticker_library sl JOIN media m ON m.id = sl.media_id
     WHERE sl.user_id = ? ORDER BY sl.created_at DESC, m.id LIMIT ?`
  )
    .bind(userId, STICKER_LIBRARY_MAX)
    .all();
  return jsonResponse({ items: rows.results || [], max: STICKER_LIBRARY_MAX });
}

/** Adds a media item to the library. The person must be able to read it; the library references it, nothing is copied. */
export async function addToLibrary(env: Env, userId: string, mediaId: unknown): Promise<Response> {
  if (typeof mediaId !== 'string' || !/^med_[a-z0-9]{1,40}$/.test(mediaId)) return jsonResponse({ error: 'Validation failed: media_id' }, 400);
  const media = await env.DB.prepare('SELECT id, owner_id, object_key, thumb_object_key, mime_type, size_bytes, kind FROM media WHERE id = ?')
    .bind(mediaId)
    .first<MediaReadRow>();
  if (!media || !(await canReadMedia(env, media, userId))) return jsonResponse({ error: 'Media not found' }, 404);
  if (media.kind !== 'sticker' && media.kind !== 'gif') return jsonResponse({ error: 'Only stickers and GIFs can be saved to the library' }, 400);
  // A sticker someone else sent is referenced only when the sender owns it; the library needs the person's own copy
  if (media.owner_id !== userId) return jsonResponse({ error: 'Save a copy of your own: upload it as a sticker first' }, 403);

  const already = await env.DB.prepare('SELECT 1 FROM sticker_library WHERE user_id = ? AND media_id = ?').bind(userId, mediaId).first();
  if (already) return jsonResponse({ success: true, already: true }, 200);
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM sticker_library WHERE user_id = ?').bind(userId).first<{ n: number }>();
  if ((count?.n ?? 0) >= STICKER_LIBRARY_MAX) return jsonResponse({ error: `Your library is full (${STICKER_LIBRARY_MAX}). Remove one first.` }, 409);
  await env.DB.prepare('INSERT INTO sticker_library (user_id, media_id, created_at) VALUES (?, ?, ?)').bind(userId, mediaId, new Date().toISOString()).run();
  return jsonResponse({ success: true }, 201);
}

export async function removeFromLibrary(env: Env, userId: string, mediaId: string): Promise<Response> {
  const res = await env.DB.prepare('DELETE FROM sticker_library WHERE user_id = ? AND media_id = ?').bind(userId, mediaId).run();
  if (!res.meta || res.meta.changes === 0) return jsonResponse({ error: 'Not in your library' }, 404);
  // The file goes away only if nothing else (a message, post, avatar) still uses it
  await deleteMediaIfUnreferenced(env, [mediaId]);
  return jsonResponse({ success: true });
}

// ---------------- forwarding ----------------

/**
 * POST /api/messages/:id/forward { conversation_id }. The person must currently be a member of the original
 * message's conversation, a member of the target conversation, and allowed to message everyone there (blocks and
 * DM policy). Media is referenced by id, never re-uploaded. Forwarded media keeps living until its last message expires.
 */
export async function forwardMessage(
  env: Env,
  auth: { user: { id: string }; profile: { username: string; display_name: string } },
  messageId: string,
  targetConversationId: unknown
): Promise<Response> {
  if (typeof targetConversationId !== 'string' || !targetConversationId) return jsonResponse({ error: 'Validation failed: conversation_id' }, 400);
  const original = await env.DB.prepare('SELECT id, conversation_id, body, expires_at FROM messages WHERE id = ?')
    .bind(messageId)
    .first<{ id: string; conversation_id: string; body: string; expires_at: string }>();
  if (!original || new Date(original.expires_at).getTime() <= Date.now()) return jsonResponse({ error: 'Message not found' }, 404);

  const member = (convId: string) =>
    env.DB.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').bind(convId, auth.user.id).first();
  // Same 404 for "not a member" and "no such message" so message ids cannot be probed
  if (!(await member(original.conversation_id))) return jsonResponse({ error: 'Message not found' }, 404);
  if (!(await member(targetConversationId))) return jsonResponse({ error: 'Forbidden: Not a member of this conversation' }, 403);

  const others = await env.DB.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?')
    .bind(targetConversationId, auth.user.id)
    .all<{ user_id: string }>();
  for (const o of others.results || []) {
    const check = await canSendDmTo(env.DB, auth.user.id, o.user_id);
    if (!check.allowed) return jsonResponse({ error: check.reason }, 403);
  }

  const mediaRows = await env.DB.prepare(
    `SELECT m.id, m.object_key, m.mime_type, m.size_bytes FROM message_media mm JOIN media m ON m.id = mm.media_id WHERE mm.message_id = ?`
  )
    .bind(messageId)
    .all<{ id: string; object_key: string; mime_type: string; size_bytes: number }>();
  const media = mediaRows.results || [];

  const nowMs = Date.now();
  const newId = `msg_${nowMs}_${randomId(12)}`;
  const sentAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + MESSAGE_TTL_MS).toISOString();
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare('INSERT INTO messages (id, conversation_id, sender_id, body, sent_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').bind(newId, targetConversationId, auth.user.id, original.body, sentAt, expiresAt),
  ];
  for (const m of media) {
    stmts.push(env.DB.prepare('INSERT INTO message_media (message_id, media_id) VALUES (?, ?)').bind(newId, m.id));
    stmts.push(env.DB.prepare('UPDATE media SET expires_at = MAX(expires_at, ?) WHERE id = ?').bind(expiresAt, m.id));
  }
  await env.DB.batch(stmts);
  return jsonResponse(
    {
      message: {
        id: newId,
        conversation_id: targetConversationId,
        sender_id: auth.user.id,
        sender_username: auth.profile.username,
        sender_display_name: auth.profile.display_name,
        body: original.body,
        sent_at: sentAt,
        expires_at: expiresAt,
        media: media.map((m) => ({ id: m.id, object_key: m.object_key, mime_type: m.mime_type, size_bytes: m.size_bytes })),
      },
    },
    201
  );
}
