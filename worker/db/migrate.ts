import type { D1Database } from '@cloudflare/workers-types';

/**
 * Migration runner for Cloudflare D1 database.
 * Tracks applied migrations in the _migrations table and executes new migrations.
 */

export const MIGRATION_001_INIT_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  provider_subject TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  username_normalized TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  avatar_media_id TEXT
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dm_policy TEXT NOT NULL DEFAULT 'everyone',
  feed_preferences TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_provider_subject ON users(provider_subject);
CREATE INDEX IF NOT EXISTS idx_profiles_username_normalized ON profiles(username_normalized);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
`;

export const MIGRATION_002_SOCIAL_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS post_media (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, media_id)
);

CREATE TABLE IF NOT EXISTS post_reactions (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'like',
  created_at TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id, type)
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followed_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (follower_id, followed_id),
  CHECK (follower_id != followed_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_feed ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);
CREATE INDEX IF NOT EXISTS idx_posts_expires_at ON posts(expires_at);
CREATE INDEX IF NOT EXISTS idx_media_owner ON media(owner_id);
CREATE INDEX IF NOT EXISTS idx_comments_post_created ON comments(post_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_comments_author ON comments(author_id);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_followed ON follows(followed_id);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_type, target_id);
`;

export const MIGRATION_003_DISCOVERY_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

INSERT OR IGNORE INTO classes (id, name) VALUES
  ('cls_2025', 'Class of 2025'),
  ('cls_2026', 'Class of 2026'),
  ('cls_2027', 'Class of 2027'),
  ('cls_2028', 'Class of 2028'),
  ('cls_alumni', 'Alumni'),
  ('cls_faculty', 'Faculty & Staff');

CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS post_topics (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  confidence REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (post_id, topic_id)
);

CREATE TABLE IF NOT EXISTS user_topic_signals (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  weight REAL NOT NULL DEFAULT 0.0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, topic_id)
);

CREATE TABLE IF NOT EXISTS impressions (
  id TEXT PRIMARY KEY,
  viewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  shown_at TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trend_snapshots (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  window TEXT NOT NULL,
  window_start TEXT NOT NULL,
  score REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_posts_body ON posts(body);
CREATE INDEX IF NOT EXISTS idx_profiles_class ON profiles(class_id);
CREATE INDEX IF NOT EXISTS idx_post_topics_topic ON post_topics(topic_id);
CREATE INDEX IF NOT EXISTS idx_user_topic_signals_user ON user_topic_signals(user_id);
CREATE INDEX IF NOT EXISTS idx_impressions_viewer_post ON impressions(viewer_id, post_id, shown_at);
CREATE INDEX IF NOT EXISTS idx_impressions_shown_at ON impressions(shown_at);
CREATE INDEX IF NOT EXISTS idx_feedback_user_post ON feedback(user_id, post_id);
CREATE INDEX IF NOT EXISTS idx_feedback_post_type ON feedback(post_id, type);
CREATE INDEX IF NOT EXISTS idx_trend_snapshots_window ON trend_snapshots(window, score DESC);
CREATE INDEX IF NOT EXISTS idx_rate_limits_key ON rate_limits(key, window_start);
`;

export const MIGRATION_004_MESSAGING_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_members_user ON conversation_members(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, sent_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at);

CREATE TABLE IF NOT EXISTS message_media (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, media_id)
);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id);

CREATE TABLE IF NOT EXISTS report_evidence (
  id TEXT PRIMARY KEY NOT NULL,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_report_evidence_report ON report_evidence(report_id);
CREATE INDEX IF NOT EXISTS idx_report_evidence_expires ON report_evidence(expires_at);
`;

export interface MigrationRecord {
  name: string;
  sql: string;
}

export const MIGRATIONS: MigrationRecord[] = [
  {
    name: '001_init.sql',
    sql: MIGRATION_001_INIT_SQL,
  },
  {
    name: '002_social.sql',
    sql: MIGRATION_002_SOCIAL_SQL,
  },
  {
    name: '003_discovery.sql',
    sql: MIGRATION_003_DISCOVERY_SQL,
  },
];

export const ALL_MIGRATIONS: MigrationRecord[] = [
  ...MIGRATIONS,
  {
    name: '004_messaging.sql',
    sql: MIGRATION_004_MESSAGING_SQL,
  },
];

export async function runMigrations(
  db: D1Database,
  migrationsToRun: MigrationRecord[] = MIGRATIONS
): Promise<{ applied: string[] }> {
  // Ensure migration tracking table exists
  await db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedQuery = await db.prepare('SELECT name FROM _migrations').all<{ name: string }>();
  const appliedSet = new Set((appliedQuery.results || []).map((r) => r.name));

  const newlyApplied: string[] = [];

  for (const migration of migrationsToRun) {
    if (!appliedSet.has(migration.name)) {
      // Execute the migration SQL
      await db.exec(migration.sql);

      // Ensure class_id on profiles for backwards compatibility
      try {
        const cols = await db.prepare("PRAGMA table_info(profiles)").all<{ name: string }>();
        if (cols.results && !cols.results.some((c) => c.name === 'class_id')) {
          await db.exec('ALTER TABLE profiles ADD COLUMN class_id TEXT;');
        }
      } catch {
        // Ignored if already added
      }

      // Record migration as applied
      const now = new Date().toISOString();
      await db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').bind(migration.name, now).run();

      newlyApplied.push(migration.name);
    }
  }

  return { applied: newlyApplied };
}
