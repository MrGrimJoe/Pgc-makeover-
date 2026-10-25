/**
 * Ranking Configuration Weights & Constants
 */
export const RANKING_CONFIG = {
  WEIGHTS: {
    INTEREST: 0.30,
    SOCIAL: 0.20,
    RECENCY: 0.15,
    ENGAGEMENT: 0.15,
    CLASS_CONTEXT: 0.10,
    TREND: 0.10,
  },
  // Posts the viewer already saw recently keep this share of their score (they sink, not vanish).
  SEEN_MULTIPLIER: 0.35,
  // Look-back for "already seen" posts.
  SEEN_WINDOW_MS: 3 * 24 * 60 * 60 * 1000,
  // Extra candidates pulled in beyond the newest 100.
  INTEREST_CANDIDATES: 60,
  TREND_CANDIDATES: 40,
  // Bounds for a stored topic signal so one binge cannot dominate for weeks.
  SIGNAL_MIN: -10,
  SIGNAL_MAX: 25,
  // 14-day half-life for user topic signals
  HALF_LIFE_MS: 14 * 24 * 60 * 60 * 1000,
  // Exploration slots reserved
  EXPLORATION_RATIO: 0.15,
  // Diversity limits per page
  MAX_PER_AUTHOR: 2,
  MAX_PER_TOPIC: 3,
  // Scope defaults for new users
  DEFAULT_SCOPE: {
    CLASS_SHARE: 0.80,
    CAMPUS_SHARE: 0.15,
    WIDER_SHARE: 0.05,
  },
} as const;
