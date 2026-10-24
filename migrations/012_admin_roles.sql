-- 012_admin_roles.sql: who may moderate. 'user' is everyone, 'admin' is an appointed admin, 'master' is the owner.
-- Nothing in the app can set 'master': only the bootstrap command (scripts/bootstrap-master.mts) does, and the
-- unique index below means there can never be a second one, whatever any code or query tries.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin', 'master'));
ALTER TABLE users ADD COLUMN appointed_by TEXT;
ALTER TABLE users ADD COLUMN appointed_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_one_master ON users(role) WHERE role = 'master';

-- Every admin action, newest first when read. No foreign keys on purpose: the log must survive deleted accounts.
CREATE TABLE IF NOT EXISTS admin_actions (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON admin_actions(created_at DESC);
