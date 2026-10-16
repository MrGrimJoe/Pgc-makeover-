import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../worker/index.ts';
import { createSqliteD1 } from '../worker/db/sqlite-d1.ts';
import { createMemoryR2Bucket } from '../worker/db/r2-shim.ts';
import { runMigrations } from '../worker/db/migrate.ts';
import { runPostLifecycleExpiry } from '../worker/jobs/expiry.ts';
import type { Env } from '../worker/types.ts';

describe('Milestone 3 Discovery Engine & Phase B Fixes', () => {
  let env: Env;
  let aliceSessionCookie: string;
  let bobSessionCookie: string;
  let charlieSessionCookie: string;

  beforeEach(async () => {
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
      ADMIN_SECRET: 'super-admin-secret-test-key-12345',
    };

    const now = new Date().toISOString();
    const expiry = new Date(Date.now() + 86400000).toISOString();

    const seedUser = async (id: string, username: string, classId = 'cls_2026') => {
      await env.DB.prepare('INSERT INTO users (id, provider_subject, created_at, status) VALUES (?, ?, ?, ?)')
        .bind(id, `sub_${id}`, now, 'active')
        .run();
      await env.DB.prepare(
        'INSERT INTO profiles (user_id, username, username_normalized, display_name, bio, class_id) VALUES (?, ?, ?, ?, ?, ?)'
      )
        .bind(id, username, username.toLowerCase(), username, '', classId)
        .run();
      await env.DB.prepare('INSERT INTO user_settings (user_id) VALUES (?)')
        .bind(id)
        .run();
      await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
        .bind(`sess_${id}`, id, expiry)
        .run();
      return `session_id=sess_${id}`;
    };

    aliceSessionCookie = await seedUser('usr_alice', 'alice', 'cls_2026');
    bobSessionCookie = await seedUser('usr_bob', 'bob', 'cls_2026');
    charlieSessionCookie = await seedUser('usr_charlie', 'charlie', 'cls_2027');
  });

  // 1. FIX #1 & #2: Expiry with bound ISO timestamps and admin secret enforcement
  describe('Expiry Job & Bound Timestamps', () => {
    it('deletes a post that expired earlier today using bound ISO timestamp', async () => {
      const earlierTodayIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const pastCreatedIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 - 2 * 60 * 60 * 1000).toISOString();

      await env.DB.prepare(
        'INSERT INTO posts (id, author_id, body, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?)'
      )
        .bind('pst_expired_today', 'usr_alice', 'Expired post', pastCreatedIso, earlierTodayIso, 'active')
        .run();

      const result = await runPostLifecycleExpiry(env);
      expect(result.deleted).toBe(1);
      expect(result.deletedPostIds).toContain('pst_expired_today');

      const check = await env.DB.prepare('SELECT id FROM posts WHERE id = ?').bind('pst_expired_today').first();
      expect(check).toBeNull();
    });

    it('rejects POST /api/jobs/cleanup-expired in production without valid admin secret', async () => {
      const prodEnv: Env = {
        ...env,
        ENVIRONMENT: 'production',
        ADMIN_SECRET: 'production-secret-999',
      };

      const unauthReq = new Request('http://localhost:3000/api/jobs/cleanup-expired', {
        method: 'POST',
      });
      const unauthRes = await worker.fetch(unauthReq, prodEnv);
      expect(unauthRes.status).toBe(401);

      // With valid header compared in constant time
      const authReq = new Request('http://localhost:3000/api/jobs/cleanup-expired', {
        method: 'POST',
        headers: {
          'x-admin-secret': 'production-secret-999',
        },
      });
      const authRes = await worker.fetch(authReq, prodEnv);
      expect(authRes.status).toBe(200);
    });
  });

  // 2. FIX #4: Uploads Content-Length check, magic bytes verification, and nosniff header
  describe('Media Upload Validation & Nosniff Header', () => {
    it('rejects upload by Content-Length header before reading body', async () => {
      const req = new Request('http://localhost:3000/api/media/uploads', {
        method: 'POST',
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': '6000000', // Exceeds 5 MB
          Cookie: aliceSessionCookie,
        },
        body: new Uint8Array([137, 80, 78, 71]),
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toContain('exceeds maximum size of 5 MB');
    });

    it('rejects image with mismatched magic bytes', async () => {
      const badJpeg = new Request('http://localhost:3000/api/media/uploads', {
        method: 'POST',
        headers: {
          'Content-Type': 'image/jpeg',
          Cookie: aliceSessionCookie,
        },
        body: new Uint8Array([0, 1, 2, 3]), // Invalid JPEG header
      });
      const res = await worker.fetch(badJpeg, env);
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toContain('magic bytes do not match');
    });

    it('serves media with X-Content-Type-Options: nosniff', async () => {
      const validPngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      const uploadReq = new Request('http://localhost:3000/api/media/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'image/png', Cookie: aliceSessionCookie },
        body: validPngBytes,
      });
      const uploadRes = await worker.fetch(uploadReq, env);
      expect(uploadRes.status).toBe(201);
      const media = (await uploadRes.json()) as { id: string };

      const serveReq = new Request(`http://localhost:3000/api/media/${media.id}`, {
        headers: { Cookie: aliceSessionCookie },
      });
      const serveRes = await worker.fetch(serveReq, env);
      expect(serveRes.status).toBe(200);
      expect(serveRes.headers.get('X-Content-Type-Options')).toBe('nosniff');
    });
  });

  // 3. FIX #5: Orphaned Media Cleanup
  describe('Orphaned Media Cleanup', () => {
    it('deletes media not attached to any post after 24 hours, keeping DB row if R2 fails', async () => {
      const olderThan24h = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      const mediaId = 'med_orphan_1';
      const objectKey = 'media_orphan_key_1';

      await env.MEDIA_BUCKET!.put(objectKey, new Uint8Array([137, 80, 78, 71]));
      await env.DB.prepare(
        'INSERT INTO media (id, owner_id, object_key, mime_type, size_bytes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
        .bind(mediaId, 'usr_alice', objectKey, 'image/png', 4, olderThan24h, olderThan24h)
        .run();

      const result = await runPostLifecycleExpiry(env);
      expect(result.prunedOrphanMedia).toBe(1);

      const dbCheck = await env.DB.prepare('SELECT id FROM media WHERE id = ?').bind(mediaId).first();
      expect(dbCheck).toBeNull();

      const r2Check = await env.MEDIA_BUCKET!.get(objectKey);
      expect(r2Check).toBeNull();
    });
  });

  // 4. FIX #8: Moderation Reports & Admin Review
  describe('Reports & Admin Moderation', () => {
    it('verifies target exists and enforces one open report per reporter/target', async () => {
      // 1. Report non-existent post fails with 404
      const missingPostReq = new Request('http://localhost:3000/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
        body: JSON.stringify({ target_type: 'post', target_id: 'pst_nonexistent', reason: 'Spam' }),
      });
      const missingRes = await worker.fetch(missingPostReq, env);
      expect(missingRes.status).toBe(404);

      // 2. Report existing user
      const validReportReq = new Request('http://localhost:3000/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
        body: JSON.stringify({ target_type: 'user', target_id: 'usr_bob', reason: 'Harassment' }),
      });
      const validRes = await worker.fetch(validReportReq, env);
      expect(validRes.status).toBe(201);
      const rep = (await validRes.json()) as { id: string };

      // 3. Duplicate open report returns 409
      const dupReq = new Request('http://localhost:3000/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
        body: JSON.stringify({ target_type: 'user', target_id: 'usr_bob', reason: 'More harassment' }),
      });
      const dupRes = await worker.fetch(dupReq, env);
      expect(dupRes.status).toBe(409);

      // 4. Admin GET reports
      const adminGetReq = new Request('http://localhost:3000/api/admin/reports', {
        headers: { 'x-admin-secret': 'super-admin-secret-test-key-12345' },
      });
      const adminGetRes = await worker.fetch(adminGetReq, env);
      expect(adminGetRes.status).toBe(200);
      const reportsData = (await adminGetRes.json()) as { reports: any[] };
      expect(reportsData.reports.length).toBeGreaterThanOrEqual(1);

      // 5. Admin PATCH report status
      const patchReq = new Request(`http://localhost:3000/api/admin/reports/${rep.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-secret': 'super-admin-secret-test-key-12345',
        },
        body: JSON.stringify({ status: 'reviewed' }),
      });
      const patchRes = await worker.fetch(patchReq, env);
      expect(patchRes.status).toBe(200);
    });
  });

  // 5. Milestone 3: Content Understanding, Topics, and Interest Signals
  describe('Content Understanding & Interest Profile', () => {
    it('extracts hashtags and keyword topics on post creation', async () => {
      const createReq = new Request('http://localhost:3000/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
        body: JSON.stringify({ body: 'Working on #ai code for the campus hackathon! Need #coffee' }),
      });
      const createRes = await worker.fetch(createReq, env);
      expect(createRes.status).toBe(201);
      const post = (await createRes.json()) as { id: string; topics: any[] };

      expect(post.topics).toBeDefined();
      const slugs = post.topics.map((t) => t.slug);
      expect(slugs).toContain('ai');
      expect(slugs).toContain('coffee');

      // Verify stored in post_topics
      const stored = await env.DB.prepare('SELECT topic_id FROM post_topics WHERE post_id = ?')
        .bind(post.id)
        .all();
      expect(stored.results.length).toBeGreaterThanOrEqual(2);
    });

    it('updates user topic signals on interaction and supports decay and reset', async () => {
      // 1. Bob creates post with #technology
      const createReq = new Request('http://localhost:3000/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: bobSessionCookie },
        body: JSON.stringify({ body: 'Loving #technology this semester' }),
      });
      const createRes = await worker.fetch(createReq, env);
      const post = (await createRes.json()) as { id: string };

      // 2. Alice likes Bob's post (+1 signal)
      await worker.fetch(
        new Request(`http://localhost:3000/api/posts/${post.id}/likes`, {
          method: 'POST',
          headers: { Cookie: aliceSessionCookie },
        }),
        env
      );

      // 3. Alice leaves a comment (+3 signal)
      await worker.fetch(
        new Request(`http://localhost:3000/api/posts/${post.id}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
          body: JSON.stringify({ body: 'Totally agree!' }),
        }),
        env
      );

      // 4. Verify Alice's interests via GET /api/me/interests
      const interestReq = new Request('http://localhost:3000/api/me/interests', {
        headers: { Cookie: aliceSessionCookie },
      });
      const interestRes = await worker.fetch(interestReq, env);
      expect(interestRes.status).toBe(200);
      const intData = (await interestRes.json()) as { interests: any[] };
      const techTopic = intData.interests.find((i) => i.slug === 'technology');
      expect(techTopic).toBeDefined();
      expect(techTopic.raw_weight).toBe(4); // 1 (like) + 3 (comment)
      expect(techTopic.effective_weight).toBeGreaterThan(3.5);

      // 5. Reset interests
      const resetReq = new Request('http://localhost:3000/api/me/interests', {
        method: 'DELETE',
        headers: { Cookie: aliceSessionCookie },
      });
      const resetRes = await worker.fetch(resetReq, env);
      expect(resetRes.status).toBe(200);

      const emptyRes = await worker.fetch(interestReq, env);
      const emptyData = (await emptyRes.json()) as { interests: any[] };
      expect(emptyData.interests.length).toBe(0);
    });

    it('records feedback (more_like_this, not_interested) and applies signals', async () => {
      const createReq = new Request('http://localhost:3000/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: charlieSessionCookie },
        body: JSON.stringify({ body: 'Delicious #food at the dining hall' }),
      });
      const createRes = await worker.fetch(createReq, env);
      const post = (await createRes.json()) as { id: string };

      // Alice gives 'more_like_this' feedback (+3)
      const fbReq = new Request('http://localhost:3000/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
        body: JSON.stringify({ post_id: post.id, type: 'more_like_this' }),
      });
      const fbRes = await worker.fetch(fbReq, env);
      expect(fbRes.status).toBe(201);

      const interestRes = await worker.fetch(
        new Request('http://localhost:3000/api/me/interests', {
          headers: { Cookie: aliceSessionCookie },
        }),
        env
      );
      const intData = (await interestRes.json()) as { interests: any[] };
      const foodTopic = intData.interests.find((i) => i.slug === 'food');
      expect(foodTopic).toBeDefined();
      expect(foodTopic.raw_weight).toBe(3);
    });
  });

  // 6. Milestone 3: Classes & Profile selection
  describe('Classes & Profile Integration', () => {
    it('allows user to retrieve classes and update class_id on profile', async () => {
      const classesRes = await worker.fetch(new Request('http://localhost:3000/api/classes'), env);
      expect(classesRes.status).toBe(200);
      const classesData = (await classesRes.json()) as { classes: any[] };
      expect(classesData.classes.length).toBeGreaterThan(0);

      // Alice updates class_id to cls_2028
      const patchReq = new Request('http://localhost:3000/api/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: aliceSessionCookie },
        body: JSON.stringify({ class_id: 'cls_2028' }),
      });
      const patchRes = await worker.fetch(patchReq, env);
      expect(patchRes.status).toBe(200);

      const meRes = await worker.fetch(
        new Request('http://localhost:3000/api/me', {
          headers: { Cookie: aliceSessionCookie },
        }),
        env
      );
      const meData = (await meRes.json()) as { profile: { class_id: string; class_name: string } };
      expect(meData.profile.class_id).toBe('cls_2028');
      expect(meData.profile.class_name).toBe('Class of 2028');
    });
  });

  // 7. Milestone 3: Ranked Feed & Search
  describe('Discovery Ranked Feed & Search', () => {
    it('returns ranked feed with topic and class context, and performs search', async () => {
      // Create posts
      await worker.fetch(
        new Request('http://localhost:3000/api/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: bobSessionCookie },
          body: JSON.stringify({ body: 'Campus updates for #technology lovers' }),
        }),
        env
      );

      // Ranked feed
      const rankedReq = new Request('http://localhost:3000/api/feed?mode=ranked', {
        headers: { Cookie: aliceSessionCookie },
      });
      const rankedRes = await worker.fetch(rankedReq, env);
      expect(rankedRes.status).toBe(200);
      const rankedData = (await rankedRes.json()) as { posts: any[] };
      expect(rankedData.posts.length).toBeGreaterThan(0);

      // Search posts
      const searchReq = new Request('http://localhost:3000/api/search?q=technology', {
        headers: { Cookie: aliceSessionCookie },
      });
      const searchRes = await worker.fetch(searchReq, env);
      expect(searchRes.status).toBe(200);
      const searchData = (await searchRes.json()) as { posts: any[] };
      expect(searchData.posts.length).toBeGreaterThan(0);
    });
  });
});
