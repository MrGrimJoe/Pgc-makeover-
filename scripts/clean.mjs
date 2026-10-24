// Works on Windows, macOS and Linux (the old script used `rm -rf`, which cmd.exe does not have).
import { rmSync } from 'node:fs';
for (const p of ['dist', 'server.js']) rmSync(p, { recursive: true, force: true });
console.log('Removed dist and server.js');
