/**
 * The single character shown inside an avatar circle.
 *
 * Always exactly ONE uppercase character: the first letter or digit of the first
 * non-empty name given. Works on code points (not UTF-16 units) so emoji and
 * non-BMP letters are never split, and never returns the two-letter expansion
 * some characters get when uppercased (e.g. 'ß' -> 'SS').
 */
export function avatarInitial(...names: Array<string | null | undefined>): string {
  for (const name of names) {
    const trimmed = (name ?? '').trim();
    if (!trimmed) continue;
    const first = trimmed.match(/[\p{L}\p{N}]/u)?.[0] ?? Array.from(trimmed)[0]!;
    const upper = first.toUpperCase();
    return Array.from(upper).length === 1 ? upper : first;
  }
  return 'U';
}
