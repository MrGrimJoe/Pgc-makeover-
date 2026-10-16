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

  // Query existing count for this window
  const record = await db
    .prepare('SELECT count FROM rate_limits WHERE key = ? AND window_start = ?')
    .bind(key, windowStart)
    .first<{ count: number }>();

  const currentCount = record?.count ?? 0;

  if (currentCount >= maxRequests) {
    return { allowed: false, retryAfterSeconds };
  }

  // Atomically insert or increment count
  await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count)
       VALUES (?, ?, 1)
       ON CONFLICT(key, window_start)
       DO UPDATE SET count = count + 1`
    )
    .bind(key, windowStart)
    .run();

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
