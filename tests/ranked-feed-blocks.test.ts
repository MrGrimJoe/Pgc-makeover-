import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../worker/index.ts';
import { createSqliteD1 } from '../worker/db/sqlite-d1.ts';
import { createMemoryR2Bucket } from '../worker/db/r2-shim.ts';
import { runMigrations, ALL_MIGRATIONS } from '../worker/db/migrate.ts';
import { clearRateLimits } from '../worker/rate-limit.ts';
import type { Env } from '../worker/types.ts';
import type { PostItem } from '../shared/schema.ts';

/**
 * Regression: the ranked feed (mode=ranked / mode=for_you) bound its SQL
 * parameters in the wrong order whenever the viewer had a block in either
 * direction. The expires_at timestamp landed in a block-list placeholder (and a
 * user id landed in the expires_at comparison), so the candidate query matched
 * nothing and the feed came back EMPTY.
 *
 * The older assertions only used `not.toContain(blockedPost)`, which an empty
 * feed satisfies. Every test here also asserts that other people's posts are
 * still returned, so an empty feed fails.
 */
describe('Ranked feed with active blocks', () => {
  let env: Env;
  const sessions: Record<string, string> = {};

  const post = async (user: string, body: string): Promise<string> => {
    const res = await worker.fetch(
      new Request('http://localhost:3000/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: sessions[user]! },
        body: JSON.stringify({ body }),
      }),
      env
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };

  const block = async (blocker: string, blockedId: string) => {
    const res = await worker.fetch(
      new Request('http://localhost:3000/api/blocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: sessions[blocker]! },
        body: JSON.stringify({ user_id: blockedId }),
      }),
      env
    );
    expect(res.status).toBe(201);
  };

  const feedIds = async (user: string, mode: 'ranked' | 'for_you'): Promise<string[]> => {
    const res = await worker.fetch(
      new Request(`http://localhost:3000/api/feed?mode=${mode}`, {
        headers: { Cookie: sessions[user]! },
      }),
      env
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { posts: PostItem[] };
    return data.posts.map((p) => p.id);
  };

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

    const seedUser = async (id: string, username: string) => {
      await env.DB.prepare('INSERT INTO users (id, provider_subject, created_at, status) VALUES (?, ?, ?, ?)')
        .bind(id, `sub_${id}`, now, 'active')
        .run();
      await env.DB.prepare(
        'INSERT INTO profiles (user_id, username, username_normalized, display_name, bio, class_id) VALUES (?, ?, ?, ?, ?, ?)'
      )
        .bind(id, username, username.toLowerCase(), username, `Bio of ${username}`, 'cls_2026')
        .run();
      await env.DB.prepare('INSERT INTO user_settings (user_id, dm_policy) VALUES (?, ?)')
        .bind(id, 'everyone')
        .run();
      await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
        .bind(`sess_${id}`, id, expiry)
        .run();
      sessions[username] = `session_id=sess_${id}`;
    };

    await seedUser('usr_alice', 'alice');
    await seedUser('usr_bob', 'bob');
    await seedUser('usr_charlie', 'charlie');
    await seedUser('usr_dana', 'dana');
  });

  for (const mode of ['ranked', 'for_you'] as const) {
    describe(`mode=${mode}`, () => {
      it('blocker: still sees other people\'s posts and not the blocked user\'s', async () => {
        const aliceId = await post('alice', 'alice own post');
        const bobId = await post('bob', 'bob post that alice blocked');
        const charlieId = await post('charlie', 'charlie post everyone can see');

        await block('alice', 'usr_bob');

        const ids = await feedIds('alice', mode);
        // An empty feed must fail this test.
        expect(ids.length).toBeGreaterThan(0);
        expect(ids).toContain(charlieId);
        expect(ids).toContain(aliceId);
        expect(ids).not.toContain(bobId);
      });

      it('blocked user: still sees other people\'s posts and not the blocker\'s', async () => {
        const aliceId = await post('alice', 'alice post, she blocked bob');
        const bobId = await post('bob', 'bob own post');
        const charlieId = await post('charlie', 'charlie post everyone can see');

        await block('alice', 'usr_bob');

        const ids = await feedIds('bob', mode);
        expect(ids.length).toBeGreaterThan(0);
        expect(ids).toContain(charlieId);
        expect(ids).toContain(bobId);
        expect(ids).not.toContain(aliceId);
      });

      it('multiple blocks (several ids in every IN list): feed is not empty and excludes all of them', async () => {
        const aliceId = await post('alice', 'alice own post');
        const bobId = await post('bob', 'bob post');
        const charlieId = await post('charlie', 'charlie post');
        const danaId = await post('dana', 'dana post');

        await block('alice', 'usr_bob');
        await block('alice', 'usr_dana');

        const ids = await feedIds('alice', mode);
        expect(ids.length).toBeGreaterThan(0);
        expect(ids).toContain(charlieId);
        expect(ids).toContain(aliceId);
        expect(ids).not.toContain(bobId);
        expect(ids).not.toContain(danaId);
      });

      it('third party with no blocks is unaffected and sees everyone', async () => {
        const aliceId = await post('alice', 'alice post');
        const bobId = await post('bob', 'bob post');
        const charlieId = await post('charlie', 'charlie own post');

        await block('alice', 'usr_bob');

        const ids = await feedIds('charlie', mode);
        expect(ids).toContain(aliceId);
        expect(ids).toContain(bobId);
        expect(ids).toContain(charlieId);
      });

      it('a blocked user\'s like on a post does not break the engager subquery', async () => {
        const charlieId = await post('charlie', 'charlie post that bob engages with');

        const like = await worker.fetch(
          new Request(`http://localhost:3000/api/posts/${charlieId}/likes`, {
            method: 'POST',
            headers: { Cookie: sessions['bob']! },
          }),
          env
        );
        expect(like.status).toBe(200);

        await block('alice', 'usr_bob');

        const ids = await feedIds('alice', mode);
        expect(ids).toContain(charlieId);
      });
    });
  }
});
