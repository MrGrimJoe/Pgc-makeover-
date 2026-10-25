import type { FeedResponse, PostItem } from '../../shared/schema.ts';
import { createPooledSource, type FeedSource, type ModerationState } from '../feed-engine/index.ts';

export type FeedMode = 'for_you' | 'following';

/** The SAFE / WILD decision for a post. Untagged posts are SAFE. */
export function classifyPost(post: PostItem): ModerationState {
  return post.moderation === 'WILD' ? 'WILD' : 'SAFE';
}

const PAGE_SIZE = 10;

/** Feeds /api/feed pages into the frame engine, classified by classifyPost. */
export function createApiFeedSource(mode: FeedMode): FeedSource<PostItem> {
  return createPooledSource<PostItem>({
    classify: classifyPost,
    getKey: (post) => post.id,
    fetchPage: async (cursor) => {
      const params = new URLSearchParams({ mode, limit: String(PAGE_SIZE) });
      if (cursor) params.set('cursor', cursor);
      const res = await fetch(`/api/feed?${params.toString()}`);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || 'Failed to load posts');
      }
      const data = (await res.json()) as FeedResponse;
      return { items: data.posts ?? [], nextCursor: data.next_cursor ?? null, hasMore: !!data.has_more };
    },
  });
}
