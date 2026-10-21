import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCatalog, buildManifestModule, imageInfo, updatePackNumbering, SIZE_BUDGET_BYTES, type Numbering } from '../scripts/build-stickers.ts';

const enc = (s: string) => [...s].map((c) => c.charCodeAt(0));
const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** A PNG with just enough structure for the header reader. `seed` makes the bytes (and hash) unique. */
const png = (w: number, h: number, seed = 0) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32be(13), ...enc('IHDR'), ...u32be(w), ...u32be(h), 8, 6, 0, 0, 0, 0, 0, 0, 0, seed, 0, 0, 0, 0, ...enc('IEND'), 0, 0, 0, 0]);
const gif = (w: number, h: number, frames: number, seed = 0) => {
  const gce = [0x21, 0xf9, 0x04, 0, 10, 0, 0, 0];
  return new Uint8Array([...enc('GIF89a'), w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0, ...Array.from({ length: frames }).flatMap(() => gce), seed, 0x3b]);
};
const webpL = (w: number, h: number, seed = 0) => {
  const bits = (w - 1) | ((h - 1) << 14);
  return new Uint8Array([...enc('RIFF'), 24, 0, 0, 0, ...enc('WEBP'), ...enc('VP8L'), 8, 0, 0, 0, 0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >> 24) & 255, seed, 0, 0, 0, 0, 0, 0]);
};
const webpX = (w: number, h: number, animated: boolean) =>
  new Uint8Array([...enc('RIFF'), 30, 0, 0, 0, ...enc('WEBP'), ...enc('VP8X'), 10, 0, 0, 0, animated ? 0x02 : 0, 0, 0, 0, (w - 1) & 255, ((w - 1) >> 8) & 255, 0, (h - 1) & 255, ((h - 1) >> 8) & 255, 0]);

describe('imageInfo', () => {
  it('reads size and animation from PNG, GIF and WebP headers', () => {
    expect(imageInfo(png(512, 256))).toEqual({ width: 512, height: 256, animated: false });
    expect(imageInfo(gif(160, 120, 1))).toEqual({ width: 160, height: 120, animated: false });
    expect(imageInfo(gif(160, 120, 5))).toEqual({ width: 160, height: 120, animated: true });
    expect(imageInfo(webpL(512, 512))).toEqual({ width: 512, height: 512, animated: false });
    expect(imageInfo(webpX(300, 200, false))).toEqual({ width: 300, height: 200, animated: false });
    expect(imageInfo(webpX(300, 200, true)).animated).toBe(true);
  });
  it('rejects anything else (SVG, text, truncated files)', () => {
    expect(() => imageInfo(new Uint8Array(enc('<svg xmlns="http://www.w3.org/2000/svg"/>')))).toThrow(/Unsupported/);
    expect(() => imageInfo(new Uint8Array([1, 2, 3]))).toThrow();
  });
});

describe('updatePackNumbering (pure)', () => {
  const files = (o: Record<string, string>) => new Map(Object.entries(o));
  it('numbers new files in name order from 1', () => {
    const n = updatePackNumbering(undefined, files({ 'b.png': 'h2', 'a.png': 'h1' }));
    expect(n.items['1']!.file).toBe('a.png');
    expect(n.items['2']!.file).toBe('b.png');
    expect(n.next).toBe(3);
  });
});

describe('sticker catalog: permanent, append-only numbering', () => {
  let dir: string;
  const pack = (id = 'cats', extra: object = {}) => {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, id, 'pack.json'), JSON.stringify({ name: 'Cats', order: 1, ...extra }));
  };
  const put = (file: string, bytes: Uint8Array, id = 'cats') => writeFileSync(join(dir, id, file), bytes);
  const build = () => {
    const r = buildCatalog(dir);
    writeFileSync(join(dir, 'numbering.json'), JSON.stringify(r.numbering));
    return r;
  };
  const numbers = (r: ReturnType<typeof buildCatalog>, id = 'cats') => Object.fromEntries(r.packs.find((p) => p.id === id)!.items.map((i) => [i.file, i.number]));

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'stickers-')); pack(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('adds: new files get the next free numbers, existing ones keep theirs, and a re-run changes nothing', () => {
    put('a.png', png(512, 512, 1)); put('b.webp', webpL(512, 512, 2));
    const first = build();
    expect(numbers(first)).toEqual({ 'a.png': 1, 'b.webp': 2 });
    put('c.png', png(512, 512, 3));
    put('0-first.png', png(512, 512, 4)); // sorts before the others but must not take number 1
    const second = build();
    expect(numbers(second)).toEqual({ 'a.png': 1, 'b.webp': 2, 'c.png': 4, '0-first.png': 3 });
    const third = buildCatalog(dir);
    expect(third.numbering).toEqual(second.numbering); // idempotent
    expect(buildManifestModule(third.packs)).toBe(buildManifestModule(second.packs));
  });

  it('renames: the same content under a new name keeps its number', () => {
    put('a.png', png(512, 512, 1)); put('b.png', png(512, 512, 2));
    build();
    renameSync(join(dir, 'cats', 'a.png'), join(dir, 'cats', 'happy.png'));
    const r = build();
    expect(numbers(r)).toEqual({ 'happy.png': 1, 'b.png': 2 });
    expect(r.packs[0]!.retired).toEqual([]);
  });

  it('a replaced file under the same name keeps its number (how the real art replaces a stand-in)', () => {
    put('a.png', png(512, 512, 1));
    const before = build();
    put('a.png', png(256, 256, 9));
    const after = build();
    expect(numbers(after)).toEqual({ 'a.png': 1 });
    expect(after.packs[0]!.items[0]!.width).toBe(256);
    expect(after.packs[0]!.items[0]!.v).not.toBe(before.packs[0]!.items[0]!.v); // new URL, so no stale cache
  });

  it('removes: the number is retired and never reused, even after more files are added and the catalog is rebuilt', () => {
    put('a.png', png(512, 512, 1)); put('b.png', png(512, 512, 2));
    build();
    unlinkSync(join(dir, 'cats', 'a.png'));
    const removed = build();
    expect(numbers(removed)).toEqual({ 'b.png': 2 });
    expect(removed.packs[0]!.retired).toEqual([1]);
    put('c.png', png(512, 512, 3));
    const added = build();
    expect(numbers(added)).toEqual({ 'b.png': 2, 'c.png': 3 }); // not 1
    expect(added.packs[0]!.retired).toEqual([1]);
    // putting the very same file back does not resurrect number 1: it is a new sticker with a new number
    put('a.png', png(512, 512, 1));
    const back = build();
    expect(numbers(back)['a.png']).toBe(4);
    expect(back.packs[0]!.retired).toEqual([1]);
  });

  it('removing the HIGHEST number does not free it: the next new file still gets a fresh number', () => {
    put('a.png', png(512, 512, 1)); put('b.png', png(512, 512, 2));
    build();
    unlinkSync(join(dir, 'cats', 'b.png'));
    build();
    put('c.png', png(512, 512, 3));
    const r = build();
    expect(numbers(r)).toEqual({ 'a.png': 1, 'c.png': 3 });
    expect(r.packs[0]!.retired).toEqual([2]);
  });

  it('a removed pack keeps its numbering with everything retired', () => {
    put('a.png', png(512, 512, 1));
    build();
    rmSync(join(dir, 'cats'), { recursive: true });
    const r = build();
    expect(r.packs).toEqual([]);
    expect((r.numbering as Numbering).packs.cats!.items['1']!.retired).toBe(true);
    expect((r.numbering as Numbering).packs.cats!.next).toBe(2);
  });

  it('marks animated files as GIFs and still images as stickers, with size and alt text', () => {
    pack('cats', { alts: { 'a.png': 'A smiling cat' } });
    put('a.png', png(512, 512, 1)); put('loop.gif', gif(200, 200, 4)); put('moving.webp', webpX(100, 100, true));
    const items = build().packs[0]!.items;
    expect(items.find((i) => i.file === 'a.png')).toMatchObject({ kind: 'sticker', width: 512, alt: 'A smiling cat' });
    expect(items.find((i) => i.file === 'loop.gif')).toMatchObject({ kind: 'gif', alt: 'loop' });
    expect(items.find((i) => i.file === 'moving.webp')!.kind).toBe('gif');
  });

  it('orders packs by "order", rejects bad pack names and broken pack.json, and rejects non-images', () => {
    pack('zebra', { name: 'Zebra', order: 0 }); put('z.png', png(10, 10), 'zebra');
    put('a.png', png(10, 10));
    expect(build().packs.map((p) => p.id)).toEqual(['zebra', 'cats']);
    mkdirSync(join(dir, 'Bad Name')); expect(() => buildCatalog(dir)).toThrow(/lowercase/);
    rmSync(join(dir, 'Bad Name'), { recursive: true });
    mkdirSync(join(dir, 'nometa')); expect(() => buildCatalog(dir)).toThrow(/pack\.json/);
    rmSync(join(dir, 'nometa'), { recursive: true });
    writeFileSync(join(dir, 'cats', 'fake.png'), new Uint8Array(enc('<svg onload=alert(1)>')));
    expect(() => buildCatalog(dir)).toThrow(/cats\/fake\.png/);
  });

  it('warns above the 8 MB budget (positive control: no warning below it) and about a placeholder pack', () => {
    put('a.png', png(10, 10));
    expect(buildCatalog(dir).warnings).toEqual([]);
    const big = new Uint8Array(SIZE_BUDGET_BYTES + 1); big.set(png(10, 10));
    put('big.png', big);
    expect(buildCatalog(dir).warnings.join(' ')).toContain('above the 8 MB budget');
    rmSync(join(dir, 'cats', 'big.png'));
    pack('cats', { placeholder: true });
    expect(buildCatalog(dir).warnings.join(' ')).toContain('PLACEHOLDER');
  });
});

describe('the committed catalog', () => {
  it('shared/stickers.ts and numbering.json match public/stickers (run npm run build:stickers after changing the files)', () => {
    const r = buildCatalog('public/stickers');
    expect(readFileSync('shared/stickers.ts', 'utf8')).toBe(buildManifestModule(r.packs));
    expect(JSON.parse(readFileSync('public/stickers/numbering.json', 'utf8'))).toEqual(JSON.parse(JSON.stringify(r.numbering)));
  });
  it('every committed sticker is within the upload caps, so a placeholder can also be saved as a library item', () => {
    const r = buildCatalog('public/stickers');
    for (const p of r.packs) for (const i of p.items) {
      const size = readFileSync(join('public/stickers', p.id, i.file)).length;
      expect(size, `${p.id}/${i.file}`).toBeLessThanOrEqual(i.kind === 'gif' ? 3 * 1024 * 1024 : 300 * 1024);
    }
  });
});
