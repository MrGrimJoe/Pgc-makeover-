/**
 * Ranking Configuration Weights & Constants
 */
export const RANKING_CONFIG = {
  WEIGHTS: {
    INTEREST: 0.30,
    SOCIAL: 0.25,
    RECENCY: 0.20,
    ENGAGEMENT: 0.15,
    CLASS_CONTEXT: 0.10,
  },
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
