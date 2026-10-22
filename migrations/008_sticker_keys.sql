-- 008_sticker_keys.sql: sticker/GIF keys on posts and comments, and attachment rows for uploaded comment stickers.
-- A key is either app:<pack>/<number> (bundled, nothing stored in R2) or usr:<mediaId> (an uploaded sticker or GIF).
ALTER TABLE posts ADD COLUMN sticker_key TEXT;
ALTER TABLE comments ADD COLUMN sticker_key TEXT;

-- Uploaded stickers and GIFs are referenced through attachment tables so retention and read rules work the same everywhere.
CREATE TABLE IF NOT EXISTS comment_media (
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  PRIMARY KEY (comment_id, media_id)
);
CREATE INDEX IF NOT EXISTS idx_comment_media_media ON comment_media(media_id);
