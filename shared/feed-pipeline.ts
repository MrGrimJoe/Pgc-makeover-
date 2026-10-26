/**
 * Feed pipeline contract: what the server packages (worker/feed-pipeline) and what the phone caches
 * (src/feed-pipeline). Nothing here knows about monetization.
 */
import type { PostItem } from './schema.ts';

export const FEED_PIPELINE_VERSION = 1;

/** Posts per batch. The server clamps any requested size into this range. */
export const BATCH_SIZE_MIN = 30;
export const BATCH_SIZE_MAX = 50;
export const BATCH_SIZE_DEFAULT = 40;

/** The client asks the server for the next batch when fewer than this many unseen posts are cached. */
export const LOW_WATER_MARK = 15;

export type PipelineMode = 'for_you' | 'following';

/** Metadata the server attaches to every packaged post. */
export interface PipelineMeta {
  /** True when the post is in the WILD pool (reported or spam-like). SAFE otherwise. */
  isWild: boolean;
  /** 0..1, where 1 means no concerns. `isWild` is `safetyScore < WILD_THRESHOLD` (see worker/feed-pipeline/safety.ts). */
  safetyScore: number;
  /** Likes from people the viewer has not blocked (same number as `likes_count`). */
  likesCount: number;
  /** Topic slugs, lowercase, at most 12. */
  tags: string[];
  /** `created_at` as epoch milliseconds. */
  timestamp: number;
  /** 0..1: how hot the post's topics are right now blended with how fast it is gaining likes and comments. */
  trendingScore: number;
}

/**
 * A normal PostItem (so existing cards render it unchanged) plus the pipeline metadata. `moderation` is always
 * set, so `classifyPost` in src/lib/feed-source.ts also understands it.
 */
export type PipelinePost = PostItem & {
  moderation: 'SAFE' | 'WILD';
  meta: PipelineMeta;
};

export interface FeedBatch {
  id: string;
  /** Epoch milliseconds on the server. */
  generatedAt: number;
  posts: PipelinePost[];
  counts: { safe: number; wild: number };
  /** Opaque. Send it back to `/next` unchanged. Null when there is nothing older. */
  nextCursor: string | null;
  hasMore: boolean;
}

export interface FeedBatchResponse {
  version: typeof FEED_PIPELINE_VERSION;
  mode: PipelineMode;
  kind: 'bootstrap' | 'next';
  batch: FeedBatch;
  /** Hot topic slug -> 0..1 (24 hour window). Lets the phone weigh trends locally without asking again. */
  trending: Record<string, number>;
  config: { batchSize: number; lowWaterMark: number };
}

export function parsePipelineMode(raw: string | null): PipelineMode | null {
  if (raw === null || raw === '') return 'for_you';
  return raw === 'for_you' || raw === 'following' ? raw : null;
}

export function clampBatchSize(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw.trim() === '') return BATCH_SIZE_DEFAULT;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return BATCH_SIZE_DEFAULT;
  return Math.min(BATCH_SIZE_MAX, Math.max(BATCH_SIZE_MIN, n));
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function isMeta(v: unknown): v is PipelineMeta {
  return (
    isObj(v) &&
    typeof v.isWild === 'boolean' &&
    typeof v.safetyScore === 'number' &&
    typeof v.likesCount === 'number' &&
    Array.isArray(v.tags) &&
    v.tags.every((t) => typeof t === 'string') &&
    typeof v.timestamp === 'number' &&
    typeof v.trendingScore === 'number'
  );
}

/** Cheap structural check, so a broken or foreign response is never written to the phone's cache. */
export function isFeedBatchResponse(x: unknown): x is FeedBatchResponse {
  if (!isObj(x) || x.version !== FEED_PIPELINE_VERSION) return false;
  if (x.mode !== 'for_you' && x.mode !== 'following') return false;
  if (x.kind !== 'bootstrap' && x.kind !== 'next') return false;
  if (!isObj(x.trending) || !isObj(x.config) || !isObj(x.batch)) return false;
  const b = x.batch;
  if (typeof b.id !== 'string' || !Array.isArray(b.posts) || typeof b.hasMore !== 'boolean') return false;
  if (b.nextCursor !== null && typeof b.nextCursor !== 'string') return false;
  return b.posts.every(
    (p) => isObj(p) && typeof p.id === 'string' && typeof p.expires_at === 'string' && isMeta(p.meta),
  );
}
