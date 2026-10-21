import { describe, it, expect } from 'vitest';
import {
  scaleToLongEdge, containFit, clampCrop, chooseEncoding, planFile, compressPhoto, makeSticker, canConvertGif,
  PHOTO_MAX_EDGE, THUMB_MAX_EDGE, STICKER_SIZE, type MediaEnv,
} from '../src/lib/media.ts';
import { MEDIA_SIZE_CAPS } from '../shared/media-rules.ts';

const enc = (s: string) => [...s].map((c) => c.charCodeAt(0));
const head = {
  png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpg: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
  gif: new Uint8Array(enc('GIF89a')),
  webp: new Uint8Array([...enc('RIFF'), 0, 0, 0, 0, ...enc('WEBP')]),
  mp4: new Uint8Array([0, 0, 0, 0x18, ...enc('ftypmp42')]),
  svg: new Uint8Array(enc('<svg xmlns=')),
};

interface Call { size: { width: number; height: number }; mime: string; quality: number; args: number[][] }

/** A fake browser: decode gives a fixed bitmap, encode records the call and returns a blob sized by pixels. */
function fakeEnv(opts: { width: number; height: number; webp?: boolean; bytesPerPixel?: number }) {
  const calls: Call[] = [];
  let closed = 0;
  const env: MediaEnv = {
    async decode() {
      return { width: opts.width, height: opts.height, source: 'bitmap', close: () => { closed++; } };
    },
    async encode(draw, size, mime, quality) {
      const args: number[][] = [];
      draw({ clear: () => undefined, drawImage: (_s, ...a) => { args.push(a); } });
      calls.push({ size, mime, quality, args });
      if (mime === 'image/webp' && opts.webp === false) return new Blob([new Uint8Array(10)], { type: 'image/png' }); // browsers answer PNG
      const bytes = Math.max(1, Math.round(size.width * size.height * (opts.bytesPerPixel ?? 0.1) * (quality + 0.2)));
      return new Blob([new Uint8Array(bytes)], { type: mime });
    },
  };
  return { env, calls, closed: () => closed };
}

describe('dimension math', () => {
  it('scales the long edge down to the limit, keeps the ratio and never enlarges', () => {
    expect(scaleToLongEdge(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(scaleToLongEdge(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 });
    expect(scaleToLongEdge(800, 600, 1600)).toEqual({ width: 800, height: 600 });
    expect(scaleToLongEdge(1600, 1600, 1600)).toEqual({ width: 1600, height: 1600 });
    expect(scaleToLongEdge(10000, 1, 1600)).toEqual({ width: 1600, height: 1 });
    expect(() => scaleToLongEdge(0, 10, 100)).toThrow();
  });

  it('contain-fits inside the sticker box with centred padding', () => {
    expect(containFit(1000, 500, 512)).toEqual({ x: 0, y: 128, width: 512, height: 256 });
    expect(containFit(500, 1000, 512)).toEqual({ x: 128, y: 0, width: 256, height: 512 });
    expect(containFit(512, 512, 512)).toEqual({ x: 0, y: 0, width: 512, height: 512 });
    expect(containFit(64, 64, 512)).toEqual({ x: 0, y: 0, width: 512, height: 512 }); // small images are scaled up to fill
  });

  it('clamps crops to the image and rejects empty ones', () => {
    expect(clampCrop({ x: -10, y: -10, width: 110, height: 60 }, 100, 50)).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(clampCrop({ x: 90, y: 40, width: 50, height: 50 }, 100, 50)).toEqual({ x: 90, y: 40, width: 10, height: 10 });
    expect(clampCrop({ x: 200, y: 0, width: 10, height: 10 }, 100, 50)).toBeNull();
    expect(clampCrop({ x: 0, y: 0, width: 0, height: 10 }, 100, 50)).toBeNull();
  });

  it('chooses WebP when supported and JPEG otherwise', () => {
    expect(chooseEncoding(true)).toEqual({ mime: 'image/webp', quality: 0.8 });
    expect(chooseEncoding(false).mime).toBe('image/jpeg');
  });
});

describe('planFile (cap checks and type decisions)', () => {
  it('photos are always re-encoded; SVG and GIF are refused as photos', () => {
    expect(planFile('photo', 5_000_000, head.jpg)).toMatchObject({ ok: true, action: 'compress-photo' });
    expect(planFile('photo', 100, head.png)).toMatchObject({ ok: true, action: 'compress-photo' });
    expect(planFile('photo', 100, head.svg)).toMatchObject({ ok: false });
    expect(planFile('photo', 100, head.gif)).toMatchObject({ ok: false });
    expect(planFile('photo', 100, head.mp4)).toMatchObject({ ok: false });
  });

  it('GIFs within the cap upload as they are; over the cap they are refused with a trim message, or offered conversion', () => {
    const cap = MEDIA_SIZE_CAPS.gif;
    expect(planFile('gif', cap, head.gif)).toMatchObject({ ok: true, action: 'upload-as-is' });
    const over = planFile('gif', cap + 1, head.gif);
    expect(over).toMatchObject({ ok: false });
    expect((over as { error: string }).error).toContain('Trim it to under 3 MB');
    expect(planFile('gif', cap + 1, head.gif, { canConvertGif: true })).toMatchObject({ ok: true, action: 'offer-convert' });
  });

  it('short clips within the video cap pass and bigger ones are refused with the cap in the message', () => {
    expect(planFile('video', MEDIA_SIZE_CAPS.video, head.mp4)).toMatchObject({ ok: true });
    const r = planFile('video', MEDIA_SIZE_CAPS.video + 1, head.mp4);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain('8.00 MB');
  });

  it('stickers from pictures are normalised; unknown types are refused', () => {
    expect(planFile('sticker', 100, head.webp)).toMatchObject({ ok: true, action: 'make-sticker' });
    expect(planFile('sticker', 100, head.svg)).toMatchObject({ ok: false });
  });

  it('detects WebCodecs support without requiring it', () => {
    expect(canConvertGif({})).toBe(false);
    expect(canConvertGif({ ImageDecoder: function () {}, VideoEncoder: function () {} })).toBe(true);
    expect(canConvertGif({ ImageDecoder: function () {} })).toBe(false);
  });
});

describe('compressPhoto (mocked canvas)', () => {
  it('scales a big photo to 1600 on the long edge, encodes WebP at about 0.8, and makes a 320 px thumbnail', async () => {
    const { env, calls, closed } = fakeEnv({ width: 4000, height: 3000 });
    const out = await compressPhoto(new Blob(['x']), env);
    expect(out.width).toBe(PHOTO_MAX_EDGE);
    expect(out.height).toBe(1200);
    expect(out.mime).toBe('image/webp');
    expect(calls[0]).toMatchObject({ mime: 'image/webp', quality: 0.8 });
    expect(out.thumb).not.toBeNull();
    expect(Math.max(calls[1]!.size.width, calls[1]!.size.height)).toBe(THUMB_MAX_EDGE);
    expect(closed()).toBe(1); // the decoded bitmap is released
  });

  it('does not enlarge a small photo', async () => {
    const { env } = fakeEnv({ width: 640, height: 480 });
    const out = await compressPhoto(new Blob(['x']), env);
    expect([out.width, out.height]).toEqual([640, 480]);
  });

  it('falls back to JPEG when the browser cannot encode WebP', async () => {
    const { env, calls } = fakeEnv({ width: 2000, height: 1000, webp: false });
    const out = await compressPhoto(new Blob(['x']), env);
    expect(out.mime).toBe('image/jpeg');
    expect(calls.some((c) => c.mime === 'image/jpeg')).toBe(true);
  });

  it('a quarter turn swaps width and height, and a crop sets the source rectangle', async () => {
    const { env, calls } = fakeEnv({ width: 2000, height: 1000 });
    const out = await compressPhoto(new Blob(['x']), env, { rotate90: 1 });
    // 2000x1000 turned a quarter is 1000x2000, then scaled so the long edge is 1600
    expect([out.width, out.height]).toEqual([800, 1600]);
    expect(calls[0]!.args[0]![8]).toBe(1);
    const cropped = fakeEnv({ width: 2000, height: 1000 });
    const c = await compressPhoto(new Blob(['x']), cropped.env, { crop: { x: 100, y: 50, width: 400, height: 200 } });
    expect([c.width, c.height]).toEqual([400, 200]);
    expect(cropped.calls[0]!.args[0]!.slice(0, 4)).toEqual([100, 50, 400, 200]);
  });

  it('steps the size down when the first encode is over the cap, and throws a readable error when it never fits', async () => {
    const heavy = fakeEnv({ width: 4000, height: 4000, bytesPerPixel: 12 });
    await expect(compressPhoto(new Blob(['x']), heavy.env)).rejects.toThrow(/can be at most 2\.50 MB/);
    const borderline = fakeEnv({ width: 4000, height: 4000, bytesPerPixel: 1.2 });
    const out = await compressPhoto(new Blob(['x']), borderline.env);
    expect(out.blob.size).toBeLessThanOrEqual(MEDIA_SIZE_CAPS.photo);
    expect(Math.max(out.width, out.height)).toBeLessThan(PHOTO_MAX_EDGE);
  });

  it('background images use the 1280 px edge and the 400 KB cap', async () => {
    const { env } = fakeEnv({ width: 3000, height: 2000, bytesPerPixel: 0.05 });
    const out = await compressPhoto(new Blob(['x']), env, { kind: 'background' });
    expect(out.width).toBe(1280);
    expect(out.blob.size).toBeLessThanOrEqual(MEDIA_SIZE_CAPS.background);
  });
});

describe('makeSticker (mocked canvas)', () => {
  it('makes a 512x512 WebP, contain-fit and centred on a transparent canvas', async () => {
    const { env, calls } = fakeEnv({ width: 1000, height: 500, bytesPerPixel: 0.05 });
    const out = await makeSticker(new Blob(['x']), env);
    expect([out.width, out.height]).toEqual([STICKER_SIZE, STICKER_SIZE]);
    expect(out.mime).toBe('image/webp');
    expect(calls[0]!.args[0]).toEqual([0, 0, 1000, 500, 0, 128, 512, 256, 0]);
    expect(out.blob.size).toBeLessThanOrEqual(MEDIA_SIZE_CAPS.sticker);
  });

  it('applies a crop first, and refuses an empty crop and browsers without WebP', async () => {
    const { env, calls } = fakeEnv({ width: 1000, height: 1000, bytesPerPixel: 0.05 });
    await makeSticker(new Blob(['x']), env, { x: 0, y: 0, width: 500, height: 250 });
    expect(calls[0]!.args[0]!.slice(0, 4)).toEqual([0, 0, 500, 250]);
    await expect(makeSticker(new Blob(['x']), env, { x: 5000, y: 0, width: 10, height: 10 })).rejects.toThrow(/crop is empty/);
    await expect(makeSticker(new Blob(['x']), fakeEnv({ width: 100, height: 100, webp: false }).env)).rejects.toThrow(/WebP/);
  });

  it('lowers the quality to fit the 300 KB cap before giving up', async () => {
    const { env, calls } = fakeEnv({ width: 512, height: 512, bytesPerPixel: 1.2 });
    const out = await makeSticker(new Blob(['x']), env);
    expect(calls.length).toBeGreaterThan(1);
    expect(out.blob.size).toBeLessThanOrEqual(MEDIA_SIZE_CAPS.sticker);
    await expect(makeSticker(new Blob(['x']), fakeEnv({ width: 512, height: 512, bytesPerPixel: 9 }).env)).rejects.toThrow(/at most 0\.29 MB/);
  });
});

import { rotatedSize, rotateRect, cropForAspect, cropFramePercent, sendAsOptions } from '../src/lib/media.ts';

describe('preview geometry', () => {
  it('rotates sizes and rectangles clockwise, and four turns return to the start', () => {
    expect(rotatedSize(400, 300, 1)).toEqual({ width: 300, height: 400 });
    expect(rotatedSize(400, 300, 2)).toEqual({ width: 400, height: 300 });
    expect(rotatedSize(400, 300, -1)).toEqual({ width: 300, height: 400 });
    const r = { x: 10, y: 20, width: 100, height: 50 };
    expect(rotateRect(r, 400, 300, 1)).toEqual({ x: 300 - 20 - 50, y: 10, width: 50, height: 100 });
    expect(rotateRect(r, 400, 300, 2)).toEqual({ x: 400 - 10 - 100, y: 300 - 20 - 50, width: 100, height: 50 });
    expect(rotateRect(r, 400, 300, 4)).toEqual(r);
  });

  it('crops to the wanted aspect, slides along the free axis, and stays inside the image', () => {
    expect(cropForAspect(400, 300, 'original', 0)).toBeNull();
    expect(cropForAspect(400, 300, '1:1', 0)).toEqual({ x: 50, y: 0, width: 300, height: 300 });
    expect(cropForAspect(400, 300, '1:1', 0, 0, 0)).toEqual({ x: 0, y: 0, width: 300, height: 300 });
    expect(cropForAspect(400, 300, '1:1', 0, 1, 1)).toEqual({ x: 100, y: 0, width: 300, height: 300 });
    expect(cropForAspect(300, 400, '16:9', 0)).toEqual({ x: 0, y: Math.round((400 - 168) / 2), width: 300, height: 168 });
    for (const a of ['1:1', '4:3', '3:4', '16:9'] as const) {
      for (const turns of [0, 1, 2, 3]) {
        const c = cropForAspect(1234, 777, a, turns, 1, 1)!;
        expect(c.x + c.width).toBeLessThanOrEqual(1234);
        expect(c.y + c.height).toBeLessThanOrEqual(777);
      }
    }
  });

  it('after a quarter turn the result has the wanted aspect, not the source one', () => {
    const c = cropForAspect(400, 300, '16:9', 1)!;
    const out = rotatedSize(c.width, c.height, 1);
    expect(out.width / out.height).toBeCloseTo(16 / 9, 1);
  });

  it('places the crop frame on the stage (whole image when there is no crop)', () => {
    expect(cropFramePercent(400, 300, null, 0)).toEqual({ left: 0, top: 12.5, width: 100, height: 75 });
    expect(cropFramePercent(300, 400, null, 0)).toEqual({ left: 12.5, top: 0, width: 75, height: 100 });
    const c = cropForAspect(400, 300, '1:1', 0)!;
    expect(cropFramePercent(400, 300, c, 0)).toEqual({ left: 12.5, top: 12.5, width: 75, height: 75 });
    // rotated: the stage shows the 300x400 result
    expect(cropFramePercent(400, 300, null, 1)).toEqual({ left: 12.5, top: 0, width: 75, height: 100 });
  });

  it('offers sensible "send as" choices per source type', () => {
    expect(sendAsOptions('image/jpeg')).toEqual(['photo', 'sticker']);
    expect(sendAsOptions('image/gif')).toEqual(['gif', 'sticker']);
    expect(sendAsOptions('video/mp4')).toEqual(['gif']);
    expect(sendAsOptions(null)).toEqual([]);
  });
});
