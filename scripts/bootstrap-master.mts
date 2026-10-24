/**
 * Makes ONE account the master admin of this app. Run it once, from the repo, after that account has signed up.
 *
 *   npm run bootstrap:master -- --user-id usr_XXXX --remote      (the live database)
 *   npm run bootstrap:master -- --user-id usr_XXXX --local       (your local test database)
 *
 * Where to find the id: sign in, open Settings, the "Account ID" line at the bottom of the Account section.
 *
 * What it will and will not do:
 *  - it only runs when you say --remote or --local (it never guesses which database you mean),
 *  - it refuses if a master already exists (it never replaces or overwrites one) and when the account is missing or not active,
 *  - running it again for the same account is safe and changes nothing,
 *  - no password or secret is involved; wrangler uses your own Cloudflare login (npx wrangler login),
 *  - it is not part of the web app and cannot be reached from the internet.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bootstrapReadSql, bootstrapSql, planBootstrap, USER_ID_PATTERN, type BootstrapTarget } from '../worker/db/bootstrap-master.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const fail = (msg: string): never => { console.error(`\nFAILED: ${msg}\n`); process.exit(1); };

const userId = value('user-id') ?? '';
if (!USER_ID_PATTERN.test(userId)) fail('Give the account id with --user-id usr_XXXX (find it in Settings, Account ID).');
if (flag('remote') === flag('local')) fail('Say which database: add exactly one of --remote (live) or --local (test).');

const toml = readFileSync('wrangler.toml', 'utf8');
const dbName = value('db') ?? /database_name\s*=\s*"([^"]+)"/.exec(toml)?.[1];
if (!dbName) fail('Could not read database_name from wrangler.toml. Pass it with --db <name>.');

// Run wrangler through node itself so this works the same in Windows CMD, PowerShell and bash (no shell, no quoting)
const wranglerJs = join(dirname(createRequire(import.meta.url).resolve('wrangler/package.json')), 'bin', 'wrangler.js');
const dir = mkdtempSync(join(tmpdir(), 'bootstrap-master-'));

function d1(sql: string): Array<{ results: Array<Record<string, unknown>> }> {
  const file = join(dir, `q${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(file, sql);
  const run = spawnSync(process.execPath, [wranglerJs, 'd1', 'execute', dbName!, flag('remote') ? '--remote' : '--local', '--json', '--file', file], { encoding: 'utf8' });
  if (run.status !== 0) fail(`wrangler stopped with an error:\n${(run.stderr || run.stdout).trim().split('\n').slice(-8).join('\n')}\nAre you signed in? Run: npx wrangler login`);
  const start = run.stdout.indexOf('[');
  try { return JSON.parse(run.stdout.slice(start)); } catch { return fail('Could not read the answer from wrangler.'); }
}

try {
  console.log(`Checking ${dbName} (${flag('remote') ? 'live' : 'local'}) ...`);
  const [targetRes, mastersRes] = d1(bootstrapReadSql(userId));
  const target = (targetRes?.results?.[0] as unknown as BootstrapTarget | undefined) ?? null;
  const masters = (mastersRes?.results ?? []).map((r) => String(r['id']));

  const plan = planBootstrap(userId, target, masters);
  if (plan.action === 'refuse') fail(plan.message);
  if (plan.action === 'already_master') {
    console.log(`\nOK, nothing to do: ${userId} is already the master admin.\n`);
    process.exit(0);
  }

  d1(bootstrapSql(userId, new Date().toISOString()));

  const [after] = d1(`SELECT role FROM users WHERE id = '${userId}';`);
  if (after?.results?.[0]?.['role'] !== 'master') fail('The change did not take effect. Nothing was promoted. Check the database and try again.');
  console.log(`\nSUCCESS: ${userId} is now the master admin. Open Settings in the app: "Admin tools" appears there.\n`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
