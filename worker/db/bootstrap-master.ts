/**
 * Rules and SQL for making the first (and only) master admin. Used by scripts/bootstrap-master.mts, which runs it
 * from the command line during deployment. It is not reachable from the web app in any way.
 */

/** Account ids look like usr_ followed by letters, digits, - or _. Checked before anything is put into SQL. */
export const USER_ID_PATTERN = /^usr_[A-Za-z0-9_-]{1,64}$/;

export interface BootstrapTarget {
  id: string;
  status: string;
  role: string;
}

export type BootstrapPlan =
  | { action: 'promote' }
  | { action: 'already_master' }
  | { action: 'refuse'; reason: 'invalid_id' | 'no_such_user' | 'not_active' | 'other_master'; message: string };

const refuse = (reason: Extract<BootstrapPlan, { action: 'refuse' }>['reason'], message: string): BootstrapPlan => ({ action: 'refuse', reason, message });

/**
 * Decides what to do from what the database currently holds.
 * `masters` is the list of account ids that are master right now (never more than one, the database enforces it).
 */
export function planBootstrap(userId: string, target: BootstrapTarget | null, masters: string[]): BootstrapPlan {
  if (!USER_ID_PATTERN.test(userId)) {
    return refuse('invalid_id', 'That is not an account id. It looks like usr_ followed by letters and digits.');
  }
  if (masters.some((m) => m !== userId)) {
    return refuse('other_master', 'A master admin already exists. This command never replaces one. See "Recovery" in the README if you really need to.');
  }
  if (!target) return refuse('no_such_user', 'No account has that id in this database. Check you are using the right database and the right id.');
  if (target.status !== 'active') return refuse('not_active', `That account is ${target.status}, only an active account can become the master admin.`);
  if (target.role === 'master' && masters.includes(userId)) return { action: 'already_master' };
  return { action: 'promote' };
}

/**
 * The write itself. Two statements, each safe on its own and safe to run twice:
 *  1. promotes the account only if it is active and nobody is master yet (the unique index is a second lock),
 *  2. writes one audit line, only if the promotion is in place and was not logged before.
 * The id must have passed USER_ID_PATTERN (it is put into the SQL text because the command line has no bound values).
 */
export function bootstrapSql(userId: string, nowIso: string): string {
  if (!USER_ID_PATTERN.test(userId)) throw new Error('Invalid account id');
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(nowIso)) throw new Error('Invalid timestamp');
  return [
    `UPDATE users SET role = 'master', appointed_by = NULL, appointed_at = '${nowIso}'`,
    `WHERE id = '${userId}' AND status = 'active' AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'master' AND id != '${userId}');`,
    `INSERT INTO admin_actions (id, actor_id, action, target_id, detail, created_at)`,
    `SELECT 'act_bootstrap_${userId.slice(4, 40)}', '${userId}', 'bootstrap:master', '${userId}', 'command line', '${nowIso}'`,
    `WHERE EXISTS (SELECT 1 FROM users WHERE id = '${userId}' AND role = 'master')`,
    `AND NOT EXISTS (SELECT 1 FROM admin_actions WHERE action = 'bootstrap:master' AND target_id = '${userId}');`,
  ].join('\n');
}

/** Read-only checks the script runs first. */
export const bootstrapReadSql = (userId: string): string => {
  if (!USER_ID_PATTERN.test(userId)) throw new Error('Invalid account id');
  return [
    `SELECT id, status, role FROM users WHERE id = '${userId}';`,
    `SELECT id FROM users WHERE role = 'master';`,
  ].join('\n');
};
