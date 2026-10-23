/**
 * A small rule-based spam check for post text. It is not a classifier: it adds up simple signals and
 * flags a post at SPAM_SCORE_THRESHOLD. One link or one pushy phrase alone is not enough.
 */
export const SPAM_SCORE_THRESHOLD = 3;
export const DUPLICATE_MIN_LENGTH = 20;
export const POST_LIMIT_MAX = 3;
export const POST_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const SPAM_STRIKES_FOR_LOCK = 3;
export const SPAM_LOCK_MS = 3 * 24 * 60 * 60 * 1000;

const PROMO_PHRASES = [
  'free money', 'earn money', 'make money fast', 'earn $', 'work from home', 'click here', 'buy now', 'limited offer',
  'act now', '100% free', 'guaranteed income', 'crypto giveaway', 'double your', 'investment opportunity',
  'buy followers', 'followers for sale', 'casino', 'betting tips', 'onlyfans', 'cheap pills', 'loan approval',
];

const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|xyz|top|click|link|ru|shop|site|online)\b/gi;
const CONTACT_RE = /\b(?:whatsapp|telegram|t\.me|wa\.me|dm me|inbox me)\b|\+?\d[\d\s-]{9,}\d/i;

export interface SpamVerdict {
  spam: boolean;
  score: number;
  signals: string[];
}

/** Lowercase, collapsed whitespace: the form used to compare a post with the same person's recent posts. */
export function normalizeForDuplicate(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function assessSpam(text: string, opts: { duplicateOfRecent?: boolean } = {}): SpamVerdict {
  const signals: string[] = [];
  let score = 0;
  const add = (points: number, name: string) => { score += points; signals.push(name); };

  const lower = text.toLowerCase();
  const urls = text.match(URL_RE)?.length ?? 0;
  if (urls >= 2) add(2, 'several_links');
  else if (urls === 1) add(1, 'link');

  if (PROMO_PHRASES.some((p) => lower.includes(p))) add(2, 'promo_phrase');
  if (CONTACT_RE.test(text)) add(1, 'contact_bait');
  if (/(.)\1{9,}/u.test(text)) add(1, 'repeated_characters');

  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length >= 20) {
    const upper = letters.replace(/[^\p{Lu}]/gu, '').length;
    if (upper / letters.length >= 0.8) add(1, 'shouting');
  }

  const words = lower.split(/\s+/).filter(Boolean);
  if (words.length >= 8 && new Set(words).size / words.length <= 0.4) add(2, 'repeated_words');

  // The caller decides what counts as a duplicate (same post text as one of the person's own in the last 24 hours, 20+ characters)
  if (opts.duplicateOfRecent) add(3, 'duplicate_of_recent_post');

  return { spam: score >= SPAM_SCORE_THRESHOLD, score, signals };
}
