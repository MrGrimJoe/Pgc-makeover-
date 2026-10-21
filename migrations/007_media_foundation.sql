-- 007_media_foundation.sql: media kinds and metadata, per-owner dedupe hash, thumbnails, sticker library.
ALTER TABLE media ADD COLUMN kind TEXT NOT NULL DEFAULT 'photo' CHECK (kind IN ('photo','sticker','gif','video','background'));
ALTER TABLE media ADD COLUMN width INTEGER;
ALTER TABLE media ADD COLUMN height INTEGER;
ALTER TABLE media ADD COLUMN duration_ms INTEGER;
ALTER TABLE media ADD COLUMN sha256 TEXT;
ALTER TABLE media ADD COLUMN thumb_object_key TEXT;
ALTER TABLE media ADD COLUMN thumb_size_bytes INTEGER NOT NULL DEFAULT 0;

-- Dedupe is per owner only: a shared hash would reveal whether someone else already has a file.
CREATE INDEX IF NOT EXISTS idx_media_owner_sha ON media(owner_id, sha256);
CREATE INDEX IF NOT EXISTS idx_media_owner ON media(owner_id);

CREATE TABLE IF NOT EXISTS sticker_library (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, media_id)
);
CREATE INDEX IF NOT EXISTS idx_sticker_library_media ON sticker_library(media_id);
