import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../worker/index.ts';
import { createSqliteD1 } from '../worker/db/sqlite-d1.ts';
import { createMemoryR2Bucket } from '../worker/db/r2-shim.ts';
import { runMigrations, ALL_MIGRATIONS } from '../worker/db/migrate.ts';
import { clearRateLimits } from '../worker/rate-limit.ts';
import { scoreCandidate, type CandidatePost, type UserRankingContext } from '../worker/ranking/engine.ts';
import { RANKING_CONFIG } from '../worker/ranking/config.ts';
import { extractTopicsFromText } from '../worker/content/topics.ts';
import type { Env } from '../worker/types.ts';
import type { PostItem } from '../shared/schema.ts';

const NOW = Date.UTC(2026, 9, 25, 12);
const post = (over: Partial<CandidatePost> = {}): CandidatePost => ({
  id: 'p1',
  author_id: 'a1',
  author_class_id: null,
  body: '',
  created_at: new Date(NOW - 3600_000).toISOString(),
  expires_at: new Date(NOW + 86400_000).toISOString(),
  status: 'active',
  topics: [],
  distinct_engagers: 0,
  impressions_count: 0,
  ...over,
});
const ctx = (over: Partial<UserRankingContext> = {}): UserRankingContext => ({
  userId: 'v',
  userClassId: null,
  followedUserIds: new Set(),
  notInterestedPostIds: new Set(),
  userTopicSignals: new Map(),
  nowMs: NOW,
  ...over,
});

describe('ranking weights', () => {
  it('sum to 1', () => {
    const total = Object.values(RANKING_CONFIG.WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });
});

describe('scoreCandidate: trend and seen', () => {
  it('lifts a post whose topic is trending', () => {
    const p = post({ topics: [{ slug: 'exam', confidence: 1 }] });
    const plain = scoreCandidate(p, ctx());
    const hot = scoreCandidate(p, ctx({ trendingTopics: new Map([['exam', 1]]) }));
    expect(hot.totalScore).toBeGreaterThan(plain.totalScore);
    expect(hot.scoreBreakdown.trend).toBe(1);
    expect(plain.scoreBreakdown.trend).toBe(0);
  });

  it('scales the trend lift by topic confidence', () => {
    const strong = scoreCandidate(post({ topics: [{ slug: 'x', confidence: 1 }] }), ctx({ trendingTopics: new Map([['x', 1]]) }));
    const weak = scoreCandidate(post({ topics: [{ slug: 'x', confidence: 0.5 }] }), ctx({ trendingTopics: new Map([['x', 1]]) }));
    expect(weak.scoreBreakdown.trend).toBe(0.5);
    expect(strong.totalScore).toBeGreaterThan(weak.totalScore);
  });

  it('sinks a post the viewer already saw, without removing it', () => {
    const fresh = scoreCandidate(post(), ctx());
    const seen = scoreCandidate(post(), ctx({ seenPostIds: new Set(['p1']) }));
    expect(seen.scoreBreakdown.seen).toBe(true);
    expect(seen.totalScore).toBeCloseTo(fresh.totalScore * RANKING_CONFIG.SEEN_MULTIPLIER, 10);
    expect(seen.totalScore).toBeGreaterThan(0);
  });
});

describe('extractTopicsFromText', () => {
  it('matches plurals and -ing forms', () => {
    const slugs = extractTopicsFromText('studying for exams with friends, hunting internships').map((t) => t.slug);
    expect(slugs).toEqual(expect.arrayContaining(['study', 'exam', 'internship']));
  });

  it('groups related words under a shared category topic', () => {
    const gym = extractTopicsFromText('leg day at the gym').map((t) => t.slug);
    const fit = extractTopicsFromText('new fitness routine').map((t) => t.slug);
    expect(gym).toContain('sports-fitness');
    expect(fit).toContain('sports-fitness');
  });

  it('adds one category topic per category, with lower confidence', () => {
    const topics = extractTopicsFromText('gym and fitness and sports');
    const cats = topics.filter((t) => t.slug === 'sports-fitness');
    expect(cats).toHaveLength(1);
    expect(cats[0]!.confidence).toBeLessThan(0.8);
  });

  it('keeps hashtags first at full confidence and never exceeds 5 word topics + 3 categories', () => {
    const topics = extractTopicsFromText('#a #b #c #d #e #f gym food music art tech code exam job');
    expect(topics.slice(0, 5).every((t) => t.confidence === 1)).toBe(true);
    expect(topics.length).toBeLessThanOrEqual(8);
  });

  it('does not invent topics for unrelated text', () => {
    expect(extractTopicsFromText('just a normal sentence')).toEqual([]);
  });
});

describe('For You learns (integration)', () => {
  let env: Env;
  let viewer = '';

  const seed = async (id: string, username: string) => {
    const now = new Date().toISOString();
    const expiry = new Date(Date.now() + 86400000).toISOString();
    await env.DB.prepare('INSERT INTO users (id, provider_subject, created_at, status) VALUES (?, ?, ?, ?)').bind(id, `sub_${id}`, now, 'active').run();
    await env.DB.prepare('INSERT INTO profiles (user_id, username, username_normalized, display_name, bio, class_id) VALUES (?, ?, ?, ?, ?, ?)').bind(id, username, username.toLowerCase(), username, 'bio', 'cls_2026').run();
    await env.DB.prepare('INSERT INTO user_settings (user_id, dm_policy) VALUES (?, ?)').bind(id, 'everyone').run();
    await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').bind(`sess_${id}`, id, expiry).run();
    return `session_id=sess_${id}`;
  };

  /** Inserts a post directly (skips the post rate limit) with the given topics. */
  const insertPost = async (id: string, authorId: string, body: string, ageMs: number, topics: string[] = []) => {
    const created = new Date(Date.now() - ageMs).toISOString();
    const expires = new Date(Date.now() + 5 * 86400000).toISOString();
    await env.DB.prepare('INSERT INTO posts (id, author_id, body, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?)').bind(id, authorId, body, created, expires, 'active').run();
    for (const slug of topics) {
      await env.DB.prepare('INSERT OR IGNORE INTO topics (id, slug, display_name) VALUES (?, ?, ?)').bind(`top_${slug}`, slug, slug).run();
      await env.DB.prepare('INSERT INTO post_topics (post_id, topic_id, confidence) VALUES (?, ?, 1.0)').bind(id, `top_${slug}`).run();
    }
  };

  const feed = async (cursor?: string): Promise<{ posts: PostItem[]; next_cursor: string | null }> => {
    const qs = new URLSearchParams({ mode: 'for_you', limit: '10' });
    if (cursor) qs.set('cursor', cursor);
    const res = await worker.fetch(new Request(`http://localhost:3000/api/feed?${qs}`, { headers: { Cookie: viewer } }), env);
    expect(res.status).toBe(200);
    return (await res.json()) as { posts: PostItem[]; next_cursor: string | null };
  };
  const allIds = async (): Promise<string[]> => {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 30; i++) {
      const page = await feed(cursor);
      ids.push(...page.posts.map((p) => p.id));
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    return ids;
  };
  const setSignal = (slug: string, weight: number, ageDays: number) =>
    env.DB.prepare('INSERT OR REPLACE INTO user_topic_signals (user_id, topic_id, weight, updated_at) VALUES (?, ?, ?, ?)')
      .bind('usr_viewer', `top_${slug}`, weight, new Date(Date.now() - ageDays * 86400000).toISOString())
      .run();

  beforeEach(async () => {
    clearRateLimits();
    const db = createSqliteD1(':memory:');
    await runMigrations(db, ALL_MIGRATIONS);
    env = {
      DB: db,
      MEDIA_BUCKET: createMemoryR2Bucket(),
      APP_URL: 'http://localhost:3000',
      GOOGLE_CLIENT_ID: 'test-google-client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
      ENVIRONMENT: 'development',
    };
    viewer = await seed('usr_viewer', 'viewer');
    await seed('usr_other', 'other');
  });

  it('finds a post on a topic you like even when 120 newer posts bury it', async () => {
    await insertPost('old-match', 'usr_other', 'my #cooking tips', 3 * 86400000, ['cooking']);
    for (let i = 0; i < 120; i++) await insertPost(`noise-${i}`, 'usr_other', `noise ${i}`, 60_000 + i * 1000, ['noise']);
    await env.DB.prepare('INSERT OR IGNORE INTO topics (id, slug, display_name) VALUES (?, ?, ?)').bind('top_cooking', 'cooking', 'cooking').run();
    await setSignal('cooking', 6, 0);
    const first = await feed();
    expect(first.posts.map((p) => p.id)).toContain('old-match');
  });

  it('without that interest the buried post is not in the first page', async () => {
    await insertPost('old-match', 'usr_other', 'my #cooking tips', 3 * 86400000, ['cooking']);
    for (let i = 0; i < 120; i++) await insertPost(`noise-${i}`, 'usr_other', `noise ${i}`, 60_000 + i * 1000, ['noise']);
    const first = await feed();
    expect(first.posts.map((p) => p.id)).not.toContain('old-match');
  });

  it('demotes a post after the viewer was shown it', async () => {
    await insertPost('a', 'usr_other', 'first', 10_000);
    await insertPost('b', 'usr_other', 'second', 20_000);
    const before = (await feed()).posts.map((p) => p.id);
    expect(before[0]).toBe('a'); // newer wins when nothing else differs
    const res = await worker.fetch(
      new Request('http://localhost:3000/api/impressions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: viewer },
        body: JSON.stringify({ impressions: [{ post_id: 'a', position: 0, duration_ms: 1500 }] }),
      }),
      env
    );
    expect(res.status).toBe(200);
    const after = (await feed()).posts.map((p) => p.id);
    expect(after).toEqual(['b', 'a']); // seen post sinks but is still there
  });

  it('boosts posts on a trending topic', async () => {
    await insertPost('plain', 'usr_other', 'plain', 10_000, ['misc']);
    await insertPost('hot', 'usr_other', 'hot', 5 * 3600_000, ['hot']);
    await env.DB.prepare('INSERT OR IGNORE INTO topics (id, slug, display_name) VALUES (?, ?, ?)').bind('top_misc', 'misc', 'misc').run();
    const before = (await feed()).posts.map((p) => p.id);
    expect(before[0]).toBe('plain');
    await env.DB.prepare('INSERT INTO trend_snapshots (id, topic_id, window, window_start, score) VALUES (?, ?, ?, ?, ?)')
      .bind('snap1', 'top_hot', '24h', new Date().toISOString(), 50)
      .run();
    const after = (await feed()).posts.map((p) => p.id);
    expect(after[0]).toBe('hot');
  });

  it('decays old interest before adding new interest', async () => {
    await insertPost('p1', 'usr_other', 'about #cooking', 10_000, ['cooking']);
    await setSignal('cooking', 4, 28); // two half-lives old: worth about 1 now
    const res = await worker.fetch(
      new Request('http://localhost:3000/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: viewer },
        body: JSON.stringify({ post_id: 'p1', type: 'more_like_this' }),
      }),
      env
    );
    expect(res.status).toBe(201);
    const row = await env.DB.prepare('SELECT weight FROM user_topic_signals WHERE user_id = ? AND topic_id = ?').bind('usr_viewer', 'top_cooking').first<{ weight: number }>();
    expect(row!.weight).toBeCloseTo(1 + 3, 1); // not 4 + 3 = 7
  });

  it('clamps a runaway signal', async () => {
    await insertPost('p1', 'usr_other', 'about #cooking', 10_000, ['cooking']);
    await setSignal('cooking', RANKING_CONFIG.SIGNAL_MAX, 0);
    await worker.fetch(
      new Request('http://localhost:3000/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: viewer },
        body: JSON.stringify({ post_id: 'p1', type: 'more_like_this' }),
      }),
      env
    );
    const row = await env.DB.prepare('SELECT weight FROM user_topic_signals WHERE user_id = ? AND topic_id = ?').bind('usr_viewer', 'top_cooking').first<{ weight: number }>();
    expect(row!.weight).toBeLessThanOrEqual(RANKING_CONFIG.SIGNAL_MAX);
  });

  it('still returns every post exactly once across pages, with the wider candidate pool', async () => {
    for (let i = 0; i < 25; i++) await insertPost(`n-${i}`, 'usr_other', `n ${i}`, 60_000 + i * 1000, ['noise']);
    await setSignal('noise', 5, 0);
    const ids = await allIds();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(25);
  });
});
