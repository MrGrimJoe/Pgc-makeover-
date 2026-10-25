/**
 * Academic details, kept as four separate fields (program, session, class/year, section).
 * Class/year is the existing `classes` list; the other three live here. None of them is part of a student's
 * identity key (campus + roll number), so a student keeps one account as they move up.
 */

export const PROGRAMS = [
  { id: 'fsc_pre_engineering', name: 'F.Sc. Pre-Engineering' },
  { id: 'fsc_pre_medical', name: 'F.Sc. Pre-Medical' },
  { id: 'ics', name: 'I.C.S. (Intermediate in Computer Science)' },
  { id: 'icom', name: 'I.Com. (Intermediate of Commerce)' },
  { id: 'fa', name: 'F.A. (Faculty of Arts)' },
  { id: 'fa_it', name: 'F.A. I.T.' },
  { id: 'dit', name: 'D.I.T. (Diploma in Information Technology)' },
] as const;

export type ProgramId = (typeof PROGRAMS)[number]['id'];
export const PROGRAM_IDS = PROGRAMS.map((p) => p.id) as [ProgramId, ...ProgramId[]];

export function programName(id: string | null | undefined): string | null {
  return PROGRAMS.find((p) => p.id === id)?.name ?? null;
}

/** "2024-2026": two four-digit years, the second after the first by 1 to 4 years. */
export function isValidSession(value: string): boolean {
  const m = /^(20\d{2})-(20\d{2})$/.exec(value);
  if (!m) return false;
  const gap = Number(m[2]) - Number(m[1]);
  return gap >= 1 && gap <= 4;
}

/** Section: 1 to 10 letters, digits, spaces or dashes ("A", "Pre-Eng 2"). Empty means none. */
export function cleanSection(value: string): string | null {
  const v = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (v === '') return '';
  return /^[A-Za-z0-9][A-Za-z0-9 \-]{0,9}$/.test(v) ? v : null;
}

export const DEFAULT_RENEWAL_DAYS = 365;

/** Is it time to ask the student to confirm their academic details? Graduates are never asked. */
export function confirmationDue(status: string, confirmedAt: string | null, now: number, renewalDays: number): boolean {
  if (status !== 'current') return false;
  if (!confirmedAt) return true;
  const t = new Date(confirmedAt).getTime();
  if (Number.isNaN(t)) return true;
  return now - t >= renewalDays * 24 * 60 * 60 * 1000;
}
