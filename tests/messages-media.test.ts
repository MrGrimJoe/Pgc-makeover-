import { describe, it, expect, beforeEach } from 'vitest';
import { makeEnv, call, seedUser } from './_helpers.ts';
import type { Env } from '../worker/types.ts';

const enc = (s: string) => [...s].map((c) => c.charCodeAt(0));
const PNG = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, 1]);
const WEBP = (n: number) => new Uint8Array([...enc('RIFF'), 8, 0, 0, 0, ...enc('WEBP'), n, 0]);
const GIF = (n: number) => new Uint8Array([...enc('GIF89a'), n, 1, 0, 1, 0, 0, 0, 0]);

describe('messages with media', () => {
  let env: Env;
  let alice: string;
  let bob: string;
  let conv: string;

  const up = async (bytes: Uint8Array, type: string, kind = 'photo') => {
    const form = new FormData();
    form.append('file', new Blob([bytes.slice()], { type }), 'f');
    form.append('kind', kind);
    return (await call(env, 'POST', '/api/media/uploads', { cookie: alice, form })).json.id as string;
  };
  const send = (json: unknown) => call(env, 'POST', `/api/conversations/${conv}/messages`, { cookie: alice, json });

  beforeEach(async () => {
    env = await makeEnv();
    alice = await seedUser(env, 'usr_alice', 'alice');
    bob = await seedUser(env, 'usr_bob', 'bob');
    const c = await call(env, 'POST', '/api/conversations', { cookie: alice, json: { user_id: 'usr_bob' } });
    conv = c.json.conversation?.id ?? c.json.id;
  });

  it('a message can be media only (no text), and carries the media kind (positive control: text still works)', async () => {
    expect((await send({ body: 'hi' })).status).toBe(201);
    const sticker = await up(WEBP(1), 'image/webp', 'sticker');
    const res = await send({ media_ids: [sticker] });
    expect(res.status).toBe(201);
    expect(res.json.message.body).toBe('');
    expect(res.json.message.media[0]).toMatchObject({ id: sticker, kind: 'sticker' });
  });

  it('rejects an empty message with no media, and more than 4 attachments (4 is accepted)', async () => {
    expect((await send({ body: '   ' })).status).toBe(400);
    expect((await send({})).status).toBe(400);
    expect((await send({ body: '', media_ids: [] })).status).toBe(400);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await up(PNG(i), 'image/png'));
    expect((await send({ body: 'four', media_ids: ids.slice(0, 4) })).status).toBe(201);
    expect((await send({ body: 'five', media_ids: ids })).status).toBe(400);
  });

  it('lists media with kind and size, and the conversation preview reports the kind of the last attachment', async () => {
    const gif = await up(GIF(1), 'image/gif', 'gif');
    await send({ media_ids: [gif] });
    const list = await call(env, 'GET', `/api/conversations/${conv}/messages`, { cookie: bob });
    expect(list.json.messages[0].media[0]).toMatchObject({ id: gif, kind: 'gif' });
    const convs = await call(env, 'GET', '/api/conversations', { cookie: bob });
    expect(convs.json.conversations[0].last_message.media_kind).toBe('gif');
    await send({ body: 'plain text' });
    const after = await call(env, 'GET', '/api/conversations', { cookie: bob });
    expect(after.json.conversations[0].last_message.media_kind).toBeNull(); // positive control: text-only has no kind
  });

  it('reporting a message stores the media ids, kinds and hashes in the evidence snapshot', async () => {
    const photo = await up(PNG(7), 'image/png');
    const sent = await send({ body: 'look', media_ids: [photo] });
    const report = await call(env, 'POST', '/api/reports', { cookie: bob, json: { target_type: 'message', target_id: sent.json.message.id, reason: 'harassment' } });
    expect(report.status).toBe(201);
    const row = await env.DB.prepare('SELECT snapshot FROM report_evidence WHERE report_id = ?').bind(report.json.id).first<{ snapshot: string }>();
    const snap = JSON.parse(row!.snapshot);
    expect(snap.attachments).toEqual([{ media_id: photo, kind: 'photo', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
  });
});
