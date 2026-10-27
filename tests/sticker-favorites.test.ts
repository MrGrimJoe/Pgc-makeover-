import { describe, it, expect, beforeEach } from 'vitest';
import { makeEnv, call, seedUser } from './_helpers.ts';
import { STICKER_PACKS } from '../shared/stickers.ts';
import { appKey } from '../shared/sticker-keys.ts';
import { MEDIA_QUOTA_BYTES } from '../shared/media-rules.ts';
import type { Env } from '../worker/types.ts';

const enc = (s: string) => [...s].map((c) => c.charCodeAt(0));
const WEBP = (n: number) => new Uint8Array([...enc('RIFF'), 8, 0, 0, 0, ...enc('WEBP'), n, 0]);
const PNG = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, 1]);
const pack = STICKER_PACKS.find((p) => p.items.some((i) => i.kind === 'sticker'))!;
const still = pack.items.find((i) => i.kind === 'sticker')!;
const KEY = appKey(pack.id, still.number);

describe('sticker favorites', () => {
  let env: Env;
  let alice: string;
  let bob: string;
  let carol: string;
  let conv: string;

  const upload = async (cookie: string, bytes: Uint8Array, type: string, kind: string) => {
    const form = new FormData();
    form.append('file', new Blob([bytes.slice()], { type }), 'f');
    form.append('kind', kind);
    return (await call(env, 'POST', '/api/media/uploads', { cookie, form })).json.id as string;
  };
  const fav = (cookie: string | undefined, key: unknown) => call(env, 'POST', '/api/stickers/favorites', { cookie, json: { sticker_key: key } });
  const count = async (sql: string, ...b: unknown[]) => (await env.DB.prepare(sql).bind(...b).first<{ n: number }>())!.n;

  beforeEach(async () => {
    env = await makeEnv();
    alice = await seedUser(env, 'usr_alice', 'alice');
    bob = await seedUser(env, 'usr_bob', 'bob');
    carol = await seedUser(env, 'usr_carol', 'carol');
    const c = (await call(env, 'POST', '/api/conversations', { cookie: alice, json: { user_id: 'usr_bob' } })).json;
    conv = c.conversation?.id ?? c.id;
  });

  describe('bundled stickers (key only)', () => {
    it('stores the key, lists it, is idempotent, and removes it', async () => {
      const mediaBefore = await count('SELECT COUNT(*) AS n FROM media');
      const a = await fav(bob, KEY);
      expect(a.status).toBe(201);
      expect(a.json).toMatchObject({ key: KEY, kind: 'sticker' });
      const again = await fav(bob, KEY);
      expect(again.status).toBe(200);
      expect(again.json.already).toBe(true);
      expect((await call(env, 'GET', '/api/stickers/favorites', { cookie: bob })).json.keys).toEqual([KEY]);
      // nothing is stored in R2 or the media table for a bundled sticker
      expect(await count('SELECT COUNT(*) AS n FROM media')).toBe(mediaBefore);
      expect(await count('SELECT COUNT(*) AS n FROM sticker_favorites')).toBe(1);
      // favorites are private to the person
      expect((await call(env, 'GET', '/api/stickers/favorites', { cookie: carol })).json.keys).toEqual([]);
      expect((await call(env, 'DELETE', `/api/stickers/favorites/${encodeURIComponent(KEY)}`, { cookie: bob })).status).toBe(200);
      expect((await call(env, 'GET', '/api/stickers/favorites', { cookie: bob })).json.keys).toEqual([]);
      expect((await call(env, 'DELETE', `/api/stickers/favorites/${encodeURIComponent(KEY)}`, { cookie: bob })).status).toBe(404);
    });

    it('removing one person\'s favorite does not touch someone else\'s', async () => {
      await fav(bob, KEY);
      await fav(carol, KEY);
      await call(env, 'DELETE', `/api/stickers/favorites/${encodeURIComponent(KEY)}`, { cookie: bob });
      expect((await call(env, 'GET', '/api/stickers/favorites', { cookie: carol })).json.keys).toEqual([KEY]);
    });

    it('refuses malformed, unknown and unauthenticated requests', async () => {
      for (const bad of ['', 'app:nope/1', `app:${pack.id}/99999`, 'http://x', 5, null, undefined, 'usr:abc']) {
        expect((await fav(bob, bad)).status, String(bad)).toBe(bad === 'app:nope/1' || bad === `app:${pack.id}/99999` ? 400 : 400);
      }
      expect((await fav(undefined, KEY)).status).toBe(401);
      expect((await call(env, 'GET', '/api/stickers/favorites')).status).toBe(401);
      expect((await call(env, 'DELETE', `/api/stickers/favorites/${encodeURIComponent(KEY)}`)).status).toBe(401);
      expect((await call(env, 'DELETE', '/api/stickers/favorites/usr%3Amed_abc', { cookie: bob })).status).toBe(400); // copies leave through the library
      expect((await call(env, 'DELETE', '/api/stickers/favorites/%E0%A4%A', { cookie: bob })).status).toBe(400);
      expect(await count('SELECT COUNT(*) AS n FROM sticker_favorites')).toBe(0);
    });
  });

  describe('uploaded stickers from other people (copied)', () => {
    it('a person in the chat gets their own copy, which survives the original being deleted', async () => {
      const orig = await upload(alice, WEBP(11), 'image/webp', 'sticker');
      await call(env, 'POST', `/api/conversations/${conv}/messages`, { cookie: alice, json: { sticker_key: `usr:${orig}` } });

      const res = await fav(bob, `usr:${orig}`);
      expect(res.status).toBe(201);
      const copyId = res.json.media_id as string;
      expect(copyId).not.toBe(orig);
      expect(res.json.key).toBe(`usr:${copyId}`);

      const row = await env.DB.prepare('SELECT owner_id, object_key, mime_type, kind, size_bytes FROM media WHERE id = ?').bind(copyId).first<any>();
      const origRow = await env.DB.prepare('SELECT object_key, size_bytes FROM media WHERE id = ?').bind(orig).first<any>();
      expect(row.owner_id).toBe('usr_bob');
      expect(row.object_key).not.toBe(origRow.object_key); // its own file, not a shared one
      expect(row.size_bytes).toBe(origRow.size_bytes);
      const lib = (await call(env, 'GET', '/api/stickers/library', { cookie: bob })).json.items;
      expect(lib).toHaveLength(1);
      expect(lib[0]).toMatchObject({ media_id: copyId, source: 'favorite', kind: 'sticker' });

      // the sender's own library is untouched, and the copy is readable only by its owner until used
      expect((await call(env, 'GET', '/api/stickers/library', { cookie: alice })).json.items).toEqual([]);
      expect((await call(env, 'GET', `/api/media/${copyId}`, { cookie: bob })).status).toBe(200);
      expect((await call(env, 'GET', `/api/media/${copyId}`, { cookie: carol })).status).toBe(403);

      // the original goes away; the copy still works (the point of copying)
      await env.DB.prepare('DELETE FROM message_media WHERE media_id = ?').bind(orig).run();
      await env.DB.prepare('DELETE FROM media WHERE id = ?').bind(orig).run();
      expect((await call(env, 'GET', `/api/media/${copyId}`, { cookie: bob })).status).toBe(200);
    });

    it('favoriting the same file twice reuses the copy', async () => {
      const orig = await upload(alice, WEBP(12), 'image/webp', 'sticker');
      await call(env, 'POST', `/api/conversations/${conv}/messages`, { cookie: alice, json: { sticker_key: `usr:${orig}` } });
      const a = await fav(bob, `usr:${orig}`);
      const b = await fav(bob, `usr:${orig}`);
      expect(a.status).toBe(201);
      expect(b.status).toBe(200);
      expect(b.json.media_id).toBe(a.json.media_id);
      expect(await count('SELECT COUNT(*) AS n FROM media WHERE owner_id = ?', 'usr_bob')).toBe(1);
      expect(await count('SELECT COUNT(*) AS n FROM sticker_library WHERE user_id = ?', 'usr_bob')).toBe(1);
    });

    it('a person who cannot see the file gets the same answer as for a file that does not exist', async () => {
      const orig = await upload(alice, WEBP(13), 'image/webp', 'sticker');
      await call(env, 'POST', `/api/conversations/${conv}/messages`, { cookie: alice, json: { sticker_key: `usr:${orig}` } });
      const outsider = await fav(carol, `usr:${orig}`);
      const missing = await fav(carol, 'usr:med_doesnotexist');
      expect(outsider.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(outsider.json).toEqual(missing.json);
      expect(await count('SELECT COUNT(*) AS n FROM media WHERE owner_id = ?', 'usr_carol')).toBe(0);
      // positive control: the person in the chat can
      expect((await fav(bob, `usr:${orig}`)).status).toBe(201);
    });

    it('a sticker in a post can be kept by a reader, but not by someone blocked with the author', async () => {
      const orig = await upload(alice, WEBP(14), 'image/webp', 'sticker');
      expect((await call(env, 'POST', '/api/posts', { cookie: alice, json: { body: 'look', sticker_key: `usr:${orig}` } })).status).toBe(201);
      await call(env, 'POST', '/api/blocks', { cookie: alice, json: { user_id: 'usr_carol' } });
      expect((await fav(carol, `usr:${orig}`)).status).toBe(404);
      expect((await fav(bob, `usr:${orig}`)).status).toBe(201); // positive control
    });

    it('a GIF is copied as a GIF', async () => {
      const GIF = new Uint8Array([...enc('GIF89a'), 1, 0, 1, 0, 0, 0, 0, 0x3b]);
      const orig = await upload(alice, GIF, 'image/gif', 'gif');
      await call(env, 'POST', `/api/conversations/${conv}/messages`, { cookie: alice, json: { sticker_key: `usr:${orig}` } });
      const res = await fav(bob, `usr:${orig}`);
      expect(res.status).toBe(201);
      expect(res.json.kind).toBe('gif');
      expect((await call(env, 'GET', '/api/stickers/library', { cookie: bob })).json.items[0]).toMatchObject({ kind: 'gif', source: 'favorite' });
    });

    it('refuses a photo, and respects the storage quota', async () => {
      const photo = await upload(alice, PNG(15), 'image/png', 'photo');
      await call(env, 'POST', `/api/conversations/${conv}/messages`, { cookie: alice, json: { media_ids: [photo] } });
      expect((await fav(bob, `usr:${photo}`)).status).toBe(400);

      const orig = await upload(alice, WEBP(16), 'image/webp', 'sticker');
      await call(env, 'POST', `/api/conversations/${conv}/messages`, { cookie: alice, json: { sticker_key: `usr:${orig}` } });
      await env.DB.prepare(
        `INSERT INTO media (id, owner_id, object_key, mime_type, size_bytes, created_at, expires_at, kind) VALUES ('med_filler', 'usr_bob', 'media_filler', 'image/png', ?, ?, ?, 'photo')`
      ).bind(MEDIA_QUOTA_BYTES, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString()).run();
      const full = await fav(bob, `usr:${orig}`);
      expect(full.status).toBe(413);
      expect(await count("SELECT COUNT(*) AS n FROM media WHERE owner_id = 'usr_bob' AND kind = 'sticker'")).toBe(0);
    });

    it('your own sticker only needs to be in your library', async () => {
      const mine = await upload(bob, WEBP(17), 'image/webp', 'sticker');
      const res = await fav(bob, `usr:${mine}`);
      expect(res.status).toBe(200);
      expect(res.json.media_id).toBe(mine);
      expect(await count('SELECT COUNT(*) AS n FROM media WHERE owner_id = ?', 'usr_bob')).toBe(1);
    });

    it('removing a saved copy through the library deletes the file, and it can be saved again', async () => {
      const orig = await upload(alice, WEBP(18), 'image/webp', 'sticker');
      await call(env, 'POST', `/api/conversations/${conv}/messages`, { cookie: alice, json: { sticker_key: `usr:${orig}` } });
      const a = await fav(bob, `usr:${orig}`);
      const copy = a.json.media_id as string;
      const objectKey = (await env.DB.prepare('SELECT object_key FROM media WHERE id = ?').bind(copy).first<{ object_key: string }>())!.object_key;
      expect(await env.MEDIA_BUCKET!.get(objectKey)).not.toBeNull();
      expect((await call(env, 'DELETE', `/api/stickers/library/${copy}`, { cookie: bob })).status).toBe(200);
      expect(await count('SELECT COUNT(*) AS n FROM media WHERE id = ?', copy)).toBe(0);
      expect(await env.MEDIA_BUCKET!.get(objectKey)).toBeNull();
      expect((await fav(bob, `usr:${orig}`)).status).toBe(201);
    });

    it('is rate limited', async () => {
      const orig = await upload(alice, WEBP(19), 'image/webp', 'sticker');
      await call(env, 'POST', `/api/conversations/${conv}/messages`, { cookie: alice, json: { sticker_key: `usr:${orig}` } });
      let last = 0;
      for (let i = 0; i < 62; i++) last = (await fav(bob, `usr:${orig}`)).status;
      expect(last).toBe(429);
    });
  });

  it('library entries made by uploading are marked as your own', async () => {
    const mine = await upload(bob, WEBP(20), 'image/webp', 'sticker');
    await call(env, 'POST', '/api/stickers/library', { cookie: bob, json: { media_id: mine } });
    expect((await call(env, 'GET', '/api/stickers/library', { cookie: bob })).json.items[0].source).toBe('own');
  });
});
