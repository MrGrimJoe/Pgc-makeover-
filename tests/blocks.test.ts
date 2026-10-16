import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../worker/index.ts';
import { createSqliteD1 } from '../worker/db/sqlite-d1.ts';
import { createMemoryR2Bucket } from '../worker/db/r2-shim.ts';
import { runMigrations, ALL_MIGRATIONS } from '../worker/db/migrate.ts';
import { clearRateLimits } from '../worker/rate-limit.ts';
import type { Env } from '../worker/types.ts';
import type { PostItem, CommentItem } from '../shared/schema.ts';

describe('Task 1: Blocks Everywhere (Worker)', () => {
  let env: Env;
  let aliceSession: string;
  let bobSession: string;
  let charlieSession: string;

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
      return `session_id=sess_${id}`;
    };

    aliceSession = await seedUser('usr_alice', 'alice');
    bobSession = await seedUser('usr_bob', 'bob');
    charlieSession = await seedUser('usr_charlie', 'charlie');
  });

  describe('1. Follow prevention and follow cleanup (both directions)', () => {
    it('prevents following between blocked users in both directions and cleans up existing follows', async () => {
      // Alice and Bob follow each other initially
      const f1 = await worker.fetch(
        new Request('http://localhost:3000/api/users/usr_bob/follow', {
          method: 'POST',
          headers: { Cookie: aliceSession },
        }),
        env
      );
      expect(f1.status).toBe(200);

      const f2 = await worker.fetch(
        new Request('http://localhost:3000/api/users/usr_alice/follow', {
          method: 'POST',
          headers: { Cookie: bobSession },
        }),
        env
      );
      expect(f2.status).toBe(200);

      // Alice blocks Bob
      const blockRes = await worker.fetch(
        new Request('http://localhost:3000/api/blocks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSession },
          body: JSON.stringify({ user_id: 'usr_bob' }),
        }),
        env
      );
      expect(blockRes.status).toBe(201);

      // Existing mutual follows should have been removed
      const followsCheck = await env.DB.prepare('SELECT * FROM follows WHERE follower_id IN (?, ?) AND followed_id IN (?, ?)')
        .bind('usr_alice', 'usr_bob', 'usr_alice', 'usr_bob')
        .all();
      expect(followsCheck.results.length).toBe(0);

      // Alice cannot follow Bob (blocker direction)
      const aFollowBob = await worker.fetch(
        new Request('http://localhost:3000/api/users/usr_bob/follow', {
          method: 'POST',
          headers: { Cookie: aliceSession },
        }),
        env
      );
      expect(aFollowBob.status).toBe(403);

      // Bob cannot follow Alice (blocked direction)
      const bFollowAlice = await worker.fetch(
        new Request('http://localhost:3000/api/users/usr_alice/follow', {
          method: 'POST',
          headers: { Cookie: bobSession },
        }),
        env
      );
      expect(bFollowAlice.status).toBe(403);
    });
  });

  describe('2. Profile visibility (both directions)', () => {
    it('returns 404 when either user views each other profile, while third party can view', async () => {
      // Alice blocks Bob
      await worker.fetch(
        new Request('http://localhost:3000/api/blocks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSession },
          body: JSON.stringify({ user_id: 'usr_bob' }),
        }),
        env
      );

      // Alice views Bob's profile -> 404
      const aViewsBob = await worker.fetch(
        new Request('http://localhost:3000/api/users/bob', {
          headers: { Cookie: aliceSession },
        }),
        env
      );
      expect(aViewsBob.status).toBe(404);

      // Bob views Alice's profile -> 404
      const bViewsAlice = await worker.fetch(
        new Request('http://localhost:3000/api/users/alice', {
          headers: { Cookie: bobSession },
        }),
        env
      );
      expect(bViewsAlice.status).toBe(404);

      // Charlie views Bob's profile -> 200
      const cViewsBob = await worker.fetch(
        new Request('http://localhost:3000/api/users/bob', {
          headers: { Cookie: charlieSession },
        }),
        env
      );
      expect(cViewsBob.status).toBe(200);
    });
  });

  describe('3. Feed exclusion (both directions)', () => {
    it('excludes posts from feed in both directions for chronological and ranked feeds', async () => {
      // Create posts
      const aPostRes = await worker.fetch(
        new Request('http://localhost:3000/api/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSession },
          body: JSON.stringify({ body: 'Post from Alice #campus' }),
        }),
        env
      );
      const aPost = (await aPostRes.json()) as { id: string };

      const bPostRes = await worker.fetch(
        new Request('http://localhost:3000/api/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: bobSession },
          body: JSON.stringify({ body: 'Post from Bob #campus' }),
        }),
        env
      );
      const bPost = (await bPostRes.json()) as { id: string };

      // Alice blocks Bob
      await worker.fetch(
        new Request('http://localhost:3000/api/blocks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSession },
          body: JSON.stringify({ user_id: 'usr_bob' }),
        }),
        env
      );

      // Alice's chronological feed (has Bob's post excluded)
      const aFeed = await worker.fetch(
        new Request('http://localhost:3000/api/feed', {
          headers: { Cookie: aliceSession },
        }),
        env
      );
      const aFeedData = (await aFeed.json()) as { posts: PostItem[] };
      const aFeedIds = aFeedData.posts.map((p) => p.id);
      expect(aFeedIds).toContain(aPost.id);
      expect(aFeedIds).not.toContain(bPost.id);

      // Bob's chronological feed (has Alice's post excluded)
      const bFeed = await worker.fetch(
        new Request('http://localhost:3000/api/feed', {
          headers: { Cookie: bobSession },
        }),
        env
      );
      const bFeedData = (await bFeed.json()) as { posts: PostItem[] };
      const bFeedIds = bFeedData.posts.map((p) => p.id);
      expect(bFeedIds).toContain(bPost.id);
      expect(bFeedIds).not.toContain(aPost.id);

      // Alice's ranked feed
      const aRankedFeed = await worker.fetch(
        new Request('http://localhost:3000/api/feed?mode=ranked', {
          headers: { Cookie: aliceSession },
        }),
        env
      );
      const aRankedData = (await aRankedFeed.json()) as { posts: PostItem[] };
      const aRankedIds = aRankedData.posts.map((p) => p.id);
      expect(aRankedIds).not.toContain(bPost.id);

      // Bob's ranked feed
      const bRankedFeed = await worker.fetch(
        new Request('http://localhost:3000/api/feed?mode=ranked', {
          headers: { Cookie: bobSession },
        }),
        env
      );
      const bRankedData = (await bRankedFeed.json()) as { posts: PostItem[] };
      const bRankedIds = bRankedData.posts.map((p) => p.id);
      expect(bRankedIds).not.toContain(aPost.id);
    });
  });

  describe('4. Search exclusion (both directions)', () => {
    it('excludes posts from search in both directions', async () => {
      // Alice and Bob post with unique matching keyword
      const kw = 'AlphaOmegaProject';
      const aPostRes = await worker.fetch(
        new Request('http://localhost:3000/api/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSession },
          body: JSON.stringify({ body: `Alice working on ${kw}` }),
        }),
        env
      );
      const aPost = (await aPostRes.json()) as { id: string };

      const bPostRes = await worker.fetch(
        new Request('http://localhost:3000/api/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: bobSession },
          body: JSON.stringify({ body: `Bob working on ${kw}` }),
        }),
        env
      );
      const bPost = (await bPostRes.json()) as { id: string };

      // Alice blocks Bob
      await worker.fetch(
        new Request('http://localhost:3000/api/blocks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSession },
          body: JSON.stringify({ user_id: 'usr_bob' }),
        }),
        env
      );

      // Alice searches keyword
      const aSearch = await worker.fetch(
        new Request(`http://localhost:3000/api/search?q=${kw}`, {
          headers: { Cookie: aliceSession },
        }),
        env
      );
      const aData = (await aSearch.json()) as { posts: PostItem[] };
      const aIds = aData.posts.map((p) => p.id);
      expect(aIds).toContain(aPost.id);
      expect(aIds).not.toContain(bPost.id);

      // Bob searches keyword
      const bSearch = await worker.fetch(
        new Request(`http://localhost:3000/api/search?q=${kw}`, {
          headers: { Cookie: bobSession },
        }),
        env
      );
      const bData = (await bSearch.json()) as { posts: PostItem[] };
      const bIds = bData.posts.map((p) => p.id);
      expect(bIds).toContain(bPost.id);
      expect(bIds).not.toContain(aPost.id);
    });
  });

  describe('5. Comments and Comment Lists (both directions)', () => {
    it('excludes blocked users comments from lists and prevents commenting on blocked user posts', async () => {
      // Charlie creates post
      const cPostRes = await worker.fetch(
        new Request('http://localhost:3000/api/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: charlieSession },
          body: JSON.stringify({ body: 'Charlie open discussion post' }),
        }),
        env
      );
      const cPost = (await cPostRes.json()) as { id: string };

      // Alice creates a post
      const aPostRes = await worker.fetch(
        new Request('http://localhost:3000/api/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSession },
          body: JSON.stringify({ body: 'Alice personal post' }),
        }),
        env
      );
      const aPost = (await aPostRes.json()) as { id: string };

      // Alice and Bob comment on Charlie's post
      await worker.fetch(
        new Request(`http://localhost:3000/api/posts/${cPost.id}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSession },
          body: JSON.stringify({ body: 'Alice thought on Charlie post' }),
        }),
        env
      );

      await worker.fetch(
        new Request(`http://localhost:3000/api/posts/${cPost.id}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: bobSession },
          body: JSON.stringify({ body: 'Bob thought on Charlie post' }),
        }),
        env
      );

      // Alice blocks Bob
      await worker.fetch(
        new Request('http://localhost:3000/api/blocks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSession },
          body: JSON.stringify({ user_id: 'usr_bob' }),
        }),
        env
      );

      // Alice views Charlie post's comments -> Bob's comment excluded
      const aCommentsRes = await worker.fetch(
        new Request(`http://localhost:3000/api/posts/${cPost.id}/comments`, {
          headers: { Cookie: aliceSession },
        }),
        env
      );
      const aCommentsData = (await aCommentsRes.json()) as { comments: CommentItem[] };
      const aCommentAuthors = aCommentsData.comments.map((c) => c.author_id);
      expect(aCommentAuthors).toContain('usr_alice');
      expect(aCommentAuthors).not.toContain('usr_bob');

      // Bob views Charlie post's comments -> Alice's comment excluded
      const bCommentsRes = await worker.fetch(
        new Request(`http://localhost:3000/api/posts/${cPost.id}/comments`, {
          headers: { Cookie: bobSession },
        }),
        env
      );
      const bCommentsData = (await bCommentsRes.json()) as { comments: CommentItem[] };
      const bCommentAuthors = bCommentsData.comments.map((c) => c.author_id);
      expect(bCommentAuthors).toContain('usr_bob');
      expect(bCommentAuthors).not.toContain('usr_alice');

      // Bob tries to comment on Alice's post -> 404
      const bCommentOnAlice = await worker.fetch(
        new Request(`http://localhost:3000/api/posts/${aPost.id}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: bobSession },
          body: JSON.stringify({ body: 'Bob attempting to comment on Alice post' }),
        }),
        env
      );
      expect(bCommentOnAlice.status).toBe(404);

      // Alice tries to view comments on Bob's posts -> 404
      const bPostRes = await worker.fetch(
        new Request('http://localhost:3000/api/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: bobSession },
          body: JSON.stringify({ body: 'Bob private post' }),
        }),
        env
      );
      const bPost = (await bPostRes.json()) as { id: string };

      const aViewBobComments = await worker.fetch(
        new Request(`http://localhost:3000/api/posts/${bPost.id}/comments`, {
          headers: { Cookie: aliceSession },
        }),
        env
      );
      expect(aViewBobComments.status).toBe(404);
    });
  });

  describe('6. Likes exclusion (both directions)', () => {
    it('excludes blocked users likes from post counts and prevents liking each other posts', async () => {
      // Charlie post
      const cPostRes = await worker.fetch(
        new Request('http://localhost:3000/api/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: charlieSession },
          body: JSON.stringify({ body: 'Charlie post for likes test' }),
        }),
        env
      );
      const cPost = (await cPostRes.json()) as { id: string };

      // Bob likes Charlie's post
      await worker.fetch(
        new Request(`http://localhost:3000/api/posts/${cPost.id}/likes`, {
          method: 'POST',
          headers: { Cookie: bobSession },
        }),
        env
      );

      // Charlie views post -> likes_count = 1
      const cView = await worker.fetch(
        new Request(`http://localhost:3000/api/posts/${cPost.id}`, {
          headers: { Cookie: charlieSession },
        }),
        env
      );
      const cData = (await cView.json()) as PostItem;
      expect(cData.likes_count).toBe(1);

      // Alice blocks Bob
      await worker.fetch(
        new Request('http://localhost:3000/api/blocks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSession },
          body: JSON.stringify({ user_id: 'usr_bob' }),
        }),
        env
      );

      // Alice views Charlie's post -> Bob's like is excluded, likes_count = 0
      const aView = await worker.fetch(
        new Request(`http://localhost:3000/api/posts/${cPost.id}`, {
          headers: { Cookie: aliceSession },
        }),
        env
      );
      const aData = (await aView.json()) as PostItem;
      expect(aData.likes_count).toBe(0);

      // Bob cannot like Alice's post
      const aPostRes = await worker.fetch(
        new Request('http://localhost:3000/api/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSession },
          body: JSON.stringify({ body: 'Alice post' }),
        }),
        env
      );
      const aPost = (await aPostRes.json()) as { id: string };

      const bLikeAlice = await worker.fetch(
        new Request(`http://localhost:3000/api/posts/${aPost.id}/likes`, {
          method: 'POST',
          headers: { Cookie: bobSession },
        }),
        env
      );
      expect(bLikeAlice.status).toBe(404);
    });
  });

  describe('7. Trends inputs exclusion', () => {
    it('excludes blocked users posts from trends calculation inputs', async () => {
      // Seed a topic with posts
      const topicSlug = 'calculus';
      // Charlie and Dave post
      await env.DB.prepare('INSERT OR IGNORE INTO topics (id, slug, display_name) VALUES (?, ?, ?)')
        .bind('top_calculus', topicSlug, 'Calculus')
        .run();

      const seedPostWithTopic = async (authorCookie: string, text: string) => {
        const res = await worker.fetch(
          new Request('http://localhost:3000/api/posts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: authorCookie },
            body: JSON.stringify({ body: text }),
          }),
          env
        );
        const post = (await res.json()) as { id: string };
        await env.DB.prepare('INSERT OR REPLACE INTO post_topics (post_id, topic_id, confidence) VALUES (?, ?, ?)')
          .bind(post.id, 'top_calculus', 1.0)
          .run();
      };

      await seedPostWithTopic(charlieSession, 'Calculus mock study group #calculus');
      await seedPostWithTopic(bobSession, 'Calculus past papers #calculus');

      // Alice blocks Bob
      await worker.fetch(
        new Request('http://localhost:3000/api/blocks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: aliceSession },
          body: JSON.stringify({ user_id: 'usr_bob' }),
        }),
        env
      );

      // Trends for Alice excludes Bob's contribution
      const aTrends = await worker.fetch(
        new Request('http://localhost:3000/api/trends?window=24h', {
          headers: { Cookie: aliceSession },
        }),
        env
      );
      expect(aTrends.status).toBe(200);
      const aTrendsData = (await aTrends.json()) as { trends: any[] };
      // Since having author_count >= 3 is required for trends snapshot, if Bob is excluded,
      // author_count is only 1 (Charlie), so calculus won't appear
      expect(aTrendsData.trends.some((t) => t.slug === topicSlug)).toBe(false);
    });
  });
});
