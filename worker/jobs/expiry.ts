import { pruneOrphanMedia, deleteMediaIfUnreferenced } from '../media.ts';
import type { Env } from '../types.ts';

export interface ExpiryJobResult {
  checked: number;
  extended: number;
  deleted: number;
  deletedPostIds: string[];
  extendedPostIds: string[];
  prunedOrphanMedia: number;
  prunedMessages?: number;
}

/**
 * Runs the daily post lifecycle expiry check.
 *
 * Rules:
 * - Posts initial expiry = created_at + 7 days.
 * - At day 7: if at least 3 distinct users other than the author liked or commented,
 *   extend expires_at to day 14 (created_at + 14 days).
 * - Otherwise expire immediately.
 * - Hard stop at day 14 (created_at + 14 days): unconditionally expire.
 * - Expiry deletes post, comments, reactions, post_media rows, media records, and R2 objects together.
 * - Cleans up orphaned media records older than 24 hours not attached to any post.
 */
/** How long handled moderation records are kept (days). Open reports, disputes and appeals are never deleted by this job. */
export const REPORT_RETENTION_DAYS = 90;
export const DISPUTE_RETENTION_DAYS = 90;
export const APPEAL_RETENTION_DAYS = 180;
export const ADMIN_LOG_RETENTION_DAYS = 365;

export async function runPostLifecycleExpiry(
  env: Env,
  referenceTime = Date.now()
): Promise<ExpiryJobResult> {
  const referenceIso = new Date(referenceTime).toISOString();

  // Find all active posts that have reached or passed their current expires_at
  const candidates = await env.DB.prepare(
    `SELECT id, author_id, created_at, expires_at
     FROM posts
     WHERE status = 'active' AND expires_at <= ?`
  )
    .bind(referenceIso)
    .all<{
      id: string;
      author_id: string;
      created_at: string;
      expires_at: string;
    }>();

  const posts = candidates.results || [];
  let extendedCount = 0;
  let deletedCount = 0;
  const deletedPostIds: string[] = [];
  const extendedPostIds: string[] = [];

  for (const post of posts) {
    const createdAtMs = new Date(post.created_at).getTime();
    const currentExpiresMs = new Date(post.expires_at).getTime();
    const day14Ms = createdAtMs + 14 * 24 * 60 * 60 * 1000;

    // Hard stop at day 14:
    // If the post has reached or exceeded day 14, or was already extended to day 14
    const isAtOrPastDay14 =
      referenceTime >= day14Ms || currentExpiresMs >= day14Ms - 1000;

    if (isAtOrPastDay14) {
      // Hard stop: delete immediately
      await deletePostAndMedia(env, post.id);
      deletedCount++;
      deletedPostIds.push(post.id);
      continue;
    }

    // Day 7 check: check distinct users other than author who liked or commented
    const engagersResult = await env.DB.prepare(
      `SELECT COUNT(DISTINCT user_id) as engagers_count
       FROM (
         SELECT user_id FROM post_reactions WHERE post_id = ? AND user_id != ?
         UNION
         SELECT author_id AS user_id FROM comments WHERE post_id = ? AND author_id != ?
       )`
    )
      .bind(post.id, post.author_id, post.id, post.author_id)
      .first<{ engagers_count: number }>();

    const distinctEngagers = Number(engagersResult?.engagers_count || 0);

    if (distinctEngagers >= 3) {
      // Extend to day 14
      const extendedExpiresAt = new Date(day14Ms).toISOString();
      await env.DB.prepare(
        'UPDATE posts SET expires_at = ? WHERE id = ?'
      )
        .bind(extendedExpiresAt, post.id)
        .run();

      extendedCount++;
      extendedPostIds.push(post.id);
    } else {
      // Less than 3 distinct engagers: expire post
      await deletePostAndMedia(env, post.id);
      deletedCount++;
      deletedPostIds.push(post.id);
    }
  }

  // Orphan media cleanup is reference-based: only media nothing references (posts, messages, profile pictures,
  // sticker library) and older than 24 hours is deleted.
  const prunedOrphanMedia = await pruneOrphanMedia(env, referenceTime);

  // Prune impressions older than 30 days
  const thirtyDaysAgoIso = new Date(referenceTime - 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare('DELETE FROM impressions WHERE shown_at < ?')
    .bind(thirtyDaysAgoIso)
    .run();

  // Message expiry: delete messages older than 14 days + attached media & R2 objects
  let prunedMessages = 0;
  try {
    const expiredMessages = await env.DB.prepare(
      'SELECT id FROM messages WHERE expires_at <= ?'
    )
      .bind(referenceIso)
      .all<{ id: string }>();

    const msgIds = (expiredMessages.results || []).map((m) => m.id);

    for (const msgId of msgIds) {
      const mediaList = await env.DB.prepare('SELECT media_id FROM message_media WHERE message_id = ?')
        .bind(msgId)
        .all<{ media_id: string }>();
      await env.DB.batch([
        env.DB.prepare('DELETE FROM message_media WHERE message_id = ?').bind(msgId),
        env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(msgId),
      ]);
      // The media goes only if nothing else still references it (a forward, the library, a profile picture)
      await deleteMediaIfUnreferenced(env, (mediaList.results || []).map((m) => m.media_id));
      prunedMessages++;
    }
  } catch {
    // messages table does not exist if migration 004 has not yet run
  }

  // Report evidence expiry: delete evidence older than 30 days
  try {
    await env.DB.prepare('DELETE FROM report_evidence WHERE expires_at <= ?')
      .bind(referenceIso)
      .run();
  } catch {
    // report_evidence table does not exist if migration 004 has not yet run
  }

  // Moderation records are not kept forever. Open items are never touched; handled ones go after a fixed time.
  const daysAgo = (n: number) => new Date(new Date(referenceIso).getTime() - n * 24 * 60 * 60 * 1000).toISOString();
  const retention: Array<[string, string, string]> = [
    // table, condition, cutoff
    ['reports', "status != 'pending' AND created_at <= ?", daysAgo(REPORT_RETENTION_DAYS)],
    ['registration_disputes', "status = 'resolved' AND resolved_at <= ?", daysAgo(DISPUTE_RETENTION_DAYS)],
    ['appeals', "status != 'open' AND decided_at <= ?", daysAgo(APPEAL_RETENTION_DAYS)],
    ['appeal_tickets', 'expires_at <= ?', referenceIso],
    ['admin_actions', 'created_at <= ?', daysAgo(ADMIN_LOG_RETENTION_DAYS)],
  ];
  for (const [table, condition, cutoff] of retention) {
    try {
      await env.DB.prepare(`DELETE FROM ${table} WHERE ${condition}`).bind(cutoff).run();
    } catch {
      // the table does not exist until its migration has run
    }
  }

  return {
    checked: posts.length,
    extended: extendedCount,
    deleted: deletedCount,
    deletedPostIds,
    extendedPostIds,
    prunedOrphanMedia,
    prunedMessages,
  };
}

/**
 * Deletes post, linked media records, and corresponding R2 objects in D1 batch.
 */
export async function deletePostAndMedia(env: Env, postId: string): Promise<void> {
  const linked = await env.DB.prepare('SELECT media_id FROM post_media WHERE post_id = ?')
    .bind(postId)
    .all<{ media_id: string }>();

  await env.DB.batch([
    env.DB.prepare('DELETE FROM post_media WHERE post_id = ?').bind(postId),
    env.DB.prepare('DELETE FROM post_reactions WHERE post_id = ?').bind(postId),
    env.DB.prepare('DELETE FROM comments WHERE post_id = ?').bind(postId),
    env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(postId),
  ]);

  // Media goes with the post unless something else still uses it (sticker library, a message, a profile picture)
  await deleteMediaIfUnreferenced(env, (linked.results || []).map((m) => m.media_id));
}
