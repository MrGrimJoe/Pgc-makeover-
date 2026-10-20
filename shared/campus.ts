/**
 * Campus name helpers shared by the Worker, the seed script and the UI.
 * Names are matched on a normalized form so "  PGC  Lahore " and "pgc lahore" are the same campus.
 */

export const CAMPUS_NAME_MIN = 2;
export const CAMPUS_NAME_MAX = 80;
export const CAMPUS_CITY_MAX = 60;

// Zero-width and bidi control characters are removed so lookalike names cannot be created.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
// Any ASCII control character (including tab and newline) is rejected after whitespace collapsing.
const CONTROL = /[\u0000-\u001F\u007F]/;

/** Collapses whitespace, strips invisible characters and trims. Keeps the original casing. */
export function cleanCampusText(input: string): string {
  if (typeof input !== 'string') return '';
  return input.normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

/** Lowercased, cleaned form used for uniqueness and matching. */
export function normalizeCampusText(input: string): string {
  return cleanCampusText(input).toLowerCase();
}

export interface CampusInputCheck {
  ok: boolean;
  name: string;
  city: string;
  error?: string;
}

/** Validates and cleans a campus name and city (city may be empty). */
export function checkCampusInput(rawName: unknown, rawCity: unknown): CampusInputCheck {
  const name = cleanCampusText(typeof rawName === 'string' ? rawName : '');
  const city = cleanCampusText(typeof rawCity === 'string' ? rawCity : '');
  if (name.length < CAMPUS_NAME_MIN) {
    return { ok: false, name, city, error: `Campus name must be at least ${CAMPUS_NAME_MIN} characters` };
  }
  if (name.length > CAMPUS_NAME_MAX) {
    return { ok: false, name, city, error: `Campus name cannot exceed ${CAMPUS_NAME_MAX} characters` };
  }
  if (city.length > CAMPUS_CITY_MAX) {
    return { ok: false, name, city, error: `City cannot exceed ${CAMPUS_CITY_MAX} characters` };
  }
  if (CONTROL.test(name) || CONTROL.test(city)) {
    return { ok: false, name, city, error: 'Campus name contains invalid characters' };
  }
  if (/[<>]/.test(name) || /[<>]/.test(city)) {
    return { ok: false, name, city, error: 'Campus name contains invalid characters' };
  }
  return { ok: true, name, city };
}

/** Escapes LIKE wildcards so user input is matched literally (use with ESCAPE '\'). */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}
