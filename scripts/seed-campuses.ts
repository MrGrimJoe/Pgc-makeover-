/**
 * Builds SQL that loads the approved campus list from a CSV (columns: name,city).
 *
 *   npx tsx scripts/seed-campuses.ts data/campuses.csv > campuses.sql
 *   npx wrangler d1 execute classsync-db --remote --file=campuses.sql
 *
 * Safe to run again: rows that already exist (same normalized name and city) are skipped.
 * No campus names are built into the app; the list comes only from your CSV.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkCampusInput, normalizeCampusText } from '../shared/campus.ts';

export interface CampusCsvRow {
  name: string;
  city: string;
}

/** Minimal RFC 4180 parser: quoted fields, escaped quotes (""), commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

/** Parses and validates the campus CSV. Throws one error listing every bad line. */
export function parseCampusCsv(text: string): CampusCsvRow[] {
  const rows = parseCsv(text);
  const header = (rows[0] ?? []).map((c) => c.trim().toLowerCase());
  if (header[0] !== 'name' || header[1] !== 'city' || header.length !== 2) {
    throw new Error('CSV header must be exactly: name,city');
  }

  const problems: string[] = [];
  const out: CampusCsvRow[] = [];
  const seen = new Set<string>();
  rows.slice(1).forEach((cells, idx) => {
    const line = idx + 2;
    if (cells.length !== 2) {
      problems.push(`line ${line}: expected 2 columns, got ${cells.length}`);
      return;
    }
    const checked = checkCampusInput(cells[0], cells[1]);
    if (!checked.ok) {
      problems.push(`line ${line}: ${checked.error}`);
      return;
    }
    const key = `${normalizeCampusText(checked.name)}|${normalizeCampusText(checked.city)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: checked.name, city: checked.city });
  });

  if (problems.length > 0) throw new Error(`Invalid campus CSV:\n${problems.join('\n')}`);
  return out;
}

/** Same name and city always give the same id, so re-seeding never duplicates a campus. */
export function campusId(name: string, city: string): string {
  const digest = createHash('sha256').update(`${normalizeCampusText(name)}|${normalizeCampusText(city)}`).digest('hex');
  return `cmp_${digest.slice(0, 24)}`;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildCampusSeedSql(rows: CampusCsvRow[], now = new Date().toISOString()): string {
  const lines = rows.map(
    (r) =>
      'INSERT OR IGNORE INTO campuses (id, name, name_normalized, city, city_normalized, status, created_at) VALUES (' +
      [
        sqlString(campusId(r.name, r.city)),
        sqlString(r.name),
        sqlString(normalizeCampusText(r.name)),
        sqlString(r.city),
        sqlString(normalizeCampusText(r.city)),
        "'approved'",
        sqlString(now),
      ].join(', ') +
      ');'
  );
  return `-- ${rows.length} approved campuses\n${lines.join('\n')}\n`;
}

const isMain = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (isMain) {
  const file = process.argv[2] ?? 'data/campuses.csv';
  try {
    const rows = parseCampusCsv(readFileSync(file, 'utf8'));
    if (rows.length === 0) {
      console.error(`No campuses found in ${file}. Add rows under the "name,city" header first.`);
      process.exit(1);
    }
    process.stdout.write(buildCampusSeedSql(rows));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
