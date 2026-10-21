import type { D1Database } from '@cloudflare/workers-types';

/**
 * Checks if userA has blocked userB or vice versa.
 */
export async function isBlockedBetween(db: D1Database, userA: string, userB: string): Promise<boolean> {
  try {
    const row = await db.prepare(
      'SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1'
    ).bind(userA, userB, userB, userA).first();
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Checks if sender is permitted to send a DM to recipient based on blocks and dm_policy.
 */
export async function canSendDmTo(
  db: D1Database,
  senderId: string,
  recipientId: string
): Promise<{ allowed: boolean; reason?: string }> {
  // 1. Check blocking in either direction
  const blocked = await isBlockedBetween(db, senderId, recipientId);
  if (blocked) {
    return { allowed: false, reason: 'Forbidden: Cannot message this user' };
  }

  // 2. Check recipient DM policy
  const settings = await db.prepare(
    'SELECT dm_policy FROM user_settings WHERE user_id = ?'
  ).bind(recipientId).first<{ dm_policy: string }>();

  // Default dm_policy is followed_only
  const policy = settings?.dm_policy || 'followed_only';

  if (policy === 'nobody' || policy === 'none') {
    return { allowed: false, reason: 'Forbidden: User does not accept direct messages' };
  }

  if (policy === 'followed_only' || policy === 'following') {
    // Recipient must follow sender
    const isFollowed = await db.prepare(
      'SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ? LIMIT 1'
    ).bind(recipientId, senderId).first();

    if (!isFollowed) {
      return { allowed: false, reason: 'Forbidden: User only accepts direct messages from users they follow' };
    }
  }

  return { allowed: true };
}
