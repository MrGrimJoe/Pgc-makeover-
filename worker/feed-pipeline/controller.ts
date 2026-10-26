/**
 * Server-side packaging API for the frame feed.
 *
 *   GET /api/v1/feed/bootstrap?mode=for_you|following&size=30..50
 *   GET /api/v1/feed/next?mode=...&cursor=<opaque>&size=30..50
 *
 * Each call returns ONE batch (30 to 50 posts, newest first) holding a pool of SAFE and WILD tagged posts,
 * gzip-compressed when the caller accepts it. The server does not rank: ranking happens on the phone
 * (src/feed-pipeline/LocalPersonalization.ts) so it can use what the viewer just did without a round trip.
 * No monetization of any kind lives here.
 *
 * `hydratePosts` and `getBlockedUserIds` are passed in (worker/index.ts owns them), which keeps this module
 * free of an import cycle and lets tests stub them.
 */
import type { D1Database } from '@cloudflare/workers-types';
import type { Env, PostRow } from '../types.ts';
import type { PostItem } from '../../shared/schema.ts';
import { authenticateRequest } from '../auth.ts';
import { jsonResponse } from '../http.ts';
import { checkRateLimit } from '../rate-limit.ts';
import { clampBatchSize, parsePipelineMode, type PipelineMode } from '../../shared/feed-pipeline.ts';
import { buildBatchResponse, decodePipelineCursor, tagPosts, type PipelineCursor } from './packager.ts';
import { compressedJson } from './compress.ts';

export type PostQueryRow = PostRow & {
  author_username: string;
  author_display_name: string;
  author_avatar_media_id: string | null;
  author_class_name: string | null;
};

export interface PipelineDeps {
  hydratePosts: (db: D1Database, rows: PostQueryRow[], currentUserId: string) => Promise<PostItem[]>;
  getBlockedUserIds: (db: D1Database, userId: string) => Promise<string[]>;
}

/** 30 batch requests a minute is far more than scrolling needs (one batch is 30+ posts). */
export const BATCH_RATE_LIMIT = { max: 30, windowMs: 60_000 };
const ROUTE = /^\/api\/v1\/feed\/(bootstrap|next)$/;

/** The newest unexpired posts the viewer may see, one page after `cursor`. Asks for size + 1 to learn `hasMore`. */
async function queryPage(
  db: D1Database,
  deps: PipelineDeps,
  userId: string,
  mode: PipelineMode,
  cursor: PipelineCursor | null,
  limit: number,
  nowIso: string,
): Promise<PostQueryRow[]> {
  const blocked = await deps.getBlockedUserIds(db, userId);
  const params: unknown[] = [nowIso];
  let where = "p.status = 'active' AND p.expires_at > ?";
  if (blocked.length > 0) {
    where += ` AND p.author_id NOT IN (${blocked.map(() => '?').join(',')})`;
    params.push(...blocked);
  }
  where += " AND p.id NOT IN (SELECT post_id FROM feedback WHERE user_id = ? AND type = 'not_interested')";
  params.push(userId);
  if (mode === 'following') {
    where += ' AND (p.author_id = ? OR p.author_id IN (SELECT followed_id FROM follows WHERE follower_id = ?))';
    params.push(userId, userId);
  }
  if (cursor) {
    where += ' AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))';
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  params.push(limit + 1);
  const res = await db
    .prepare(
      `SELECT p.id, p.author_id, p.body, p.created_at, p.expires_at, p.status,
              pr.username AS author_username, pr.display_name AS author_display_name,
              pr.avatar_media_id AS author_avatar_media_id, c.name AS author_class_name
       FROM posts p
       JOIN profiles pr ON pr.user_id = p.author_id
       LEFT JOIN classes c ON c.id = pr.class_id
       WHERE ${where}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ?`,
    )
    .bind(...params)
    .all<PostQueryRow>();
  return res.results || [];
}

/** Distinct people who reported each post and whose report an admin has not dismissed. */
async function reporterCounts(db: D1Database, postIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (postIds.length === 0) return out;
  const res = await db
    .prepare(
      `SELECT target_id, COUNT(DISTINCT reporter_id) AS n
       FROM reports
       WHERE target_type = 'post' AND status != 'dismissed' AND target_id IN (${postIds.map(() => '?').join(',')})
       GROUP BY target_id`,
    )
    .bind(...postIds)
    .all<{ target_id: string; n: number }>();
  for (const r of res.results || []) out.set(r.target_id, Number(r.n));
  return out;
}

/** The hottest 24 hour topics, scaled so the hottest is 1. */
async function topicTrends(db: D1Database): Promise<Map<string, number>> {
  const res = await db
    .prepare(
      `SELECT t.slug, ts.score
       FROM trend_snapshots ts JOIN topics t ON t.id = ts.topic_id
       WHERE ts.window = '24h'
       ORDER BY ts.score DESC
       LIMIT 20`,
    )
    .all<{ slug: string; score: number }>();
  const rows = res.results || [];
  const max = Math.max(0, ...rows.map((r) => Number(r.score)));
  const out = new Map<string, number>();
  if (max > 0) for (const r of rows) out.set(r.slug.toLowerCase(), Math.round((Number(r.score) / max) * 100) / 100);
  return out;
}

/** Returns a Response for the two pipeline routes, or null when the request is not one of them. */
export async function handleFeedPipelineRoutes(
  request: Request,
  env: Env,
  pathname: string,
  deps: PipelineDeps,
): Promise<Response | null> {
  const match = ROUTE.exec(pathname);
  if (!match || request.method !== 'GET') return null;
  const kind = match[1] as 'bootstrap' | 'next';

  const auth = await authenticateRequest(request, env.DB);
  if (!auth) return jsonResponse({ error: 'Unauthorized' }, 401);

  const rate = await checkRateLimit(env.DB, `feedbatch:${auth.user.id}`, BATCH_RATE_LIMIT.max, BATCH_RATE_LIMIT.windowMs);
  if (!rate.allowed) {
    return jsonResponse({ error: 'Too many feed requests. Try again shortly.' }, 429, {
      'Retry-After': String(rate.retryAfterSeconds),
    });
  }

  const params = new URL(request.url).searchParams;
  const mode = parsePipelineMode(params.get('mode'));
  if (!mode) return jsonResponse({ error: "mode must be 'for_you' or 'following'" }, 400);
  const size = clampBatchSize(params.get('size'));

  let cursor: PipelineCursor | null = null;
  if (kind === 'next') {
    const raw = params.get('cursor');
    if (!raw) return jsonResponse({ error: 'cursor is required' }, 400);
    cursor = decodePipelineCursor(raw);
    if (!cursor) return jsonResponse({ error: 'Invalid cursor' }, 400);
  }

  const nowMs = Date.now();
  const rows = await queryPage(env.DB, deps, auth.user.id, mode, cursor, size, new Date(nowMs).toISOString());
  const hasMore = rows.length > size;
  const pageRows = hasMore ? rows.slice(0, size) : rows;

  const [hydrated, reporters, trends] = await Promise.all([
    deps.hydratePosts(env.DB, pageRows, auth.user.id),
    reporterCounts(env.DB, pageRows.map((r) => r.id)),
    topicTrends(env.DB),
  ]);
  const posts = tagPosts(hydrated, { nowMs, reporters, topicTrends: trends });
  const body = buildBatchResponse({ kind, mode, posts, hasMore, batchSize: size, topicTrends: trends, nowMs });
  return compressedJson(request, body);
}
