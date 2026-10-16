import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../worker/index.ts';
import { createSqliteD1 } from '../worker/db/sqlite-d1.ts';
import { createMemoryR2Bucket } from '../worker/db/r2-shim.ts';
import { runMigrations, ALL_MIGRATIONS } from '../worker/db/migrate.ts';
import { clearRateLimits } from '../worker/rate-limit.ts';
import { runPostLifecycleExpiry } from '../worker/jobs/expiry.ts';
import type { Env } from '../worker/types.ts';
import type { ConversationItem, MessageItem, BlockItem } from '../shared/schema.ts';

describe('Task B: Direct Messaging, Blocking, DM Policy & Report Evidence', () => {
  let env: Env;
  let aliceSessionCookie: string;
  let bobSessionCookie: string;
  let charlieSessionCookie: string;

  beforeEach(async () => {
    clearRateLimits();
    const db = createSqliteD1(':memory:');
    const r2 = createMemoryR2Bucket();
    await runMigrations(db, ALL_MIGRATIONS);

    env = {
      DB: db,
      MEDIA_BUCKET: r2,
      APP_URL: 'http://localhost:3000',
      GOOGLE_CLIENT_ID: 'test-google-client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
      ENVIRONMENT: 'development',
    };

    const now = new Date().toISOString();
    const expiry = new Date(Date.now() + 86400000).toISOString();

    const seedUser = async (id: string, username: string, dmPolicy = 'followed_only') => {
      await env.DB.prepare('INSERT INTO users (id, provider_subject, created_at, status) VALUES (?, ?, ?, ?)')
        .bind(id, `sub_${id}`, now, 'active')
        .run();
      await env.DB.prepare('INSERT INTO profiles (user_id, username, username_normalized, display_name, bio) VALUES (?, ?, ?, ?, ?)')
        .bind(id, username, username.toLowerCase(), username, '')
        .run();
      await env.DB.prepare('INSERT INTO user_settings (user_id, dm_policy) VALUES (?, ?)')
        .bind(id, dmPolicy)
        .run();
      await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
        .bind(`sess_${id}`, id, expiry)
        .run();
      return `session_id=sess_${id}`;
    };

    aliceSessionCookie = await seedUser('usr_alice', 'alice', 'followed_only');
    bobSessionCookie = await seedUser('usr_bob', 'bob', 'followed_only');
    charlieSessionCookie = await seedUser('usr_charlie', 'charlie', 'followed_only');
  });

  describe('Session & Membership Enforcement', () => {
    it('requires a session on all messaging endpoints', async () => {
      const endpoints = [
        { path: 'http://localhost:3000/api/conversations', method: 'GET' },
        { path: 'http://localhost:3000/api/conversations', method: 'POST', body: { user_id: 'usr_bob' } },
        { path: 'http://localhost:3000/api/conversations/conv_123/messages', method: 'GET' },
        { path: 'http://localhost:3000/api/conversations/conv_123/messages', method: 'POST', body: { body: 'hello' } },
        { path: 'http://localhost:3000/api/blocks', method: 'GET' },
        { path: 'http://localhost:3000/api/blocks', method: 'POST', body: { user_id: 'usr_bob' } },
        { path: 'http://localhost:3000/api/blocks/usr_bob', method: 'DELETE' },
      ];

      for (const ep of endpoints) {
        const res = await worker.fetch(
          new Request(ep.path, {
            method: ep.method,
            headers: ep.body ? { 'Content-Type': 'application/json' } : undefined,
            body: ep.body ? JSON.stringify(ep.body) : undefined,
          }),
          env
        );
        expect(res.status).toBe(401);
      }
    });

    it('rejects message access for users who are not conversation members', async () => {
      // Bob makes his dm_policy everyone
      await env.DB.prepare("UPDATE user_settings SET dm_policy = 'everyone' WHERE user_id = 'usr_bob'").run();

      // Alice starts a conversation with Bob
      const createConvRes = await worker.fetch(
        new Request('http://localhost:3000/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
          body: JSON.stringify({ user_id: 'usr_bob' }),
        }),
        env
      );
      expect(createConvRes.status).toBe(201);
      const { conversation } = (await createConvRes.json()) as { conversation: ConversationItem };

      // Charlie attempts to view messages
      const getRes = await worker.fetch(
        new Request(`http://localhost:3000/api/conversations/${conversation.id}/messages`, {
          method: 'GET',
          headers: { Cookie: charlieSessionCookie },
        }),
        env
      );
      expect(getRes.status).toBe(403);

      // Charlie attempts to send a message
      const postRes = await worker.fetch(
        new Request(`http://localhost:3000/api/conversations/${conversation.id}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: charlieSessionCookie },
          body: JSON.stringify({ body: 'Sneaking in' }),
        }),
        env
      );
      expect(postRes.status).toBe(403);
    });
  });

  describe('DM Policy & Permissions', () => {
    it('enforces followed_only policy by default (recipient must follow sender)', async () => {
      // Alice tries to start a conversation with Bob (default policy followed_only)
      const res1 = await worker.fetch(
        new Request('http://localhost:3000/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
          body: JSON.stringify({ user_id: 'usr_bob' }),
        }),
        env
      );
      expect(res1.status).toBe(403);

      // Bob follows Alice
      const now = new Date().toISOString();
      await env.DB.prepare('INSERT INTO follows (follower_id, followed_id, created_at) VALUES (?, ?, ?)')
        .bind('usr_bob', 'usr_alice', now)
        .run();

      // Now Alice can start a conversation with Bob
      const res2 = await worker.fetch(
        new Request('http://localhost:3000/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
          body: JSON.stringify({ user_id: 'usr_bob' }),
        }),
        env
      );
      expect(res2.status).toBe(201);
    });

    it('enforces dm_policy: nobody and everyone', async () => {
      // Bob sets policy to nobody
      await env.DB.prepare("UPDATE user_settings SET dm_policy = 'nobody' WHERE user_id = 'usr_bob'").run();

      const resNobody = await worker.fetch(
        new Request('http://localhost:3000/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
          body: JSON.stringify({ user_id: 'usr_bob' }),
        }),
        env
      );
      expect(resNobody.status).toBe(403);

      // Bob sets policy to everyone
      await env.DB.prepare("UPDATE user_settings SET dm_policy = 'everyone' WHERE user_id = 'usr_bob'").run();

      const resEveryone = await worker.fetch(
        new Request('http://localhost:3000/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
          body: JSON.stringify({ user_id: 'usr_bob' }),
        }),
        env
      );
      expect(resEveryone.status).toBe(201);
    });

    it('updates dm_policy via PATCH /api/me', async () => {
      const patchRes = await worker.fetch(
        new Request('http://localhost:3000/api/me', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
          body: JSON.stringify({ dm_policy: 'everyone' }),
        }),
        env
      );
      expect(patchRes.status).toBe(200);

      const meRes = await worker.fetch(
        new Request('http://localhost:3000/api/me', {
          method: 'GET',
          headers: { Cookie: aliceSessionCookie },
        }),
        env
      );
      const meData = (await meRes.json()) as any;
      expect(meData.settings.dm_policy).toBe('everyone');
    });
  });

  describe('Blocking System', () => {
    it('blocks and unblocks users and rejects messaging', async () => {
      // Bob allows everyone
      await env.DB.prepare("UPDATE user_settings SET dm_policy = 'everyone' WHERE user_id = 'usr_bob'").run();

      // Alice blocks Bob
      const blockRes = await worker.fetch(
        new Request('http://localhost:3000/api/blocks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
          body: JSON.stringify({ user_id: 'usr_bob' }),
        }),
        env
      );
      expect(blockRes.status).toBe(201);

      // Verify Bob appears in Alice's blocked list
      const listRes = await worker.fetch(
        new Request('http://localhost:3000/api/blocks', {
          method: 'GET',
          headers: { Cookie: aliceSessionCookie },
        }),
        env
      );
      const listData = (await listRes.json()) as { blocks: BlockItem[] };
      expect(listData.blocks.map((b) => b.user_id)).toContain('usr_bob');

      // Bob tries to message Alice -> 403 Forbidden
      const convRes = await worker.fetch(
        new Request('http://localhost:3000/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: bobSessionCookie },
          body: JSON.stringify({ user_id: 'usr_alice' }),
        }),
        env
      );
      expect(convRes.status).toBe(403);

      // Alice tries to message Bob -> 403 Forbidden
      const convRes2 = await worker.fetch(
        new Request('http://localhost:3000/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
          body: JSON.stringify({ user_id: 'usr_bob' }),
        }),
        env
      );
      expect(convRes2.status).toBe(403);

      // Cannot block self
      const selfBlockRes = await worker.fetch(
        new Request('http://localhost:3000/api/blocks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
          body: JSON.stringify({ user_id: 'usr_alice' }),
        }),
        env
      );
      expect(selfBlockRes.status).toBe(400);

      // Alice unblocks Bob
      const unblockRes = await worker.fetch(
        new Request('http://localhost:3000/api/blocks/usr_bob', {
          method: 'DELETE',
          headers: { Cookie: aliceSessionCookie },
        }),
        env
      );
      expect(unblockRes.status).toBe(200);

      // Now conversation can be started
      const convRes3 = await worker.fetch(
        new Request('http://localhost:3000/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
          body: JSON.stringify({ user_id: 'usr_bob' }),
        }),
        env
      );
      expect(convRes3.status).toBe(201);
    });
  });

  describe('1:1 Messaging & Cursor Pagination', () => {
    it('creates messages, attaches media, and supports cursor pagination', async () => {
      // Bob allows everyone
      await env.DB.prepare("UPDATE user_settings SET dm_policy = 'everyone' WHERE user_id = 'usr_bob'").run();

      // Alice creates conversation with Bob
      const convRes = await worker.fetch(
        new Request('http://localhost:3000/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
          body: JSON.stringify({ user_id: 'usr_bob' }),
        }),
        env
      );
      const { conversation } = (await convRes.json()) as { conversation: ConversationItem };

      // Alice uploads media attachment
      const mediaId = 'med_test_attach';
      const now = new Date().toISOString();
      await env.DB.prepare(
        'INSERT INTO media (id, owner_id, object_key, mime_type, size_bytes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
        .bind(mediaId, 'usr_alice', 'obj_attach.png', 'image/png', 1024, now, now)
        .run();

      // Alice sends message with attachment
      const msgRes1 = await worker.fetch(
        new Request(`http://localhost:3000/api/conversations/${conversation.id}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
          body: JSON.stringify({ body: 'Message 1 with photo', media_ids: [mediaId] }),
        }),
        env
      );
      expect(msgRes1.status).toBe(201);
      const msg1 = (await msgRes1.json()) as { message: MessageItem };
      expect(msg1.message.body).toBe('Message 1 with photo');
      expect(msg1.message.media.length).toBe(1);
      expect(msg1.message.media[0]!.id).toBe(mediaId);

      // Verify media expires with the message (14 days)
      const mediaRow = await env.DB.prepare('SELECT expires_at FROM media WHERE id = ?').bind(mediaId).first<{ expires_at: string }>();
      expect(mediaRow?.expires_at).toBe(msg1.message.expires_at);

      // Alice allows everyone
      await env.DB.prepare("UPDATE user_settings SET dm_policy = 'everyone' WHERE user_id = 'usr_alice'").run();

      // Bob replies with 2 more messages
      await worker.fetch(
        new Request(`http://localhost:3000/api/conversations/${conversation.id}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: bobSessionCookie },
          body: JSON.stringify({ body: 'Message 2 from Bob' }),
        }),
        env
      );

      await worker.fetch(
        new Request(`http://localhost:3000/api/conversations/${conversation.id}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: bobSessionCookie },
          body: JSON.stringify({ body: 'Message 3 from Bob' }),
        }),
        env
      );

      // Fetch page 1 with limit=2
      const page1Res = await worker.fetch(
        new Request(`http://localhost:3000/api/conversations/${conversation.id}/messages?limit=2`, {
          method: 'GET',
          headers: { Cookie: aliceSessionCookie },
        }),
        env
      );
      expect(page1Res.status).toBe(200);
      const page1Data = (await page1Res.json()) as { messages: MessageItem[]; next_cursor: string | null; has_more: boolean };
      expect(page1Data.messages.length).toBe(2);
      expect(page1Data.has_more).toBe(true);
      expect(page1Data.next_cursor).toBeTruthy();

      // Fetch page 2 using cursor
      const page2Res = await worker.fetch(
        new Request(`http://localhost:3000/api/conversations/${conversation.id}/messages?limit=2&cursor=${encodeURIComponent(page1Data.next_cursor!)}`, {
          method: 'GET',
          headers: { Cookie: aliceSessionCookie },
        }),
        env
      );
      expect(page2Res.status).toBe(200);
      const page2Data = (await page2Res.json()) as { messages: MessageItem[]; next_cursor: string | null; has_more: boolean };
      expect(page2Data.messages.length).toBe(1);
      expect(page2Data.messages[0]!.body).toBe('Message 1 with photo');
      expect(page2Data.has_more).toBe(false);
    });
  });

  describe('Report Evidence & 14-day Expiry Lifecycle', () => {
    it('creates report evidence for reported messages with 30-day snapshot', async () => {
      // Bob allows everyone
      await env.DB.prepare("UPDATE user_settings SET dm_policy = 'everyone' WHERE user_id = 'usr_bob'").run();

      const convRes = await worker.fetch(
        new Request('http://localhost:3000/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
          body: JSON.stringify({ user_id: 'usr_bob' }),
        }),
        env
      );
      const { conversation } = (await convRes.json()) as { conversation: ConversationItem };

      const msgRes = await worker.fetch(
        new Request(`http://localhost:3000/api/conversations/${conversation.id}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
          body: JSON.stringify({ body: 'Inappropriate message content' }),
        }),
        env
      );
      const { message } = (await msgRes.json()) as { message: MessageItem };

      // Bob reports Alice's message
      const reportRes = await worker.fetch(
        new Request('http://localhost:3000/api/reports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: bobSessionCookie },
          body: JSON.stringify({
            target_type: 'message',
            target_id: message.id,
            reason: 'Harassment',
          }),
        }),
        env
      );
      expect(reportRes.status).toBe(201);
      const reportData = (await reportRes.json()) as { id: string };

      // Verify report_evidence was created with message snapshot
      const evidenceRow = await env.DB.prepare('SELECT * FROM report_evidence WHERE report_id = ?')
        .bind(reportData.id)
        .first<{ id: string; snapshot: string; expires_at: string }>();

      expect(evidenceRow).toBeDefined();
      const snapshot = JSON.parse(evidenceRow!.snapshot);
      expect(snapshot.message_id).toBe(message.id);
      expect(snapshot.body).toBe('Inappropriate message content');
      expect(snapshot.sender_id).toBe('usr_alice');

      // Cannot report same message twice while pending
      const dupReportRes = await worker.fetch(
        new Request('http://localhost:3000/api/reports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: bobSessionCookie },
          body: JSON.stringify({
            target_type: 'message',
            target_id: message.id,
            reason: 'Spam',
          }),
        }),
        env
      );
      expect(dupReportRes.status).toBe(409);
    });

    it('prunes expired messages and attached media after 14 days in expiry job', async () => {
      // Bob allows everyone
      await env.DB.prepare("UPDATE user_settings SET dm_policy = 'everyone' WHERE user_id = 'usr_bob'").run();

      const convRes = await worker.fetch(
        new Request('http://localhost:3000/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
          body: JSON.stringify({ user_id: 'usr_bob' }),
        }),
        env
      );
      const { conversation } = (await convRes.json()) as { conversation: ConversationItem };

      // Seed an expired message (expired yesterday) with attached media in R2 and DB
      const pastMsgId = 'msg_old_14d';
      const pastSent = new Date(Date.now() - 15 * 86400000).toISOString();
      const pastExpires = new Date(Date.now() - 1 * 86400000).toISOString();
      const mediaId = 'med_old_msg';
      const objectKey = 'obj_old_msg.png';

      // Insert mock file in R2
      await env.MEDIA_BUCKET!.put(objectKey, new Uint8Array([1, 2, 3]), {
        httpMetadata: { contentType: 'image/png' },
      });

      await env.DB.prepare(
        'INSERT INTO media (id, owner_id, object_key, mime_type, size_bytes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
        .bind(mediaId, 'usr_alice', objectKey, 'image/png', 3, pastSent, pastExpires)
        .run();

      await env.DB.prepare(
        'INSERT INTO messages (id, conversation_id, sender_id, body, sent_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
        .bind(pastMsgId, conversation.id, 'usr_alice', 'Expired message', pastSent, pastExpires)
        .run();

      await env.DB.prepare('INSERT INTO message_media (message_id, media_id) VALUES (?, ?)')
        .bind(pastMsgId, mediaId)
        .run();

      // Run lifecycle expiry job
      const expiryResult = await runPostLifecycleExpiry(env, Date.now());
      expect(expiryResult.prunedMessages).toBe(1);

      // Verify message and media are pruned from DB
      const checkMsg = await env.DB.prepare('SELECT id FROM messages WHERE id = ?').bind(pastMsgId).first();
      expect(checkMsg).toBeNull();

      const checkMedia = await env.DB.prepare('SELECT id FROM media WHERE id = ?').bind(mediaId).first();
      expect(checkMedia).toBeNull();

      // Verify R2 object was deleted
      const r2Obj = await env.MEDIA_BUCKET!.get(objectKey);
      expect(r2Obj).toBeNull();
    });
  });
});
