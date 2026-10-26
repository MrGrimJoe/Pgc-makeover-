import { describe, it, expect } from 'vitest';
import { scoreSafety, WILD_THRESHOLD } from '../worker/feed-pipeline/safety.ts';
import { engagementVelocity, trendingScore } from '../worker/feed-pipeline/trending.ts';
import {
  buildBatchResponse,
  decodePipelineCursor,
  encodePipelineCursor,
  tagPosts,
} from '../worker/feed-pipeline/packager.ts';
import { clampBatchSize, isFeedBatchResponse, parsePipelineMode } from '../shared/feed-pipeline.ts';
import type { PostItem } from '../shared/schema.ts';

const NOW = Date.parse('2026-10-25T12:00:00.000Z');

const post = (id: string, over: Partial<PostItem> = {}): PostItem => ({
  id,
  author_id: 'a1',
  author_username: 'ali',
  author_display_name: 'Ali',
  author_avatar_media_id: null,
  body: `body of ${id}`,
  created_at: '2026-10-25T11:00:00.000Z',
  expires_at: '2026-11-08T11:00:00.000Z',
  status: 'active',
  media: [],
  likes_count: 0,
  has_liked: false,
  comments_count: 0,
  ...over,
});

describe('safety score', () => {
  it('a clean post is SAFE with a perfect score', () => {
    expect(scoreSafety({ reporters: 0, spamScore: 0 })).toEqual({ safetyScore: 1, isWild: false });
  });

  it('one reporter is not enough, two are', () => {
    expect(scoreSafety({ reporters: 1, spamScore: 0 }).isWild).toBe(false);
    expect(scoreSafety({ reporters: 2, spamScore: 0 }).isWild).toBe(true);
  });

  it('a post at the spam threshold (3 points) is WILD, one link (1 point) is not', () => {
    expect(scoreSafety({ reporters: 0, spamScore: 1 }).isWild).toBe(false);
    expect(scoreSafety({ reporters: 0, spamScore: 3 }).isWild).toBe(true);
  });

  it('is clamped to 0..1 and never goes below the WILD line by accident', () => {
    const worst = scoreSafety({ reporters: 99, spamScore: 99 });
    expect(worst.safetyScore).toBeGreaterThanOrEqual(0);
    expect(worst.safetyScore).toBeLessThan(WILD_THRESHOLD);
    expect(scoreSafety({ reporters: -5, spamScore: -5 }).safetyScore).toBe(1);
  });
});

describe('trending score', () => {
  it('no engagement and no hot topics scores 0', () => {
    expect(trendingScore([], new Map(), 0, 0, 3_600_000)).toBe(0);
  });

  it('a hot topic raises it, and a fast-liked fresh post beats a slow old one', () => {
    const hot = new Map([['exams', 1]]);
    expect(trendingScore(['exams'], hot, 0, 0, 0)).toBe(0.5);
    const fresh = engagementVelocity(10, 3, 3_600_000);
    const old = engagementVelocity(10, 3, 5 * 24 * 3_600_000);
    expect(fresh).toBeGreaterThan(old);
    expect(fresh).toBeLessThanOrEqual(1);
  });

  it('stays within 0..1 for absurd input', () => {
    const s = trendingScore(['x'], new Map([['x', 50]]), 1e9, 1e9, -1000);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});

describe('cursor', () => {
  it('round-trips a normal post id', () => {
    const c = encodePipelineCursor('2026-10-25T11:00:00.000Z', 'pst_a1-B2');
    expect(decodePipelineCursor(c)).toEqual({ createdAt: '2026-10-25T11:00:00.000Z', id: 'pst_a1-B2' });
  });

  it.each(["x' OR '1'='1", 'a b', 'é', 'a/b', 'a'.repeat(101)])('refuses an id that is not plain ASCII: %s', (id) => {
    expect(decodePipelineCursor(encodePipelineCursor('2026-10-25T11:00:00.000Z', id))).toBeNull();
  });

  it.each(['', '!!!', 'bm9wZQ', encodePipelineCursor('not-a-date', 'x'), 'a'.repeat(300)])('rejects %s', (bad) => {
    expect(decodePipelineCursor(bad)).toBeNull();
  });
});

describe('tagPosts', () => {
  const ctx = { nowMs: NOW, reporters: new Map([['p2', 2]]), topicTrends: new Map([['exams', 1]]) };

  it('adds moderation and meta, keeps order, drops _debug', () => {
    const tagged = tagPosts(
      [
        post('p1', { likes_count: 4, topics: [{ id: 't', slug: 'Exams', display_name: 'Exams', confidence: 1 }] }),
        post('p2'),
        post('p3', { body: 'FREE MONEY click here www.a.xyz www.b.xyz', _debug: { totalScore: 1 } as PostItem['_debug'] }),
      ],
      ctx,
    );
    expect(tagged.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(tagged[0]!.meta).toMatchObject({ isWild: false, likesCount: 4, tags: ['exams'], timestamp: Date.parse('2026-10-25T11:00:00.000Z') });
    expect(tagged[0]!.meta.trendingScore).toBeGreaterThan(0.5);
    expect(tagged[1]).toMatchObject({ moderation: 'WILD' });
    expect(tagged[1]!.meta.isWild).toBe(true);
    expect(tagged[2]!.meta.isWild).toBe(true); // spam-like text
    expect('_debug' in tagged[2]!).toBe(false);
  });

  it('dedupes tags and caps them at 12', () => {
    const topics = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, slug: `tag${i % 15}`, display_name: 'x', confidence: 1 }));
    expect(tagPosts([post('p1', { topics })], ctx)[0]!.meta.tags).toHaveLength(12);
  });
});

describe('batch envelope and request parsing', () => {
  it('counts SAFE and WILD, sets the cursor from the last post and passes the trending map', () => {
    const posts = tagPosts([post('p1'), post('p2'), post('p3')], { nowMs: NOW, reporters: new Map([['p2', 3]]), topicTrends: new Map() });
    const res = buildBatchResponse({ kind: 'next', mode: 'for_you', posts, hasMore: true, batchSize: 30, topicTrends: new Map([['a', 0.5]]), nowMs: NOW });
    expect(res.batch.counts).toEqual({ safe: 2, wild: 1 });
    expect(res.batch.hasMore).toBe(true);
    expect(decodePipelineCursor(res.batch.nextCursor!)?.id).toBe('p3');
    expect(res.trending).toEqual({ a: 0.5 });
    expect(isFeedBatchResponse(JSON.parse(JSON.stringify(res)))).toBe(true);
  });

  it('has no cursor when nothing is left or the page is empty', () => {
    const end = buildBatchResponse({ kind: 'bootstrap', mode: 'following', posts: [], hasMore: true, batchSize: 40, topicTrends: new Map(), nowMs: NOW });
    expect(end.batch.nextCursor).toBeNull();
    expect(end.batch.hasMore).toBe(false);
  });

  it('clamps the size to 30..50 and validates the mode', () => {
    expect(clampBatchSize(null)).toBe(40);
    expect(clampBatchSize('5')).toBe(30);
    expect(clampBatchSize('500')).toBe(50);
    expect(clampBatchSize('abc')).toBe(40);
    expect(clampBatchSize('37.9')).toBe(37);
    expect(parsePipelineMode(null)).toBe('for_you');
    expect(parsePipelineMode('following')).toBe('following');
    expect(parsePipelineMode('ranked')).toBeNull();
  });

  it('the structural check rejects garbage', () => {
    expect(isFeedBatchResponse(null)).toBe(false);
    expect(isFeedBatchResponse({ version: 2 })).toBe(false);
    expect(isFeedBatchResponse({ version: 1, mode: 'for_you', kind: 'next', trending: {}, config: {}, batch: { id: 'x', hasMore: false, nextCursor: null, posts: [{ id: 'p' }] } })).toBe(false);
  });
});
