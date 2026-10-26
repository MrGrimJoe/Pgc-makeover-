import type { FeedBatchResponse, PipelineMode, PipelinePost } from '../shared/feed-pipeline.ts';
import type { BatchFetchParams, BatchFetcher } from '../src/feed-pipeline/FeedCacheManager.ts';

export const T0 = Date.parse('2026-10-25T12:00:00.000Z');

export interface MakePostOptions {
  author?: string;
  tags?: string[];
  wild?: boolean;
  likes?: number;
  trending?: number;
  /** minutes before T0 */
  ageMin?: number;
  /** days after T0 */
  expiresInDays?: number;
}

/** Post n is n minutes old by default, so a higher n is older (the order the server returns). */
export function makePost(n: number, o: MakePostOptions = {}): PipelinePost {
  const ts = T0 - (o.ageMin ?? n) * 60_000;
  const wild = o.wild ?? false;
  return {
    id: `p${String(n).padStart(3, '0')}`,
    author_id: o.author ?? `author${n % 7}`,
    author_username: 'someone',
    author_display_name: 'Someone',
    author_avatar_media_id: null,
    body: `post ${n}`,
    created_at: new Date(ts).toISOString(),
    expires_at: new Date(T0 + (o.expiresInDays ?? 10) * 86_400_000).toISOString(),
    status: 'active',
    media: [],
    likes_count: o.likes ?? 0,
    has_liked: false,
    comments_count: 0,
    moderation: wild ? 'WILD' : 'SAFE',
    meta: {
      isWild: wild,
      safetyScore: wild ? 0.4 : 1,
      likesCount: o.likes ?? 0,
      tags: o.tags ?? [],
      timestamp: ts,
      trendingScore: o.trending ?? 0,
    },
  };
}

/** A stand-in for the server: serves a fixed newest-first list in batches and records every call. */
export class FakeFeedServer {
  calls: Array<{ kind: 'bootstrap' | 'next'; params: BatchFetchParams }> = [];
  failWith: Error | null = null;
  trending: Record<string, number> = {};
  private count = 0;

  constructor(public posts: PipelinePost[], public mode: PipelineMode = 'for_you') {}

  get fetcher(): BatchFetcher {
    return async (kind, params) => {
      this.calls.push({ kind, params });
      if (this.failWith) throw this.failWith;
      const start = kind === 'bootstrap' ? 0 : Number(Buffer.from(params.cursor ?? '', 'base64url').toString() || 0);
      const slice = this.posts.slice(start, start + params.size);
      const end = start + slice.length;
      const hasMore = end < this.posts.length;
      const body: FeedBatchResponse = {
        version: 1,
        mode: this.mode,
        kind,
        batch: {
          id: `batch${++this.count}`,
          generatedAt: T0,
          posts: structuredClone(slice),
          counts: { safe: slice.filter((p) => !p.meta.isWild).length, wild: slice.filter((p) => p.meta.isWild).length },
          nextCursor: hasMore ? Buffer.from(String(end)).toString('base64url') : null,
          hasMore,
        },
        trending: this.trending,
        config: { batchSize: params.size, lowWaterMark: 15 },
      };
      return body;
    };
  }

  get nextCalls() {
    return this.calls.filter((c) => c.kind === 'next').length;
  }
}
