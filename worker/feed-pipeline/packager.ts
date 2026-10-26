/**
 * Pure packaging steps (no database): cursors, tagging a page of posts, and building the batch envelope.
 * The controller does the querying; everything here is easy to test on its own.
 */
import { assessSpam } from '../content/spam.ts';
import {
  FEED_PIPELINE_VERSION,
  LOW_WATER_MARK,
  type FeedBatch,
  type FeedBatchResponse,
  type PipelineMode,
  type PipelinePost,
} from '../../shared/feed-pipeline.ts';
import type { PostItem } from '../../shared/schema.ts';
import { scoreSafety } from './safety.ts';
import { trendingScore } from './trending.ts';

const MAX_TAGS = 12;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

// ---------------------------------------------------------------- cursor: (created_at, id), base64url, no Buffer

function toBase64Url(text: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export interface PipelineCursor {
  createdAt: string;
  id: string;
}

export function encodePipelineCursor(createdAt: string, id: string): string {
  return toBase64Url(`${createdAt}|${id}`);
}

/** Null for anything that is not a cursor this module produced. */
export function decodePipelineCursor(raw: string): PipelineCursor | null {
  if (raw.length === 0 || raw.length > 200) return null;
  try {
    const [createdAt, id, ...rest] = fromBase64Url(raw).split('|');
    if (rest.length > 0 || !createdAt || !id || id.length > 100 || !ISO_RE.test(createdAt)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- tagging

export interface TagContext {
  nowMs: number;
  /** post id -> distinct reporters (non-dismissed reports). Missing means none. */
  reporters: ReadonlyMap<string, number>;
  /** topic slug -> 0..1 */
  topicTrends: ReadonlyMap<string, number>;
}

/** Adds `moderation` and `meta` to each hydrated post. Order is kept. */
export function tagPosts(posts: readonly PostItem[], ctx: TagContext): PipelinePost[] {
  return posts.map((post) => {
    const tags = [...new Set((post.topics ?? []).map((t) => t.slug.toLowerCase()))].slice(0, MAX_TAGS);
    const timestamp = Date.parse(post.created_at);
    const ageMs = Number.isFinite(timestamp) ? ctx.nowMs - timestamp : 0;
    const { safetyScore, isWild } = scoreSafety({
      reporters: ctx.reporters.get(post.id) ?? 0,
      spamScore: assessSpam(post.body).score,
    });
    const { _debug: _ignored, ...rest } = post;
    return {
      ...rest,
      moderation: isWild ? 'WILD' : 'SAFE',
      meta: {
        isWild,
        safetyScore,
        likesCount: post.likes_count,
        tags,
        timestamp: Number.isFinite(timestamp) ? timestamp : ctx.nowMs,
        trendingScore: trendingScore(tags, ctx.topicTrends, post.likes_count, post.comments_count, ageMs),
      },
    };
  });
}

// ---------------------------------------------------------------- envelope

export interface BuildBatchInput {
  kind: 'bootstrap' | 'next';
  mode: PipelineMode;
  posts: PipelinePost[];
  hasMore: boolean;
  batchSize: number;
  topicTrends: ReadonlyMap<string, number>;
  nowMs: number;
}

export function buildBatchResponse(input: BuildBatchInput): FeedBatchResponse {
  const { posts, hasMore } = input;
  const last = posts[posts.length - 1];
  const wild = posts.filter((p) => p.meta.isWild).length;
  const batch: FeedBatch = {
    id: `b_${input.nowMs.toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
    generatedAt: input.nowMs,
    posts,
    counts: { safe: posts.length - wild, wild },
    nextCursor: hasMore && last ? encodePipelineCursor(last.created_at, last.id) : null,
    hasMore: hasMore && !!last,
  };
  return {
    version: FEED_PIPELINE_VERSION,
    mode: input.mode,
    kind: input.kind,
    batch,
    trending: Object.fromEntries(input.topicTrends),
    config: { batchSize: input.batchSize, lowWaterMark: LOW_WATER_MARK },
  };
}
