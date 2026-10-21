import { describe, it, expect, beforeEach } from 'vitest';
import { makeEnv, call, seedUser, uploadPng } from './_helpers.ts';
import { runPostLifecycleExpiry } from '../worker/jobs/expiry.ts';
import type { Env } from '../worker/types.ts';

const DAY = 86_400_000;

describe('Media retention is reference-based', () => {
  let env: Env;
  let alice: string;

  const exists = async (id: string) =>
    ((await env.DB.prepare('SELECT COUNT(*) AS n FROM media WHERE id = ?').bind(id).first<{ n: number }>())?.n ?? 0) === 1;
  const age = (id: string, ms: number) =>
    env.DB.prepare('UPDATE media SET created_at = ? WHERE id = ?').bind(new Date(Date.now() - ms).toISOString(), id).run();
  const sendWithMedia = async (mediaId: string) => {
    const conv = await call(env, 'POST', '/api/conversations', { cookie: alice, json: { user_id: 'usr_bob' } });
    const convId = conv.json.id ?? conv.json.conversation?.id;
    const msg = await call(env, 'POST', `/api/conversations/${convId}/messages`, { cookie: alice, json: { body: 'photo', media_ids: [mediaId] } });
    expect(msg.status).toBe(201);
    return { convId, messageId: msg.json.id ?? msg.json.message?.id };
  };

  beforeEach(async () => {
    env = await makeEnv();
    alice = await seedUser(env, 'usr_alice', 'alice');
    await seedUser(env, 'usr_bob', 'bob');
  });

  it('positive control: an unreferenced upload older than 24 hours is deleted (with its R2 object)', async () => {
    const id = await uploadPng(env, alice);
    const key = (await env.DB.prepare('SELECT object_key FROM media WHERE id = ?').bind(id).first<{ object_key: string }>())!.object_key;
    expect(await env.MEDIA_BUCKET!.get(key)).not.toBeNull();
    await age(id, 3 * DAY);
    await runPostLifecycleExpiry(env, Date.now());
    expect(await exists(id)).toBe(false);
    expect(await env.MEDIA_BUCKET!.get(key)).toBeNull();
  });

  it('an unreferenced upload younger than 24 hours is kept', async () => {
    const id = await uploadPng(env, alice);
    await age(id, 2 * 3_600_000);
    await runPostLifecycleExpiry(env, Date.now());
    expect(await exists(id)).toBe(true);
  });

  it('a message attachment older than 24 hours survives the cleanup (suspected bug)', async () => {
    const id = await uploadPng(env, alice);
    await sendWithMedia(id);
    await age(id, 3 * DAY);
    await runPostLifecycleExpiry(env, Date.now());
    expect(await exists(id)).toBe(true);
  });

  it('a post attachment survives the cleanup', async () => {
    const id = await uploadPng(env, alice);
    const post = await call(env, 'POST', '/api/posts', { cookie: alice, json: { body: 'with photo', media_ids: [id] } });
    expect(post.status).toBe(201);
    await age(id, 3 * DAY);
    await runPostLifecycleExpiry(env, Date.now());
    expect(await exists(id)).toBe(true);
  });

  it('a profile picture survives the cleanup', async () => {
    const id = await uploadPng(env, alice);
    expect((await call(env, 'PATCH', '/api/me', { cookie: alice, json: { avatar_media_id: id } })).status).toBe(200);
    await age(id, 3 * DAY);
    await runPostLifecycleExpiry(env, Date.now());
    expect(await exists(id)).toBe(true);
  });
});
