import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

interface Marker {
  file: string;
  line: number;
  content: string;
}

const SEARCH_MARKER = ['DEV', 'ONLY'].join('-');
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.wrangler',
  'dist',
  'build',
  'coverage',
  'backups',
]);

const SCANNED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.toml',
  '.html',
  '.md',
  '.css',
  '.sql',
]);

function findDevOnlyMarkers(dir: string, baseDir: string): Marker[] {
  const results: Marker[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        results.push(...findDevOnlyMarkers(fullPath, baseDir));
      }
    } else if (entry.isFile()) {
      // Exclude prelaunch-check.ts itself
      if (relativePath.endsWith('prelaunch-check.ts')) {
        continue;
      }

      const ext = path.extname(entry.name);
      if (SCANNED_EXTENSIONS.has(ext)) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          if (content.includes(SEARCH_MARKER)) {
            const lines = content.split('\n');
            lines.forEach((lineText, idx) => {
              if (lineText.includes(SEARCH_MARKER)) {
                results.push({
                  file: relativePath,
                  line: idx + 1,
                  content: lineText.trim(),
                });
              }
            });
          }
        } catch {
          // ignore read errors
        }
      }
    }
  }

  return results;
}

export function runPrelaunchCheck(options: { listOnly?: boolean } = {}) {
  const rootDir = process.cwd();
  const listOnly = options.listOnly ?? process.argv.includes('--list');
  const failures: string[] = [];

  console.log('=== Prelaunch Check ===\n');

  // 1. Scan for DEV-ONLY markers
  const markers = findDevOnlyMarkers(rootDir, rootDir);

  console.log(`Found ${markers.length} ${SEARCH_MARKER} marker(s):`);
  for (const m of markers) {
    console.log(`  ${m.file}:${m.line} -> ${m.content}`);
  }
  console.log('');

  if (listOnly) {
    console.log(`--list specified: Listed ${markers.length} marker(s).`);
    return { pass: true, markers, failures: [] };
  }

  if (markers.length > 0) {
    failures.push(`${markers.length} ${SEARCH_MARKER} marker(s) remain in the codebase.`);
  }

  // 2. Check wrangler.toml for placeholder-d1-id
  const wranglerPath = path.join(rootDir, 'wrangler.toml');
  if (!fs.existsSync(wranglerPath)) {
    failures.push('wrangler.toml does not exist.');
  } else {
    const wranglerContent = fs.readFileSync(wranglerPath, 'utf8');

    if (wranglerContent.includes('placeholder-d1-id')) {
      failures.push('wrangler.toml still contains "placeholder-d1-id" in database_id.');
    }

    // 3. Check ENVIRONMENT in wrangler.toml is "production"
    const envMatch = wranglerContent.match(/ENVIRONMENT\s*=\s*"([^"]+)"/);
    if (!envMatch) {
      failures.push('ENVIRONMENT variable is not set in wrangler.toml [vars].');
    } else if (envMatch[1] !== 'production') {
      failures.push(`ENVIRONMENT in wrangler.toml is "${envMatch[1]}" instead of "production".`);
    }
  }

  if (failures.length > 0) {
    console.log('Prelaunch Check: FAIL');
    console.log('Failures:');
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
    return { pass: false, markers, failures };
  }

  console.log('Prelaunch Check: PASS');
  return { pass: true, markers, failures: [] };
}

// CLI execution
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const result = runPrelaunchCheck();
  if (!result.pass) {
    process.exit(1);
  }
}
