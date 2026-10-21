/**
 * Builds the bundled sticker catalog.
 *
 *   npm run build:stickers
 *
 * Reads public/stickers/<pack>/ (pack.json + image files), keeps public/stickers/numbering.json, and writes
 * shared/stickers.ts (the manifest the app and the Worker both import).
 *
 * NUMBERING IS PERMANENT AND APPEND-ONLY. A file keeps its number forever. A new file gets the next free number in
 * its pack. A removed file is marked retired and its number is never reused, so old messages still resolve (to a
 * placeholder). A renamed file keeps its number only if its content is unchanged (matched by SHA-256). Replacing a
 * file's content under the same file name keeps the number too.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SIZE_BUDGET_BYTES = 8 * 1024 * 1024;
const PACK_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const IMAGE_EXT = /\.(webp|png|gif)$/i;

export interface ImageInfo {
  width: number;
  height: number;
  animated: boolean;
}

/** Reads width, height and "is animated" from PNG, GIF and WebP headers (no dependencies). */
export function imageInfo(b: Uint8Array): ImageInfo {
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 3) === 'PNG') {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let animated = false;
    for (let i = 8; i + 8 <= b.length; ) {
      const len = dv.getUint32(i);
      if (ascii(i + 4, 4) === 'acTL') animated = true;
      i += 12 + len;
    }
    return { width: dv.getUint32(16), height: dv.getUint32(20), animated };
  }
  if (b.length >= 10 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) {
    // Count image descriptors (0x2C) is unreliable inside data blocks; count Graphic Control Extensions instead
    let frames = 0;
    for (let i = 13; i + 3 < b.length; i++) if (b[i] === 0x21 && b[i + 1] === 0xf9 && b[i + 2] === 0x04) frames++;
    return { width: b[6]! | (b[7]! << 8), height: b[8]! | (b[9]! << 8), animated: frames > 1 };
  }
  if (b.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const kind = ascii(12, 4);
    if (kind === 'VP8X') {
      const w = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16));
      const h = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16));
      return { width: w, height: h, animated: (b[20]! & 0x02) !== 0 };
    }
    if (kind === 'VP8L') {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff), animated: false };
    }
    if (kind === 'VP8 ') {
      return { width: (b[26]! | (b[27]! << 8)) & 0x3fff, height: (b[28]! | (b[29]! << 8)) & 0x3fff, animated: false };
    }
  }
  throw new Error('Unsupported or corrupt image (use WebP, PNG or GIF)');
}

export interface NumberingItem {
  file: string;
  sha256: string;
  retired: boolean;
}
export interface PackNumbering {
  next: number;
  items: Record<string, NumberingItem>;
}
export interface Numbering {
  version: 1;
  packs: Record<string, PackNumbering>;
}

export interface ManifestItem {
  number: number;
  file: string;
  kind: 'sticker' | 'gif';
  width: number;
  height: number;
  alt: string;
  /** First 8 hex characters of the file hash: part of the URL so replaced files are never served stale. */
  v: string;
}
export interface ManifestPack {
  id: string;
  name: string;
  order: number;
  placeholder: boolean;
  items: ManifestItem[];
  retired: number[];
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function defaultAlt(file: string): string {
  return file.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Sticker';
}

/**
 * Pure numbering step: given the files now in a pack (name -> hash) and the previous numbering, returns the new
 * numbering. Exported for tests.
 */
export function updatePackNumbering(prev: PackNumbering | undefined, files: Map<string, string>): PackNumbering {
  const next: PackNumbering = { next: prev?.next ?? 1, items: {} };
  const taken = new Set<string>();
  const missing: Array<[string, NumberingItem]> = [];
  for (const [num, item] of Object.entries(prev?.items ?? {})) {
    if (item.retired) {
      next.items[num] = item;
    } else if (files.has(item.file)) {
      next.items[num] = { file: item.file, sha256: files.get(item.file)!, retired: false }; // same name keeps the number even if the content changed
      taken.add(item.file);
    } else {
      missing.push([num, item]);
    }
  }
  const unnumbered = [...files.keys()].filter((f) => !taken.has(f)).sort();
  // A missing file whose exact content shows up under a new name is a rename and keeps its number
  for (const [num, item] of missing) {
    const renamedTo = unnumbered.find((f) => !taken.has(f) && files.get(f) === item.sha256);
    if (renamedTo) {
      next.items[num] = { file: renamedTo, sha256: item.sha256, retired: false };
      taken.add(renamedTo);
    } else {
      next.items[num] = { ...item, retired: true };
    }
  }
  for (const f of unnumbered) {
    if (taken.has(f)) continue;
    const n = next.next++;
    next.items[String(n)] = { file: f, sha256: files.get(f)!, retired: false };
    taken.add(f);
  }
  return next;
}

export interface BuildResult {
  numbering: Numbering;
  packs: ManifestPack[];
  totalBytes: number;
  warnings: string[];
}

/** Reads a stickers directory and returns the new numbering and manifest. Does not write anything. */
export function buildCatalog(dir: string): BuildResult {
  const numberingPath = join(dir, 'numbering.json');
  const prev: Numbering = existsSync(numberingPath) ? JSON.parse(readFileSync(numberingPath, 'utf8')) : { version: 1, packs: {} };
  const numbering: Numbering = { version: 1, packs: {} };
  const packs: ManifestPack[] = [];
  const warnings: string[] = [];
  let totalBytes = 0;

  const packIds = existsSync(dir) ? readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory()).sort() : [];
  for (const id of packIds) {
    if (!PACK_ID.test(id)) throw new Error(`Pack folder "${id}" must be lowercase letters, digits and dashes (1 to 32 characters)`);
    const packDir = join(dir, id);
    const metaPath = join(packDir, 'pack.json');
    if (!existsSync(metaPath)) throw new Error(`Pack "${id}" has no pack.json (needs a name and an order)`);
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { name?: string; order?: number; placeholder?: boolean; alts?: Record<string, string> };
    if (typeof meta.name !== 'string' || !meta.name.trim() || meta.name.length > 60) throw new Error(`Pack "${id}": pack.json needs a "name" (1 to 60 characters)`);
    if (typeof meta.order !== 'number') throw new Error(`Pack "${id}": pack.json needs a numeric "order"`);

    const files = new Map<string, string>();
    const bytes = new Map<string, Uint8Array>();
    for (const f of readdirSync(packDir).filter((n) => IMAGE_EXT.test(n)).sort()) {
      const data = new Uint8Array(readFileSync(join(packDir, f)));
      files.set(f, sha(data));
      bytes.set(f, data);
      totalBytes += data.length;
    }
    const packNumbering = updatePackNumbering(prev.packs[id], files);
    numbering.packs[id] = packNumbering;

    const items: ManifestItem[] = [];
    const retired: number[] = [];
    for (const [num, item] of Object.entries(packNumbering.items)) {
      if (item.retired) {
        retired.push(Number(num));
        continue;
      }
      const data = bytes.get(item.file)!;
      let info: ImageInfo;
      try {
        info = imageInfo(data);
      } catch (e) {
        throw new Error(`${id}/${item.file}: ${(e as Error).message}`);
      }
      items.push({
        number: Number(num),
        file: item.file,
        kind: info.animated || /\.gif$/i.test(item.file) ? 'gif' : 'sticker',
        width: info.width,
        height: info.height,
        alt: meta.alts?.[item.file] ?? defaultAlt(item.file),
        v: item.sha256.slice(0, 8),
      });
    }
    items.sort((a, b) => a.number - b.number);
    retired.sort((a, b) => a - b);
    packs.push({ id, name: meta.name.trim(), order: meta.order, placeholder: meta.placeholder === true, items, retired });
  }
  // Packs that were removed entirely keep their numbering, with every item retired
  for (const [id, p] of Object.entries(prev.packs)) {
    if (numbering.packs[id]) continue;
    numbering.packs[id] = { next: p.next, items: Object.fromEntries(Object.entries(p.items).map(([n, it]) => [n, { ...it, retired: true }])) };
  }
  packs.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  if (totalBytes > SIZE_BUDGET_BYTES) warnings.push(`Stickers total ${(totalBytes / 1048576).toFixed(1)} MB, above the ${SIZE_BUDGET_BYTES / 1048576} MB budget. Every student downloads these, so shrink or drop some.`);
  if (packs.some((p) => p.placeholder)) warnings.push('A PLACEHOLDER pack is still in the catalog (public/stickers/placeholder). Replace it with the real stickers before launch. See README, "Stickers and GIFs".');
  return { numbering, packs, totalBytes, warnings };
}

/** Source text of shared/stickers.ts. */
export function buildManifestModule(packs: ManifestPack[]): string {
  return `// GENERATED by scripts/build-stickers.ts from public/stickers. Do not edit by hand.
export interface BundledSticker {
  readonly number: number;
  readonly file: string;
  readonly kind: 'sticker' | 'gif';
  readonly width: number;
  readonly height: number;
  readonly alt: string;
  /** Short content hash, used in the URL so a replaced file is never served from an old cache. */
  readonly v: string;
}

export interface StickerPack {
  readonly id: string;
  readonly name: string;
  readonly order: number;
  /** True for the stand-in pack that ships until the real stickers are added. */
  readonly placeholder: boolean;
  readonly items: readonly BundledSticker[];
  /** Numbers that were removed. They are never reused; old messages show a placeholder. */
  readonly retired: readonly number[];
}

export const STICKER_PACKS: readonly StickerPack[] = ${JSON.stringify(packs, null, 2)};
`;
}

const isMain = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (isMain) {
  try {
    const dir = fileURLToPath(new URL('../public/stickers', import.meta.url));
    const { numbering, packs, totalBytes, warnings } = buildCatalog(dir);
    writeFileSync(join(dir, 'numbering.json'), JSON.stringify(numbering, null, 2) + '\n');
    writeFileSync(fileURLToPath(new URL('../shared/stickers.ts', import.meta.url)), buildManifestModule(packs));
    const count = packs.reduce((n, p) => n + p.items.length, 0);
    console.log(`shared/stickers.ts: ${packs.length} pack(s), ${count} item(s), ${(totalBytes / 1024).toFixed(0)} KB`);
    for (const w of warnings) console.warn(`WARNING: ${w}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
