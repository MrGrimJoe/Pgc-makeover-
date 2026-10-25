import { DEFAULT_LAYOUT, type FrameLayout } from './layout.ts';
import type {
  FeedFrameEvents,
  FeedSource,
  FeedStatus,
  Frame,
  FrameKind,
  ModerationState,
  ScrollDirection,
  UnmountReason,
} from './types.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (payload: any) => void;

/** Upper bound on layout steps spent looking for the next frame, so a bad layout cannot spin forever. */
const MAX_LAYOUT_STEPS = 64;
/** How many empty dropped slots the window may step over when looking for the next content frame. */
const MAX_STEPPED_OVER_SLOTS = 2;

export interface FeedFrameManagerOptions<T> {
  source: FeedSource<T>;
  layout?: FrameLayout;
  /** Items per content frame. Default 8 (recommended range 5-10). */
  frameSize?: number;
  /** Frames kept mounted behind / ahead of the focused frame. Default 1 / 1. */
  windowBehind?: number;
  windowAhead?: number;
  /** Hard cap on simultaneously mounted frames. Default 3. */
  maxActiveFrames?: number;
}

/**
 * Core Frame Feed Engine.
 *
 * Slices a feed into frames (SAFE / WILD content frames plus MID buffer slots), keeps only a small
 * sliding window of them mounted, and emits events so other managers can attach without touching
 * this file. It renders nothing itself: the UI renders getMountedFrames().
 */
export class FeedFrameManager<T> {
  private readonly source: FeedSource<T>;
  private readonly layout: FrameLayout;
  private readonly frameSize: number;
  private readonly windowBehind: number;
  private readonly windowAhead: number;

  /** Data cache: every generated frame by index. Never evicted, so scrolling back rebuilds the same frame. */
  private readonly frames: Frame<T>[] = [];
  /** Frames currently in the UI, by index. */
  private readonly mounted = new Map<number, Frame<T>>();
  private readonly volatileIds = new Set<string>();
  private readonly exhausted = new Set<ModerationState>();
  private readonly handlers = new Map<keyof FeedFrameEvents<T>, Set<AnyHandler>>();
  private readonly changeListeners = new Set<() => void>();

  private mountedSnapshot: readonly Frame<T>[] = Object.freeze([]);
  private status: FeedStatus = Object.freeze({ loading: false, ended: false, error: null });
  private layoutCursor = 0;
  private focusIndex = -1;
  private lastDirection: ScrollDirection = 'down';
  private focusToken = 0;
  private generation: Promise<void> = Promise.resolve();

  constructor(options: FeedFrameManagerOptions<T>) {
    const { windowBehind = 1, windowAhead = 1, maxActiveFrames = 3 } = options;
    if (windowBehind < 0 || windowAhead < 0 || windowBehind + windowAhead + 1 > maxActiveFrames) {
      throw new RangeError(
        `Window (${windowBehind} behind + focus + ${windowAhead} ahead) exceeds maxActiveFrames (${maxActiveFrames})`,
      );
    }
    this.source = options.source;
    this.layout = options.layout ?? DEFAULT_LAYOUT;
    this.frameSize = Math.max(1, Math.floor(options.frameSize ?? 8));
    this.windowBehind = windowBehind;
    this.windowAhead = windowAhead;
  }

  // ------------------------------------------------------------------ public API

  /**
   * Move focus to a frame index. Generates missing frames, then reconciles the mounted window.
   * Rejects if the source throws (also surfaced via getStatus().error and the loadError event).
   */
  focus(index: number): Promise<void> {
    return this.moveFocus(index, false);
  }

  /** Re-run the current focus, e.g. after a load error. */
  retry(): Promise<void> {
    return this.moveFocus(Math.max(this.focusIndex, 0), true);
  }

  /**
   * Call when the user has scrolled to the end of the mounted frames. Moves the focus to the last
   * mounted frame, or one further when it is already there. This keeps the feed moving when the last
   * mounted frame is a zero-height Mid-Frame (it never crosses the viewport middle) and when a WILD
   * neighbour is held back behind a focused Mid-Frame (nothing below to scroll onto).
   */
  advance(): Promise<void> {
    if (this.focusIndex < 0 || this.mounted.size === 0) return Promise.resolve();
    return this.focus(Math.max(this.focusIndex + 1, Math.max(...this.mounted.keys())));
  }

  /** Mirror of advance(): the user has scrolled to the top of the mounted frames. */
  retreat(): Promise<void> {
    if (this.focusIndex <= 0 || this.mounted.size === 0) return Promise.resolve();
    return this.focus(Math.min(this.focusIndex - 1, Math.min(...this.mounted.keys())));
  }

  getFocusIndex(): number {
    return this.focusIndex;
  }

  /** A generated frame by index (mounted or not). */
  getFrame(index: number): Frame<T> | undefined {
    return this.frames[index];
  }

  /** How many frames have been generated so far (mounted or not). */
  getFrameCount(): number {
    return this.frames.length;
  }

  /** Mark a frame as one that must never be mounted beside a WILD frame. MID frames already are. */
  markVolatile(frameId: string, volatile = true): void {
    if (volatile) this.volatileIds.add(frameId);
    else this.volatileIds.delete(frameId);
    if (this.focusIndex >= 0) this.reconcile(this.focusIndex, this.lastDirection);
  }

  isVolatile(frame: Frame<T>): boolean {
    return frame.kind === 'MID' || this.volatileIds.has(frame.id);
  }

  /** Immutable snapshot of mounted frames sorted by index. Same reference until something changes. */
  readonly getMountedFrames = (): readonly Frame<T>[] => this.mountedSnapshot;

  readonly getStatus = (): FeedStatus => this.status;

  /** Subscribe to mounted-set / status changes (useSyncExternalStore compatible). */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  };

  on<K extends keyof FeedFrameEvents<T>>(
    event: K,
    handler: (payload: FeedFrameEvents<T>[K]) => void,
  ): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  onFrameMount(handler: (p: FeedFrameEvents<T>['frameMount']) => void): () => void {
    return this.on('frameMount', handler);
  }
  onFrameUnmount(handler: (p: FeedFrameEvents<T>['frameUnmount']) => void): () => void {
    return this.on('frameUnmount', handler);
  }
  onMidFrameReached(handler: (p: FeedFrameEvents<T>['midFrameReached']) => void): () => void {
    return this.on('midFrameReached', handler);
  }

  /** Unmounts every frame and cancels in-flight focus calls. The instance can be focused again. */
  destroy(): void {
    this.focusToken++;
    for (const frame of [...this.mounted.values()]) this.unmountFrame(frame, 'destroy');
    this.focusIndex = -1;
  }

  // ------------------------------------------------------------ frame generation

  private async moveFocus(index: number, force: boolean): Promise<void> {
    if (!Number.isInteger(index) || index < 0) throw new RangeError(`Invalid frame index: ${index}`);
    if (!force && index === this.focusIndex) return;

    const token = ++this.focusToken;
    const direction: ScrollDirection =
      index === this.focusIndex ? this.lastDirection : index > this.focusIndex ? 'down' : 'up';

    await this.ensureFrames(index + this.windowAhead);
    if (token !== this.focusToken) return; // superseded by a newer focus() or destroy()

    const last = this.frames.length - 1;
    if (last < 0) return; // empty feed
    this.reconcile(Math.min(index, last), direction);
  }

  /** Serialises generation so frames are always created in index order. */
  private ensureFrames(upTo: number): Promise<void> {
    const run = this.generation.then(async () => {
      if (this.frames.length > upTo || this.status.ended) return;
      this.setStatus({ loading: true });
      try {
        while (this.frames.length <= upTo && !this.status.ended) await this.generateNext();
        this.setStatus({ loading: false, error: null });
      } catch (error) {
        this.setStatus({ loading: false, error });
        this.emit('loadError', { error });
        throw error;
      }
    });
    this.generation = run.catch(() => undefined); // a failed load must not wedge the chain
    return run;
  }

  /**
   * Builds the next content frame (plus any Mid-Frames due before it).
   * Exhausted kinds are skipped, and Mid-Frames are only created when content follows them,
   * so the feed never ends on an empty slot.
   */
  private async generateNext(): Promise<void> {
    let pendingMids = 0;
    for (let step = 0; step < MAX_LAYOUT_STEPS; step++) {
      if (this.exhausted.has('SAFE') && this.exhausted.has('WILD')) break;
      const kind = this.layout(this.layoutCursor++);
      if (kind === 'MID') {
        pendingMids++;
        continue;
      }
      if (this.exhausted.has(kind)) continue;

      const result = await this.source.load(kind, this.frameSize);
      if (result.done) this.exhausted.add(kind);
      if (result.items.length === 0) continue; // nothing right now: skip this slot

      for (let i = 0; i < pendingMids; i++) this.pushFrame('MID', []);
      this.pushFrame(kind, result.items);
      return;
    }
    this.setStatus({ ended: true });
    this.emit('feedEnd', { totalFrames: this.frames.length });
  }

  private pushFrame(kind: FrameKind, items: readonly T[]): void {
    const index = this.frames.length;
    const frame: Frame<T> = Object.freeze({
      id: `frame-${index}`,
      index,
      kind,
      items: Object.freeze([...items]),
    });
    this.frames.push(frame);
    this.emit('frameCreated', { frame });
  }

  // --------------------------------------------------------------- reconciliation

  private reconcile(focus: number, direction: ScrollDirection): void {
    const focused = this.frames[focus];
    if (!focused) return;
    const previous = this.focusIndex >= 0 ? (this.frames[this.focusIndex] ?? null) : null;
    this.focusIndex = focus;
    this.lastDirection = direction;

    const target = this.resolveWindow(focused, direction);
    const targetIndexes = new Set(target.map((f) => f.index));
    const targetHasWild = target.some((f) => f.kind === 'WILD');

    // 1. Unmount everything outside the target, farthest first. The target never mixes a volatile
    //    frame with a WILD frame, so by the time step 2 mounts a WILD frame every volatile frame is gone.
    const evict = [...this.mounted.values()]
      .filter((f) => !targetIndexes.has(f.index))
      .sort((a, b) => Math.abs(b.index - focus) - Math.abs(a.index - focus));
    for (const frame of evict) {
      let reason: UnmountReason = 'window';
      if (this.isVolatile(frame) && targetHasWild) reason = 'pre-wild';
      else if (frame.index >= focus - this.windowBehind && frame.index <= focus + this.windowAhead) {
        reason = 'conflict';
      }
      this.unmountFrame(frame, reason);
    }

    // 2. Mount what is missing, in scroll-direction order.
    const toMount = target
      .filter((f) => !this.mounted.has(f.index))
      .sort((a, b) => (direction === 'down' ? a.index - b.index : b.index - a.index));
    for (const frame of toMount) this.mountFrame(frame, direction);

    // 3. Focus and Mid-Frame events.
    if (previous?.index !== focus) {
      this.emit('frameFocus', { frame: focused, previous, direction });
      this.emitMidFramesPassed(previous, focus, direction);
    }
  }

  /** Emits midFrameReached for every Mid-Frame between the old and new focus, in travel order. */
  private emitMidFramesPassed(previous: Frame<T> | null, focus: number, direction: ScrollDirection): void {
    const indexes: number[] = [];
    if (!previous) indexes.push(focus);
    else if (direction === 'down') for (let i = previous.index + 1; i <= focus; i++) indexes.push(i);
    else for (let i = previous.index - 1; i >= focus; i--) indexes.push(i);

    for (const i of indexes) {
      const frame = this.frames[i];
      if (frame?.kind === 'MID') this.emit('midFrameReached', { frame, direction, landed: i === focus });
    }
  }

  /**
   * Picks the frames to keep mounted: the focused frame, then up to windowAhead / windowBehind frames on
   * each side. The neighbour in the scroll direction is chosen first, so it wins any conflict. A candidate
   * that would put a volatile frame next to a WILD frame is dropped. A dropped frame with no content (a
   * Mid-Frame slot) is stepped over, so the content frame beyond it stays mounted instead of vanishing
   * while still on screen; a dropped frame that has content is never stepped over, because that would
   * leave a hole in the feed.
   */
  private resolveWindow(focused: Frame<T>, direction: ScrollDirection): Frame<T>[] {
    const picked: Frame<T>[] = [focused];

    const take = (step: 1 | -1, limit: number): void => {
      let taken = 0;
      for (let d = 1; d <= limit + MAX_STEPPED_OVER_SLOTS && taken < limit; d++) {
        const candidate = this.frames[focused.index + step * d];
        if (!candidate) return;
        if (!this.conflicts(candidate, picked)) {
          picked.push(candidate);
          taken++;
        } else if (candidate.items.length > 0) {
          return;
        }
      }
    };

    if (direction === 'down') {
      take(1, this.windowAhead);
      take(-1, this.windowBehind);
    } else {
      take(-1, this.windowBehind);
      take(1, this.windowAhead);
    }
    return picked;
  }

  private conflicts(candidate: Frame<T>, picked: readonly Frame<T>[]): boolean {
    const candidateWild = candidate.kind === 'WILD';
    const candidateVolatile = this.isVolatile(candidate);
    return picked.some(
      (p) => (candidateWild && this.isVolatile(p)) || (candidateVolatile && p.kind === 'WILD'),
    );
  }

  private mountFrame(frame: Frame<T>, direction: ScrollDirection): void {
    this.mounted.set(frame.index, frame);
    this.refreshSnapshot();
    this.emit('frameMount', { frame, direction });
  }

  private unmountFrame(frame: Frame<T>, reason: UnmountReason): void {
    if (!this.mounted.has(frame.index)) return;
    this.emit('frameUnmount', { frame, reason }); // before removal: listeners tear down first
    this.mounted.delete(frame.index);
    this.refreshSnapshot();
  }

  private refreshSnapshot(): void {
    this.mountedSnapshot = Object.freeze([...this.mounted.values()].sort((a, b) => a.index - b.index));
    this.notify();
  }

  private setStatus(patch: Partial<FeedStatus>): void {
    const next = { ...this.status, ...patch };
    if (next.loading === this.status.loading && next.ended === this.status.ended && next.error === this.status.error) {
      return;
    }
    this.status = Object.freeze(next);
    this.notify();
  }

  private notify(): void {
    this.changeListeners.forEach((listener) => listener());
  }

  private emit<K extends keyof FeedFrameEvents<T>>(event: K, payload: FeedFrameEvents<T>[K]): void {
    this.handlers.get(event)?.forEach((handler) => {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[FeedFrameManager] "${String(event)}" handler threw`, err);
      }
    });
  }
}
