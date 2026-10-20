import { describe, it, expect, beforeEach } from 'vitest';
import { makeEnv, call, seedUser, uploadPng } from './_helpers.ts';
import type { Env } from '../worker/types.ts';

describe('Profile pictures', () => {
  let env: Env;
  let alice: string;
  let bob: string;

  beforeEach(async () => {
    env = await makeEnv();
    alice = await seedUser(env, 'usr_alice', 'alice');
    bob = await seedUser(env, 'usr_bob', 'bob');
  });

  it('the owner can set and clear a profile picture', async () => {
    const mediaId = await uploadPng(env, alice);
    expect(mediaId).toBeTruthy();
    const set = await call(env, 'PATCH', '/api/me', { cookie: alice, json: { avatar_media_id: mediaId } });
    expect(set.status).toBe(200);
    expect(set.json.profile.avatar_media_id).toBe(mediaId);
    const cleared = await call(env, 'PATCH', '/api/me', { cookie: alice, json: { avatar_media_id: null } });
    expect(cleared.json.profile.avatar_media_id).toBeNull();
  });

  it("rejects someone else's upload and unknown ids as a profile picture", async () => {
    const aliceMedia = await uploadPng(env, alice);
    expect((await call(env, 'PATCH', '/api/me', { cookie: bob, json: { avatar_media_id: aliceMedia } })).status).toBe(400);
    expect((await call(env, 'PATCH', '/api/me', { cookie: bob, json: { avatar_media_id: 'med_missing' } })).status).toBe(400);
    expect((await call(env, 'GET', '/api/me', { cookie: bob })).json.profile.avatar_media_id).toBeNull();
    // and bob still cannot read alice's private upload
    expect((await call(env, 'GET', `/api/media/${aliceMedia}`, { cookie: bob })).status).toBe(403);
  });

  it('other signed-in people can see a profile picture, signed-out visitors cannot', async () => {
    const mediaId = await uploadPng(env, alice);
    await call(env, 'PATCH', '/api/me', { cookie: alice, json: { avatar_media_id: mediaId } });

    const asBob = await call(env, 'GET', `/api/media/${mediaId}`, { cookie: bob });
    expect(asBob.status).toBe(200);
    expect(asBob.headers.get('content-type')).toBe('image/png');
    expect(asBob.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await call(env, 'GET', `/api/media/${mediaId}`)).status).toBe(401);
  });

  it('a blocked person cannot load the picture, in either direction', async () => {
    const mediaId = await uploadPng(env, alice);
    await call(env, 'PATCH', '/api/me', { cookie: alice, json: { avatar_media_id: mediaId } });
    await call(env, 'POST', '/api/blocks/usr_bob', { cookie: alice, json: { user_id: 'usr_bob' } });
    expect((await call(env, 'GET', `/api/media/${mediaId}`, { cookie: bob })).status).toBe(403);

    const bobMedia = await uploadPng(env, bob);
    await call(env, 'PATCH', '/api/me', { cookie: bob, json: { avatar_media_id: bobMedia } });
    expect((await call(env, 'GET', `/api/media/${bobMedia}`, { cookie: alice })).status).toBe(403);
  });

  it('the profile picture survives the orphan-media cleanup job', async () => {
    const mediaId = await uploadPng(env, alice);
    await call(env, 'PATCH', '/api/me', { cookie: alice, json: { avatar_media_id: mediaId } });
    await env.DB.prepare('UPDATE media SET created_at = ? WHERE id = ?').bind(new Date(Date.now() - 3 * 86_400_000).toISOString(), mediaId).run();
    const { runPostLifecycleExpiry } = await import('../worker/jobs/expiry.ts');
    await runPostLifecycleExpiry(env, Date.now());
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM media WHERE id = ?').bind(mediaId).first<{ n: number }>())?.n).toBe(1);
  });
});
