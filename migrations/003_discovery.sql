-- Milestone 3: Discovery Engine Schema (Topics, Signals, Impressions, Feedback, Trends, Classes, Rate Limits)
PRAGMA foreign_keys = ON;

-- Classes table
CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

-- Seed default classes
INSERT OR IGNORE INTO classes (id, name) VALUES
  ('cls_2025', 'Class of 2025'),
  ('cls_2026', 'Class of 2026'),
  ('cls_2027', 'Class of 2027'),
  ('cls_2028', 'Class of 2028'),
  ('cls_alumni', 'Alumni'),
  ('cls_faculty', 'Faculty & Staff');

-- Add class_id to profiles (user picks class on profile edit)
ALTER TABLE profiles ADD COLUMN class_id TEXT REFERENCES classes(id) ON DELETE SET NULL;

-- Topics table
CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL
);

-- Post topics with confidence score and cascades
CREATE TABLE IF NOT EXISTS post_topics (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  confidence REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (post_id, topic_id)
);

-- User topic signals with decayed weights and cascades
CREATE TABLE IF NOT EXISTS user_topic_signals (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  weight REAL NOT NULL DEFAULT 0.0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, topic_id)
);

-- Impressions log for view deduplication and exposure adjustment
CREATE TABLE IF NOT EXISTS impressions (
  id TEXT PRIMARY KEY,
  viewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  shown_at TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

-- Explicit feedback (more_like_this, show_less, not_interested)
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Trend snapshots aggregated over time windows (24h, 7d)
CREATE TABLE IF NOT EXISTS trend_snapshots (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  window TEXT NOT NULL,
  window_start TEXT NOT NULL,
  score REAL NOT NULL
);

-- D1-backed rate limiting table
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);

-- Search index over posts.body
CREATE INDEX IF NOT EXISTS idx_posts_body ON posts(body);

-- Additional indexes for performance and query optimization
CREATE INDEX IF NOT EXISTS idx_profiles_class ON profiles(class_id);
CREATE INDEX IF NOT EXISTS idx_post_topics_topic ON post_topics(topic_id);
CREATE INDEX IF NOT EXISTS idx_user_topic_signals_user ON user_topic_signals(user_id);
CREATE INDEX IF NOT EXISTS idx_impressions_viewer_post ON impressions(viewer_id, post_id, shown_at);
CREATE INDEX IF NOT EXISTS idx_impressions_shown_at ON impressions(shown_at);
CREATE INDEX IF NOT EXISTS idx_feedback_user_post ON feedback(user_id, post_id);
CREATE INDEX IF NOT EXISTS idx_feedback_post_type ON feedback(post_id, type);
CREATE INDEX IF NOT EXISTS idx_trend_snapshots_window ON trend_snapshots(window, score DESC);
CREATE INDEX IF NOT EXISTS idx_rate_limits_key ON rate_limits(key, window_start);
