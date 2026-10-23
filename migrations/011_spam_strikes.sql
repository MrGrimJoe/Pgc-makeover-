-- 011_spam_strikes.sql: one row per post attempt that looked like spam. Three in a row (no normal post between,
-- all within 3 days) lock posting for 3 days from the newest one.
CREATE TABLE IF NOT EXISTS spam_strikes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signals TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spam_strikes_user ON spam_strikes(user_id, created_at);
