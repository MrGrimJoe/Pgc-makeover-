// Copies the text-reading engine into public/ocr so the sign-up screen loads it from this site, never from a CDN
// (no third party sees the card, and it works behind school networks that block CDNs). Run before dev and build.
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const out = 'public/ocr';
mkdirSync(out, { recursive: true });
const tess = dirname(require.resolve('tesseract.js/package.json'));
const core = dirname(require.resolve('tesseract.js-core/package.json'));
const data = dirname(require.resolve('@tesseract.js-data/eng/package.json'));
cpSync(join(tess, 'dist/worker.min.js'), join(out, 'worker.min.js'));
for (const f of ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js']) cpSync(join(core, f), join(out, f));
cpSync(join(data, '4.0.0/eng.traineddata.gz'), join(out, 'eng.traineddata.gz'));
if (!existsSync(join(out, 'eng.traineddata.gz'))) throw new Error('OCR language data missing');
console.log('OCR assets copied to', out);
