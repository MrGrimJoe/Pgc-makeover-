/**
 * Cursor for the ranked feed: the set of posts already delivered, not a page number.
 *
 * The ranking changes while someone scrolls (views are reported, posts get demoted once seen, counts
 * move). Recomputing "page N" would shift page boundaries, skipping some posts and repeating others.
 * Remembering what was delivered makes every page "the best of what is left", so nothing is skipped
 * or repeated no matter how the ranking moves. Ids are shortened to 53-bit hashes to keep the cursor
 * small (the pool is at most about 160 posts, so a cursor stays under 2 KB).
 */
const PREFIX = 'd1:';
const MAX_CURSOR_LENGTH = 8000;

/** cyrb53: a fast, well-distributed 53-bit string hash. */
function cyrb53(str: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function hashPostId(id: string): string {
  return cyrb53(id).toString(36);
}

/** Hashes of the posts already delivered, or null when there is no (valid) cursor: start from the top. */
export function decodeDeliveredCursor(cursor: string | null): Set<string> | null {
  if (!cursor || cursor.length > MAX_CURSOR_LENGTH || !cursor.startsWith(PREFIX)) return null;
  const body = cursor.slice(PREFIX.length);
  if (!/^[0-9a-z.]*$/.test(body)) return null;
  return new Set(body.split('.').filter(Boolean));
}

export function encodeDeliveredCursor(hashes: Iterable<string>): string {
  return PREFIX + [...hashes].join('.');
}
