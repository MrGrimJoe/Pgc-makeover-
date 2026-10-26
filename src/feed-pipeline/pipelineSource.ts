/**
 * Glue between the local cache, local ranking and the frame engine. Nothing in src/feed-engine changes.
 *
 *   createPipelineFeedSource   a FeedSource the FeedFrameManager can use instead of createApiFeedSource
 *   attachHistoryTracking      marks a frame's posts viewed when it comes into focus (builds the history)
 *   createLocalImpressionSender  feeds on-screen time into local preferences and the history, then reports upstream
 */
import type { PipelinePost } from '../../shared/feed-pipeline.ts';
import type { FeedFrameManager, FeedSource, ModerationState } from '../feed-engine/index.ts';
import { sendImpressions, type ImpressionReport } from '../lib/impressions.ts';
import type { FeedCacheManager } from './FeedCacheManager.ts';
import type { LocalPersonalization } from './LocalPersonalization.ts';

/** SAFE or WILD, straight from the server's tag. */
export function classifyPipelinePost(post: PipelinePost): ModerationState {
  return post.meta.isWild ? 'WILD' : 'SAFE';
}

export interface PipelineSourceOptions {
  cache: FeedCacheManager;
  personalization: LocalPersonalization;
  /** Server fetches allowed per load() while hunting for enough posts of one state. Default 3. */
  maxPagesPerLoad?: number;
}

export interface PipelineFeedSource extends FeedSource<PipelinePost> {
  /** A post this source has already handed to the engine (to attribute impressions and interactions). */
  getPost(id: string): PipelinePost | undefined;
}

type Pools = Record<ModerationState, PipelinePost[]>;
const emptyPools = (): Pools => ({ SAFE: [], WILD: [] });

export function createPipelineFeedSource(options: PipelineSourceOptions): PipelineFeedSource {
  const { cache, personalization, maxPagesPerLoad = 3 } = options;
  const served = new Map<string, PipelinePost>();
  let pools = emptyPools();
  let builtVersion = -1;
  let started: Promise<void> | null = null;
  let history: Pools | null = null;

  const start = (): Promise<void> => {
    started ??= cache.start().then(
      () => undefined,
      (error: unknown) => {
        started = null; // let a retry start again
        throw error;
      },
    );
    return started;
  };

  /** Re-rank everything not yet shown, then split it into the two pools. Runs again when a new batch arrives. */
  async function rebuild(): Promise<void> {
    const [pool, trending] = await Promise.all([cache.getPool(), cache.getTrending()]);
    const ranked = personalization.rank(
      pool.filter((p) => !served.has(p.id)),
      { trending },
    );
    pools = emptyPools();
    for (const post of ranked) pools[classifyPipelinePost(post)].push(post);
    builtVersion = cache.version;
  }

  /** Previously viewed posts, newest view first. Only used when the network is unavailable. */
  async function loadHistory(): Promise<Pools> {
    if (!history) {
      history = emptyPools();
      for (const post of (await cache.readOffline()).history) {
        if (!served.has(post.id)) history[classifyPipelinePost(post)].push(post);
      }
    }
    return history;
  }

  return {
    getPost: (id) => served.get(id),

    async load(kind, limit) {
      await start();
      let failure: unknown = null;
      for (let page = 0; ; page++) {
        if (builtVersion !== cache.version) await rebuild();
        if (pools[kind].length >= limit || page >= maxPagesPerLoad || !(await cache.hasMore())) break;
        try {
          await cache.loadMore();
        } catch (error) {
          failure = error; // offline or server trouble: use what is stored
          break;
        }
      }

      let items = pools[kind].splice(0, limit);
      const unreachable = failure !== null || !cache.isOnline();
      if (items.length === 0 && unreachable) {
        items = (await loadHistory())[kind].splice(0, limit); // nothing unseen left: show what was seen before
        if (items.length === 0 && failure !== null) throw failure; // nothing stored at all: let the page show "Try again"
      }
      for (const post of items) served.set(post.id, post);

      void cache.prefetchIfLow(pools.SAFE.length + pools.WILD.length);
      const more = unreachable ? true : await cache.hasMore();
      return { items, done: !more && pools[kind].length === 0 };
    },
  };
}

/**
 * Builds the history as the person scrolls: every frame that takes focus has its posts marked viewed in
 * IndexedDB. Returns the unsubscribe function.
 */
export function attachHistoryTracking(
  manager: Pick<FeedFrameManager<PipelinePost>, 'on'>,
  cache: Pick<FeedCacheManager, 'markViewed'>,
): () => void {
  return manager.on('frameFocus', ({ frame }) => {
    if (frame.kind === 'MID' || frame.items.length === 0) return;
    void cache.markViewed(frame.items.map((p) => p.id)).catch(() => undefined);
  });
}

export interface LocalImpressionSenderOptions {
  personalization: Pick<LocalPersonalization, 'recordView'>;
  cache: Pick<FeedCacheManager, 'recordDwell'>;
  getPost: (id: string) => PipelinePost | undefined;
  /** Where the reports go afterwards. Defaults to the existing POST /api/impressions. */
  upstream?: (batch: ImpressionReport[]) => void | Promise<void>;
}

/**
 * Drop-in `send` for `new ImpressionTracker(send)`. Local learning happens first and never waits on the network,
 * so it keeps working offline; the upstream report is best effort.
 */
export function createLocalImpressionSender(options: LocalImpressionSenderOptions) {
  const { personalization, cache, getPost, upstream = sendImpressions } = options;
  return async (batch: ImpressionReport[]): Promise<void> => {
    for (const report of batch) {
      const post = getPost(report.post_id);
      if (post) personalization.recordView(post, report.duration_ms);
    }
    void cache.recordDwell(batch.map((r) => ({ id: r.post_id, dwellMs: r.duration_ms }))).catch(() => undefined);
    await Promise.resolve(upstream(batch)).catch(() => undefined);
  };
}
