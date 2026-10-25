import type { FeedSource, ModerationState } from './types.ts';

export interface Page<T> {
  items: readonly T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface PooledSourceOptions<T> {
  fetchPage: (cursor: string | null) => Promise<Page<T>>;
  /** The SAFE / WILD classification step. Everything downstream trusts it. */
  classify: (item: T) => ModerationState;
  /** Stable id per item. Items already served are dropped if a later page repeats them. */
  getKey?: (item: T) => string;
  /** Cap on pages fetched per load() while looking for enough items of one state. Default 3. */
  maxPagesPerLoad?: number;
}

/**
 * Turns one paged, mixed feed into two classified pools. Frames drain the pool that matches their kind.
 * Pages fetched while hunting for one state are kept for the other, so nothing is wasted.
 */
export function createPooledSource<T>(options: PooledSourceOptions<T>): FeedSource<T> {
  const { fetchPage, classify, getKey, maxPagesPerLoad = 3 } = options;
  const seen = new Set<string>();
  const pools: Record<ModerationState, T[]> = { SAFE: [], WILD: [] };
  let cursor: string | null = null;
  let serverDone = false;

  async function fetchNext(): Promise<void> {
    const page = await fetchPage(cursor); // throws leave cursor and pools untouched
    for (const item of page.items) {
      if (getKey) {
        const key = getKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
      }
      pools[classify(item)].push(item);
    }
    cursor = page.nextCursor;
    if (!page.hasMore || page.nextCursor === null) serverDone = true;
  }

  return {
    async load(moderation, limit) {
      let pages = 0;
      while (pools[moderation].length < limit && !serverDone && pages < maxPagesPerLoad) {
        await fetchNext();
        pages++;
      }
      const items = pools[moderation].splice(0, limit);
      return { items, done: serverDone && pools[moderation].length === 0 };
    },
  };
}
