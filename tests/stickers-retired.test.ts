import { describe, it, expect, vi, beforeEach } from 'vitest';

// A catalog where number 2 of the pack was removed (retired) and number 1 still exists
vi.mock('../shared/stickers.ts', () => ({
  STICKER_PACKS: [
    { id: 'demo', name: 'Demo', order: 1, placeholder: false, retired: [2], items: [{ number: 1, file: 'one.webp', kind: 'sticker', width: 512, height: 512, alt: 'one', v: 'abcd1234' }] },
  ],
}));

import { makeEnv, call, seedUser } from './_helpers.ts';
import { resolveBundled } from '../shared/sticker-keys.ts';
import type { Env } from '../worker/types.ts';

describe('retired bundled stickers', () => {
  let env: Env;
  let alice: string;
  beforeEach(async () => {
    env = await makeEnv();
    alice = await seedUser(env, 'usr_alice', 'alice');
    await seedUser(env, 'usr_bob', 'bob');
  });

  it('resolves as retired, not unknown', () => {
    expect(resolveBundled('demo', 1).status).toBe('ok');
    expect(resolveBundled('demo', 2).status).toBe('retired');
    expect(resolveBundled('demo', 3).status).toBe('unknown');
  });

  it('cannot be sent in a message, post or comment (positive control: the live number can)', async () => {
    const conv = (await call(env, 'POST', '/api/conversations', { cookie: alice, json: { user_id: 'usr_bob' } })).json;
    const convId = conv.conversation?.id ?? conv.id;
    const send = (key: string) => call(env, 'POST', `/api/conversations/${convId}/messages`, { cookie: alice, json: { sticker_key: key } });
    expect((await send('app:demo/1')).status).toBe(201);
    const retired = await send('app:demo/2');
    expect(retired.status).toBe(400);
    expect(retired.json.error).toContain('no longer available');
    expect((await send('app:demo/3')).json.error).toBe('Unknown sticker');
    const post = await call(env, 'POST', '/api/posts', { cookie: alice, json: { body: 'x', sticker_key: 'app:demo/2' } });
    expect(post.status).toBe(400);
  });

  it('an old message that already uses the retired number is still returned (the app shows a placeholder)', async () => {
    const conv = (await call(env, 'POST', '/api/conversations', { cookie: alice, json: { user_id: 'usr_bob' } })).json;
    const convId = conv.conversation?.id ?? conv.id;
    await env.DB.prepare('INSERT INTO messages (id, conversation_id, sender_id, body, sticker_key, sent_at, expires_at) VALUES (?,?,?,?,?,?,?)')
      .bind('msg_old', convId, 'usr_alice', '', 'app:demo/2', new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString()).run();
    const list = await call(env, 'GET', `/api/conversations/${convId}/messages`, { cookie: alice });
    expect(list.json.messages[0].sticker_key).toBe('app:demo/2');
  });
});
