/**
 * Core Frame Feed Engine: shared types.
 * Nothing in src/feed-engine knows about monetization. Third parties attach through events.
 */
export type ModerationState = 'SAFE' | 'WILD';
/** MID is the buffer slot inserted after every two SAFE frames. It never holds items. */
export type FrameKind = ModerationState | 'MID';
export type ScrollDirection = 'up' | 'down';
/**
 * window    left the sliding window
 * pre-wild  a volatile frame removed so a WILD frame can mount
 * conflict  a WILD frame removed because the focused frame is volatile
 * destroy   manager.destroy()
 */
export type UnmountReason = 'window' | 'pre-wild' | 'conflict' | 'destroy';

export interface Frame<T> {
  readonly id: string;
  /** Stable position in the feed. The same index always yields the same frame. */
  readonly index: number;
  readonly kind: FrameKind;
  readonly items: readonly T[];
}

export interface LoadResult<T> {
  items: T[];
  /** True when this moderation state will never produce another item. */
  done: boolean;
}

/**
 * Supplies already-classified items. The manager calls load() once per content frame, in order.
 * An empty result with done=false means "nothing right now": the slot is skipped, not the feed ended.
 */
export interface FeedSource<T> {
  load(moderation: ModerationState, limit: number): Promise<LoadResult<T>>;
}

export interface FeedStatus {
  readonly loading: boolean;
  readonly ended: boolean;
  readonly error: unknown | null;
}

export interface FeedFrameEvents<T> {
  frameCreated: { frame: Frame<T> };
  /** The frame has joined the mounted set (the UI commits it right after). */
  frameMount: { frame: Frame<T>; direction: ScrollDirection };
  /** The frame is about to leave the mounted set. Tear down anything you attached to it. */
  frameUnmount: { frame: Frame<T>; reason: UnmountReason };
  frameFocus: { frame: Frame<T>; previous: Frame<T> | null; direction: ScrollDirection };
  /** `landed` is false when the user scrolled past the Mid-Frame without stopping on it. */
  midFrameReached: { frame: Frame<T>; direction: ScrollDirection; landed: boolean };
  feedEnd: { totalFrames: number };
  loadError: { error: unknown };
}
