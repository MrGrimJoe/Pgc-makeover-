/** Exports the live database to backups/classsync-YYYY-MM-DD.sql. Works in Windows CMD (the old script used $(date), which CMD does not understand). */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const dbName = /database_name\s*=\s*"([^"]+)"/.exec(readFileSync('wrangler.toml', 'utf8'))?.[1];
if (!dbName) { console.error('Could not read database_name from wrangler.toml'); process.exit(1); }
mkdirSync('backups', { recursive: true });
const out = `backups/${dbName.replace(/-db$/, '')}-${new Date().toISOString().slice(0, 10)}.sql`;
const wranglerJs = join(dirname(createRequire(import.meta.url).resolve('wrangler/package.json')), 'bin', 'wrangler.js');
const run = spawnSync(process.execPath, [wranglerJs, 'd1', 'export', dbName, '--remote', `--output=${out}`], { stdio: 'inherit' });
if (run.status === 0) console.log(`Backup written to ${out}`);
process.exit(run.status ?? 1);
