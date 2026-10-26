/**
 * SAFE / WILD tagging for the feed pipeline.
 *
 * There is no classifier. A post's safety score starts at 1 and loses points for two things the app already
 * knows: how many different people reported it (dismissed reports do not count) and how spam-like its text is
 * (the same rule-based check that gates posting). Below WILD_THRESHOLD the post goes in the WILD pool.
 * The server never hides a WILD post: it only tags it, and the client's frame layout decides what to do.
 */
export const WILD_THRESHOLD = 0.7;
/** Each distinct reporter costs this much, up to REPORT_PENALTY_CAP in total. One report alone stays SAFE. */
export const REPORT_PENALTY_EACH = 0.25;
export const REPORT_PENALTY_CAP = 0.8;
/** Each point from assessSpam costs this much, up to SPAM_PENALTY_CAP. A post at the spam threshold (3) is WILD. */
export const SPAM_PENALTY_PER_POINT = 0.12;
export const SPAM_PENALTY_CAP = 0.5;

export interface SafetyInputs {
  /** Distinct people with a report on this post that an admin has not dismissed. */
  reporters: number;
  /** Score from assessSpam(post.body). */
  spamScore: number;
}

export interface SafetyVerdict {
  safetyScore: number;
  isWild: boolean;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function scoreSafety({ reporters, spamScore }: SafetyInputs): SafetyVerdict {
  const reportPenalty = Math.min(REPORT_PENALTY_CAP, Math.max(0, reporters) * REPORT_PENALTY_EACH);
  const spamPenalty = Math.min(SPAM_PENALTY_CAP, Math.max(0, spamScore) * SPAM_PENALTY_PER_POINT);
  const safetyScore = round2(Math.min(1, Math.max(0, 1 - reportPenalty - spamPenalty)));
  return { safetyScore, isWild: safetyScore < WILD_THRESHOLD };
}
