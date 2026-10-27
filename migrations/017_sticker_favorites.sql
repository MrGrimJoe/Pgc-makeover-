-- 017_sticker_favorites.sql: favorites. A person can keep a sticker or GIF they saw in someone else's chat, post or comment.
--
-- Bundled stickers are only a key (nothing is stored in R2), so they go in sticker_favorites.
-- A sticker or GIF someone uploaded is copied into the person's own library (their own media row), and the row is
-- marked source = 'favorite' so the picker can show it under Favorites instead of Mine.
CREATE TABLE IF NOT EXISTS sticker_favorites (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sticker_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, sticker_key)
);
ALTER TABLE sticker_library ADD COLUMN source TEXT NOT NULL DEFAULT 'own' CHECK (source IN ('own', 'favorite'));
