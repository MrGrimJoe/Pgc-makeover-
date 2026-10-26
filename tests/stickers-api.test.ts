import { describe, it, expect, beforeEach } from 'vitest';
import { makeEnv, call, seedUser } from './_helpers.ts';
import worker from '../worker/index.ts';
import { STICKER_PACKS } from '../shared/stickers.ts';
import { parseStickerKey, resolveBundled, bundledUrl, bundledKind, appKey } from '../shared/sticker-keys.ts';
import { runPostLifecycleExpiry } from '../worker/jobs/expiry.ts';
import type { Env } from '../worker/types.ts';

const enc = (s: string) => [...s].map((c) => c.charCodeAt(0));
const WEBP = (n: number) => new Uint8Array([...enc('RIFF'), 8, 0, 0, 0, ...enc('WEBP'), n, 0]);
const PNG = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, 1]);

// stills and GIFs live in separate packs (Memes, Reactions)
const pack = STICKER_PACKS.find((p) => p.items.some((i) => i.kind === 'sticker'))!;
const loopPack = STICKER_PACKS.find((p) => p.items.some((i) => i.kind === 'gif'))!;
const still = pack.items.find((i) => i.kind === 'sticker')!;
const loop = loopPack.items.find((i) => i.kind === 'gif')!;
const KEY = appKey(pack.id, still.number);

describe('sticker keys (pure)', () => {
  it('accepts exactly the two forms and nothing else', () => {
    expect(parseStickerKey('app:memes/3')).toEqual({ kind: 'app', pack: 'memes', number: 3 });
    expect(parseStickerKey('usr:med_abc123')).toEqual({ kind: 'usr', mediaId: 'med_abc123' });
    for (const bad of ['', 'app:', 'app:x/0', 'app:x/01', 'app:X/1', 'app:../1', 'app:x/1/2', 'app:x/1 ', 'usr:abc', 'usr:med_', 'usr:med_A', 'http://x', 'app:x/9999999', 'a'.repeat(61), 5, null, undefined, {}]) {
      expect(parseStickerKey(bad as unknown), String(bad)).toBeNull();
    }
  });
  it('resolves bundled stickers, and tells retired numbers from numbers that never existed', () => {
    expect(resolveBundled(pack.id, still.number).status).toBe('ok');
    expect(resolveBundled(pack.id, 99999).status).toBe('unknown');
    expect(resolveBundled('nope', 1).status).toBe('unknown');
    const withRetired = [{ ...pack, retired: [77] }];
    expect(resolveBundled(pack.id, 77, withRetired).status).toBe('retired');
  });
  it('builds a versioned static URL and knows the kind', () => {
    expect(bundledUrl(pack, still)).toBe(`/stickers/${pack.id}/${still.file}?v=${still.v}`);
    expect(bundledKind(KEY)).toBe('sticker');
    expect(bundledKind(appKey(loopPack.id, loop.number))).toBe('gif');
    expect(bundledKind('app:placeholder/99999')).toBeNull();
  });
});

describe('sticker keys in messages, posts and comments', () => {
  let env: Env;
  let alice: string;
  let bob: string;
  let carol: string;
  let conv: string;
  let postId: string;

  const upload = async (cookie: string, bytes: Uint8Array, type: string, kind: string) => {
    const form = new FormData();
    form.append('file', new Blob([bytes.slice()], { type }), 'f');
    form.append('kind', kind);
    return (await call(env, 'POST', '/api/media/uploads', { cookie, form })).json.id as string;
  };
  const msg = (cookie: string, json: unknown) => call(env, 'POST', `/api/conversations/${conv}/messages`, { cookie, json });
  const post = (cookie: string, json: unknown) => call(env, 'POST', '/api/posts', { cookie, json });
  const comment = (cookie: string, json: unknown) => call(env, 'POST', `/api/posts/${postId}/comments`, { cookie, json });
  const count = async (sql: string, ...b: unknown[]) => (await env.DB.prepare(sql).bind(...b).first<{ n: number }>())!.n;

  beforeEach(async () => {
    env = await makeEnv();
    alice = await seedUser(env, 'usr_alice', 'alice');
    bob = await seedUser(env, 'usr_bob', 'bob');
    carol = await seedUser(env, 'usr_carol', 'carol');
    const c = (await call(env, 'POST', '/api/conversations', { cookie: alice, json: { user_id: 'usr_bob' } })).json;
    conv = c.conversation?.id ?? c.id;
    postId = (await post(bob, { body: 'a post to comment on' })).json.id;
  });

  describe('bundled stickers store only the key', () => {
    it('a message, a post and a comment can be a bundled sticker, and nothing is written to R2 or media', async () => {
      const mediaBefore = await count('SELECT COUNT(*) AS n FROM media');
      const m = await msg(alice, { sticker_key: KEY });
      expect(m.status).toBe(201);
      expect(m.json.message).toMatchObject({ body: '', sticker_key: KEY, media: [] });
      const p = await post(alice, { body: 'look', sticker_key: KEY });
      expect(p.status).toBe(201);
      expect(p.json.sticker_key).toBe(KEY);
      const c = await comment(alice, { sticker_key: KEY });
      expect(c.status).toBe(201);
      expect(c.json).toMatchObject({ body: '', sticker_key: KEY });
      expect(await count('SELECT COUNT(*) AS n FROM media')).toBe(mediaBefore);
      expect(await count('SELECT COUNT(*) AS n FROM message_media')).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM post_media')).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM comment_media')).toBe(0);
    });

    it('the key comes back when messages, posts and comments are read', async () => {
      await msg(alice, { sticker_key: KEY });
      const list = await call(env, 'GET', `/api/conversations/${conv}/messages`, { cookie: bob });
      expect(list.json.messages[0].sticker_key).toBe(KEY);
      const convs = await call(env, 'GET', '/api/conversations', { cookie: bob });
      expect(convs.json.conversations[0].last_message).toMatchObject({ sticker_key: KEY, media_kind: 'sticker' });
      const p = (await post(alice, { body: 'p', sticker_key: appKey(loopPack.id, loop.number) })).json;
      const one = await call(env, 'GET', `/api/posts/${p.id}`, { cookie: bob });
      expect(one.json.sticker_key).toBe(appKey(loopPack.id, loop.number));
      const feed = await call(env, 'GET', '/api/feed?tab=following', { cookie: bob }).catch(() => null);
      void feed;
      await comment(alice, { body: 'hi', sticker_key: KEY });
      const comments = await call(env, 'GET', `/api/posts/${postId}/comments`, { cookie: carol });
      expect(comments.json.comments[0]).toMatchObject({ body: 'hi', sticker_key: KEY });
    });

    it('rejects forged, malformed, unknown and non-string keys with 400 (positive control above)', async () => {
      const bad: unknown[] = ['app:placeholder/99999', 'app:nope/1', 'app:placeholder/0', "app:placeholder/1'; DROP TABLE messages;--", '../../etc/passwd', 'usr:med_doesnotexist', 'usr:abc', 'javascript:alert(1)', 123, ['app:placeholder/1'], { a: 1 }, 'x'.repeat(500)];
      for (const key of bad) {
        await env.DB.prepare('DELETE FROM rate_limits').run(); // the post and comment limits are not what is being tested here
        expect((await msg(alice, { sticker_key: key })).status, `message ${JSON.stringify(key)}`).toBe(400);
        expect((await post(alice, { body: 'x', sticker_key: key })).status, `post ${JSON.stringify(key)}`).toBe(400);
        expect((await comment(alice, { sticker_key: key })).status, `comment ${JSON.stringify(key)}`).toBe(400);
      }
      expect(await count("SELECT COUNT(*) AS n FROM messages WHERE sticker_key IS NOT NULL")).toBe(0);
    });

    it('a number that is not in the catalog still shows in old messages (as a placeholder) but cannot be sent', async () => {
      // Store a message directly, as if the sticker were removed after it was sent
      await env.DB.prepare('INSERT INTO messages (id, conversation_id, sender_id, body, sticker_key, sent_at, expires_at) VALUES (?,?,?,?,?,?,?)')
        .bind('msg_old', conv, 'usr_alice', '', 'app:placeholder/424242', new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString()).run();
      const list = await call(env, 'GET', `/api/conversations/${conv}/messages`, { cookie: bob });
      expect(list.status).toBe(200);
      expect(list.json.messages.find((m: any) => m.id === 'msg_old').sticker_key).toBe('app:placeholder/424242');
      expect((await msg(alice, { sticker_key: 'app:placeholder/424242' })).status).toBe(400);
    });
  });

  describe('content rules', () => {
    it('a message may be text and/or sticker and/or photos; a comment text and/or one sticker; empty is refused', async () => {
      const photo = await upload(alice, PNG(1), 'image/png', 'photo');
      expect((await msg(alice, { body: 'hi', sticker_key: KEY, media_ids: [photo] })).status).toBe(201);
      expect((await msg(alice, {})).status).toBe(400);
      expect((await comment(alice, {})).status).toBe(400);
      expect((await comment(alice, { body: '  ' })).status).toBe(400);
      expect((await comment(alice, { body: 'text and sticker', sticker_key: KEY })).status).toBe(201);
      expect((await comment(alice, { sticker_key: KEY, extra: 1 })).status).toBe(400);
    });

    it('a post is text plus exactly one of photos or one sticker/GIF, never both, and text is required', async () => {
      const photo = await upload(alice, PNG(2), 'image/png', 'photo');
      expect((await post(alice, { body: 'photos', media_ids: [photo] })).status).toBe(201);
      expect((await post(alice, { body: 'sticker', sticker_key: KEY })).status).toBe(201);
      expect((await post(alice, { body: 'both', media_ids: [photo], sticker_key: KEY })).status).toBe(400);
      expect((await post(alice, { sticker_key: KEY })).status).toBe(400);
      expect((await post(alice, { body: 'two', sticker_key: [KEY, KEY] })).status).toBe(400);
    });

    it('a sticker or GIF cannot be smuggled into a post as a photo', async () => {
      const sticker = await upload(alice, WEBP(3), 'image/webp', 'sticker');
      const res = await post(alice, { body: 'sneaky', media_ids: [sticker] });
      expect(res.status).toBe(400);
      expect(res.json.error).toContain('sticker_key');
    });
  });

  describe('uploaded stickers (usr: keys)', () => {
    it('the sender must be able to read the file, and it must be a sticker or GIF', async () => {
      const mine = await upload(alice, WEBP(4), 'image/webp', 'sticker');
      const photo = await upload(alice, PNG(5), 'image/png', 'photo');
      const bobs = await upload(bob, WEBP(6), 'image/webp', 'sticker');
      expect((await msg(alice, { sticker_key: `usr:${mine}` })).status).toBe(201);
      expect((await msg(alice, { sticker_key: `usr:${photo}` })).status).toBe(400); // a photo is not a sticker
      expect((await msg(alice, { sticker_key: `usr:${bobs}` })).status).toBe(400); // private to bob until it is attached somewhere alice can see
      expect((await post(alice, { body: 'p', sticker_key: `usr:${bobs}` })).status).toBe(400);
      expect((await comment(alice, { sticker_key: `usr:${bobs}` })).status).toBe(400);
    });

    it('is attached, so recipients can read it, outsiders cannot, and it appears in the message media', async () => {
      const mine = await upload(alice, WEBP(7), 'image/webp', 'sticker');
      const m = await msg(alice, { sticker_key: `usr:${mine}` });
      expect(m.json.message.media[0]).toMatchObject({ id: mine, kind: 'sticker' });
      expect((await call(env, 'GET', `/api/media/${mine}`, { cookie: bob })).status).toBe(200);
      expect((await call(env, 'GET', `/api/media/${mine}`, { cookie: carol })).status).toBe(403);
    });

    it('a post sticker is readable by people who can see the post, and not by someone blocked with the author', async () => {
      const mine = await upload(alice, WEBP(8), 'image/webp', 'sticker');
      expect((await post(alice, { body: 'p', sticker_key: `usr:${mine}` })).status).toBe(201);
      expect((await call(env, 'GET', `/api/media/${mine}`, { cookie: carol })).status).toBe(200);
      await call(env, 'POST', '/api/blocks', { cookie: alice, json: { user_id: 'usr_carol' } });
      expect((await call(env, 'GET', `/api/media/${mine}`, { cookie: carol })).status).toBe(403);
    });

    it('a comment sticker is readable by people who can see the post, and hidden from someone blocked with the commenter', async () => {
      const mine = await upload(alice, WEBP(9), 'image/webp', 'sticker');
      expect((await comment(alice, { sticker_key: `usr:${mine}` })).status).toBe(201);
      expect(await count('SELECT COUNT(*) AS n FROM comment_media')).toBe(1);
      expect((await call(env, 'GET', `/api/media/${mine}`, { cookie: carol })).status).toBe(200);
      await call(env, 'POST', '/api/blocks', { cookie: carol, json: { user_id: 'usr_alice' } });
      expect((await call(env, 'GET', `/api/media/${mine}`, { cookie: carol })).status).toBe(403);
      const list = await call(env, 'GET', `/api/posts/${postId}/comments`, { cookie: carol });
      expect(list.json.comments).toEqual([]); // blocked people's comments are hidden too
    });

    it('stays in storage while a post or comment uses it, even after the library entry is removed', async () => {
      const mine = await upload(alice, WEBP(10), 'image/webp', 'sticker');
      await call(env, 'POST', '/api/stickers/library', { cookie: alice, json: { media_id: mine } });
      await comment(alice, { sticker_key: `usr:${mine}` });
      await call(env, 'DELETE', `/api/stickers/library/${mine}`, { cookie: alice });
      await env.DB.prepare('UPDATE media SET created_at = ?').bind(new Date(Date.now() - 3 * 86_400_000).toISOString()).run();
      await runPostLifecycleExpiry(env, Date.now());
      expect(await count('SELECT COUNT(*) AS n FROM media WHERE id = ?', mine)).toBe(1);
      // positive control: once the comment is gone the file is cleaned up
      const cid = (await env.DB.prepare('SELECT id FROM comments WHERE author_id = ?').bind('usr_alice').first<{ id: string }>())!.id;
      await call(env, 'DELETE', `/api/comments/${cid}`, { cookie: alice });
      await runPostLifecycleExpiry(env, Date.now());
      expect(await count('SELECT COUNT(*) AS n FROM media WHERE id = ?', mine)).toBe(0);
    });
  });

  describe('forwarding and reports', () => {
    it('forwarding a sticker message keeps the key', async () => {
      const sent = await msg(alice, { sticker_key: KEY });
      const bc = (await call(env, 'POST', '/api/conversations', { cookie: bob, json: { user_id: 'usr_carol' } })).json;
      const fwd = await call(env, 'POST', `/api/messages/${sent.json.message.id}/forward`, { cookie: bob, json: { conversation_id: bc.conversation?.id ?? bc.id } });
      expect(fwd.status).toBe(201);
      expect(fwd.json.message.sticker_key).toBe(KEY);
    });

    it('reports on messages, posts and comments keep the sticker key (and media ids) as evidence', async () => {
      const mine = await upload(alice, WEBP(11), 'image/webp', 'sticker');
      const m = (await msg(alice, { body: 'rude', sticker_key: `usr:${mine}` })).json.message;
      const p = (await post(alice, { body: 'p', sticker_key: KEY })).json;
      const c = (await comment(alice, { sticker_key: `usr:${mine}` })).json;
      const evidence = async (type: string, id: string, cookie: string) => {
        const r = await call(env, 'POST', '/api/reports', { cookie, json: { target_type: type, target_id: id, reason: 'harassment' } });
        expect(r.status, type).toBe(201);
        const row = await env.DB.prepare('SELECT snapshot FROM report_evidence WHERE report_id = ?').bind(r.json.id).first<{ snapshot: string }>();
        return JSON.parse(row!.snapshot);
      };
      expect(await evidence('message', m.id, bob)).toMatchObject({ sticker_key: `usr:${mine}`, attachments: [{ media_id: mine, kind: 'sticker' }] });
      expect(await evidence('post', p.id, bob)).toMatchObject({ post_id: p.id, sticker_key: KEY, attachments: [] });
      expect(await evidence('comment', c.id, carol)).toMatchObject({ comment_id: c.id, sticker_key: `usr:${mine}`, attachments: [{ media_id: mine, kind: 'sticker' }] });
    });
  });

  describe('static files', () => {
    it('serves bundled stickers with a one-year immutable cache and nosniff (positive control: the file is served)', async () => {
      const assets = { fetch: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/webp' } }) };
      const withAssets = { ...env, ASSETS: assets } as Env;
      const res = await worker.fetch(new Request(`http://localhost:3000/stickers/${pack.id}/${still.file}?v=${still.v}`), withAssets);
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      // other static files are not given the long cache
      const other = await worker.fetch(new Request('http://localhost:3000/index.html'), withAssets);
      expect(other.headers.get('Cache-Control')).not.toBe('public, max-age=31536000, immutable');
    });
  });
});
