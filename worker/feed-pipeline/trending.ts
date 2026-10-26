/**
 * Trending score for one post: half "are its topics hot right now" (the 24 hour topic trends the cron job
 * already computes), half "is it gaining likes and comments quickly for its age".
 */
const HOUR_MS = 3_600_000;

/** 0..1. Fresh posts with a few likes and comments score high; old posts need far more to keep up. */
export function engagementVelocity(likes: number, comments: number, ageMs: number): number {
  const hours = Math.max(0, ageMs) / HOUR_MS;
  const raw = (Math.max(0, likes) + 2 * Math.max(0, comments)) / Math.pow(hours + 2, 1.2);
  return 1 - Math.exp(-raw / 2);
}

/** `topicTrends` maps topic slug -> 0..1. */
export function trendingScore(
  tags: readonly string[],
  topicTrends: ReadonlyMap<string, number>,
  likes: number,
  comments: number,
  ageMs: number,
): number {
  let topic = 0;
  for (const t of tags) topic = Math.max(topic, topicTrends.get(t) ?? 0);
  const score = 0.5 * Math.min(1, topic) + 0.5 * engagementVelocity(likes, comments, ageMs);
  return Math.round(Math.min(1, Math.max(0, score)) * 100) / 100;
}
