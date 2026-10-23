-- 010_wallpaper_polls.sql: profile background from the person's own image, and polls on posts.
ALTER TABLE profiles ADD COLUMN wallpaper_media_id TEXT;

CREATE TABLE IF NOT EXISTS polls (
  post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS poll_options (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(post_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options(poll_id, position);

-- One vote per account per poll: the primary key makes parallel votes collapse into one row.
CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id TEXT NOT NULL REFERENCES polls(post_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_id TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  voted_at TEXT NOT NULL,
  PRIMARY KEY (poll_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_poll_votes_option ON poll_votes(option_id);
