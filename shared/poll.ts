import { cleanCampusText } from './campus.ts';

/** Polls exist on posts only. 2 to 6 options of 1 to 60 characters. */
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 6;
export const POLL_OPTION_MAX = 60;

/** Same cleaning as other short text: Unicode normalised, invisible characters removed, whitespace collapsed. */
export function cleanPollOption(input: unknown): string {
  return typeof input === 'string' ? cleanCampusText(input) : '';
}

export type PollOptionsCheck = { ok: true; options: string[] } | { ok: false; error: string };

/** Cleans and validates a poll's options. Duplicates (ignoring case) are rejected because they split the votes. */
export function checkPollOptions(raw: unknown): PollOptionsCheck {
  if (!Array.isArray(raw)) return { ok: false, error: 'A poll needs a list of options' };
  if (raw.length < POLL_MIN_OPTIONS) return { ok: false, error: `A poll needs at least ${POLL_MIN_OPTIONS} options` };
  if (raw.length > POLL_MAX_OPTIONS) return { ok: false, error: `A poll can have at most ${POLL_MAX_OPTIONS} options` };
  const options: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const text = cleanPollOption(item);
    if (text.length < 1) return { ok: false, error: 'Poll options cannot be empty' };
    if (text.length > POLL_OPTION_MAX) return { ok: false, error: `Poll options cannot exceed ${POLL_OPTION_MAX} characters` };
    if (/[\u0000-\u001F\u007F<>]/.test(text)) return { ok: false, error: 'Poll options contain invalid characters' };
    const key = text.toLowerCase();
    if (seen.has(key)) return { ok: false, error: 'Poll options must be different from each other' };
    seen.add(key);
    options.push(text);
  }
  return { ok: true, options };
}
