import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PostItem } from '../../shared/schema.ts';
import { PostCard } from '../components/PostCard.tsx';
import { FeedFrame } from '../components/FeedFrame.tsx';
import { TrackedPost } from '../components/TrackedPost.tsx';
import { ImpressionTracker, sendImpressions } from '../lib/impressions.ts';
import { FeedFrameManager, type FrameLayout } from '../feed-engine/index.ts';
import { useEdgeSentinel, useFeedStatus, useMountedFrames, useScrollAnchor } from '../feed-engine/react.ts';
import { createApiFeedSource, type FeedMode } from '../lib/feed-source.ts';

interface FeedPageProps {
  currentUserId: string;
  onNavigateToCompose: () => void;
  onViewAuthorProfile: (username: string) => void;
  /** Frame layout. Defaults to one continuous run of SAFE frames. */
  frameLayout?: FrameLayout;
}

/** Posts per content frame. */
const FEED_FRAME_SIZE = 8;

type Engagement = Pick<PostItem, 'likes_count' | 'has_liked' | 'comments_count'>;

export const FeedPage: React.FC<FeedPageProps> = ({
  currentUserId,
  onNavigateToCompose,
  onViewAuthorProfile,
  frameLayout,
}) => {
  const [feedMode, setFeedMode] = useState<FeedMode>('for_you');
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(() => new Set());
  // Frames are destroyed when they leave the window, so like/comment changes are kept here.
  const engagement = useRef(new Map<string, Engagement>());
  const listRef = useRef<HTMLDivElement>(null);
  // Reports how long each post is on screen so For You learns from what the viewer actually looks at.
  const [tracker] = useState(() => new ImpressionTracker(sendImpressions));
  useEffect(() => () => tracker.dispose(), [tracker]);

  const { manager, heights } = useMemo(() => {
    const m = new FeedFrameManager<PostItem>({
      source: createApiFeedSource(feedMode),
      layout: frameLayout,
      frameSize: FEED_FRAME_SIZE,
    });
    // A frame's DOM is destroyed when it leaves the window, so remember how tall it was. The blank
    // spacer above the list stands in for those frames and keeps the page from jumping.
    const measured = new Map<number, number>();
    m.onFrameUnmount(({ frame }) => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-frame-index="${frame.index}"]`);
      if (el) measured.set(frame.index, el.getBoundingClientRect().height);
    });
    return { manager: m, heights: measured };
  }, [feedMode, frameLayout]);
  const mountedFrames = useMountedFrames(manager);
  const status = useFeedStatus(manager);
  useScrollAnchor(manager, listRef, mountedFrames);
  const topSentinel = useEdgeSentinel(() => void manager.retreat().catch(() => undefined), mountedFrames, 'up');
  const bottomSentinel = useEdgeSentinel(() => void manager.advance().catch(() => undefined), mountedFrames, 'down');

  // Blank stand-ins for generated frames outside the window, at their measured height, above and below.
  // They keep the page the same height, so neither the scroll position nor the end of the page moves
  // when frames are destroyed or brought back.
  const firstMounted = mountedFrames[0]?.index ?? 0;
  const lastMounted = mountedFrames[mountedFrames.length - 1]?.index ?? -1;
  const known = [...heights.values()].filter((h) => h > 0);
  // Frames that were never measured are estimated, so the page keeps extending ahead of a fast scroll
  // instead of ending (an empty Mid-Frame slot is zero tall).
  const estimate = known.length ? known.reduce((a, b) => a + b, 0) / known.length : window.innerHeight * 2;
  const heightOf = (i: number): number => heights.get(i) ?? (manager.getFrame(i)?.kind === 'MID' ? 0 : estimate);
  let topSpacer = 0;
  for (let i = 0; i < firstMounted; i++) topSpacer += heightOf(i);
  let bottomSpacer = 0;
  if (mountedFrames.length > 0) {
    for (let i = lastMounted + 1; i < manager.getFrameCount(); i++) bottomSpacer += heightOf(i);
  }

  const firstRun = useRef(true);
  useEffect(() => {
    if (!firstRun.current && window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'instant' });
    firstRun.current = false;
    void manager.focus(0).catch(() => undefined); // failures show up in status.error
    return () => manager.destroy();
  }, [manager]);

  const handlePostDeleted = useCallback((deletedId: string) => {
    setDeleted((prev) => new Set(prev).add(deletedId));
  }, []);

  const handleEngagementChange = useCallback((postId: string, state: Engagement) => {
    engagement.current.set(postId, state);
  }, []);

  const error = status.error ? (status.error instanceof Error ? status.error.message : 'Failed to load posts') : null;
  const loading = mountedFrames.length === 0 && !status.ended && !error;
  const empty = mountedFrames.length === 0 && status.ended && !error;

  return (
    <div className="w-full max-w-content mx-auto pb-16 tablet:pb-0 bg-[var(--bg,#fff)]">
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
        <div role="alert" className="py-8 text-center text-[var(--danger,#B23A40)] text-[14px] px-4 space-y-2">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => void manager.retry().catch(() => undefined)}
            className="text-[13px] font-semibold text-[var(--blue,#244C8A)] hover:underline cursor-pointer min-h-[44px] px-3 bg-transparent border-0"
          >
            Try again
          </button>
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
      {empty && (
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

      {/* Frames: only the sliding window is in the DOM */}
      <div ref={listRef}>
        <div aria-hidden="true" data-frame-spacer="top" style={{ height: topSpacer }} />
        <div ref={topSentinel} aria-hidden="true" data-frame-sentinel="top" style={{ height: 1 }} />
        {mountedFrames.map((frame) => (
          <FeedFrame key={frame.id} manager={manager} frame={frame}>
            {frame.items
              .filter((post) => !deleted.has(post.id))
              .map((post, i) => (
                <TrackedPost key={post.id} tracker={tracker} postId={post.id} position={frame.index * FEED_FRAME_SIZE + i}>
                  <PostCard
                    post={{ ...post, ...engagement.current.get(post.id) }}
                    currentUserId={currentUserId}
                    onPostDeleted={handlePostDeleted}
                    onViewAuthorProfile={onViewAuthorProfile}
                    onEngagementChange={handleEngagementChange}
                  />
                </TrackedPost>
              ))}
          </FeedFrame>
        ))}
        <div ref={bottomSentinel} aria-hidden="true" data-frame-sentinel="bottom" style={{ height: 1 }} />
        <div aria-hidden="true" data-frame-spacer="bottom" style={{ height: bottomSpacer }} />
      </div>

      {status.loading && mountedFrames.length > 0 && (
        <p role="status" className="text-center py-4 text-[13px] text-[var(--muted,#5B6577)]">
          Loading older posts...
        </p>
      )}
    </div>
  );
};
