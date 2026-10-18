import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findPlaceholderStrings, PLACEHOLDER_PATTERNS } from '../scripts/placeholder-check.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');

describe('No hardcoded placeholder data in src/', () => {
  it('src/ contains no fake people, fake counts or fake class names', () => {
    const hits = findPlaceholderStrings(path.join(repoRoot, 'src'), repoRoot);
    const report = hits.map((h) => `${h.file}:${h.line} [${h.label}] ${h.content}`).join('\n');
    expect(hits, `Placeholder data found:\n${report}`).toEqual([]);
  });

  it('the scanner really detects every banned string (guard is not vacuous)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'placeholder-scan-'));
    try {
      fs.mkdirSync(path.join(tmp, 'pages'));
      fs.writeFileSync(
        path.join(tmp, 'pages', 'Fake.tsx'),
        [
          "const a = 'ayesha.k';",
          "const b = 'Hamza.M';",
          'const c = `${n} posts this week`;',
          "const d = 'Class 12-B';",
          "const clean = 'nothing to see here';",
        ].join('\n')
      );
      const hits = findPlaceholderStrings(tmp);
      expect(hits.map((h) => h.label).sort()).toEqual(
        PLACEHOLDER_PATTERNS.map((p) => p.label).sort()
      );
      expect(hits.map((h) => h.line).sort()).toEqual([1, 2, 3, 4]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
