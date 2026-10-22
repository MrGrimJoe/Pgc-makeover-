import { parseStickerKey } from '../../shared/sticker-keys.ts';

/** How many recently used bundled stickers are remembered. */
export const RECENT_MAX = 24;
const storageKey = (userId: string) => `recent-stickers:${userId}`;

/** Puts a key first, drops duplicates, and keeps at most `max`. Only bundled keys are remembered. Pure. */
export function pushRecent(list: readonly string[], key: string, max = RECENT_MAX): string[] {
  if (parseStickerKey(key)?.kind !== 'app') return [...list];
  return [key, ...list.filter((k) => k !== key)].slice(0, max);
}

/** Recently used bundled stickers. They live on this device only (localStorage) and are never sent anywhere. */
export function loadRecent(userId: string, storage: Pick<Storage, 'getItem'> | null = safeStorage()): string[] {
  try {
    const raw = storage?.getItem(storageKey(userId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string' && parseStickerKey(k)?.kind === 'app').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function saveRecent(userId: string, key: string, storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()): string[] {
  const next = pushRecent(loadRecent(userId, storage), key);
  try {
    storage?.setItem(storageKey(userId), JSON.stringify(next));
  } catch {
    // storage full or blocked: recents are a convenience, so ignore
  }
  return next;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
