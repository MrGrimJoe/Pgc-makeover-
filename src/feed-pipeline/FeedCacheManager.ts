/**
 * Local feed cache and history for one signed-in person and one feed mode, kept in IndexedDB on the phone.
 *
 *  - bulk-writes the batches the server packages (/api/v1/feed/bootstrap and /next);
 *  - remembers which posts were viewed, in the order they were first viewed, so scrolling back up (and the next
 *    visit) reads history from the phone with no network call;
 *  - pre-fetches the next batch in the background when the unseen stock runs low;
 *  - keeps working with no connection by reading what is already stored;
 *  - forgets posts the moment they expire, and everything for a person on sign-out (`clear()`).
 *
 * It knows nothing about ranking or frames. If IndexedDB is missing or fails (some private modes), it falls back to
 * memory for the rest of the session instead of breaking the feed.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import {
  BATCH_SIZE_DEFAULT,
  LOW_WATER_MARK,
  isFeedBatchResponse,
  type FeedBatchResponse,
  type PipelineMode,
  type PipelinePost,
} from '../../shared/feed-pipeline.ts';

export const FEED_DB_NAME = 'pgc-feed-cache';
const DB_VERSION = 1;
const FALLBACK_TTL_MS = 14 * 24 * 3_600_000;
/** A stored feed younger than this is used as it is. Older, the newest posts are fetched before the feed is shown. */
export const DEFAULT_FRESH_MS = 60_000;
/** How long opening the feed waits for that refresh before showing what is stored (the refresh carries on behind it). */
export const DEFAULT_STALE_WAIT_MS = 2_500;

export interface CachedPostRecord {
  /** `${userId}|${mode}|${postId}` */
  key: string;
  userId: string;
  mode: PipelineMode;
  postId: string;
  post: PipelinePost;
  batchId: string;
  fetchedAt: number;
  expiresAtMs: number;
  /** Order of first view (1, 2, 3 ...). Null until the post has been viewed. */
  viewSeq: number | null;
  viewedAt: number | null;
  viewCount: number;
  dwellMs: number;
}

export interface ScopeMeta {
  /** `${userId}|${mode}` */
  key: string;
  userId: string;
  mode: PipelineMode;
  nextCursor: string | null;
  /** True until the server says there is nothing older. */
  hasMore: boolean;
  /** Last view sequence number handed out. */
  seq: number;
  bootstrappedAt: number | null;
  /** True when a refresh is owed regardless of how much is stored (the person posted). Cleared by the next bootstrap. */
  dirty?: boolean;
  /** Hot topics from the latest batch, for local ranking. */
  trending: Record<string, number>;
}

export interface BatchFetchParams {
  mode: PipelineMode;
  cursor: string | null;
  size: number;
}
export type BatchFetcher = (kind: 'bootstrap' | 'next', params: BatchFetchParams) => Promise<FeedBatchResponse>;

export class FeedHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'FeedHttpError';
  }
}

/** No connection (or the server could not be reached) and nothing usable is stored on this phone. */
export class FeedUnavailableError extends Error {
  constructor(message = 'You are offline and no posts are saved on this phone yet.') {
    super(message);
    this.name = 'FeedUnavailableError';
  }
}

/** The real fetcher. The browser decompresses the gzip body before `.json()` sees it. */
export const httpBatchFetcher: BatchFetcher = async (kind, { mode, cursor, size }) => {
  const params = new URLSearchParams({ mode, size: String(size) });
  if (cursor) params.set('cursor', cursor);
  const res = await fetch(`/api/v1/feed/${kind}?${params.toString()}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new FeedHttpError(res.status, data.error || 'Failed to load posts');
  }
  const data: unknown = await res.json();
  if (!isFeedBatchResponse(data)) throw new Error('Unexpected feed response');
  return data;
};

// ------------------------------------------------------------------------------------------------ storage backends

interface Backend {
  readonly kind: 'indexeddb' | 'memory';
  readScope(userId: string, mode: PipelineMode): Promise<CachedPostRecord[]>;
  readUser(userId: string): Promise<CachedPostRecord[]>;
  putRecords(records: CachedPostRecord[]): Promise<void>;
  deleteRecords(keys: string[]): Promise<void>;
  getMeta(key: string): Promise<ScopeMeta | undefined>;
  putMeta(meta: ScopeMeta): Promise<void>;
  deleteUser(userId: string): Promise<void>;
  close(): void;
}

interface FeedDB extends DBSchema {
  posts: {
    key: string;
    value: CachedPostRecord;
    indexes: { byScope: [string, string]; byUser: string };
  };
  meta: { key: string; value: ScopeMeta };
}

class IdbBackend implements Backend {
  readonly kind = 'indexeddb' as const;
  constructor(private readonly db: IDBPDatabase<FeedDB>) {}

  static async open(name: string, onLost: () => void): Promise<IdbBackend> {
    const db = await openDB<FeedDB>(name, DB_VERSION, {
      upgrade(d) {
        const posts = d.createObjectStore('posts', { keyPath: 'key' });
        posts.createIndex('byScope', ['userId', 'mode']);
        posts.createIndex('byUser', 'userId');
        d.createObjectStore('meta', { keyPath: 'key' });
      },
      blocking() {
        // another tab wants to upgrade the database: let it
        onLost();
      },
      terminated: onLost,
    });
    return new IdbBackend(db);
  }

  readScope(userId: string, mode: PipelineMode) {
    return this.db.getAllFromIndex('posts', 'byScope', [userId, mode]);
  }
  readUser(userId: string) {
    return this.db.getAllFromIndex('posts', 'byUser', userId);
  }
  async putRecords(records: CachedPostRecord[]) {
    const tx = this.db.transaction('posts', 'readwrite');
    await Promise.all([...records.map((r) => tx.store.put(r)), tx.done]);
  }
  async deleteRecords(keys: string[]) {
    const tx = this.db.transaction('posts', 'readwrite');
    await Promise.all([...keys.map((k) => tx.store.delete(k)), tx.done]);
  }
  getMeta(key: string) {
    return this.db.get('meta', key);
  }
  async putMeta(meta: ScopeMeta) {
    await this.db.put('meta', meta);
  }
  async deleteUser(userId: string) {
    const tx = this.db.transaction(['posts', 'meta'], 'readwrite');
    const keys = await tx.objectStore('posts').index('byUser').getAllKeys(userId);
    await Promise.all([
      ...keys.map((k) => tx.objectStore('posts').delete(k)),
      tx.objectStore('meta').delete(`${userId}|for_you`),
      tx.objectStore('meta').delete(`${userId}|following`),
      tx.done,
    ]);
  }
  close() {
    this.db.close();
  }
}

class MemoryBackend implements Backend {
  readonly kind = 'memory' as const;
  private posts = new Map<string, CachedPostRecord>();
  private metas = new Map<string, ScopeMeta>();

  async readScope(userId: string, mode: PipelineMode) {
    return [...this.posts.values()].filter((r) => r.userId === userId && r.mode === mode).map((r) => structuredClone(r));
  }
  async readUser(userId: string) {
    return [...this.posts.values()].filter((r) => r.userId === userId).map((r) => structuredClone(r));
  }
  async putRecords(records: CachedPostRecord[]) {
    for (const r of records) this.posts.set(r.key, structuredClone(r));
  }
  async deleteRecords(keys: string[]) {
    for (const k of keys) this.posts.delete(k);
  }
  async getMeta(key: string) {
    const m = this.metas.get(key);
    return m ? structuredClone(m) : undefined;
  }
  async putMeta(meta: ScopeMeta) {
    this.metas.set(meta.key, structuredClone(meta));
  }
  async deleteUser(userId: string) {
    for (const [k, r] of this.posts) if (r.userId === userId) this.posts.delete(k);
    for (const [k, m] of this.metas) if (m.userId === userId) this.metas.delete(k);
  }
  close() {
    /* nothing to release */
  }
}

// ------------------------------------------------------------------------------------------------ the manager

export interface FeedCacheOptions {
  userId: string;
  mode: PipelineMode;
  fetchBatch?: BatchFetcher;
  /** Posts to ask for per batch (the server clamps to 30..50). */
  batchSize?: number;
  /**
   * The request limiter: the server is asked for more posts only when fewer than this many unseen posts are stored
   * (default 15). It covers the background pre-fetch and the refresh of an old cache when the feed opens. It does not
   * cover the first request on a cold cache (that always asks for a full batch), a refresh after the person posts, or
   * a page that cannot be filled from what is stored. So the server is asked slowly, as the stored posts are used up.
   */
  lowWaterMark?: number;
  /** A cache bootstrapped this recently is used as it is, with no server call at start. Default 5 minutes. */
  freshMs?: number;
  /** How long `start()` waits for a refresh of a stale cache before showing what is stored. Default 2.5 seconds. */
  staleWaitMs?: number;
  /** Cap on stored posts per mode. Only viewed (history) posts are evicted, oldest first. Default 400. */
  maxRecords?: number;
  /** After a failed background fetch, wait this long before trying again. Default 15 s. */
  retryBackoffMs?: number;
  dbName?: string;
  isOnline?: () => boolean;
  now?: () => number;
  /** 'memory' skips IndexedDB entirely (tests, unsupported browsers). */
  storage?: 'auto' | 'memory';
}

export interface StartResult {
  source: 'network' | 'cache';
  /** True when the cache is older than `freshMs` or the server could not be reached. */
  stale: boolean;
}

export interface HistoryEntry {
  post: PipelinePost;
  viewSeq: number;
  viewedAt: number;
}

export interface HistoryFrame {
  /** In the order they were originally shown. */
  items: PipelinePost[];
  firstSeq: number;
  lastSeq: number;
}

export interface CacheStats {
  unviewed: number;
  viewed: number;
  total: number;
  backend: 'indexeddb' | 'memory';
  hasMore: boolean;
  bootstrappedAt: number | null;
}

export class FeedCacheManager {
  readonly userId: string;
  readonly mode: PipelineMode;

  private readonly fetcher: BatchFetcher;
  private readonly batchSize: number;
  private readonly lowWater: number;
  private readonly freshMs: number;
  private readonly staleWaitMs: number;
  private readonly maxRecords: number;
  private readonly backoffMs: number;
  private readonly dbName: string;
  private readonly onlineFn: () => boolean;
  private readonly nowFn: () => number;
  private readonly forceMemory: boolean;

  private backendPromise: Promise<Backend> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private net: Promise<number> | null = null;
  private prefetching: Promise<boolean> | null = null;
  private lastFailureAt = -Infinity;
  private dataVersion = 0;

  constructor(options: FeedCacheOptions) {
    this.userId = options.userId;
    this.mode = options.mode;
    this.fetcher = options.fetchBatch ?? httpBatchFetcher;
    this.batchSize = options.batchSize ?? BATCH_SIZE_DEFAULT;
    this.lowWater = options.lowWaterMark ?? LOW_WATER_MARK;
    this.freshMs = options.freshMs ?? DEFAULT_FRESH_MS;
    this.staleWaitMs = options.staleWaitMs ?? DEFAULT_STALE_WAIT_MS;
    this.maxRecords = options.maxRecords ?? 400;
    this.backoffMs = options.retryBackoffMs ?? 15_000;
    this.dbName = options.dbName ?? FEED_DB_NAME;
    this.onlineFn = options.isOnline ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);
    this.nowFn = options.now ?? (() => Date.now());
    this.forceMemory = options.storage === 'memory';
  }

  /** Goes up every time a batch is written. A ranking built from the cache is out of date when this changes. */
  get version(): number {
    return this.dataVersion;
  }

  // ---------------------------------------------------------------- plumbing

  private openBackend(): Promise<Backend> {
    if (!this.backendPromise) {
      this.backendPromise = (async (): Promise<Backend> => {
        if (this.forceMemory || typeof indexedDB === 'undefined') return new MemoryBackend();
        try {
          return await IdbBackend.open(this.dbName, () => this.degrade());
        } catch {
          return new MemoryBackend();
        }
      })();
    }
    return this.backendPromise;
  }

  private degrade(): void {
    this.backendPromise = Promise.resolve(new MemoryBackend());
  }

  /** Runs `op` on the backend. If IndexedDB itself fails, continues on memory so the feed keeps working. */
  private async run<T>(op: (b: Backend) => Promise<T>): Promise<T> {
    const backend = await this.openBackend();
    try {
      return await op(backend);
    } catch (error) {
      if (backend.kind === 'memory') throw error;
      this.degrade();
      return op(await this.openBackend());
    }
  }

  /** One storage change at a time, so a read-modify-write can never interleave with another. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.catch(() => undefined).then(fn);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private metaKey(): string {
    return `${this.userId}|${this.mode}`;
  }

  private async readMeta(b: Backend): Promise<ScopeMeta> {
    return (
      (await b.getMeta(this.metaKey())) ?? {
        key: this.metaKey(),
        userId: this.userId,
        mode: this.mode,
        nextCursor: null,
        hasMore: true,
        seq: 0,
        bootstrappedAt: null,
        trending: {},
      }
    );
  }

  private online(): boolean {
    return this.onlineFn();
  }

  /** The cache's clock (injectable for tests), so everything that judges the age of a post uses the same time. */
  now(): number {
    return this.nowFn();
  }

  /** Whether the phone currently reports a connection. */
  isOnline(): boolean {
    return this.onlineFn();
  }

  // ---------------------------------------------------------------- network

  private fetchAndApply(kind: 'bootstrap' | 'next', cursor: string | null): Promise<number> {
    if (this.net) return this.net; // one request at a time; callers re-check the pool afterwards
    if (!this.online()) return Promise.reject(new FeedUnavailableError('You are offline.'));
    const p: Promise<number> = (async () => {
      const resp = await this.fetcher(kind, { mode: this.mode, cursor, size: this.batchSize });
      if (resp.mode !== this.mode) throw new Error('Feed response is for a different feed');
      return this.applyBatch(resp);
    })().finally(() => {
      if (this.net === p) this.net = null;
    });
    this.net = p;
    return p;
  }

  /** Asks the server for the newest batch and merges it in. Resolves with the number of new posts. */
  bootstrap(): Promise<number> {
    return this.fetchAndApply('bootstrap', null);
  }

  /** Fetches the next older batch. Resolves with the number of new posts (0 when there is nothing older). */
  async loadMore(): Promise<number> {
    const meta = await this.run((b) => this.readMeta(b));
    if (!meta.hasMore) return 0;
    if (!meta.nextCursor) return this.bootstrap();
    return this.fetchAndApply('next', meta.nextCursor);
  }

  /**
   * Background pre-fetch. Does nothing when enough unseen posts are stored, when the server has nothing older,
   * when offline, or right after a failure. Never throws. Resolves true when it fetched a batch.
   * Pass `unseen` when the caller already knows how many are left (it avoids re-reading the cache).
   */
  prefetchIfLow(unseen?: number): Promise<boolean> {
    // Claimed synchronously: simultaneous callers share one attempt instead of each passing the checks first.
    if (this.prefetching) return this.prefetching;
    const attempt = (async () => {
      try {
        if (this.net) return false;
        const meta = await this.run((b) => this.readMeta(b));
        if (!meta.hasMore || !meta.nextCursor) return false;
        if (!this.online() || this.nowFn() - this.lastFailureAt < this.backoffMs) return false;
        const left = unseen ?? (await this.getPool()).length;
        if (left >= this.lowWater) return false;
        await this.fetchAndApply('next', meta.nextCursor);
        return true;
      } catch {
        this.lastFailureAt = this.nowFn();
        return false;
      }
    })().finally(() => {
      if (this.prefetching === attempt) this.prefetching = null;
    });
    this.prefetching = attempt;
    return attempt;
  }

  /** Tries to catch up as soon as the phone gets its connection back. Returns a function that stops listening. */
  watchConnectivity(): () => void {
    if (typeof window === 'undefined') return () => undefined;
    const onOnline = () => {
      this.lastFailureAt = -Infinity;
      void this.prefetchIfLow();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }

  // ---------------------------------------------------------------- writing

  private applyBatch(resp: FeedBatchResponse): Promise<number> {
    return this.serial(() =>
      this.run(async (b) => {
        const now = this.nowFn();
        const existing = new Map((await b.readScope(this.userId, this.mode)).map((r) => [r.key, r]));
        const fresh: CachedPostRecord[] = [];
        let added = 0;
        for (const post of resp.batch.posts) {
          const key = `${this.userId}|${this.mode}|${post.id}`;
          const prev = existing.get(key);
          const parsed = Date.parse(post.expires_at);
          const expiresAtMs = Number.isFinite(parsed) ? parsed : now + FALLBACK_TTL_MS;
          if (expiresAtMs <= now) continue; // already expired: never stored
          if (!prev) added++;
          fresh.push({
            key,
            userId: this.userId,
            mode: this.mode,
            postId: post.id,
            post,
            batchId: resp.batch.id,
            fetchedAt: now,
            expiresAtMs,
            // what the person already did with this post survives a refresh of its data
            viewSeq: prev?.viewSeq ?? null,
            viewedAt: prev?.viewedAt ?? null,
            viewCount: prev?.viewCount ?? 0,
            dwellMs: prev?.dwellMs ?? 0,
          });
        }
        await b.putRecords(fresh);

        const meta = await this.readMeta(b);
        meta.trending = resp.trending;
        meta.nextCursor = resp.batch.nextCursor;
        meta.hasMore = resp.batch.hasMore;
        if (resp.kind === 'bootstrap') {
          meta.bootstrappedAt = now;
          delete meta.dirty;
        }
        await b.putMeta(meta);

        // Bound the history. Unseen posts are never evicted: they are what the feed still has to show.
        const all = new Map(existing);
        for (const r of fresh) all.set(r.key, r);
        const overflow = all.size - this.maxRecords;
        if (overflow > 0) {
          const oldestViewed = [...all.values()]
            .filter((r) => r.viewSeq !== null)
            .sort((x, y) => x.viewSeq! - y.viewSeq!)
            .slice(0, overflow);
          await b.deleteRecords(oldestViewed.map((r) => r.key));
        }
        this.dataVersion++;
        return added;
      }),
    );
  }

  /**
   * Marks posts as viewed (call it with a frame's posts when that frame comes into focus). The first view fixes the
   * post's place in the history; later calls only add to its view count. Unknown ids are ignored.
   */
  markViewed(ids: readonly string[]): Promise<number> {
    return this.touch(ids.map((id) => ({ id })), true);
  }

  /** Adds measured on-screen time to posts (a post not yet marked viewed becomes viewed). Does not count as a new view. */
  recordDwell(entries: ReadonlyArray<{ id: string; dwellMs: number }>): Promise<number> {
    return this.touch(entries, false);
  }

  private touch(entries: ReadonlyArray<{ id: string; dwellMs?: number }>, countView: boolean): Promise<number> {
    if (entries.length === 0) return Promise.resolve(0);
    return this.serial(() =>
      this.run(async (b) => {
        const now = this.nowFn();
        const records = new Map((await b.readScope(this.userId, this.mode)).map((r) => [r.postId, r]));
        const meta = await this.readMeta(b);
        const touched = new Map<string, CachedPostRecord>();
        for (const e of entries) {
          const rec = records.get(e.id);
          if (!rec) continue;
          if (!touched.has(e.id)) {
            if (rec.viewSeq === null) {
              rec.viewSeq = ++meta.seq;
              rec.viewedAt = now;
              rec.viewCount = 1;
            } else if (countView) {
              rec.viewCount++;
            }
            touched.set(e.id, rec);
          }
          rec.dwellMs += Math.max(0, e.dwellMs ?? 0);
        }
        if (touched.size === 0) return 0;
        await b.putRecords([...touched.values()]);
        await b.putMeta(meta);
        return touched.size;
      }),
    );
  }

  // ---------------------------------------------------------------- reading

  /** Posts not viewed yet and not expired, newest first. This is what local ranking starts from. */
  async getPool(): Promise<PipelinePost[]> {
    const now = this.nowFn();
    const records = await this.run((b) => b.readScope(this.userId, this.mode));
    return records
      .filter((r) => r.viewSeq === null && r.expiresAtMs > now)
      .sort((a, b) => b.post.meta.timestamp - a.post.meta.timestamp || (a.postId < b.postId ? 1 : -1))
      .map((r) => r.post);
  }

  async getTrending(): Promise<Record<string, number>> {
    return (await this.run((b) => this.readMeta(b))).trending;
  }

  async hasMore(): Promise<boolean> {
    return (await this.run((b) => this.readMeta(b))).hasMore;
  }

  /** Viewed posts, most recently first-viewed first. Reads only from the phone. */
  async getHistory(opts: { limit?: number; beforeSeq?: number } = {}): Promise<HistoryEntry[]> {
    const { limit = 50, beforeSeq } = opts;
    const now = this.nowFn();
    const records = await this.run((b) => b.readScope(this.userId, this.mode));
    return records
      .filter((r) => r.viewSeq !== null && r.expiresAtMs > now && (beforeSeq === undefined || r.viewSeq < beforeSeq))
      .sort((a, b) => b.viewSeq! - a.viewSeq!)
      .slice(0, Math.max(0, limit))
      .map((r) => ({ post: r.post, viewSeq: r.viewSeq!, viewedAt: r.viewedAt ?? 0 }));
  }

  /**
   * History grouped into frames for scrolling back up, nearest first. Items inside a frame keep the order they
   * were shown in. Continue upward with `beforeSeq` set to the last returned frame's `firstSeq`.
   */
  async getHistoryFrames(opts: { frameSize?: number; frames?: number; beforeSeq?: number } = {}): Promise<HistoryFrame[]> {
    const { frameSize = 8, frames = 3, beforeSeq } = opts;
    const size = Math.max(1, Math.floor(frameSize));
    const entries = await this.getHistory({ limit: size * Math.max(1, frames), beforeSeq });
    const out: HistoryFrame[] = [];
    for (let i = 0; i < entries.length; i += size) {
      const chunk = entries.slice(i, i + size).reverse();
      out.push({ items: chunk.map((e) => e.post), firstSeq: chunk[0]!.viewSeq, lastSeq: chunk[chunk.length - 1]!.viewSeq });
    }
    return out;
  }

  /** Everything the feed can show with no connection: unseen posts first, then history. One read. */
  async readOffline(): Promise<{ unviewed: PipelinePost[]; history: PipelinePost[]; trending: Record<string, number> }> {
    const now = this.nowFn();
    const [records, meta] = await this.run(async (b) => [await b.readScope(this.userId, this.mode), await this.readMeta(b)] as const);
    const live = records.filter((r) => r.expiresAtMs > now);
    return {
      unviewed: live
        .filter((r) => r.viewSeq === null)
        .sort((a, b) => b.post.meta.timestamp - a.post.meta.timestamp)
        .map((r) => r.post),
      history: live
        .filter((r) => r.viewSeq !== null)
        .sort((a, b) => b.viewSeq! - a.viewSeq!)
        .map((r) => r.post),
      trending: meta.trending,
    };
  }

  async getStats(): Promise<CacheStats> {
    const now = this.nowFn();
    const [records, meta] = await this.run(async (b) => [await b.readScope(this.userId, this.mode), await this.readMeta(b)] as const);
    const live = records.filter((r) => r.expiresAtMs > now);
    const viewed = live.filter((r) => r.viewSeq !== null).length;
    return {
      unviewed: live.length - viewed,
      viewed,
      total: live.length,
      backend: (await this.openBackend()).kind, // after run(), so a fallback to memory shows up here
      hasMore: meta.hasMore,
      bootstrappedAt: meta.bootstrappedAt,
    };
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Gets the feed ready. A cold cache asks the server for a full batch. A stored feed is used as it is while it holds
   * enough unseen posts (`lowWaterMark`); the server is asked for more only when the stock is low and the stored feed
   * is older than `freshMs`, or when a refresh is owed because the person posted (`markStale`). Such a refresh is done
   * before the feed is shown, waiting at most `staleWaitMs`; after that, or with no connection, the stored posts are
   * shown and the refresh carries on behind them. Only throws when there is nothing at all to show.
   */
  async start(): Promise<StartResult> {
    await this.purgeExpired();
    const meta = await this.run((b) => this.readMeta(b));
    const age = meta.bootstrappedAt === null ? Infinity : this.nowFn() - meta.bootstrappedAt;
    const pool = await this.getPool();
    if (pool.length > 0) {
      const aged = age > this.freshMs;
      const owed = meta.dirty === true;
      const stockLow = pool.length < this.lowWater;
      if (!owed && !(aged && stockLow)) return { source: 'cache', stale: aged }; // enough stored: no request
      if (!this.online()) return { source: 'cache', stale: true };
      const refresh = this.bootstrap().then(
        () => true,
        () => {
          this.lastFailureAt = this.nowFn();
          return false; // the stored posts are still shown (a signed-out answer is picked up by the next request)
        },
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wait = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), this.staleWaitMs);
      });
      const refreshed = await Promise.race([refresh, wait]).finally(() => clearTimeout(timer));
      return { source: 'cache', stale: !refreshed };
    }
    try {
      await this.bootstrap();
      return { source: 'network', stale: false };
    } catch (error) {
      if (error instanceof FeedHttpError && (error.status === 401 || error.status === 403)) throw error;
      if ((await this.getStats()).total > 0) return { source: 'cache', stale: true }; // history only: still something to show
      if (error instanceof FeedHttpError) throw error;
      throw new FeedUnavailableError(
        error instanceof FeedUnavailableError
          ? undefined
          : 'Could not reach the server and no posts are saved on this phone yet.',
      );
    }
  }

  /**
   * Makes the next `start()` fetch the newest posts first, even if the cache is young and holds plenty (the limiter
   * does not apply). Call it when something the person did changes what the feed should show (they posted). Kept in
   * storage, so it survives a reload. Does nothing for a scope with nothing stored (that one starts cold anyway).
   */
  markStale(): Promise<void> {
    return this.serial(() =>
      this.run(async (b) => {
        const meta = await b.getMeta(this.metaKey());
        if (!meta) return;
        meta.dirty = true;
        await b.putMeta(meta);
      }),
    );
  }

  /** Deletes every stored post and cursor of expired posts (all feed modes for this person). */
  purgeExpired(): Promise<number> {
    return this.serial(() =>
      this.run(async (b) => {
        const now = this.nowFn();
        const gone = (await b.readUser(this.userId)).filter((r) => r.expiresAtMs <= now).map((r) => r.key);
        if (gone.length > 0) await b.deleteRecords(gone);
        return gone.length;
      }),
    );
  }

  /** Forgets everything stored for this person, in every feed mode. Call it on sign-out. */
  clear(): Promise<void> {
    return this.serial(() =>
      this.run(async (b) => {
        await b.deleteUser(this.userId);
        this.dataVersion++;
      }),
    );
  }

  /** Closes the database connection. The manager can still be used; it reopens on demand. */
  async destroy(): Promise<void> {
    const pending = this.backendPromise;
    this.backendPromise = null;
    if (pending) (await pending).close();
  }
}
