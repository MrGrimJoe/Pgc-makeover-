-- 006_bundled_campuses.sql: campus names now ship inside the app (shared/campuses.ts).
-- Rebuilds profiles without the foreign key on campus_id, adds campus_other (free text), and
-- drops the campuses and campus_requests tables. D1 enforces foreign keys, so the rebuild defers them.
PRAGMA defer_foreign_keys = true;

CREATE TABLE profiles_new (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  username_normalized TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  avatar_media_id TEXT,
  class_id TEXT REFERENCES classes(id) ON DELETE SET NULL,
  campus_id TEXT,
  campus_other TEXT CHECK (campus_other IS NULL OR (length(campus_other) BETWEEN 2 AND 80 AND campus_id IS NULL)),
  real_name TEXT,
  wallpaper_id TEXT,
  theme_id TEXT,
  text_style_id TEXT
);

INSERT INTO profiles_new (user_id, username, username_normalized, display_name, bio, avatar_media_id, class_id, campus_id, real_name, wallpaper_id, theme_id, text_style_id)
SELECT user_id, username, username_normalized, display_name, bio, avatar_media_id, class_id, campus_id, real_name, wallpaper_id, theme_id, text_style_id FROM profiles;

DROP TABLE profiles;
ALTER TABLE profiles_new RENAME TO profiles;

CREATE INDEX IF NOT EXISTS idx_profiles_username_normalized ON profiles(username_normalized);
CREATE INDEX IF NOT EXISTS idx_profiles_class ON profiles(class_id);
CREATE INDEX IF NOT EXISTS idx_profiles_campus ON profiles(campus_id);

DROP TABLE IF EXISTS campus_requests;
DROP TABLE IF EXISTS campuses;
