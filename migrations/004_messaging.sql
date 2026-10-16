-- 004_messaging.sql: Direct messaging, blocking, and report evidence
PRAGMA foreign_keys = ON;

-- conversations: 1:1 conversation containers
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL
);

-- conversation_members: Users participating in a conversation
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_members_user ON conversation_members(user_id);

-- messages: Ephemeral messages (14-day expiry)
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

-- message_media: Media attachments linked to messages
CREATE TABLE IF NOT EXISTS message_media (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, media_id)
);

-- blocks: User blocking records
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id);

-- report_evidence: Preserved snapshots of reported content (30-day expiry)
CREATE TABLE IF NOT EXISTS report_evidence (
  id TEXT PRIMARY KEY NOT NULL,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_report_evidence_report ON report_evidence(report_id);
CREATE INDEX IF NOT EXISTS idx_report_evidence_expires ON report_evidence(expires_at);
