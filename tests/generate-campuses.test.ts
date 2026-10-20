import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCsv, parseCampusCsv, buildCampusSeedSql, campusId } from '../scripts/seed-campuses.ts';
import { makeEnv, call, seedUser } from './_helpers.ts';
import { MIGRATION_005_ONBOARDING_SQL } from '../worker/db/migrate.ts';

describe('seed-campuses', () => {
  it('parses quoted fields, escaped quotes, CRLF and a BOM', () => {
    const csv = '\uFEFFname,city\r\n"Main, Campus",Lahore\r\n"The ""Hill"" College",\r\n';
    expect(parseCsv(csv)).toEqual([['name', 'city'], ['Main, Campus', 'Lahore'], ['The "Hill" College', '']]);
  });

  it('requires the exact header and reports every bad line', () => {
    expect(() => parseCampusCsv('campus,town\nA,B\n')).toThrow('header must be exactly');
    expect(() => parseCampusCsv('name,city\nX,Lahore\nOnlyOneColumn\nGood Name,Lahore\n<b>,Lahore\n')).toThrow(/line 3: expected 2 columns[\s\S]*line 5/);
  });

  it('skips duplicates that differ only in case or spacing, and keeps the first spelling', () => {
    const rows = parseCampusCsv('name,city\nCentral  Campus,Lahore\ncentral campus,LAHORE\nCentral Campus,Karachi\n');
    expect(rows).toEqual([
      { name: 'Central Campus', city: 'Lahore' },
      { name: 'Central Campus', city: 'Karachi' },
    ]);
  });

  it('gives the same id for the same campus every time', () => {
    expect(campusId('Central Campus', 'Lahore')).toBe(campusId('  central   CAMPUS ', 'lahore'));
    expect(campusId('Central Campus', 'Lahore')).not.toBe(campusId('Central Campus', 'Karachi'));
  });

  it('generates SQL that loads approved, searchable campuses and is safe to run twice', async () => {
    const rows = parseCampusCsv("name,city\nSt. Mary's College,Lahore\nRiverside Campus,Multan\n");
    const sql = buildCampusSeedSql(rows, '2026-10-19T00:00:00.000Z');
    expect(sql).toContain("'St. Mary''s College'");

    const env = await makeEnv();
    await env.DB.exec(sql);
    await env.DB.exec(sql);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM campuses WHERE status = 'approved'").first<{ n: number }>();
    expect(count?.n).toBe(2);

    const cookie = await seedUser(env, 'usr_a', 'alice');
    const res = await call(env, 'GET', `/api/campuses?q=${encodeURIComponent('st. mary')}`, { cookie });
    expect(res.json.campuses).toEqual([
      { id: campusId("St. Mary's College", 'Lahore'), name: "St. Mary's College", city: 'Lahore', status: 'approved' },
    ]);
  });

  it('does not let a malicious name break out of the SQL string', async () => {
    const evil = "x'); DROP TABLE users; --";
    const rows = parseCampusCsv(`name,city\n"${evil}",Lahore\n`);
    const env = await makeEnv();
    await env.DB.exec(buildCampusSeedSql(rows));
    const users = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").first();
    expect(users).not.toBeNull();
    const row = await env.DB.prepare('SELECT name FROM campuses').first<{ name: string }>();
    expect(row?.name).toBe(evil);
  });

  it('ships a valid campus list with no duplicates', () => {
    const text = readFileSync('data/campuses.csv', 'utf8');
    const rows = parseCampusCsv(text);
    expect(rows.length).toBe(text.trim().split('\n').length - 1);
    expect(rows.length).toBeGreaterThan(100);
    expect(rows).toContainEqual({ name: 'Johar Town Campus', city: 'Lahore' });
    expect(rows).toContainEqual({ name: 'Sialkot Campus', city: 'Sialkot' });
    const ids = new Set(rows.map((r) => campusId(r.name, r.city)));
    expect(ids.size).toBe(rows.length);
  });
});

describe('migration files', () => {
  it('migrations/005_onboarding.sql matches the copy used by the test runner', () => {
    expect(readFileSync('migrations/005_onboarding.sql', 'utf8').trim()).toBe(MIGRATION_005_ONBOARDING_SQL.trim());
  });
});
