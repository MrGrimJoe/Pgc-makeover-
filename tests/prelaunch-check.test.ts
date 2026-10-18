import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runPrelaunchCheck } from '../scripts/prelaunch-check.ts';

// Built the same way the script builds it, so this file never contains the literal marker.
const MARKER = ['DEV', 'ONLY'].join('-');
const GOOD_WRANGLER = 'database_id = "real-id"\n[vars]\nENVIRONMENT = "production"\n';

describe('scripts/prelaunch-check', () => {
  let root: string;

  const write = (rel: string, content: string) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'prelaunch-'));
    write('wrangler.toml', GOOD_WRANGLER);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('passes on a clean tree', () => {
    write('src/App.tsx', 'export const x = 1;\n');
    const r = runPrelaunchCheck({ rootDir: root });
    expect(r.pass).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it('finds markers in src/, worker/, server.ts and wrangler.toml', () => {
    write('src/App.tsx', `// ${MARKER}: remove before launch\n`);
    write('worker/index.ts', `// ${MARKER}: remove before launch\n`);
    write('server.ts', `// ${MARKER}: remove before launch\n`);
    write('wrangler.toml', `${GOOD_WRANGLER}# ${MARKER}\n`);
    const r = runPrelaunchCheck({ rootDir: root });
    expect(r.pass).toBe(false);
    expect(r.markers.map((m) => m.file).sort()).toEqual(
      ['server.ts', path.join('src', 'App.tsx'), path.join('worker', 'index.ts'), 'wrangler.toml'].sort()
    );
  });

  it('ignores markers in tests/, scripts/, README and docs', () => {
    write('tests/auth.test.ts', `// ${MARKER}: remove before launch\n`);
    write('scripts/seed-dev.ts', `// ${MARKER}: remove before launch\n`);
    write('README.md', `Search for \`// ${MARKER}\`\n`);
    write('docs/notes.md', `${MARKER}\n`);
    const r = runPrelaunchCheck({ rootDir: root });
    expect(r.markers).toEqual([]);
    expect(r.pass).toBe(true);
  });

  it('fails when src/ contains a placeholder string', () => {
    write('src/pages/Search.tsx', "const p = { username: 'ayesha.k' };\n");
    const r = runPrelaunchCheck({ rootDir: root });
    expect(r.pass).toBe(false);
    expect(r.failures.join('\n')).toMatch(/placeholder string/);
  });

  it('does not flag placeholder strings outside src/', () => {
    write('src/App.tsx', 'export const x = 1;\n');
    write('tests/fixture.ts', "const p = 'hamza.m'; // 18 posts this week, Class 12-A\n");
    write('worker/index.ts', "const p = 'ayesha';\n");
    const r = runPrelaunchCheck({ rootDir: root });
    expect(r.pass).toBe(true);
  });

  it('--list style run reports but never fails', () => {
    write('src/pages/Search.tsx', "const p = 'hamza';\n");
    write('src/App.tsx', `// ${MARKER}\n`);
    const r = runPrelaunchCheck({ rootDir: root, listOnly: true });
    expect(r.pass).toBe(true);
    expect(r.markers.length).toBe(1);
  });
});
