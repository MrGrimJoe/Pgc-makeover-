import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../worker/index.ts';
import { createSqliteD1 } from '../worker/db/sqlite-d1.ts';
import { createMemoryR2Bucket } from '../worker/db/r2-shim.ts';
import { runMigrations } from '../worker/db/migrate.ts';
import { clearRateLimits } from '../worker/rate-limit.ts';
import { runPostLifecycleExpiry } from '../worker/jobs/expiry.ts';
import type { Env } from '../worker/types.ts';

describe('Milestone 2 Social Feed, Media, Interactions & Expiry Lifecycle', () => {
  let env: Env;
  let aliceSessionCookie: string;
  let bobSessionCookie: string;
  let charlieSessionCookie: string;
  let daveSessionCookie: string;

  beforeEach(async () => {
    clearRateLimits();
    const db = createSqliteD1(':memory:');
    const r2 = createMemoryR2Bucket();
    await runMigrations(db);

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

    // Helper to seed users
    const seedUser = async (id: string, username: string) => {
      await env.DB.prepare('INSERT INTO users (id, provider_subject, created_at, status) VALUES (?, ?, ?, ?)')
        .bind(id, `sub_${id}`, now, 'active')
        .run();
      await env.DB.prepare('INSERT INTO profiles (user_id, username, username_normalized, display_name, bio) VALUES (?, ?, ?, ?, ?)')
        .bind(id, username, username.toLowerCase(), username, '')
        .run();
      await env.DB.prepare('INSERT INTO user_settings (user_id) VALUES (?)')
        .bind(id)
        .run();
      await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
        .bind(`sess_${id}`, id, expiry)
        .run();
      return `session_id=sess_${id}`;
    };

    aliceSessionCookie = await seedUser('usr_alice', 'alice');
    bobSessionCookie = await seedUser('usr_bob', 'bob');
    charlieSessionCookie = await seedUser('usr_charlie', 'charlie');
    daveSessionCookie = await seedUser('usr_dave', 'dave');
  });

  // 1. Unauthenticated access returns 401 on every new route
  describe('Authentication Enforcement', () => {
    it('returns 401 Unauthorized for unauthenticated requests on all new routes', async () => {
      const endpoints = [
        { path: 'http://localhost:3000/api/posts', method: 'POST', body: JSON.stringify({ body: 'test' }) },
        { path: 'http://localhost:3000/api/posts/p1', method: 'GET' },
        { path: 'http://localhost:3000/api/posts/p1', method: 'DELETE' },
        { path: 'http://localhost:3000/api/feed', method: 'GET' },
        { path: 'http://localhost:3000/api/posts/p1/likes', method: 'POST' },
        { path: 'http://localhost:3000/api/posts/p1/likes', method: 'DELETE' },
        { path: 'http://localhost:3000/api/posts/p1/comments', method: 'GET' },
        { path: 'http://localhost:3000/api/posts/p1/comments', method: 'POST', body: JSON.stringify({ body: 'test' }) },
        { path: 'http://localhost:3000/api/comments/c1', method: 'DELETE' },
        { path: 'http://localhost:3000/api/users/usr_bob/follow', method: 'POST' },
        { path: 'http://localhost:3000/api/users/usr_bob/follow', method: 'DELETE' },
        { path: 'http://localhost:3000/api/reports', method: 'POST', body: JSON.stringify({ target_type: 'post', target_id: 'p1', reason: 'spam' }) },
        { path: 'http://localhost:3000/api/media/uploads', method: 'POST' },
        { path: 'http://localhost:3000/api/media/m1', method: 'GET' },
        { path: 'http://localhost:3000/api/media/m1', method: 'DELETE' },
      ];

      for (const ep of endpoints) {
        const req = new Request(ep.path, {
          method: ep.method,
          headers: ep.body ? { 'Content-Type': 'application/json' } : undefined,
          body: ep.body,
        });
        const res = await worker.fetch(req, env);
        expect(res.status, `Endpoint ${ep.method} ${ep.path} should return 401`).toBe(401);
      }
    });
  });

  // 2. Ownership & Permissions
  describe('Ownership Access Control', () => {
    it("a user cannot delete another user's post", async () => {
      // Alice creates a post
      const createReq = new Request('http://localhost:3000/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
        body: JSON.stringify({ body: "Alice's private thought" }),
      });
      const createRes = await worker.fetch(createReq, env);
      expect(createRes.status).toBe(201);
      const post = (await createRes.json()) as { id: string };

      // Bob tries to delete Alice's post
      const deleteReq = new Request(`http://localhost:3000/api/posts/${post.id}`, {
        method: 'DELETE',
        headers: { Cookie: bobSessionCookie },
      });
      const deleteRes = await worker.fetch(deleteReq, env);
      expect(deleteRes.status).toBe(403);

      // Alice can delete her own post
      const aliceDeleteReq = new Request(`http://localhost:3000/api/posts/${post.id}`, {
        method: 'DELETE',
        headers: { Cookie: aliceSessionCookie },
      });
      const aliceDeleteRes = await worker.fetch(aliceDeleteReq, env);
      expect(aliceDeleteRes.status).toBe(200);
    });

    it("a user cannot delete another user's comment", async () => {
      // Alice creates a post
      const createPostReq = new Request('http://localhost:3000/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
        body: JSON.stringify({ body: 'Post for comments' }),
      });
      const postRes = await worker.fetch(createPostReq, env);
      const post = (await postRes.json()) as { id: string };

      // Alice comments on her post
      const commentReq = new Request(`http://localhost:3000/api/posts/${post.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
        body: JSON.stringify({ body: "Alice's comment" }),
      });
      const commentRes = await worker.fetch(commentReq, env);
      const comment = (await commentRes.json()) as { id: string };

      // Bob attempts to delete Alice's comment
      const deleteReq = new Request(`http://localhost:3000/api/comments/${comment.id}`, {
        method: 'DELETE',
        headers: { Cookie: bobSessionCookie },
      });
      const deleteRes = await worker.fetch(deleteReq, env);
      expect(deleteRes.status).toBe(403);
    });

    it("a user cannot delete another user's media", async () => {
      // Alice uploads media
      const uploadReq = new Request('http://localhost:3000/api/media/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'image/png', Cookie: aliceSessionCookie },
        body: new Uint8Array([137, 80, 78, 71]), // PNG signature
      });
      const uploadRes = await worker.fetch(uploadReq, env);
      expect(uploadRes.status).toBe(201);
      const media = (await uploadRes.json()) as { id: string };

      // Bob attempts to delete Alice's media
      const deleteReq = new Request(`http://localhost:3000/api/media/${media.id}`, {
        method: 'DELETE',
        headers: { Cookie: bobSessionCookie },
      });
      const deleteRes = await worker.fetch(deleteReq, env);
      expect(deleteRes.status).toBe(403);
    });
  });

  // 3. Post Expiry Lifecycle & R2 Cleanup
  describe('Post Lifecycle Expiry & R2 Cleanup', () => {
    it('expires and deletes post at day 7 when fewer than 3 distinct users engaged', async () => {
      // 1. Upload media to attach to post
      const uploadReq = new Request('http://localhost:3000/api/media/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'image/png', Cookie: aliceSessionCookie },
        body: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), // Valid PNG header
      });
      const uploadRes = await worker.fetch(uploadReq, env);
      const media = (await uploadRes.json()) as { id: string; object_key: string };

      // 2. Alice creates post with media
      const createReq = new Request('http://localhost:3000/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
        body: JSON.stringify({ body: 'Post with media', media_ids: [media.id] }),
      });
      const createRes = await worker.fetch(createReq, env);
      const post = (await createRes.json()) as { id: string };

      // Only 1 user (Bob) likes the post (< 3 distinct users)
      const likeReq = new Request(`http://localhost:3000/api/posts/${post.id}/likes`, {
        method: 'POST',
        headers: { Cookie: bobSessionCookie },
      });
      await worker.fetch(likeReq, env);

      // Verify object exists in R2
      const r2ObjBefore = await env.MEDIA_BUCKET!.get(media.object_key);
      expect(r2ObjBefore).not.toBeNull();

      // Fast-forward 7 days + 1 minute
      const day7Ms = Date.now() + 7 * 24 * 60 * 60 * 1000 + 60 * 1000;
      const result = await runPostLifecycleExpiry(env, day7Ms);

      expect(result.deleted).toBe(1);
      expect(result.extended).toBe(0);

      // Verify post and media deleted from database
      const checkPost = await env.DB.prepare('SELECT id FROM posts WHERE id = ?').bind(post.id).first();
      expect(checkPost).toBeNull();

      const checkMedia = await env.DB.prepare('SELECT id FROM media WHERE id = ?').bind(media.id).first();
      expect(checkMedia).toBeNull();

      // CRITICAL: Verify R2 object is deleted
      const r2ObjAfter = await env.MEDIA_BUCKET!.get(media.object_key);
      expect(r2ObjAfter).toBeNull();
    });

    it('extends expires_at to day 14 when at least 3 distinct users liked or commented', async () => {
      const createReq = new Request('http://localhost:3000/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
        body: JSON.stringify({ body: 'Engaged post' }),
      });
      const createRes = await worker.fetch(createReq, env);
      const post = (await createRes.json()) as { id: string; created_at: string };

      // 3 distinct engagers: Bob (like), Charlie (like), Dave (comment)
      await worker.fetch(
        new Request(`http://localhost:3000/api/posts/${post.id}/likes`, {
          method: 'POST',
          headers: { Cookie: bobSessionCookie },
        }),
        env
      );

      await worker.fetch(
        new Request(`http://localhost:3000/api/posts/${post.id}/likes`, {
          method: 'POST',
          headers: { Cookie: charlieSessionCookie },
        }),
        env
      );

      await worker.fetch(
        new Request(`http://localhost:3000/api/posts/${post.id}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: daveSessionCookie },
          body: JSON.stringify({ body: 'Engaged comment from Dave' }),
        }),
        env
      );

      // Run expiry at day 7
      const day7Ms = Date.now() + 7 * 24 * 60 * 60 * 1000 + 60 * 1000;
      const result = await runPostLifecycleExpiry(env, day7Ms);

      expect(result.extended).toBe(1);
      expect(result.deleted).toBe(0);

      // Verify post expiry is extended to created_at + 14 days
      const updatedPost = await env.DB.prepare('SELECT expires_at FROM posts WHERE id = ?')
        .bind(post.id)
        .first<{ expires_at: string }>();

      const expectedDay14 = new Date(new Date(post.created_at).getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();
      expect(updatedPost?.expires_at).toBe(expectedDay14);
    });

    it('hard stop at day 14: deletes post even if it has 3+ distinct engagers', async () => {
      const createReq = new Request('http://localhost:3000/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
        body: JSON.stringify({ body: 'Post at day 14' }),
      });
      const createRes = await worker.fetch(createReq, env);
      const post = (await createRes.json()) as { id: string };

      // 3 distinct engagers
      await worker.fetch(new Request(`http://localhost:3000/api/posts/${post.id}/likes`, { method: 'POST', headers: { Cookie: bobSessionCookie } }), env);
      await worker.fetch(new Request(`http://localhost:3000/api/posts/${post.id}/likes`, { method: 'POST', headers: { Cookie: charlieSessionCookie } }), env);
      await worker.fetch(new Request(`http://localhost:3000/api/posts/${post.id}/likes`, { method: 'POST', headers: { Cookie: daveSessionCookie } }), env);

      // Extend at day 7
      const day7Ms = Date.now() + 7 * 24 * 60 * 60 * 1000 + 60 * 1000;
      await runPostLifecycleExpiry(env, day7Ms);

      // Fast forward to day 14 + 1 minute
      const day14Ms = Date.now() + 14 * 24 * 60 * 60 * 1000 + 60 * 1000;
      const day14Result = await runPostLifecycleExpiry(env, day14Ms);

      expect(day14Result.deleted).toBe(1);

      const checkPost = await env.DB.prepare('SELECT id FROM posts WHERE id = ?').bind(post.id).first();
      expect(checkPost).toBeNull();
    });
  });

  // 4. Cursor Pagination & Feed
  describe('Feed & Cursor Pagination', () => {
    it('returns chronological feed from followed users and own posts with cursor pagination', async () => {
      // Alice follows Bob
      await worker.fetch(
        new Request('http://localhost:3000/api/users/usr_bob/follow', {
          method: 'POST',
          headers: { Cookie: aliceSessionCookie },
        }),
        env
      );

      // Bob publishes 3 posts
      for (let i = 1; i <= 3; i++) {
        await worker.fetch(
          new Request('http://localhost:3000/api/posts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: bobSessionCookie },
            body: JSON.stringify({ body: `Bob post ${i}` }),
          }),
          env
        );
      }

      // Charlie publishes a post (Alice does NOT follow Charlie)
      await worker.fetch(
        new Request('http://localhost:3000/api/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: charlieSessionCookie },
          body: JSON.stringify({ body: 'Charlie unfollowed post' }),
        }),
        env
      );

      // Alice fetches feed with limit 2
      const feedReq = new Request('http://localhost:3000/api/feed?limit=2', {
        headers: { Cookie: aliceSessionCookie },
      });
      const feedRes = await worker.fetch(feedReq, env);
      expect(feedRes.status).toBe(200);

      const feedData = (await feedRes.json()) as { posts: any[]; has_more: boolean; next_cursor: string };
      expect(feedData.posts.length).toBe(2);
      expect(feedData.has_more).toBe(true);
      expect(feedData.next_cursor).toBeDefined();

      // Verify none of Charlie's posts are present
      expect(feedData.posts.every((p) => p.author_id !== 'usr_charlie')).toBe(true);

      // Page 2 using next_cursor
      const page2Req = new Request(`http://localhost:3000/api/feed?limit=2&cursor=${encodeURIComponent(feedData.next_cursor)}`, {
        headers: { Cookie: aliceSessionCookie },
      });
      const page2Res = await worker.fetch(page2Req, env);
      const page2Data = (await page2Res.json()) as { posts: any[]; has_more: boolean };
      expect(page2Data.posts.length).toBe(1);
      expect(page2Data.has_more).toBe(false);
    });
  });

  // 5. Media Upload Validation
  describe('Media Upload Validation', () => {
    it('rejects unsupported MIME types and files exceeding 5 MB', async () => {
      // 1. Reject invalid MIME type
      const textUpload = new Request('http://localhost:3000/api/media/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', Cookie: aliceSessionCookie },
        body: new TextEncoder().encode('not an image'),
      });
      const textRes = await worker.fetch(textUpload, env);
      expect(textRes.status).toBe(400);
      const textBody = (await textRes.json()) as { error: string };
      expect(textBody.error).toContain('Only JPEG, PNG, and WebP');

      // 2. Reject file exceeding 5 MB
      const bigFile = new Uint8Array(5 * 1024 * 1024 + 100);
      const bigUpload = new Request('http://localhost:3000/api/media/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg', Cookie: aliceSessionCookie },
        body: bigFile,
      });
      const bigRes = await worker.fetch(bigUpload, env);
      expect(bigRes.status).toBe(400);
      const bigBody = (await bigRes.json()) as { error: string };
      expect(bigBody.error).toContain('exceeds maximum size of 5 MB');
    });
  });

  // 6. Rate Limiting
  describe('Rate Limiting', () => {
    it('returns 429 when post rate limit is exceeded', async () => {
      // Limit is 10 posts per hour
      for (let i = 0; i < 10; i++) {
        const req = new Request('http://localhost:3000/api/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
          body: JSON.stringify({ body: `Post #${i}` }),
        });
        const res = await worker.fetch(req, env);
        expect(res.status).toBe(201);
      }

      // 11th post within the hour should be rate-limited
      const overflowReq = new Request('http://localhost:3000/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
        body: JSON.stringify({ body: 'Excess post' }),
      });
      const overflowRes = await worker.fetch(overflowReq, env);
      expect(overflowRes.status).toBe(429);
      const err = (await overflowRes.json()) as { error: string };
      expect(err.error).toContain('Rate limit exceeded');
    });
  });
});
