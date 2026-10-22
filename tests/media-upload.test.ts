import { describe, it, expect, beforeEach } from 'vitest';
import { makeEnv, call, seedUser } from './_helpers.ts';
import worker from '../worker/index.ts';
import { sniffMime, checkKindFile, MEDIA_SIZE_CAPS, MEDIA_QUOTA_BYTES, STICKER_LIBRARY_MAX } from '../shared/media-rules.ts';
import { stripJpegMetadata } from '../worker/media.ts';
import { runPostLifecycleExpiry } from '../worker/jobs/expiry.ts';
import type { Env } from '../worker/types.ts';

const enc = (s: string) => [...s].map((c) => c.charCodeAt(0));
const PNG = (n = 0) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, 1, 2, 3]);
const GIF = (n = 0) => new Uint8Array([...enc('GIF89a'), n, 1, 0, 1, 0, 0, 0, 0]);
const WEBP = (n = 0, m = 0) => new Uint8Array([...enc("RIFF"), 8, 0, 0, 0, ...enc("WEBP"), n, m]);
const MP4 = () => new Uint8Array([0, 0, 0, 0x18, ...enc('ftypmp42'), 0, 0, 0, 0]);
const pad = (head: Uint8Array, total: number) => {
  const out = new Uint8Array(total);
  out.set(head);
  return out;
};

/** A JPEG with an EXIF APP1 segment that carries GPS text, an APP0, a comment, a tiny scan and an EOI. */
function jpegWithGps(): Uint8Array {
  const exif = [...enc('Exif'), 0, 0, ...enc('GPSLatitude=31.5204N;GPSLongitude=74.3587E')];
  const app1 = [0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 0xff, ...exif];
  const app0 = [0xff, 0xe0, 0, 16, ...enc('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const com = [0xff, 0xfe, 0, 7, ...enc('hello')];
  const sos = [0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x12, 0x34, 0x56];
  return new Uint8Array([0xff, 0xd8, ...app0, ...app1, ...com, ...sos, 0xff, 0xd9]);
}

describe('media rules (pure)', () => {
  it('sniffs allowed types and rejects SVG/HTML', () => {
    expect(sniffMime(PNG())).toBe('image/png');
    expect(sniffMime(GIF())).toBe('image/gif');
    expect(sniffMime(new Uint8Array([...enc('GIF87a'), 0]))).toBe('image/gif');
    expect(sniffMime(WEBP())).toBe('image/webp');
    expect(sniffMime(MP4())).toBe('video/mp4');
    expect(sniffMime(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0]))).toBe('video/webm');
    expect(sniffMime(new Uint8Array(enc('<svg xmlns="http://www.w3.org/2000/svg"></svg>')))).toBeNull();
    expect(sniffMime(new Uint8Array(enc('<html>')))).toBeNull();
  });

  it('checks caps per kind, and a file exactly at the cap passes (positive control)', () => {
    for (const [kind, type] of [['photo', 'image/png'], ['sticker', 'image/webp'], ['gif', 'image/gif'], ['background', 'image/webp'], ['video', 'video/mp4']] as const) {
      const cap = MEDIA_SIZE_CAPS[kind];
      expect(checkKindFile(kind, type, { length: cap }, type).ok, `${kind} at cap`).toBe(true);
      expect(checkKindFile(kind, type, { length: cap + 1 }, type).ok, `${kind} over cap`).toBe(false);
    }
    expect(MEDIA_SIZE_CAPS.photo).toBe(Math.floor(2.5 * 1024 * 1024));
    expect(MEDIA_SIZE_CAPS.sticker).toBe(300 * 1024);
  });

  it('a kind refuses the wrong type (a sticker cannot be a video, a photo cannot be a GIF)', () => {
    expect(checkKindFile('sticker', 'video/mp4', { length: 10 }, 'video/mp4').ok).toBe(false);
    expect(checkKindFile('photo', 'image/gif', { length: 10 }, 'image/gif').ok).toBe(false);
    expect(checkKindFile('gif', 'video/webm', { length: 10 }, 'video/webm').ok).toBe(true);
  });
});

describe('stripJpegMetadata', () => {
  it('removes EXIF/GPS (APP1) and comments but keeps APP0 and the image data', () => {
    const src = jpegWithGps();
    expect(new TextDecoder('latin1').decode(src)).toContain('GPSLatitude'); // the fixture really has GPS
    const out = stripJpegMetadata(src)!;
    expect(out).not.toBeNull();
    const text = new TextDecoder('latin1').decode(out);
    expect(text).not.toContain('GPSLatitude');
    expect(text).not.toContain('Exif');
    expect(text).not.toContain('hello');
    expect(text).toContain('JFIF');
    expect([...out.slice(0, 2)]).toEqual([0xff, 0xd8]);
    expect([...out.slice(-2)]).toEqual([0xff, 0xd9]);
    expect(out.includes(0x12) && out.includes(0x56)).toBe(true);
  });

  it('rejects structures that are not JPEGs and truncated segments', () => {
    expect(stripJpegMetadata(new Uint8Array([0xff, 0xd8, 0x00, 0x00]))).toBeNull();
    expect(stripJpegMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1, 2]))).toBeNull();
    expect(stripJpegMetadata(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});

describe('upload API', () => {
  let env: Env;
  let alice: string;
  let bob: string;

  const up = (cookie: string, bytes: Uint8Array, type: string, kind?: string, extra: Record<string, string> = {}, thumb?: Uint8Array) => {
    const form = new FormData();
    form.append('file', new Blob([bytes.slice()], { type }), 'f');
    if (kind) form.append('kind', kind);
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    if (thumb) form.append('thumb', new Blob([thumb.slice()], { type: 'image/webp' }), 't.webp');
    return call(env, 'POST', '/api/media/uploads', { cookie, form });
  };
  const rowOf = (id: string) => env.DB.prepare('SELECT * FROM media WHERE id = ?').bind(id).first<any>();

  beforeEach(async () => {
    env = await makeEnv();
    alice = await seedUser(env, 'usr_alice', 'alice');
    bob = await seedUser(env, 'usr_bob', 'bob');
  });

  it('accepts each kind with its own type and stores kind and metadata (positive controls)', async () => {
    const photo = await up(alice, PNG(), 'image/png');
    expect(photo.status).toBe(201);
    expect(photo.json.kind).toBe('photo');
    const sticker = await up(alice, WEBP(1), 'image/webp', 'sticker', { width: '512', height: '512' });
    expect(sticker.status).toBe(201);
    expect((await rowOf(sticker.json.id)).width).toBe(512);
    expect((await up(alice, GIF(), 'image/gif', 'gif')).status).toBe(201);
    expect((await up(alice, MP4(), 'video/mp4', 'video', { duration_ms: '3000' })).status).toBe(201);
    expect((await up(alice, WEBP(2), 'image/webp', 'background')).status).toBe(201);
  });

  it('rejects SVG, HTML, mismatched bytes and unknown kinds', async () => {
    for (const [bytes, type] of [[new Uint8Array(enc('<svg onload=alert(1)></svg>')), 'image/svg+xml'], [new Uint8Array(enc('<svg></svg>')), 'image/png'], [PNG(), 'image/jpeg'], [GIF(), 'image/png'], [new Uint8Array(enc('<html>')), 'text/html']] as const) {
      expect((await up(alice, bytes, type)).status, type).toBe(400);
    }
    expect((await up(alice, PNG(), 'image/png', 'avatar')).status).toBe(400);
    expect((await up(alice, GIF(), 'image/gif', 'photo')).status).toBe(400);
  });

  it('enforces the per-kind size caps with a clear message, and cap-sized files pass', async () => {
    const big = await up(alice, pad(WEBP(), MEDIA_SIZE_CAPS.sticker + 1), 'image/webp', 'sticker');
    expect(big.status).toBe(413);
    expect(big.json.error).toContain('a sticker can be at most 0.29 MB');
    expect((await up(alice, pad(WEBP(), MEDIA_SIZE_CAPS.sticker), 'image/webp', 'sticker')).status).toBe(201);
    const gif = await up(alice, pad(GIF(), MEDIA_SIZE_CAPS.gif + 1), 'image/gif', 'gif');
    expect(gif.status).toBe(413);
    expect(gif.json.error).toContain('Trim it');
    expect((await up(alice, pad(GIF(), MEDIA_SIZE_CAPS.gif), 'image/gif', 'gif')).status).toBe(201);
    expect((await up(alice, pad(MP4(), MEDIA_SIZE_CAPS.video + 1), 'video/mp4', 'video')).status).toBe(413);
  });

  it('strips EXIF and GPS from JPEGs before storing (checked in the stored object)', async () => {
    const res = await up(alice, jpegWithGps(), 'image/jpeg');
    expect(res.status).toBe(201);
    const obj = await env.MEDIA_BUCKET!.get((await rowOf(res.json.id)).object_key);
    const stored = new TextDecoder('latin1').decode(await obj!.arrayBuffer());
    expect(stored).not.toContain('GPSLatitude');
    expect(stored).toContain('JFIF');
  });

  it('rejects a JPEG that cannot be parsed instead of storing unstripped bytes', async () => {
    expect((await up(alice, new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x00]), 'image/jpeg')).status).toBe(400);
  });

  it('rate limits per kind: photos 60/hour, backgrounds 10/hour, with a positive control that other kinds are unaffected', async () => {
    for (let i = 0; i < 10; i++) expect((await up(alice, WEBP(i), 'image/webp', 'background')).status).toBe(201);
    const eleventh = await up(alice, WEBP(99), 'image/webp', 'background');
    expect(eleventh.status).toBe(429);
    expect(eleventh.headers.get('Retry-After')).toBeTruthy();
    expect((await up(alice, PNG(1), 'image/png')).status).toBe(201); // photos have their own budget
    expect((await up(alice, WEBP(100), 'image/webp', 'sticker')).status).toBe(201);
    expect((await up(bob, WEBP(99), 'image/webp', 'background')).status).toBe(201); // other people are unaffected
  });

  it('photos are limited to 60 per hour', async () => {
    for (let i = 0; i < 60; i++) expect((await up(alice, PNG(i), 'image/png')).status).toBe(201);
    expect((await up(alice, PNG(200), 'image/png')).status).toBe(429);
  });

  it('enforces the live-storage quota with a clear message', async () => {
    await env.DB.prepare('INSERT INTO media (id, owner_id, object_key, mime_type, size_bytes, created_at, expires_at) VALUES (?,?,?,?,?,?,?)')
      .bind('med_big', 'usr_alice', 'k_big', 'image/png', MEDIA_QUOTA_BYTES - 10, new Date().toISOString(), new Date().toISOString())
      .run();
    const res = await up(alice, PNG(), 'image/png');
    expect(res.status).toBe(413);
    expect(res.json.error).toContain('Storage full');
    expect((await up(bob, PNG(), 'image/png')).status).toBe(201); // positive control: quota is per person
  });

  it('dedupes per owner only: the same bytes reuse the row for the owner, and never reveal another owner’s file', async () => {
    const a1 = await up(alice, PNG(7), 'image/png');
    const a2 = await up(alice, PNG(7), 'image/png');
    expect(a2.json.id).toBe(a1.json.id);
    expect(a2.json.deduplicated).toBe(true);
    const b1 = await up(bob, PNG(7), 'image/png');
    expect(b1.status).toBe(201);
    expect(b1.json.id).not.toBe(a1.json.id);
    expect(b1.json.deduplicated).toBeUndefined();
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM media').first<{ n: number }>();
    expect(n!.n).toBe(2);
  });

  it('stores an optional thumbnail, counts it toward quota, and serves it', async () => {
    const res = await up(alice, PNG(3), 'image/png', undefined, {}, WEBP(5));
    expect(res.status).toBe(201);
    expect(res.json.has_thumb).toBe(true);
    const row = await rowOf(res.json.id);
    expect(row.thumb_size_bytes).toBeGreaterThan(0);
    const thumb = await worker.fetch(new Request(`http://localhost:3000/api/media/${res.json.id}/thumb`, { headers: { Cookie: alice } }), env);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('Content-Type')).toBe('image/webp');
    const none = await up(alice, PNG(4), 'image/png');
    expect((await worker.fetch(new Request(`http://localhost:3000/api/media/${none.json.id}/thumb`, { headers: { Cookie: alice } }), env)).status).toBe(404);
    const bigThumb = await up(alice, PNG(6), 'image/png', undefined, {}, pad(WEBP(), 80 * 1024 + 1));
    expect(bigThumb.status).toBe(413);
  });

  it('serves with nosniff, the real content type, a private cache and an ETag, and answers 304 to a matching ETag', async () => {
    const id = (await up(alice, GIF(), 'image/gif', 'gif')).json.id;
    const get = (headers: Record<string, string> = {}) => worker.fetch(new Request(`http://localhost:3000/api/media/${id}`, { headers: { Cookie: alice, ...headers } }), env);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Type')).toBe('image/gif');
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=86400');
    const etag = res.headers.get('ETag')!;
    expect(etag).toBeTruthy();
    expect((await get({ 'If-None-Match': etag })).status).toBe(304);
    expect((await get({ 'If-None-Match': '"other"' })).status).toBe(200);
  });
});

describe('who can read media', () => {
  let env: Env;
  let alice: string;
  let bob: string;
  let carol: string;

  const up = async (cookie: string, bytes: Uint8Array, type: string, kind = 'photo') => {
    const form = new FormData();
    form.append('file', new Blob([bytes.slice()], { type }), 'f');
    form.append('kind', kind);
    return (await call(env, 'POST', '/api/media/uploads', { cookie, form })).json.id as string;
  };
  const read = (cookie: string, id: string) => call(env, 'GET', `/api/media/${id}`, { cookie }).then((r) => r.status);
  const convWith = async (cookie: string, other: string) => {
    const c = await call(env, 'POST', '/api/conversations', { cookie, json: { user_id: other } });
    return (c.json.id ?? c.json.conversation?.id) as string;
  };
  const send = (cookie: string, convId: string, mediaIds: string[]) =>
    call(env, 'POST', `/api/conversations/${convId}/messages`, { cookie, json: { body: 'x', media_ids: mediaIds } });

  beforeEach(async () => {
    env = await makeEnv();
    alice = await seedUser(env, 'usr_alice', 'alice');
    bob = await seedUser(env, 'usr_bob', 'bob');
    carol = await seedUser(env, 'usr_carol', 'carol');
  });

  it('message media is readable by the conversation members only (positive control: the recipient can read it)', async () => {
    const id = await up(alice, PNG(1), 'image/png');
    const conv = await convWith(alice, 'usr_bob');
    expect((await send(alice, conv, [id])).status).toBe(201);
    expect(await read(bob, id)).toBe(200);
    expect(await read(alice, id)).toBe(200);
    expect(await read(carol, id)).toBe(403);
  });

  it('a library sticker that is not attached anywhere is private to its owner', async () => {
    const id = await up(alice, WEBP(1), 'image/webp', 'sticker');
    expect((await call(env, 'POST', '/api/stickers/library', { cookie: alice, json: { media_id: id } })).status).toBe(201);
    expect(await read(alice, id)).toBe(200);
    expect(await read(bob, id)).toBe(403);
  });

  it('post media is readable unless the viewer is blocked with the author', async () => {
    const id = await up(alice, PNG(2), 'image/png');
    expect((await call(env, 'POST', '/api/posts', { cookie: alice, json: { body: 'p', media_ids: [id] } })).status).toBe(201);
    expect(await read(bob, id)).toBe(200);
    expect((await call(env, 'POST', '/api/blocks', { cookie: alice, json: { user_id: 'usr_bob' } })).status).toBeLessThan(300);
    expect(await read(bob, id)).toBe(403);
    expect(await read(carol, id)).toBe(200);
  });
});

describe('sticker library', () => {
  let env: Env;
  let alice: string;
  let bob: string;
  const up = async (cookie: string, n: number, kind = 'sticker') => {
    const form = new FormData();
    form.append('file', new Blob([WEBP(n % 250, n >> 8).slice()], { type: 'image/webp' }), 'f');
    form.append('kind', kind);
    return call(env, 'POST', '/api/media/uploads', { cookie, form });
  };

  beforeEach(async () => {
    env = await makeEnv();
    alice = await seedUser(env, 'usr_alice', 'alice');
    bob = await seedUser(env, 'usr_bob', 'bob');
  });

  it('adds, lists and removes; removing deletes the file when nothing else uses it', async () => {
    const id = (await up(alice, 1)).json.id;
    expect((await call(env, 'POST', '/api/stickers/library', { cookie: alice, json: { media_id: id } })).status).toBe(201);
    expect((await call(env, 'POST', '/api/stickers/library', { cookie: alice, json: { media_id: id } })).status).toBe(200); // idempotent
    const list = await call(env, 'GET', '/api/stickers/library', { cookie: alice });
    expect(list.json.items.map((i: any) => i.media_id)).toEqual([id]);
    expect((await call(env, 'GET', '/api/stickers/library', { cookie: bob })).json.items).toEqual([]);
    expect((await call(env, 'DELETE', `/api/stickers/library/${id}`, { cookie: alice })).status).toBe(200);
    const gone = await env.DB.prepare('SELECT COUNT(*) AS n FROM media WHERE id = ?').bind(id).first<{ n: number }>();
    expect(gone!.n).toBe(0);
    expect((await call(env, 'DELETE', `/api/stickers/library/${id}`, { cookie: alice })).status).toBe(404);
  });

  it('only stickers and GIFs, and only your own, can be added', async () => {
    const photo = new FormData();
    photo.append('file', new Blob([PNG().slice()], { type: 'image/png' }), 'f');
    const photoId = (await call(env, 'POST', '/api/media/uploads', { cookie: alice, form: photo })).json.id;
    expect((await call(env, 'POST', '/api/stickers/library', { cookie: alice, json: { media_id: photoId } })).status).toBe(400);
    const sticker = (await up(alice, 2)).json.id;
    expect((await call(env, 'POST', '/api/stickers/library', { cookie: bob, json: { media_id: sticker } })).status).toBe(404);
    expect((await call(env, 'POST', '/api/stickers/library', { cookie: alice, json: { media_id: "x' OR 1=1" } })).status).toBe(400);
    expect((await call(env, 'POST', '/api/stickers/library', { json: { media_id: sticker } })).status).toBe(401);
  });

  it('caps the library at 200 items (positive control: the 200th is accepted)', async () => {
    const now = new Date().toISOString();
    const stmts = [];
    for (let i = 0; i < STICKER_LIBRARY_MAX - 1; i++) {
      stmts.push(env.DB.prepare("INSERT INTO media (id, owner_id, object_key, mime_type, size_bytes, created_at, expires_at, kind) VALUES (?,?,?,?,?,?,?,'sticker')").bind(`med_s${i}`, 'usr_alice', `k${i}`, 'image/webp', 10, now, now));
      stmts.push(env.DB.prepare('INSERT INTO sticker_library (user_id, media_id, created_at) VALUES (?,?,?)').bind('usr_alice', `med_s${i}`, now));
    }
    await env.DB.batch(stmts);
    const a = (await up(alice, 1000)).json.id;
    const b = (await up(alice, 1001)).json.id;
    expect((await call(env, 'POST', '/api/stickers/library', { cookie: alice, json: { media_id: a } })).status).toBe(201);
    const over = await call(env, 'POST', '/api/stickers/library', { cookie: alice, json: { media_id: b } });
    expect(over.status).toBe(409);
    expect(over.json.error).toContain('full');
  });

  it('a library item survives the orphan cleanup, and a deleted-from-library one does not (positive control)', async () => {
    const kept = (await up(alice, 3)).json.id;
    const dropped = (await up(alice, 4)).json.id;
    await call(env, 'POST', '/api/stickers/library', { cookie: alice, json: { media_id: kept } });
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    await env.DB.prepare('UPDATE media SET created_at = ?').bind(old).run();
    await runPostLifecycleExpiry(env, Date.now());
    const has = async (id: string) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM media WHERE id = ?').bind(id).first<{ n: number }>())!.n;
    expect(await has(kept)).toBe(1);
    expect(await has(dropped)).toBe(0);
  });

  it('DELETE /api/media/:id refuses while the file is still used', async () => {
    const id = (await up(alice, 5, 'sticker')).json.id;
    await env.DB.prepare('UPDATE profiles SET avatar_media_id = ? WHERE user_id = ?').bind(id, 'usr_alice').run();
    expect((await call(env, 'DELETE', `/api/media/${id}`, { cookie: alice })).status).toBe(409);
    await env.DB.prepare('UPDATE profiles SET avatar_media_id = NULL WHERE user_id = ?').bind('usr_alice').run();
    expect((await call(env, 'DELETE', `/api/media/${id}`, { cookie: alice })).status).toBe(200);
  });
});

describe('forwarding', () => {
  let env: Env;
  let alice: string;
  let bob: string;
  let carol: string;

  const up = async (cookie: string, n: number) => {
    const form = new FormData();
    form.append('file', new Blob([PNG(n).slice()], { type: 'image/png' }), 'f');
    return (await call(env, 'POST', '/api/media/uploads', { cookie, form })).json.id as string;
  };
  const conv = async (cookie: string, other: string) => {
    const c = await call(env, 'POST', '/api/conversations', { cookie, json: { user_id: other } });
    return (c.json.id ?? c.json.conversation?.id) as string;
  };
  const has = async (id: string) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM media WHERE id = ?').bind(id).first<{ n: number }>())!.n;

  beforeEach(async () => {
    env = await makeEnv();
    alice = await seedUser(env, 'usr_alice', 'alice');
    bob = await seedUser(env, 'usr_bob', 'bob');
    carol = await seedUser(env, 'usr_carol', 'carol');
  });

  const setup = async () => {
    const media = await up(alice, 1);
    const ab = await conv(alice, 'usr_bob');
    const sent = await call(env, 'POST', `/api/conversations/${ab}/messages`, { cookie: alice, json: { body: 'look', media_ids: [media] } });
    return { media, ab, messageId: sent.json.message.id as string };
  };

  it('a recipient forwards a photo they do not own by id, without re-uploading (positive control)', async () => {
    const { media, messageId } = await setup();
    const bc = await conv(bob, 'usr_carol');
    const before = (await env.DB.prepare('SELECT COUNT(*) AS n FROM media').first<{ n: number }>())!.n;
    const res = await call(env, 'POST', `/api/messages/${messageId}/forward`, { cookie: bob, json: { conversation_id: bc } });
    expect(res.status).toBe(201);
    expect(res.json.message.media.map((m: any) => m.id)).toEqual([media]);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM media').first<{ n: number }>())!.n).toBe(before);
    expect((await call(env, 'GET', `/api/media/${media}`, { cookie: carol })).status).toBe(200);
  });

  it('sending a media id you do not own through the normal send route is still refused', async () => {
    const { media } = await setup();
    const bc = await conv(bob, 'usr_carol');
    expect((await call(env, 'POST', `/api/conversations/${bc}/messages`, { cookie: bob, json: { body: 'x', media_ids: [media] } })).status).toBe(400);
  });

  it('refuses people who are not in the original conversation, with the same 404 as a missing message', async () => {
    const { messageId } = await setup();
    const cd = await conv(carol, 'usr_alice');
    const outsider = await call(env, 'POST', `/api/messages/${messageId}/forward`, { cookie: carol, json: { conversation_id: cd } });
    const missing = await call(env, 'POST', `/api/messages/msg_nope/forward`, { cookie: carol, json: { conversation_id: cd } });
    expect(outsider.status).toBe(404);
    expect(missing.status).toBe(404);
  });

  it('refuses a target conversation the person is not in', async () => {
    const { messageId } = await setup();
    const ac = await conv(alice, 'usr_carol');
    expect((await call(env, 'POST', `/api/messages/${messageId}/forward`, { cookie: bob, json: { conversation_id: ac } })).status).toBe(403);
  });

  it('respects blocks and the recipient’s DM policy', async () => {
    const { messageId } = await setup();
    const bc = await conv(bob, 'usr_carol');
    await env.DB.prepare("UPDATE user_settings SET dm_policy = 'nobody' WHERE user_id = ?").bind('usr_carol').run();
    expect((await call(env, 'POST', `/api/messages/${messageId}/forward`, { cookie: bob, json: { conversation_id: bc } })).status).toBe(403);
    await env.DB.prepare("UPDATE user_settings SET dm_policy = 'everyone' WHERE user_id = ?").bind('usr_carol').run();
    await call(env, 'POST', '/api/blocks', { cookie: carol, json: { user_id: 'usr_bob' } });
    expect((await call(env, 'POST', `/api/messages/${messageId}/forward`, { cookie: bob, json: { conversation_id: bc } })).status).toBe(403);
  });

  it('forwarded media outlives the original message and goes only when the last message expires', async () => {
    const { media, messageId } = await setup();
    const bc = await conv(bob, 'usr_carol');
    await call(env, 'POST', `/api/messages/${messageId}/forward`, { cookie: bob, json: { conversation_id: bc } });
    // original message expires first
    await env.DB.prepare('UPDATE messages SET expires_at = ? WHERE id = ?').bind(new Date(Date.now() - 1000).toISOString(), messageId).run();
    await runPostLifecycleExpiry(env, Date.now());
    expect(await has(media)).toBe(1);
    // then the forwarded one
    await env.DB.prepare('UPDATE messages SET expires_at = ? WHERE conversation_id = ?').bind(new Date(Date.now() - 1000).toISOString(), bc).run();
    await runPostLifecycleExpiry(env, Date.now());
    expect(await has(media)).toBe(0);
  });

  it('requires a sign-in', async () => {
    const { messageId } = await setup();
    expect((await call(env, 'POST', `/api/messages/${messageId}/forward`, { json: { conversation_id: 'x' } })).status).toBe(401);
  });
});

describe('account deletion with media that other people still reference', () => {
  it('deletes the account when its photo was forwarded into someone else’s chat, and keeps that message (positive control: the account is gone)', async () => {
    const env = await makeEnv();
    const alice = await seedUser(env, 'usr_alice', 'alice');
    const bob = await seedUser(env, 'usr_bob', 'bob');
    await seedUser(env, 'usr_carol', 'carol');
    const form = new FormData();
    form.append('file', new Blob([PNG(5).slice()], { type: 'image/png' }), 'f');
    const mediaId = (await call(env, 'POST', '/api/media/uploads', { cookie: alice, form })).json.id as string;
    const ab = (await call(env, 'POST', '/api/conversations', { cookie: alice, json: { user_id: 'usr_bob' } })).json;
    const sent = await call(env, 'POST', `/api/conversations/${ab.conversation?.id ?? ab.id}/messages`, { cookie: alice, json: { body: 'x', media_ids: [mediaId] } });
    expect(sent.status).toBe(201);
    const bc = (await call(env, 'POST', '/api/conversations', { cookie: bob, json: { user_id: 'usr_carol' } })).json;
    const fwd = await call(env, 'POST', `/api/messages/${sent.json.message.id}/forward`, { cookie: bob, json: { conversation_id: bc.conversation?.id ?? bc.id } });
    expect(fwd.status).toBe(201);

    expect((await call(env, 'DELETE', '/api/me', { cookie: alice })).status).toBe(200);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').bind('usr_alice').first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE id = ?').bind(fwd.json.message.id).first<{ n: number }>())!.n).toBe(1);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM media WHERE id = ?').bind(mediaId).first<{ n: number }>())!.n).toBe(0);
  });
});
