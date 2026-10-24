/**
 * Roll numbers and the card barcode.
 *
 * The roll number is a student's identity key together with the campus. It is normalized so that "ab-0123",
 * "AB 0123" and "ab/123" are one student. Section, class and session are never part of the key.
 * Pure functions: used by the server and by the sign-up screen, and testable without a browser.
 */

/** What a person may type: letters, digits and the separators printed on cards. */
export const ROLL_INPUT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 \-/.]{1,30}$/;

/** Uppercase, separators removed, leading zeros dropped when the whole value is digits. '' when nothing usable is left. */
export function normalizeRoll(input: string): string {
  const cleaned = input.normalize('NFKC').toUpperCase().replace(/[\s\-/.]/g, '');
  if (!/^[A-Z0-9]+$/.test(cleaned)) return '';
  if (/^[0-9]+$/.test(cleaned)) return cleaned.replace(/^0+(?=[0-9])/, '');
  return cleaned;
}

/** Normalized roll numbers have 2 to 20 characters (a lone "7" is not a roll number; "07" would normalize to "7"). */
export function isUsableRoll(normalized: string): boolean {
  return normalized.length >= 2 && normalized.length <= 20;
}

/** Last three digits when the roll number ends in three digits; null otherwise (the column allows null). */
export function rollLast3(normalized: string): string | null {
  const m = /([0-9]{3})$/.exec(normalized);
  return m?.[1] ?? null;
}

/** The campus half of the uniqueness key: a bundled campus id, or the normalized text of a typed one. */
export function campusKey(campusId: string | null | undefined, campusOther: string | null | undefined): string {
  if (campusId) return `id:${campusId}`;
  const other = (campusOther ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  return `other:${other}`;
}

/**
 * Does the value decoded from the card's barcode equal the roll number the student typed?
 * Equal after the same normalization, nothing looser. A mismatch is never accepted silently.
 */
export function barcodeMatchesRoll(barcodeValue: string, typedRoll: string): boolean {
  const a = normalizeRoll(barcodeValue);
  const b = normalizeRoll(typedRoll);
  return a !== '' && a === b;
}
