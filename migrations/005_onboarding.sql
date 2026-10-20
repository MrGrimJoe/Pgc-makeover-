-- 005_onboarding.sql: campuses, private sign-up data, sign-up tickets, profile styles
PRAGMA foreign_keys = ON;

-- campuses: approved list (seeded by an admin) plus student-requested pending entries
CREATE TABLE IF NOT EXISTS campuses (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '',
  city_normalized TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'pending')),
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_campuses_name_city ON campuses(name_normalized, city_normalized);
CREATE INDEX IF NOT EXISTS idx_campuses_city ON campuses(city_normalized);
CREATE INDEX IF NOT EXISTS idx_campuses_status ON campuses(status);

-- campus_requests: who asked for a pending campus (actor_key is a user id or 'ticket:<id>' during sign-up)
CREATE TABLE IF NOT EXISTS campus_requests (
  campus_id TEXT NOT NULL REFERENCES campuses(id) ON DELETE CASCADE,
  actor_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (campus_id, actor_key)
);

CREATE INDEX IF NOT EXISTS idx_campus_requests_actor ON campus_requests(actor_key);

-- Profile additions. real_name is shown on the profile page only.
ALTER TABLE profiles ADD COLUMN campus_id TEXT REFERENCES campuses(id) ON DELETE SET NULL;
ALTER TABLE profiles ADD COLUMN real_name TEXT;
ALTER TABLE profiles ADD COLUMN wallpaper_id TEXT;
ALTER TABLE profiles ADD COLUMN theme_id TEXT;
ALTER TABLE profiles ADD COLUMN text_style_id TEXT;

CREATE INDEX IF NOT EXISTS idx_profiles_campus ON profiles(campus_id);
CREATE INDEX IF NOT EXISTS idx_profiles_class ON profiles(class_id);

-- user_private: never returned by any API. Kept out of profiles on purpose so SELECT * cannot leak it.
CREATE TABLE IF NOT EXISTS user_private (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  roll_last3 TEXT CHECK (roll_last3 IS NULL OR (length(roll_last3) = 3 AND roll_last3 NOT GLOB '*[^0-9]*'))
);

-- signup_tickets: short-lived, single-use proof that a Google account was verified. No user row exists yet.
CREATE TABLE IF NOT EXISTS signup_tickets (
  id TEXT PRIMARY KEY NOT NULL,
  provider_subject TEXT NOT NULL,
  email TEXT,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_signup_tickets_expires ON signup_tickets(expires_at);
