import type { MeResponse } from '../../shared/schema.ts';

/**
 * The last "who am I" answer, kept on this device so a signed-in person who opens the app with no connection
 * still lands in the app (on the posts already saved here) instead of the sign-in screen. It is the same
 * information the feed history on the device is already keyed to, it is replaced on every successful load,
 * and it is removed when the server says nobody is signed in and when the person signs out.
 * A blocked or empty store just means the old behaviour (sign-in screen).
 */
const KEY = 'dialtone-last-me';

export function saveLastMe(me: MeResponse): void {
  try { window.localStorage.setItem(KEY, JSON.stringify(me)); } catch { /* storage unavailable */ }
}

export function loadLastMe(): MeResponse | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const me = JSON.parse(raw) as MeResponse;
    return me && typeof me === 'object' && me.user && typeof me.user.id === 'string' ? me : null;
  } catch { return null; }
}

export function clearLastMe(): void {
  try { window.localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}
