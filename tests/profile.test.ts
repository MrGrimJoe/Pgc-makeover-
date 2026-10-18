import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../worker/index.ts';
import { createSqliteD1 } from '../worker/db/sqlite-d1.ts';
import { runMigrations, ALL_MIGRATIONS } from '../worker/db/migrate.ts';
import { createMemoryR2Bucket } from '../worker/db/r2-shim.ts';
import type { Env } from '../worker/types.ts';

describe('Profile Management and Access Control', () => {
  let env: Env;

  beforeEach(async () => {
    const db = createSqliteD1(':memory:');
    const r2 = createMemoryR2Bucket();
    await runMigrations(db, ALL_MIGRATIONS);
    env = {
      DB: db,
      MEDIA_BUCKET: r2,
      APP_URL: 'http://localhost:3000',
      GOOGLE_CLIENT_ID: 'test-google-client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
    };

    // Seed User A
    const now = new Date().toISOString();
    const expiry = new Date(Date.now() + 86400000).toISOString();

    await env.DB.prepare(
      'INSERT INTO users (id, provider_subject, created_at, status) VALUES (?, ?, ?, ?)'
    )
      .bind('usr_alice', 'google_sub_alice', now, 'active')
      .run();

    await env.DB.prepare(
      'INSERT INTO profiles (user_id, username, username_normalized, display_name, bio, avatar_media_id) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind('usr_alice', 'alice_original', 'alice_original', 'Alice Original', 'Alice Bio', null)
      .run();

    await env.DB.prepare(
      'INSERT INTO user_settings (user_id, dm_policy, feed_preferences) VALUES (?, ?, ?)'
    )
      .bind('usr_alice', 'everyone', '{}')
      .run();

    await env.DB.prepare(
      'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
    )
      .bind('sess_alice', 'usr_alice', expiry)
      .run();

    // Seed User B
    await env.DB.prepare(
      'INSERT INTO users (id, provider_subject, created_at, status) VALUES (?, ?, ?, ?)'
    )
      .bind('usr_bob', 'google_sub_bob', now, 'active')
      .run();

    await env.DB.prepare(
      'INSERT INTO profiles (user_id, username, username_normalized, display_name, bio, avatar_media_id) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind('usr_bob', 'bob_builder', 'bob_builder', 'Bob The Builder', 'Bob Bio', null)
      .run();

    await env.DB.prepare(
      'INSERT INTO user_settings (user_id, dm_policy, feed_preferences) VALUES (?, ?, ?)'
    )
      .bind('usr_bob', 'everyone', '{}')
      .run();

    await env.DB.prepare(
      'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
    )
      .bind('sess_bob', 'usr_bob', expiry)
      .run();
  });

  it('PATCH /api/me with no session returns 401', async () => {
    const req = new Request('http://localhost:3000/api/me', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        display_name: 'Unauthenticated User',
      }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe('Unauthorized');
  });

  it('PATCH /api/me with expired session returns 401', async () => {
    // Add expired session
    await env.DB.prepare(
      'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
    )
      .bind('sess_expired', 'usr_alice', new Date(Date.now() - 1000).toISOString())
      .run();

    const req = new Request('http://localhost:3000/api/me', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'session_id=sess_expired',
      },
      body: JSON.stringify({
        display_name: 'Expired Session User',
      }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it("a user cannot edit another user's profile", async () => {
    // Alice performs PATCH /api/me to change her profile
    const req = new Request('http://localhost:3000/api/me', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'session_id=sess_alice',
      },
      body: JSON.stringify({
        username: 'alice_new',
        display_name: 'Alice Modified',
        bio: 'Updated Alice Bio',
      }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);

    // Verify Alice's profile was updated
    const aliceProfile = await env.DB.prepare('SELECT * FROM profiles WHERE user_id = ?')
      .bind('usr_alice')
      .first<{ username: string; display_name: string; bio: string }>();

    expect(aliceProfile?.username).toBe('alice_new');
    expect(aliceProfile?.display_name).toBe('Alice Modified');
    expect(aliceProfile?.bio).toBe('Updated Alice Bio');

    // CRITICAL: Verify Bob's profile was completely unaffected and untouched
    const bobProfile = await env.DB.prepare('SELECT * FROM profiles WHERE user_id = ?')
      .bind('usr_bob')
      .first<{ username: string; display_name: string; bio: string }>();

    expect(bobProfile?.username).toBe('bob_builder');
    expect(bobProfile?.display_name).toBe('Bob The Builder');
    expect(bobProfile?.bio).toBe('Bob Bio');
  });

  it('PATCH /api/me rejects taking an existing username with 409 Conflict', async () => {
    // Alice attempts to change her username to Bob's username
    const req = new Request('http://localhost:3000/api/me', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'session_id=sess_alice',
      },
      body: JSON.stringify({
        username: 'bob_builder',
      }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(409);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain('Username is already taken');
  });

  it('maps D1 unique-constraint errors on username to 409 in race case with two parallel requests', async () => {
    // Both Alice and Bob attempt to update their username to the exact same new username in parallel
    const p1 = worker.fetch(
      new Request('http://localhost:3000/api/me', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'session_id=sess_alice',
        },
        body: JSON.stringify({
          username: 'race_winner_hero',
        }),
      }),
      env
    );

    const p2 = worker.fetch(
      new Request('http://localhost:3000/api/me', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'session_id=sess_bob',
        },
        body: JSON.stringify({
          username: 'race_winner_hero',
        }),
      }),
      env
    );

    const [res1, res2] = await Promise.all([p1, p2]);
    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const conflictRes = res1.status === 409 ? res1 : res2;
    const conflictData = (await conflictRes.json()) as { error: string };
    expect(conflictData.error).toContain('Username is already taken');
  });

  it('GET /api/users/:username requires a valid session', async () => {
    const unauthReq = new Request('http://localhost:3000/api/users/bob_builder', {
      method: 'GET',
    });
    const res = await worker.fetch(unauthReq, env);
    expect(res.status).toBe(401);
  });

  it('GET /api/users/:username returns public fields only and rejects hidden fields', async () => {
    const req = new Request('http://localhost:3000/api/users/bob_builder', {
      method: 'GET',
      headers: {
        Cookie: 'session_id=sess_alice',
      },
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);

    const data = (await res.json()) as Record<string, unknown>;

    // Must return public fields
    expect(data.username).toBe('bob_builder');
    expect(data.display_name).toBe('Bob The Builder');
    expect(data.bio).toBe('Bob Bio');
    expect(data.created_at).toBeDefined();

    // Must NOT leak private fields
    expect(data.provider_subject).toBeUndefined();
    expect(data.status).toBeUndefined();
    expect(data.user_id).toBeUndefined();
    expect(data.id).toBeUndefined();
    expect(data.dm_policy).toBeUndefined();
    expect(data.feed_preferences).toBeUndefined();
  });

  it('GET /api/users/:username is case-insensitive through username_normalized', async () => {
    const req = new Request('http://localhost:3000/api/users/BOB_BUILDER', {
      method: 'GET',
      headers: {
        Cookie: 'session_id=sess_alice',
      },
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { username: string };
    expect(data.username).toBe('bob_builder');
  });

  it('DELETE /api/me removes the user, all their rows, R2 objects, and message attachments', async () => {
    // 1. Create R2 media object owned by Alice
    const now = new Date().toISOString();
    await env.MEDIA_BUCKET!.put('alice_avatar_key', new Uint8Array([1, 2, 3]));
    await env.DB.prepare(
      'INSERT INTO media (id, owner_id, object_key, mime_type, size_bytes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
      .bind('med_alice_1', 'usr_alice', 'alice_avatar_key', 'image/png', 3, now, now)
      .run();

    // 2. Create conversation and message with media attachment sent by Alice
    await env.MEDIA_BUCKET!.put('alice_msg_attach_key', new Uint8Array([4, 5, 6]));
    await env.DB.prepare(
      'INSERT INTO media (id, owner_id, object_key, mime_type, size_bytes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
      .bind('med_alice_2', 'usr_alice', 'alice_msg_attach_key', 'image/png', 3, now, now)
      .run();

    await env.DB.prepare('INSERT INTO conversations (id, created_at) VALUES (?, ?)')
      .bind('conv_test_del', now)
      .run();
    await env.DB.prepare('INSERT INTO messages (id, conversation_id, sender_id, body, sent_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('msg_test_del', 'conv_test_del', 'usr_alice', 'Secret photo', now, now)
      .run();
    await env.DB.prepare('INSERT INTO message_media (message_id, media_id) VALUES (?, ?)')
      .bind('msg_test_del', 'med_alice_2')
      .run();

    // 3. Alice performs DELETE /api/me
    const req = new Request('http://localhost:3000/api/me', {
      method: 'DELETE',
      headers: {
        Cookie: 'session_id=sess_alice',
      },
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);

    // 4. Verify R2 objects are deleted
    expect(await env.MEDIA_BUCKET!.get('alice_avatar_key')).toBeNull();
    expect(await env.MEDIA_BUCKET!.get('alice_msg_attach_key')).toBeNull();

    // 5. Verify message attachments and messages are removed from database
    const msgRow = await env.DB.prepare('SELECT * FROM messages WHERE sender_id = ?').bind('usr_alice').first();
    expect(msgRow).toBeNull();
    const msgMediaRow = await env.DB.prepare('SELECT * FROM message_media WHERE message_id = ?').bind('msg_test_del').first();
    expect(msgMediaRow).toBeNull();
    const mediaRow = await env.DB.prepare('SELECT * FROM media WHERE owner_id = ?').bind('usr_alice').first();
    expect(mediaRow).toBeNull();

    // 6. Verify all Alice's rows are removed from database
    const userRow = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('usr_alice').first();
    const profileRow = await env.DB.prepare('SELECT * FROM profiles WHERE user_id = ?').bind('usr_alice').first();
    const settingsRow = await env.DB.prepare('SELECT * FROM user_settings WHERE user_id = ?').bind('usr_alice').first();
    const sessionRow = await env.DB.prepare('SELECT * FROM sessions WHERE user_id = ?').bind('usr_alice').first();

    expect(userRow).toBeNull();
    expect(profileRow).toBeNull();
    expect(settingsRow).toBeNull();
    expect(sessionRow).toBeNull();

    // 7. Verify Bob is unaffected
    const bobUser = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('usr_bob').first();
    expect(bobUser).not.toBeNull();
  });

  it('rejects feed_preferences exceeding 2000 characters with 400', async () => {
    const oversizedPrefs = 'a'.repeat(2001);
    const req = new Request('http://localhost:3000/api/me', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'session_id=sess_alice',
      },
      body: JSON.stringify({
        feed_preferences: oversizedPrefs,
      }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain('feed_preferences cannot exceed 2000 characters');

    // Valid size <= 2000 succeeds
    const validPrefs = 'b'.repeat(2000);
    const validReq = new Request('http://localhost:3000/api/me', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'session_id=sess_alice',
      },
      body: JSON.stringify({
        feed_preferences: validPrefs,
      }),
    });
    const validRes = await worker.fetch(validReq, env);
    expect(validRes.status).toBe(200);
  });

  it('rejects class_id values that do not exist in the classes table with 400', async () => {
    const req = new Request('http://localhost:3000/api/me', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'session_id=sess_alice',
      },
      body: JSON.stringify({
        class_id: 'cls_nonexistent_999',
      }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe('Class not found');

    // Valid class_id works
    const validReq = new Request('http://localhost:3000/api/me', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'session_id=sess_alice',
      },
      body: JSON.stringify({
        class_id: 'cls_2028',
      }),
    });
    const validRes = await worker.fetch(validReq, env);
    expect(validRes.status).toBe(200);
  });
});
