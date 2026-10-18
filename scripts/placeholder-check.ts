import fs from 'fs';
import path from 'path';

/**
 * Hardcoded sample/placeholder data must never ship in the client.
 *
 * Used by both the vitest guard (tests/placeholder-data.test.ts) and
 * scripts/prelaunch-check.ts, so there is one list of banned strings.
 * Only scan src/ with this: the patterns themselves live in this file.
 */
export interface PlaceholderHit {
  file: string;
  line: number;
  label: string;
  content: string;
}

export const PLACEHOLDER_PATTERNS: ReadonlyArray<{ label: string; regex: RegExp }> = [
  { label: 'ayesha', regex: /ayesha/i },
  { label: 'hamza', regex: /hamza/i },
  { label: 'posts this week', regex: /posts this week/i },
  { label: 'Class 12-', regex: /Class 12-/i },
];

const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.html', '.css', '.md']);

/** Recursively scan `dir`; reported paths are relative to `baseDir`. */
export function findPlaceholderStrings(dir: string, baseDir: string = dir): PlaceholderHit[] {
  const hits: PlaceholderHit[] = [];
  if (!fs.existsSync(dir)) return hits;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) hits.push(...findPlaceholderStrings(fullPath, baseDir));
      continue;
    }
    if (!entry.isFile() || !SCANNED_EXTENSIONS.has(path.extname(entry.name))) continue;

    const lines = fs.readFileSync(fullPath, 'utf8').split('\n');
    lines.forEach((text, idx) => {
      for (const { label, regex } of PLACEHOLDER_PATTERNS) {
        if (regex.test(text)) {
          hits.push({
            file: path.relative(baseDir, fullPath),
            line: idx + 1,
            label,
            content: text.trim(),
          });
        }
      }
    });
  }
  return hits;
}
