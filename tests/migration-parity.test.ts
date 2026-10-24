// `wrangler d1 migrations apply` runs the .sql files; the tests run the copies embedded in worker/db/migrate.ts.
// If the two drift apart, the tests pass on code that breaks on the real database.
//
// 005 onwards must be identical text. 001 to 004 are older: their embedded copies drop comments, a PRAGMA line and
// (in 003) the `profiles.class_id` ALTER, which runMigrations adds on its own. They are compared with those removed.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { ALL_MIGRATIONS } from '../worker/db/migrate.ts';

const text = (s: string) => s.replace(/\r\n/g, '\n').trim();
const loose = (s: string) =>
  s
    .replace(/--[^\n]*/g, '')
    .replace(/pragma foreign_keys = on;/gi, '')
    .replace(/alter table profiles add column class_id text references classes\(id\) on delete set null;/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/ ?([(),;]) ?/g, '$1')
    .replace(/if not exists /gi, '')
    .trim()
    .toLowerCase();

describe('migration files and embedded copies', () => {
  const files = readdirSync(new URL('../migrations', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();
  it('every .sql file is embedded, and the other way round', () => {
    expect(ALL_MIGRATIONS.map((m) => m.name).sort()).toEqual(files);
  });
  it.each(files)('%s matches its embedded copy', (f) => {
    const embedded = ALL_MIGRATIONS.find((m) => m.name === f);
    expect(embedded, `${f} is not embedded`).toBeTruthy();
    const onDisk = readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8');
    if (parseInt(f, 10) >= 5) expect(text(embedded!.sql)).toBe(text(onDisk));
    else expect(loose(embedded!.sql)).toBe(loose(onDisk));
  });
});
