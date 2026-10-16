import { RANKING_CONFIG } from './config.ts';
import { computeDecayedWeight } from './decay.ts';

export interface CandidatePost {
  id: string;
  author_id: string;
  author_class_id: string | null;
  body: string;
  created_at: string;
  expires_at: string;
  status: string;
  topics: Array<{ slug: string; confidence: number }>;
  distinct_engagers: number;
  impressions_count: number;
  pool?: 'social' | 'interest' | 'trending' | 'exploration';
}

export interface UserRankingContext {
  userId: string;
  userClassId: string | null;
  followedUserIds: Set<string>;
  notInterestedPostIds: Set<string>;
  userTopicSignals: Map<string, { weight: number; updatedAt: string }>;
  nowMs?: number;
}

export interface ScoredPost {
  post: CandidatePost;
  totalScore: number;
  scoreBreakdown: {
    interest: number;
    social: number;
    recency: number;
    engagement: number;
    classContext: number;
  };
}

/**
 * Computes component scores and total score for a single candidate post.
 */
export function scoreCandidate(
  post: CandidatePost,
  context: UserRankingContext
): ScoredPost {
  const now = context.nowMs ?? Date.now();
  const createdMs = new Date(post.created_at).getTime();

  // 1. Interest Score: match post topics with user topic signals (with 14-day decay)
  let rawInterest = 0;
  if (post.topics && post.topics.length > 0) {
    for (const t of post.topics) {
      const signal = context.userTopicSignals.get(t.slug);
      if (signal) {
        const decayed = computeDecayedWeight(signal.weight, signal.updatedAt, now);
        if (decayed > 0) {
          rawInterest += decayed * t.confidence;
        }
      }
    }
  }
  // Normalize interest score using tanh / saturation
  const interestScore = Math.max(0, Math.min(1, Math.tanh(rawInterest / 3.0)));

  // 2. Social Score: followed author = 1.0, same class = 0.5, else 0
  let socialScore = 0;
  if (context.followedUserIds.has(post.author_id)) {
    socialScore = 1.0;
  } else if (context.userClassId && post.author_class_id === context.userClassId) {
    socialScore = 0.5;
  }

  // 3. Recency Score: decays linearly over 7 days (604800000 ms)
  const ageMs = Math.max(0, now - createdMs);
  const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
  const recencyScore = Math.max(0, 1 - ageMs / maxAgeMs);

  // 4. Engagement Score: distinct engagers adjusted for exposure (impressions)
  // Ratio: distinct_engagers / (impressions + 1)
  const exposureRatio = post.distinct_engagers / (post.impressions_count + 1);
  const engagementScore = Math.max(0, Math.min(1, exposureRatio * 2.0));

  // 5. Class Context Score:
  // 1.0 if author in same class as viewer, 0.5 if author has any campus class, 0.0 otherwise
  let classContextScore = 0;
  if (context.userClassId && post.author_class_id === context.userClassId) {
    classContextScore = 1.0;
  } else if (post.author_class_id) {
    classContextScore = 0.5;
  }

  // Final weighted score: 0.30*interest + 0.25*social + 0.20*recency + 0.15*engagement + 0.10*class
  const totalScore =
    RANKING_CONFIG.WEIGHTS.INTEREST * interestScore +
    RANKING_CONFIG.WEIGHTS.SOCIAL * socialScore +
    RANKING_CONFIG.WEIGHTS.RECENCY * recencyScore +
    RANKING_CONFIG.WEIGHTS.ENGAGEMENT * engagementScore +
    RANKING_CONFIG.WEIGHTS.CLASS_CONTEXT * classContextScore;

  return {
    post,
    totalScore,
    scoreBreakdown: {
      interest: Number(interestScore.toFixed(4)),
      social: Number(socialScore.toFixed(4)),
      recency: Number(recencyScore.toFixed(4)),
      engagement: Number(engagementScore.toFixed(4)),
      classContext: Number(classContextScore.toFixed(4)),
    },
  };
}

/**
 * Filter, score, and diversify candidate posts.
 */
export function rankPosts(
  candidates: CandidatePost[],
  context: UserRankingContext,
  limit = 20
): ScoredPost[] {
  const now = context.nowMs ?? Date.now();
  const nowIso = new Date(now).toISOString();

  // 1. Filter expired, deleted, and hidden/not-interested posts
  const filtered = candidates.filter((c) => {
    if (c.status !== 'active') return false;
    if (c.expires_at <= nowIso) return false;
    if (context.notInterestedPostIds.has(c.id)) return false;
    return true;
  });

  // 2. Score candidates
  const scored = filtered.map((c) => scoreCandidate(c, context));

  // Sort descending by total score
  scored.sort((a, b) => b.totalScore - a.totalScore);

  // 3. Diversity Pass:
  // - Max 2 posts per author
  // - Max 3 posts per topic
  // - Reserve ~15% of slots for exploration pool
  const explorationTarget = Math.max(1, Math.round(limit * RANKING_CONFIG.EXPLORATION_RATIO));
  const mainTarget = limit - explorationTarget;

  const result: ScoredPost[] = [];
  const authorCounts = new Map<string, number>();
  const topicCounts = new Map<string, number>();
  const remainingExploration: ScoredPost[] = [];

  const canAdd = (item: ScoredPost): boolean => {
    const authorCount = authorCounts.get(item.post.author_id) || 0;
    if (authorCount >= RANKING_CONFIG.MAX_PER_AUTHOR) return false;

    if (item.post.topics) {
      for (const t of item.post.topics) {
        const topCount = topicCounts.get(t.slug) || 0;
        if (topCount >= RANKING_CONFIG.MAX_PER_TOPIC) return false;
      }
    }
    return true;
  };

  const recordAdd = (item: ScoredPost) => {
    authorCounts.set(item.post.author_id, (authorCounts.get(item.post.author_id) || 0) + 1);
    if (item.post.topics) {
      for (const t of item.post.topics) {
        topicCounts.set(t.slug, (topicCounts.get(t.slug) || 0) + 1);
      }
    }
  };

  // Separate exploration items (outside usual circle: author not followed, not own class)
  for (const item of scored) {
    const isExploration =
      item.post.pool === 'exploration' ||
      (!context.followedUserIds.has(item.post.author_id) &&
        item.post.author_id !== context.userId &&
        item.post.author_class_id !== context.userClassId);

    if (isExploration) {
      remainingExploration.push(item);
    }
  }

  // Populate main slots
  for (const item of scored) {
    if (result.length >= mainTarget) break;
    if (canAdd(item)) {
      result.push(item);
      recordAdd(item);
    }
  }

  // Add exploration slots
  for (const exp of remainingExploration) {
    if (result.length >= limit) break;
    if (!result.some((r) => r.post.id === exp.post.id) && canAdd(exp)) {
      result.push(exp);
      recordAdd(exp);
    }
  }

  // If still under limit, backfill from scored candidates
  for (const item of scored) {
    if (result.length >= limit) break;
    if (!result.some((r) => r.post.id === item.post.id)) {
      result.push(item);
    }
  }

  return result;
}
