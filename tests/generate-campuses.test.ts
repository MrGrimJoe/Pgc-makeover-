import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCsv, parseCampusCsv, campusId, buildCampusModule } from '../scripts/generate-campuses.ts';
import { MIGRATION_005_ONBOARDING_SQL, MIGRATION_006_BUNDLED_CAMPUSES_SQL, MIGRATION_007_MEDIA_FOUNDATION_SQL, MIGRATION_008_STICKER_KEYS_SQL, MIGRATION_009_MESSAGE_STICKERS_SQL, MIGRATION_010_WALLPAPER_POLLS_SQL } from '../worker/db/migrate.ts';

describe('generate-campuses', () => {
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

  it('the committed shared/campuses.ts matches data/campuses.csv (run npm run generate:campuses after editing the CSV)', () => {
    const rows = parseCampusCsv(readFileSync('data/campuses.csv', 'utf8'));
    expect(readFileSync('shared/campuses.ts', 'utf8')).toBe(buildCampusModule(rows));
  });

  it('keeps the id function stable so already-saved profiles still resolve', () => {
    // fixed expectation: the id function is unchanged from the seed script, so saved campus ids keep resolving
    expect(campusId('Allama Iqbal Town Campus', 'Lahore')).toBe('cmp_39e1988999d2e811f0291ce8');
  });
});

describe('migration files', () => {
  it('migrations/005_onboarding.sql matches the copy used by the test runner', () => {
    expect(readFileSync('migrations/005_onboarding.sql', 'utf8').trim()).toBe(MIGRATION_005_ONBOARDING_SQL.trim());
  });

  it('migrations/008 and 009 match the copies used by the test runner', () => {
    expect(readFileSync('migrations/008_sticker_keys.sql', 'utf8').trim()).toBe(MIGRATION_008_STICKER_KEYS_SQL.trim());
    expect(readFileSync('migrations/009_message_stickers.sql', 'utf8').trim()).toBe(MIGRATION_009_MESSAGE_STICKERS_SQL.trim());
  });

  it('migrations/010_wallpaper_polls.sql matches the copy used by the test runner', () => {
    expect(readFileSync('migrations/010_wallpaper_polls.sql', 'utf8').trim()).toBe(MIGRATION_010_WALLPAPER_POLLS_SQL.trim());
  });

  it('migrations/007_media_foundation.sql matches the copy used by the test runner', () => {
    expect(readFileSync('migrations/007_media_foundation.sql', 'utf8').trim()).toBe(MIGRATION_007_MEDIA_FOUNDATION_SQL.trim());
  });

  it('migrations/006_bundled_campuses.sql matches the copy used by the test runner', () => {
    expect(readFileSync('migrations/006_bundled_campuses.sql', 'utf8').trim()).toBe(MIGRATION_006_BUNDLED_CAMPUSES_SQL.trim());
  });
});
