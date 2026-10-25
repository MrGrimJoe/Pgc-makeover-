/**
 * Comparing the text printed on the student card (read by OCR) with what the student typed.
 *
 * OCR is a hint, never proof and never an authority: it misreads, and a card can be imitated. So every field gets one of
 *   match       the typed value is clearly on the card
 *   uncertain   part of it is there, or the text is poor
 *   mismatch    the card was readable and the typed value is clearly not on it
 *   unreadable  not enough text was read to say anything
 * Nothing here ever changes what the student typed.
 */
import { programName } from './academic.ts';

export type FieldResult = 'match' | 'uncertain' | 'mismatch' | 'unreadable';
export interface PrintedCheck { name: FieldResult; campus: FieldResult; program: FieldResult; session: FieldResult }

const STOP = new Set(['of', 'the', 'and', 'for', 'college', 'colleges', 'campus', 'group', 'govt', 'government', 'branch', 'mr', 'ms', 'miss', 'student', 'name', 'roll', 'no', 'class', 'program', 'session', 'card', 'id']);

export function words(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** One edit (insert, delete or change a letter) apart: tolerates a misread letter. */
function nearly(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}

const has = (pool: string[], w: string) => pool.some((p) => nearly(p, w));

/** Enough readable words to judge anything at all. */
export function readable(text: string): boolean {
  return words(text).filter((w) => w.length >= 3).length >= 6;
}

function fraction(wanted: string[], pool: string[]): number {
  return wanted.length ? wanted.filter((w) => has(pool, w)).length / wanted.length : 0;
}

function grade(found: number, wantedCount: number, text: string): FieldResult {
  if (wantedCount === 0 || !readable(text)) return 'unreadable';
  if (found >= 0.99) return 'match';
  if (found >= 0.5) return 'uncertain';
  return found === 0 ? 'mismatch' : 'uncertain';
}

export function compareName(text: string, typedName: string): FieldResult {
  const wanted = words(typedName).filter((w) => w.length >= 2 && !STOP.has(w));
  return grade(fraction(wanted, words(text)), wanted.length, text);
}

export function compareCampus(text: string, campusName: string): FieldResult {
  const wanted = words(campusName).filter((w) => w.length >= 3 && !STOP.has(w));
  return grade(fraction(wanted, words(text)), wanted.length, text);
}

const PROGRAM_WORDS: Record<string, string[][]> = {
  fsc_pre_engineering: [['engineering'], ['eng'], ['engg']],
  fsc_pre_medical: [['medical'], ['med']],
  ics: [['computer', 'science'], ['ics'], ['computer']],
  icom: [['commerce'], ['icom'], ['com']],
  fa: [['arts'], ['fa']],
  fa_it: [['it'], ['information', 'technology']],
  dit: [['dit'], ['diploma'], ['information', 'technology']],
};

export function comparePrograms(text: string, programId: string): FieldResult {
  const pool = words(text);
  if (!readable(text) || !programName(programId)) return 'unreadable';
  const options = PROGRAM_WORDS[programId] ?? [];
  const hit = options.some((o) => o.every((w) => has(pool, w)));
  // F.A. also appears inside "F.A. I.T." and "F.Sc.": a bare "fa" is weak evidence, so it can only say "uncertain"
  const strong = options.filter((o) => o.join('').length > 3).some((o) => o.every((w) => has(pool, w)));
  if (strong) return 'match';
  return hit ? 'uncertain' : 'mismatch';
}

/**
 * "2024-2026", "2024 - 26", "2024-26". If the card prints a session range, it has to be the same range: a card that says
 * 2022-2024 shares a year with 2024-2026 but is a different session.
 */
export function compareSession(text: string, session: string): FieldResult {
  const m = /^(\d{4})-(\d{4})$/.exec(session);
  if (!m || !readable(text)) return 'unreadable';
  const [a, b] = [m[1]!, m[2]!];
  const ranges = [...text.matchAll(/(\d{4})\s*[-–—/]\s*(\d{4}|\d{2})(?!\d)/g)];
  if (ranges.some((r) => r[1] === a && (r[2] === b || r[2] === b.slice(2)))) return 'match';
  if (ranges.length > 0) return 'mismatch';
  const flat = text.replace(/\s+/g, '');
  return flat.includes(a) || flat.includes(b) ? 'uncertain' : 'mismatch';
}

export function compareCard(text: string, typed: { name: string; campusName: string; program: string; session: string }): PrintedCheck {
  return {
    name: compareName(text, typed.name),
    campus: compareCampus(text, typed.campusName),
    program: comparePrograms(text, typed.program),
    session: compareSession(text, typed.session),
  };
}

/** What the student sees, in plain words. Only fields with something to say are listed. */
export function describeCheck(c: PrintedCheck): { ok: string[]; check: string[]; unread: string[] } {
  const label: Record<keyof PrintedCheck, string> = { name: 'name', campus: 'campus', program: 'program', session: 'session' };
  const out = { ok: [] as string[], check: [] as string[], unread: [] as string[] };
  for (const k of Object.keys(label) as Array<keyof PrintedCheck>) {
    if (c[k] === 'match') out.ok.push(label[k]);
    else if (c[k] === 'unreadable') out.unread.push(label[k]);
    else out.check.push(label[k]);
  }
  return out;
}

/** Is there anything that clearly disagrees (and so deserves a second look from the student)? */
export const hasMismatch = (c: PrintedCheck) => Object.values(c).includes('mismatch');
