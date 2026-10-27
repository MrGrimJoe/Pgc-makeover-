// Reading the student card from a picture file (laptop sign-up): what is accepted and what is turned down, and why.
import { describe, it, expect } from 'vitest';
import bwipjs from 'bwip-js';
import { PNG } from 'pngjs';
import { readFileSync } from 'node:fs';
import {
  CARD_PHOTO_MESSAGES, MAX_BYTES, explainFailedRead, judgeBeforeReading, measureGrey, readCardPhoto, type LoadedPicture, type PictureLoader,
} from '../src/lib/cardPhoto.ts';

function greyOfFixture(file: string) {
  const img = PNG.sync.read(readFileSync(new URL(`./fixtures/${file}`, import.meta.url)));
  const grey = new Uint8ClampedArray(img.width * img.height);
  for (let i = 0; i < grey.length; i++) grey[i] = (img.data[i * 4]! * 77 + img.data[i * 4 + 1]! * 150 + img.data[i * 4 + 2]! * 29) >> 8;
  return { width: img.width, height: img.height, grey };
}

/** A picture, as the browser would hand it over. `scaleTo` pretends the original file was that wide. */
const pic = (p: { width: number; height: number; grey: Uint8ClampedArray }, originalWidth = Math.max(p.width, 1200)): LoadedPicture => ({
  ...p, originalWidth, originalHeight: Math.round((originalWidth * p.height) / p.width),
});
const loaderOf = (p: LoadedPicture): PictureLoader => async () => p;
const file = (type = 'image/png', size = 1000) => new File([new Uint8Array(size)], 'card', { type });

/** The same picture, blurred with a box filter (a camera that did not focus). */
function blur(p: { width: number; height: number; grey: Uint8ClampedArray }, radius: number) {
  const { width, height } = p;
  let src = Float32Array.from(p.grey);
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(src.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0, n = 0;
        for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && xx < width && yy >= 0 && yy < height) { sum += src[yy * width + xx]!; n++; }
        }
        out[y * width + x] = sum / n;
      }
    }
    src = out;
  }
  return { width, height, grey: Uint8ClampedArray.from(src) };
}

const shade = (p: { width: number; height: number; grey: Uint8ClampedArray }, f: (v: number) => number) => ({ ...p, grey: p.grey.map(f) as Uint8ClampedArray });

describe('a good picture of a card', () => {
  it('is accepted and gives the barcode text (the same decoder as the camera)', async () => {
    const r = await readCardPhoto(file(), loaderOf(pic(greyOfFixture('card-ok.png'))));
    expect(r).toMatchObject({ ok: true, barcode: '20240907' });
  });
  it('a JPG or WebP file type is fine too', async () => {
    for (const t of ['image/jpeg', 'image/webp']) {
      expect((await readCardPhoto(file(t), loaderOf(pic(greyOfFixture('card-ok.png'))))).ok).toBe(true);
    }
  });
});

describe('a picture that is turned down, with a reason the student can act on', () => {
  const rejected = async (f: File, p?: LoadedPicture) => {
    const r = await readCardPhoto(f, p ? loaderOf(p) : async () => { throw new Error('boom'); });
    if (r.ok) throw new Error('expected a rejection');
    return r;
  };

  it('not a picture type (a PDF, a document, a HEIC)', async () => {
    for (const t of ['application/pdf', 'text/plain', 'image/heic', 'image/gif', '']) {
      expect(await rejected(file(t))).toMatchObject({ problem: 'type', message: CARD_PHOTO_MESSAGES.type });
    }
  });
  it('too big', async () => {
    expect(await rejected(file('image/png', MAX_BYTES + 1))).toMatchObject({ problem: 'size' });
  });
  it('a file that claims to be a picture but cannot be opened', async () => {
    expect(await rejected(file())).toMatchObject({ problem: 'unopenable' });
  });
  it('too small to hold a readable barcode', async () => {
    const p = greyOfFixture('card-ok.png');
    expect(await rejected(file(), pic(p, 500))).toMatchObject({ problem: 'too-small' });
  });
  it('far too dark', async () => {
    const dark = shade(greyOfFixture('card-ok.png'), (v) => v * 0.12);
    expect(await rejected(file(), pic(dark))).toMatchObject({ problem: 'too-dark' });
  });
  it('washed out by glare or a flash', async () => {
    const bright = shade(greyOfFixture('card-ok.png'), (v) => 235 + v / 15);
    expect(await rejected(file(), pic(bright))).toMatchObject({ problem: 'too-bright' });
  });
  it('blurry: the barcode cannot be read, and the message says why', async () => {
    const r = await rejected(file(), pic(blur(greyOfFixture('card-ok.png'), 3)));
    expect(r).toMatchObject({ problem: 'blurry', message: CARD_PHOTO_MESSAGES.blurry });
  });
  it('underexposed but not flat: dim enough that the barcode is lost, and the message says so', async () => {
    const dim = shade(greyOfFixture('card-ok.png'), (v) => v * 0.2);
    const r = await rejected(file(), pic(dim));
    expect(r.problem).toBe('too-dark');
  });
  it('a picture with no barcode in it (a face, a logo, a QR code) is never read as a roll number', async () => {
    const qr = PNG.sync.read(await bwipjs.toBuffer({ bcid: 'qrcode', text: 'https://example.com/x', scale: 6, backgroundcolor: 'FFFFFF', paddingwidth: 40, paddingheight: 40 }));
    const grey = new Uint8ClampedArray(qr.width * qr.height);
    for (let i = 0; i < grey.length; i++) grey[i] = Math.round(0.299 * qr.data[i * 4]! + 0.587 * qr.data[i * 4 + 1]! + 0.114 * qr.data[i * 4 + 2]!);
    const r = await rejected(file(), pic({ width: qr.width, height: qr.height, grey }, 1200));
    expect(r.problem).toBe('no-barcode');
  });
  it('never throws, whatever the loader does', async () => {
    await expect(readCardPhoto(file(), async () => { throw new TypeError('x'); })).resolves.toMatchObject({ ok: false });
  });
});

describe('the measurements (set by measuring real card pictures)', () => {
  const stats = (p: { width: number; height: number; grey: Uint8ClampedArray }) => measureGrey(p.width, p.height, p.grey);
  const sharp = stats(greyOfFixture('card-ok.png'));

  it('a clean card is mostly white, so a high average brightness alone never rejects it', () => {
    expect(sharp.brightness).toBeGreaterThan(225);
    expect(judgeBeforeReading(sharp, 2000, 1200)).toBeNull();
  });
  it('detail separates a sharp picture from a blurred one and does not depend on exposure', () => {
    const slightlySoft = stats(blur(greyOfFixture('card-ok.png'), 1));
    const soft = stats(blur(greyOfFixture('card-ok.png'), 3));
    const dim = stats(shade(greyOfFixture('card-ok.png'), (v) => v * 0.45));
    expect(sharp.detail).toBeGreaterThan(0.5);
    expect(dim.detail).toBeGreaterThan(0.5); // a dim picture is not a blurry one
    expect(slightlySoft.detail).toBeGreaterThan(0.05); // still readable, so it is not called blurry
    expect(soft.detail).toBeLessThan(0.05);
  });
  it('a slightly soft picture is still accepted, because the decoder can read it', async () => {
    const r = await readCardPhoto(file(), loaderOf(pic(blur(greyOfFixture('card-ok.png'), 1))));
    expect(r).toMatchObject({ ok: true, barcode: '20240907' });
  });
  it('a flat picture is judged by its brightness', () => {
    expect(judgeBeforeReading(measureGrey(10, 10, new Uint8ClampedArray(100).fill(10)), 2000, 1200)).toBe('too-dark');
    expect(judgeBeforeReading(measureGrey(10, 10, new Uint8ClampedArray(100).fill(250)), 2000, 1200)).toBe('too-bright');
  });
  it('a failed read is explained as underexposed, blurry, or just no barcode', () => {
    expect(explainFailedRead({ width: 1200, height: 800, brightness: 40, contrast: 30, detail: 1 })).toBe('too-dark');
    expect(explainFailedRead({ width: 1200, height: 800, brightness: 200, contrast: 40, detail: 0.01 })).toBe('blurry');
    expect(explainFailedRead({ width: 1200, height: 800, brightness: 200, contrast: 40, detail: 0.9 })).toBe('no-barcode');
  });
});
