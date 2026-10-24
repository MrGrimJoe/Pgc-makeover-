-- 013_student_verification.sql: one registration per student per campus, and what was checked at sign-up.
--
-- campus_key  the campus id from the bundled list, or 'other:<normalized text>' for a typed campus.
-- roll_key    HMAC-SHA256 of the normalized full roll number (secret ROLL_KEY_SECRET), never the roll number itself.
--             Section, class and session are NOT part of the key: a student keeps the same roll number as they move up.
-- verification_status  'unverified' (no card check), 'provisional' (barcode on the card matched the roll number).
--             Provisional is NOT proof: a barcode can be copied. It is the most this app can say without a PGC registry.
ALTER TABLE user_private ADD COLUMN campus_key TEXT;
ALTER TABLE user_private ADD COLUMN roll_key TEXT;
ALTER TABLE user_private ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'unverified'
  CHECK (verification_status IN ('unverified', 'provisional'));
ALTER TABLE user_private ADD COLUMN verification_method TEXT;
ALTER TABLE user_private ADD COLUMN verified_at TEXT;

-- The database, not the browser, decides: two sign-ups racing for the same roll number cannot both succeed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_private_registration
  ON user_private(campus_key, roll_key)
  WHERE campus_key IS NOT NULL AND roll_key IS NOT NULL;

-- A student who is told "already registered" is not banned; the attempt is kept here for an administrator to look at.
-- It holds no details of the other account. One row per (Google account, campus, roll number).
CREATE TABLE IF NOT EXISTS registration_disputes (
  id TEXT PRIMARY KEY NOT NULL,
  provider_subject TEXT NOT NULL,
  email TEXT,
  campus_key TEXT NOT NULL,
  roll_key TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  UNIQUE (provider_subject, campus_key, roll_key)
);
CREATE INDEX IF NOT EXISTS idx_registration_disputes_status ON registration_disputes(status, created_at);
