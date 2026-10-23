import { SPAM_LOCK_MS, SPAM_STRIKES_FOR_LOCK } from './content/spam.ts';

/**
 * When posting is locked, the time it unlocks; otherwise null. Strikes count only if they are less than 3 days old
 * and newer than the person's latest post, so one normal post clears the streak and old strikes expire by themselves.
 */
export async function getSpamLockUntil(db: D1Database, userId: string, nowMs = Date.now()): Promise<Date | null> {
  const since = new Date(nowMs - SPAM_LOCK_MS).toISOString();
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(created_at) AS newest FROM spam_strikes
       WHERE user_id = ? AND created_at > ?
         AND created_at > COALESCE((SELECT MAX(created_at) FROM posts WHERE author_id = ?), '')`
    )
    .bind(userId, since, userId)
    .first<{ n: number; newest: string | null }>();
  if (!row || row.n < SPAM_STRIKES_FOR_LOCK || !row.newest) return null;
  return new Date(Date.parse(row.newest) + SPAM_LOCK_MS);
}
