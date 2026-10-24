import type { D1Database } from '@cloudflare/workers-types';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Checks rate limits using the D1 rate_limits table.
 * Table schema: rate_limits (key TEXT, window_start INTEGER, count INTEGER, PRIMARY KEY (key, window_start))
 */
export async function checkRateLimit(
  db: D1Database,
  key: string,
  maxRequests: number,
  windowMs: number
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const windowEnd = windowStart + windowMs;
  const retryAfterSeconds = Math.max(1, Math.ceil((windowEnd - now) / 1000));

  // Purge older windows for this key to prevent unbounded row accumulation
  await db
    .prepare('DELETE FROM rate_limits WHERE key = ? AND window_start < ?')
    .bind(key, windowStart)
    .run();

  if (maxRequests < 1) return { allowed: false, retryAfterSeconds };

  // One statement decides: it counts the request only while the window is under the limit, and RETURNING
  // yields a row only when it did. Two simultaneous requests can no longer both read "9 of 10" and both pass.
  const counted = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count)
       VALUES (?, ?, 1)
       ON CONFLICT(key, window_start)
       DO UPDATE SET count = count + 1 WHERE count < ?
       RETURNING count`
    )
    .bind(key, windowStart, maxRequests)
    .first<{ count: number }>();

  if (!counted) return { allowed: false, retryAfterSeconds };

  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Helper to clear rate limit records in tests.
 */
export async function clearRateLimits(db?: D1Database): Promise<void> {
  if (db) {
    await db.prepare('DELETE FROM rate_limits').run();
  }
}
