import type { Env } from './types.ts';

const DEV_ONLY_SECRET = 'development-only-roll-key-secret';

/** Is the card scan a required part of sign-up? On unless REQUIRE_CARD_SCAN is exactly "false". */
export function cardScanRequired(env: Env): boolean {
  return env.REQUIRE_CARD_SCAN !== 'false';
}

/**
 * The stored form of "this student at this campus": HMAC-SHA256(secret, campusKey | normalized roll), hex.
 * A keyed hash, so a copy of the database does not hand over roll numbers (they are easy to guess without the key).
 * Returns null when the secret is missing in production, so sign-up fails closed instead of using a known key.
 */
export async function computeRollKey(env: Env, campusKeyValue: string, normalizedRoll: string): Promise<string | null> {
  const relaxed = env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test';
  const secret = env.ROLL_KEY_SECRET || (relaxed ? DEV_ONLY_SECRET : '');
  if (!secret) return null;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${campusKeyValue}|${normalizedRoll}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
