-- 014_appeals.sql: a suspended or banned student can ask for a review.
--
-- appeal_tickets  short-lived, issued when a blocked account signs in with Google. A blocked account has no session,
--                 so this is how the app knows who is asking. It allows exactly one thing: sending or reading an appeal.
-- appeals         one open appeal per account. An admin grants or denies it; granting reinstates the account.
CREATE TABLE IF NOT EXISTS appeal_tickets (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appeal_tickets_expires ON appeal_tickets(expires_at);

CREATE TABLE IF NOT EXISTS appeals (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 500),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'granted', 'denied')),
  account_status TEXT NOT NULL CHECK (account_status IN ('suspended', 'banned')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  decision_note TEXT NOT NULL DEFAULT ''
);
-- At most one open appeal per account; the database enforces it, not the screen.
CREATE UNIQUE INDEX IF NOT EXISTS idx_appeals_one_open ON appeals(user_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_appeals_status ON appeals(status, created_at);
