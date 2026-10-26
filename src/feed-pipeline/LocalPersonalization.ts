/**
 * Re-ranks the posts cached on the phone using only what this person did on this phone (tags clicked, how long
 * posts were looked at, likes, "show less") plus the trending weights the server sent with the batch.
 * Nothing here talks to the server, so it can run on every frame and works offline.
 *
 *   score = 0.40 preference + 0.25 trending + 0.20 recency + 0.15 engagement   (minus a penalty for posts already seen)
 *
 * Preferences are per tag, decay with a 14 day half-life and are kept in localStorage, one entry per signed-in
 * person, so two accounts on one phone never share them.
 */
import type { PipelinePost } from '../../shared/feed-pipeline.ts';

export type InteractionKind = 'like' | 'comment' | 'more_like_this' | 'show_less' | 'not_interested';

export interface PersonalizationConfig {
  weights: { preference: number; trending: number; recency: number; engagement: number };
  /** How long it takes a stored preference to lose half its strength. */
  halfLifeMs: number;
  /** A post fades to zero recency after this long. */
  recencyWindowMs: number;
  /** A view shorter than this teaches nothing. */
  viewThresholdMs: number;
  /** Subtracted from the score of a post the viewer has already seen. */
  seenPenalty: number;
  /** Subtracted per same-author post among the last three picks. */
  authorRepeatPenalty: number;
  maxTags: number;
  weightMin: number;
  weightMax: number;
  deltas: Record<InteractionKind, number> & { tagClick: number; viewMin: number; viewMax: number };
}

export const DEFAULT_PERSONALIZATION: PersonalizationConfig = {
  weights: { preference: 0.4, trending: 0.25, recency: 0.2, engagement: 0.15 },
  halfLifeMs: 14 * 86_400_000,
  recencyWindowMs: 7 * 86_400_000,
  viewThresholdMs: 3000,
  seenPenalty: 0.5,
  authorRepeatPenalty: 0.15,
  maxTags: 200,
  weightMin: -10,
  weightMax: 25,
  // the same steps the server's For You feed uses for its own signals
  deltas: { like: 1, comment: 3, more_like_this: 3, show_less: -3, not_interested: -4, tagClick: 1.5, viewMin: 0.1, viewMax: 0.6 },
};

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface RankContext {
  /** Hot topic slug -> 0..1 (the batch envelope's `trending`). */
  trending?: Readonly<Record<string, number>>;
  /** Post ids the viewer has already seen. */
  seen?: ReadonlySet<string>;
  now?: number;
}

export interface ScoreBreakdown {
  preference: number;
  trending: number;
  recency: number;
  engagement: number;
  seen: boolean;
  total: number;
}

export interface LocalPersonalizationOptions {
  userId: string;
  /** Defaults to localStorage when it exists and works, otherwise memory only. */
  storage?: StorageLike | null;
  now?: () => number;
  config?: Partial<PersonalizationConfig>;
}

interface StoredPrefs {
  v: 1;
  /** tag -> [weight at time t, t] */
  tags: Record<string, [number, number]>;
}

const MAX_TAG_LENGTH = 40;

export function normalizeTag(tag: string): string | null {
  const t = tag.trim().replace(/^#+/, '').toLowerCase();
  return t.length > 0 && t.length <= MAX_TAG_LENGTH ? t : null;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // some browsers throw just for touching localStorage
  }
}

export class LocalPersonalization {
  private readonly key: string;
  private readonly storage: StorageLike | null;
  private readonly nowFn: () => number;
  private readonly cfg: PersonalizationConfig;
  private tags = new Map<string, { w: number; t: number }>();

  constructor(options: LocalPersonalizationOptions) {
    this.key = `pgc:feed-prefs:v1:${options.userId}`;
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.nowFn = options.now ?? (() => Date.now());
    this.cfg = {
      ...DEFAULT_PERSONALIZATION,
      ...options.config,
      weights: { ...DEFAULT_PERSONALIZATION.weights, ...options.config?.weights },
      deltas: { ...DEFAULT_PERSONALIZATION.deltas, ...options.config?.deltas },
    };
    this.load();
  }

  // ---------------------------------------------------------------- storage

  private load(): void {
    try {
      const raw = this.storage?.getItem(this.key);
      if (!raw) return;
      const data = JSON.parse(raw) as Partial<StoredPrefs>;
      if (data.v !== 1 || !data.tags || typeof data.tags !== 'object') return;
      for (const [tag, entry] of Object.entries(data.tags)) {
        const [w, t] = entry as [unknown, unknown];
        if (typeof w === 'number' && typeof t === 'number' && Number.isFinite(w) && Number.isFinite(t)) {
          this.tags.set(tag, { w, t });
        }
      }
    } catch {
      this.tags.clear(); // corrupt entry: start clean rather than break the feed
    }
  }

  private save(): void {
    try {
      const tags: StoredPrefs['tags'] = {};
      for (const [tag, e] of this.tags) tags[tag] = [Math.round(e.w * 1000) / 1000, e.t];
      this.storage?.setItem(this.key, JSON.stringify({ v: 1, tags } satisfies StoredPrefs));
    } catch {
      /* quota or private mode: keep working from memory */
    }
  }

  // ---------------------------------------------------------------- learning

  private decayed(e: { w: number; t: number }, now: number): number {
    return e.w * Math.pow(0.5, Math.max(0, now - e.t) / this.cfg.halfLifeMs);
  }

  private bump(rawTags: readonly string[], delta: number): void {
    const now = this.nowFn();
    for (const raw of rawTags) {
      const tag = normalizeTag(raw);
      if (!tag) continue;
      const current = this.tags.get(tag);
      const base = current ? this.decayed(current, now) : 0;
      const w = Math.min(this.cfg.weightMax, Math.max(this.cfg.weightMin, base + delta));
      this.tags.set(tag, { w, t: now });
    }
    if (this.tags.size > this.cfg.maxTags) {
      const strongest = [...this.tags.entries()]
        .sort((a, b) => Math.abs(this.decayed(b[1], now)) - Math.abs(this.decayed(a[1], now)))
        .slice(0, this.cfg.maxTags);
      this.tags = new Map(strongest);
    }
    this.save();
  }

  /** The person tapped a tag or hashtag. */
  recordTagClick(tag: string): void {
    this.bump([tag], this.cfg.deltas.tagClick);
  }

  /** The person looked at a post for `dwellMs`. Fly-bys under the threshold teach nothing. */
  recordView(post: Pick<PipelinePost, 'meta'>, dwellMs: number): void {
    const { viewThresholdMs: min, deltas } = this.cfg;
    if (!(dwellMs >= min)) return;
    const t = Math.min(1, (dwellMs - min) / 12_000); // full strength at 15 s
    this.bump(post.meta.tags, deltas.viewMin + (deltas.viewMax - deltas.viewMin) * t);
  }

  /** Mirrors the server's own feedback steps: like +1, comment +3, more like this +3, show less -3, not interested -4. */
  recordInteraction(post: Pick<PipelinePost, 'meta'>, kind: InteractionKind): void {
    this.bump(post.meta.tags, this.cfg.deltas[kind]);
  }

  /** What has been learned so far, strongest first, decayed to now. */
  getTagWeights(): Record<string, number> {
    const now = this.nowFn();
    return Object.fromEntries(
      [...this.tags.entries()]
        .map(([tag, e]) => [tag, Math.round(this.decayed(e, now) * 1000) / 1000] as const)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])),
    );
  }

  reset(): void {
    this.tags.clear();
    try {
      this.storage?.removeItem(this.key);
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------- scoring

  scorePost(post: PipelinePost, ctx: RankContext = {}): ScoreBreakdown {
    const now = ctx.now ?? this.nowFn();
    const { weights: w } = this.cfg;

    const tagWeights = post.meta.tags
      .map((raw) => normalizeTag(raw))
      .filter((t): t is string => t !== null)
      .map((t) => {
        const e = this.tags.get(t);
        return e ? this.decayed(e, now) : 0;
      });
    const top = tagWeights.filter((x) => x > 0).sort((a, b) => b - a).slice(0, 3).reduce((s, x) => s + x, 0);
    const worst = Math.min(0, ...tagWeights); // one disliked tag is enough to push a post down
    const preference = Math.tanh((top + worst) / 6);

    let hot = 0;
    for (const raw of post.meta.tags) hot = Math.max(hot, ctx.trending?.[raw] ?? 0);
    const trending = Math.min(1, Math.max(post.meta.trendingScore, hot));

    const recency = Math.min(1, Math.max(0, 1 - (now - post.meta.timestamp) / this.cfg.recencyWindowMs));
    const engagement = Math.min(1, Math.log1p(Math.max(0, post.meta.likesCount)) / Math.log1p(30));
    const seen = ctx.seen?.has(post.id) ?? false;

    const total =
      w.preference * preference + w.trending * trending + w.recency * recency + w.engagement * engagement - (seen ? this.cfg.seenPenalty : 0);
    return { preference, trending, recency, engagement, seen, total };
  }

  /**
   * Best first. Deterministic: ties fall back to newer first, then id. After scoring, a light pass keeps one author
   * from filling several slots in a row.
   */
  rankWithScores(posts: readonly PipelinePost[], ctx: RankContext = {}): Array<{ post: PipelinePost; score: ScoreBreakdown }> {
    const now = ctx.now ?? this.nowFn();
    const scored = posts
      .map((post) => ({ post, score: this.scorePost(post, { ...ctx, now }) }))
      .sort(
        (a, b) =>
          b.score.total - a.score.total ||
          b.post.meta.timestamp - a.post.meta.timestamp ||
          (a.post.id < b.post.id ? -1 : a.post.id > b.post.id ? 1 : 0),
      );

    const out: typeof scored = [];
    const rest = scored.slice();
    const LOOKAHEAD = 60;
    while (rest.length > 0) {
      const recentAuthors = out.slice(-3).map((e) => e.post.author_id);
      let bestIndex = 0;
      let best = -Infinity;
      for (let i = 0; i < Math.min(rest.length, LOOKAHEAD); i++) {
        const c = rest[i]!;
        const repeats = recentAuthors.filter((a) => a === c.post.author_id).length;
        const adjusted = c.score.total - repeats * this.cfg.authorRepeatPenalty;
        if (adjusted > best) {
          best = adjusted;
          bestIndex = i;
        }
      }
      out.push(rest.splice(bestIndex, 1)[0]!);
    }
    return out;
  }

  rank(posts: readonly PipelinePost[], ctx: RankContext = {}): PipelinePost[] {
    return this.rankWithScores(posts, ctx).map((e) => e.post);
  }
}
