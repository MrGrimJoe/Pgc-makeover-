// Decodes real barcode pictures (made with bwip-js) with the same library the sign-up screen uses.
import { describe, it, expect } from 'vitest';
import bwipjs from 'bwip-js';
import { PNG } from 'pngjs';
import { readFileSync } from 'node:fs';
import { decodeBarcodeFromGrey, classifyCameraError } from '../src/lib/cardScan.ts';

function greyOf(file: string) {
  const img = PNG.sync.read(readFileSync(new URL(`./fixtures/${file}`, import.meta.url)));
  const grey = new Uint8ClampedArray(img.width * img.height);
  for (let i = 0; i < grey.length; i++) grey[i] = (img.data[i * 4]! * 77 + img.data[i * 4 + 1]! * 150 + img.data[i * 4 + 2]! * 29) >> 8;
  return { width: img.width, height: img.height, grey };
}

async function picture(bcid: string, text: string, scale = 3, extra: Record<string, unknown> = {}) {
  const png = await bwipjs.toBuffer({ bcid, text, scale, height: 14, includetext: false, paddingwidth: 12, paddingheight: 8, backgroundcolor: 'FFFFFF', ...extra });
  const img = PNG.sync.read(png);
  const grey = new Uint8ClampedArray(img.width * img.height);
  for (let i = 0; i < grey.length; i++) grey[i] = Math.round(0.299 * img.data[i * 4]! + 0.587 * img.data[i * 4 + 1]! + 0.114 * img.data[i * 4 + 2]!);
  return { width: img.width, height: img.height, grey };
}

describe('reading the roll number from a card barcode', () => {
  it.each([
    ['code128', 'LHR-2024-0457'],
    ['code128', '24157'],
    ['code39', 'FSC0457'],
    ['interleaved2of5', '20240457'],
  ])('%s %s', async (bcid, text) => {
    const p = await picture(bcid, text);
    expect(await decodeBarcodeFromGrey(p.width, p.height, p.grey)).toBe(text);
  });

  it('reads a small, low-resolution barcode', async () => {
    const p = await picture('code128', '24157', 1);
    expect(await decodeBarcodeFromGrey(p.width, p.height, p.grey)).toBe('24157');
  });

  it.each([['card-ok.png', '20240907'], ['card-other.png', '20220311']])('reads the barcode on a whole card picture with a border, text and a photo-sized margin (%s)', async (file, roll) => {
    const p = greyOf(file);
    expect(await decodeBarcodeFromGrey(p.width, p.height, p.grey)).toBe(roll);
  });

  it('a card with a dark line left of the barcode still reads (found by testing: it used to fail)', async () => {
    const p = greyOf('card-ok.png');
    for (let y = 0; y < p.height; y++) for (let x = 14; x < 20; x++) p.grey[y * p.width + x] = 0; // a thick vertical line
    expect(await decodeBarcodeFromGrey(p.width, p.height, p.grey)).toBe('20240907');
  });

  it('returns null, not a guess, for a picture with no barcode', async () => {
    const grey = new Uint8ClampedArray(200 * 100).fill(255);
    for (let i = 0; i < grey.length; i += 7) grey[i] = 30;
    expect(await decodeBarcodeFromGrey(200, 100, grey)).toBeNull();
  });

  it('does not read a QR code (the card has a 1D barcode)', async () => {
    const p = await picture('qrcode', 'https://example.com/x', 4);
    expect(await decodeBarcodeFromGrey(p.width, p.height, p.grey)).toBeNull();
  });

  it('names camera problems in terms the screen can explain', () => {
    expect(classifyCameraError({ name: 'NotAllowedError' })).toBe('denied');
    expect(classifyCameraError({ name: 'NotFoundError' })).toBe('no-camera');
    expect(classifyCameraError({ name: 'TypeError' })).toBe('unsupported');
    expect(classifyCameraError(new Error('x'))).toBe('failed');
  });
});
