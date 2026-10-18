import React, { useState, useEffect } from 'react';
import type { PostItem, FeedResponse } from '../../shared/schema.ts';
import { PostCard } from '../components/PostCard.tsx';

interface FeedPageProps {
  currentUserId: string;
  onNavigateToCompose: () => void;
  onViewAuthorProfile: (username: string) => void;
}

export const FeedPage: React.FC<FeedPageProps> = ({
  currentUserId,
  onNavigateToCompose,
  onViewAuthorProfile,
}) => {
  const [feedMode, setFeedMode] = useState<'for_you' | 'following'>('for_you');
  const [posts, setPosts] = useState<PostItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchFeed = async (cursor?: string) => {
    if (cursor) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      const modeParam = feedMode === 'for_you' ? 'mode=for_you' : 'mode=following';
      const url = cursor
        ? `/api/feed?${modeParam}&cursor=${encodeURIComponent(cursor)}&limit=10`
        : `/api/feed?${modeParam}&limit=10`;

      const res = await fetch(url);
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error || 'Failed to load posts');
      }

      const data = (await res.json()) as FeedResponse & { posts: PostItem[] };
      if (cursor) {
        setPosts((prev) => [...prev, ...data.posts]);
      } else {
        setPosts(data.posts || []);
      }
      setNextCursor(data.next_cursor || null);
      setHasMore(!!data.has_more);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    fetchFeed();
  }, [feedMode]);

  const handlePostDeleted = (deletedId: string) => {
    setPosts((prev) => prev.filter((p) => p.id !== deletedId));
  };

  return (
    <div className="w-full max-w-[430px] mx-auto pb-16 bg-[var(--bg,#fff)]">
      {/* "For you / Following" tabs: 44px high, 14px/600; active tab has text color and 2px blue underline */}
      <div className="flex border-b border-[var(--line,#E8EBF0)]">
        <button
          type="button"
          onClick={() => setFeedMode('for_you')}
          aria-current={feedMode === 'for_you' ? 'true' : undefined}
          className={`flex-1 min-h-[44px] py-3 text-center text-[14px] font-semibold transition-colors cursor-pointer border-b-2 bg-transparent ${
            feedMode === 'for_you'
              ? 'text-[var(--text,#17233A)] border-[var(--blue,#244C8A)]'
              : 'text-[var(--muted,#5B6577)] border-transparent hover:text-[var(--text,#17233A)]'
          }`}
        >
          For you
        </button>
        <button
          type="button"
          onClick={() => setFeedMode('following')}
          aria-current={feedMode === 'following' ? 'true' : undefined}
          className={`flex-1 min-h-[44px] py-3 text-center text-[14px] font-semibold transition-colors cursor-pointer border-b-2 bg-transparent ${
            feedMode === 'following'
              ? 'text-[var(--text,#17233A)] border-[var(--blue,#244C8A)]'
              : 'text-[var(--muted,#5B6577)] border-transparent hover:text-[var(--text,#17233A)]'
          }`}
        >
          Following
        </button>
      </div>

      {/* Error state */}
      {error && (
        <div role="alert" className="py-8 text-center text-[var(--danger,#B23A40)] text-[14px] px-4">
          {error}
        </div>
      )}

      {/* Loading Skeletons: flat line color blocks */}
      {loading && (
        <div className="divide-y divide-[var(--line,#E8EBF0)]">
          {[1, 2, 3].map((i) => (
            <div key={i} className="py-4 px-4 space-y-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-full skeleton-box shrink-0" />
                <div className="space-y-1.5 flex-1">
                  <div className="w-28 h-3.5 skeleton-box rounded" />
                  <div className="w-16 h-2.5 skeleton-box rounded" />
                </div>
              </div>
              <div className="w-full h-4 skeleton-box rounded" />
              <div className="w-4/5 h-4 skeleton-box rounded" />
            </div>
          ))}
        </div>
      )}

      {/* Empty State: one muted line and one small button */}
      {!loading && posts.length === 0 && !error && (
        <div className="py-16 text-center space-y-3 px-4">
          <p className="text-[14px] text-[var(--muted,#5B6577)]">No posts in this feed yet.</p>
          <button
            type="button"
            onClick={onNavigateToCompose}
            className="text-[13px] font-semibold text-[var(--blue,#244C8A)] hover:underline cursor-pointer min-h-[44px] px-3 bg-transparent border-0"
          >
            Create a post
          </button>
        </div>
      )}

      {/* Posts List */}
      {!loading && posts.length > 0 && (
        <div>
          {posts.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              currentUserId={currentUserId}
              onPostDeleted={handlePostDeleted}
              onViewAuthorProfile={onViewAuthorProfile}
            />
          ))}

          {/* Load More Pagination */}
          {hasMore && (
            <div className="text-center py-4">
              <button
                type="button"
                onClick={() => nextCursor && fetchFeed(nextCursor)}
                disabled={loadingMore}
                className="text-[13px] font-semibold text-[var(--blue,#244C8A)] hover:underline cursor-pointer min-h-[44px] px-4 bg-transparent border-0"
              >
                {loadingMore ? 'Loading older posts...' : 'Older posts'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
