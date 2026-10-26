import type { D1Database } from '@cloudflare/workers-types';
import { generateRandomString } from './auth.ts';
import { computeDecayedWeight } from './ranking/decay.ts';
import { RANKING_CONFIG } from './ranking/config.ts';

/**
 * Recording what a student looked at, built for the Cloudflare free plan:
 *  - a Worker invocation may run at most 50 D1 queries there, and the old loop used 2 to 9 PER POST, so a
 *    normal batch of 10 views failed half way;
 *  - every D1 row written counts against 100,000 per day.
 * This version always uses the same handful of queries, however many posts are in the batch.
 */
export const MAX_IMPRESSIONS_PER_REQUEST = 20;
/** A viewer is counted once per post per hour. */
export const IMPRESSION_DEDUPE_MS = 60 * 60 * 1000;
/** A view this long strengthens the post's topics for this viewer. */
export const LONG_VIEW_MS = 3000;
const LONG_VIEW_DELTA = 0.1;
/** 4 bound values per row, so 24 rows stay under D1's limit of 100 bound parameters per query. */
const MAX_TOPICS_PER_REQUEST = 24;

export interface ImpressionInput {
  post_id?: unknown;
  position?: unknown;
  duration_ms?: unknown;
}

interface CleanImpression {
  postId: string;
  position: number;
  durationMs: number;
}

/** Keeps the first MAX_IMPRESSIONS_PER_REQUEST usable items, one per post (longest view, first position wins). */
export function cleanImpressions(raw: unknown): CleanImpression[] {
  if (!Array.isArray(raw)) return [];
  const byPost = new Map<string, CleanImpression>();
  for (const item of raw.slice(0, MAX_IMPRESSIONS_PER_REQUEST * 2) as ImpressionInput[]) {
    if (!item || typeof item.post_id !== 'string' || item.post_id.length === 0 || item.post_id.length > 100) continue;
    const durationMs = typeof item.duration_ms === 'number' && Number.isFinite(item.duration_ms) ? Math.max(0, item.duration_ms) : 0;
    const position = typeof item.position === 'number' && Number.isFinite(item.position) ? Math.max(0, Math.min(10_000, Math.floor(item.position))) : 0;
    const seen = byPost.get(item.post_id);
    if (seen) {
      seen.durationMs = Math.max(seen.durationMs, durationMs);
    } else if (byPost.size < MAX_IMPRESSIONS_PER_REQUEST) {
      byPost.set(item.post_id, { postId: item.post_id, position, durationMs });
    }
  }
  return [...byPost.values()];
}

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(',');

export async function recordImpressions(
  db: D1Database,
  viewerId: string,
  raw: unknown,
  nowMs = Date.now(),
): Promise<{ received: number; inserted: number }> {
  const items = cleanImpressions(raw);
  if (items.length === 0) return { received: 0, inserted: 0 };

  const nowIso = new Date(nowMs).toISOString();
  const sinceIso = new Date(nowMs - IMPRESSION_DEDUPE_MS).toISOString();
  const ids = items.map((i) => i.postId);

  // Query 1: which of these did this viewer already log in the last hour (uses idx_impressions_viewer_post).
  const existingRows = await db
    .prepare(`SELECT DISTINCT post_id FROM impressions WHERE viewer_id = ? AND shown_at >= ? AND post_id IN (${placeholders(ids.length)})`)
    .bind(viewerId, sinceIso, ...ids)
    .all<{ post_id: string }>();
  const already = new Set((existingRows.results || []).map((r) => r.post_id));

  // Query 2: two statements in one batch, however many posts. Only real posts are logged (the EXISTS), and the
  // counters of exactly those posts go up by one.
  const fresh = items.filter((i) => !already.has(i.postId));
  let inserted = 0;
  if (fresh.length > 0) {
    const rowsSql = fresh.map(() => '(?, ?, ?)').join(', ');
    const rowBinds: unknown[] = [];
    for (const item of fresh) {
      rowBinds.push(`imp_${generateRandomString(16).toLowerCase().replace(/[^a-z0-9]/g, '')}`, item.postId, item.position);
    }
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO impressions (id, viewer_id, post_id, shown_at, position)
           SELECT v.column1, ?, v.column2, ?, v.column3 FROM (VALUES ${rowsSql}) v
           WHERE EXISTS (SELECT 1 FROM posts p WHERE p.id = v.column2)`,
        )
        .bind(viewerId, nowIso, ...rowBinds),
      db
        .prepare(
          `UPDATE posts SET impressions_count = impressions_count + 1
           WHERE id IN (${placeholders(fresh.length)})
             AND id IN (SELECT post_id FROM impressions WHERE viewer_id = ? AND shown_at = ?)`,
        )
        .bind(...fresh.map((i) => i.postId), viewerId, nowIso),
    ]);
    inserted = Number(results?.[0]?.meta?.changes ?? 0);
  }

  // Queries 3 to 5: learning from long views, for all posts at once.
  const longViews = items.filter((i) => i.durationMs >= LONG_VIEW_MS).map((i) => i.postId);
  if (longViews.length > 0) await strengthenTopics(db, viewerId, longViews, nowMs);

  return { received: items.length, inserted };
}

async function strengthenTopics(db: D1Database, viewerId: string, postIds: string[], nowMs: number): Promise<void> {
  const topicRows = await db
    .prepare(`SELECT topic_id FROM post_topics WHERE post_id IN (${placeholders(postIds.length)})`)
    .bind(...postIds)
    .all<{ topic_id: string }>();
  // One +0.1 for every (post, topic) pair, exactly as when each post was handled on its own.
  const hits = new Map<string, number>();
  for (const r of topicRows.results || []) hits.set(r.topic_id, (hits.get(r.topic_id) ?? 0) + 1);
  const topicIds = [...hits.keys()].slice(0, MAX_TOPICS_PER_REQUEST);
  if (topicIds.length === 0) return;

  const currentRows = await db
    .prepare(`SELECT topic_id, weight, updated_at FROM user_topic_signals WHERE user_id = ? AND topic_id IN (${placeholders(topicIds.length)})`)
    .bind(viewerId, ...topicIds)
    .all<{ topic_id: string; weight: number; updated_at: string }>();
  const current = new Map((currentRows.results || []).map((r) => [r.topic_id, r]));

  const nowIso = new Date(nowMs).toISOString();
  const binds: unknown[] = [];
  for (const topicId of topicIds) {
    const existing = current.get(topicId);
    // Decay the stored weight to "now" before adding, so old interest does not return at full strength.
    const base = existing ? computeDecayedWeight(existing.weight, existing.updated_at, nowMs) : 0;
    const next = Math.max(RANKING_CONFIG.SIGNAL_MIN, Math.min(RANKING_CONFIG.SIGNAL_MAX, base + LONG_VIEW_DELTA * (hits.get(topicId) ?? 1)));
    binds.push(viewerId, topicId, next, nowIso);
  }
  await db
    .prepare(
      `INSERT INTO user_topic_signals (user_id, topic_id, weight, updated_at) VALUES ${topicIds.map(() => '(?, ?, ?, ?)').join(', ')}
       ON CONFLICT(user_id, topic_id) DO UPDATE SET weight = excluded.weight, updated_at = excluded.updated_at`,
    )
    .bind(...binds)
    .run();
}
