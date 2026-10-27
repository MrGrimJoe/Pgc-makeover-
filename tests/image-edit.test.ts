import { describe, it, expect } from 'vitest';
import {
  wrapText, layoutLayer, drawLayers, hitTest, createLayer, createMemeLayers, normalizeLayer, outlineColor, displayText,
  renderEdited, hasAnyText, MAX_TEXT_LENGTH, SIZE_MAX, SIZE_MIN, MAX_TEXT_WIDTH,
} from '../src/lib/image-edit.ts';
import type { Canvas2DLike, MediaEnv } from '../src/lib/media.ts';

/** A canvas stand-in: every character is half as wide as the font is tall, and every call is recorded. */
function recorder() {
  const calls: Array<{ op: string; text?: string; x?: number; y?: number; font?: string; fill?: string; stroke?: string; lineWidth?: number }> = [];
  const ctx: Canvas2DLike = {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0, lineJoin: '', textAlign: '', textBaseline: '',
    measureText(t: string) {
      const px = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 10);
      return { width: t.length * px * 0.5 };
    },
    fillText(text, x, y) { calls.push({ op: 'fill', text, x, y, font: this.font, fill: this.fillStyle, lineWidth: this.lineWidth }); },
    strokeText(text, x, y) { calls.push({ op: 'stroke', text, x, y, stroke: this.strokeStyle, lineWidth: this.lineWidth }); },
    save() { calls.push({ op: 'save' }); },
    restore() { calls.push({ op: 'restore' }); },
  };
  return { ctx, calls };
}
const m10 = (s: string) => s.length * 10;

describe('wrapText', () => {
  it('keeps short text on one line and wraps at word boundaries', () => {
    expect(wrapText(m10, 'hello', 100)).toEqual(['hello']);
    expect(wrapText(m10, 'one two three four', 100)).toEqual(['one two', 'three four']);
  });
  it('keeps explicit line breaks, including blank ones in the middle', () => {
    expect(wrapText(m10, 'a\nb', 100)).toEqual(['a', 'b']);
    expect(wrapText(m10, 'a\n\nb', 100)).toEqual(['a', '', 'b']);
    expect(wrapText(m10, 'a\n\n', 100)).toEqual(['a']);
  });
  it('splits a word that is wider than the line instead of overflowing', () => {
    const lines = wrapText(m10, 'abcdefghijklmnop', 50);
    expect(lines.every((l) => l.length <= 5)).toBe(true);
    expect(lines.join('')).toBe('abcdefghijklmnop');
  });
  it('never loses a word or invents one', () => {
    const text = 'the quick brown fox jumps over the lazy dog';
    expect(wrapText(m10, text, 120).join(' ')).toBe(text);
  });
  it('returns one empty line for empty text', () => {
    expect(wrapText(m10, '', 100)).toEqual(['']);
  });
});

describe('layers', () => {
  it('normalizeLayer clamps everything a slider or a drag can push out of range', () => {
    const l = normalizeLayer({ ...createLayer(), x: 5, y: -3, size: 9, text: 'x'.repeat(500), color: 'red', style: 'weird' as never });
    expect(l).toMatchObject({ x: 1, y: 0, size: SIZE_MAX, color: '#FFFFFF', style: 'meme' });
    expect(l.text).toHaveLength(MAX_TEXT_LENGTH);
    expect(normalizeLayer({ ...createLayer(), size: 0, x: NaN }).size).toBe(SIZE_MIN);
    expect(normalizeLayer({ ...createLayer(), x: NaN }).x).toBe(0);
  });
  it('the meme preset is a top and a bottom caption, both empty', () => {
    const [top, bottom] = createMemeLayers();
    expect(top!.y).toBeLessThan(0.5);
    expect(bottom!.y).toBeGreaterThan(0.5);
    expect(top!.text + bottom!.text).toBe('');
    expect(top!.id).not.toBe(bottom!.id);
    expect(hasAnyText([top!, bottom!])).toBe(false);
  });
  it('picks a readable outline for any colour', () => {
    expect(outlineColor('#FFFFFF')).toBe('#000000');
    expect(outlineColor('#FFE600')).toBe('#000000');
    expect(outlineColor('#000000')).toBe('#FFFFFF');
    expect(outlineColor('#2F6BFF')).toBe('#FFFFFF');
    expect(outlineColor('nonsense')).toBe('#000000');
  });
  it('ALL CAPS only changes what is drawn, not what was typed', () => {
    expect(displayText({ text: 'Hi there', uppercase: true })).toBe('HI THERE');
    expect(displayText({ text: 'Hi there', uppercase: false })).toBe('Hi there');
  });
});

describe('layoutLayer', () => {
  it('sizes letters from the picture width and wraps inside 94% of it', () => {
    const { ctx } = recorder();
    const layer = createLayer({ text: 'a long caption that has to wrap onto several lines for sure', size: 0.1 });
    const box = layoutLayer(layer, 400, 300, ctx);
    expect(box.fontPx).toBeCloseTo(40);
    expect(box.lines.length).toBeGreaterThan(1);
    expect(box.width).toBeLessThanOrEqual(MAX_TEXT_WIDTH * 400 + 0.001);
  });
  it('keeps the block inside the picture even when the layer sits on an edge', () => {
    const { ctx } = recorder();
    for (const [x, y] of [[0, 0], [1, 1], [0, 1], [1, 0], [0.5, 0.01]] as const) {
      const b = layoutLayer(createLayer({ text: 'EDGE CASE', x, y, size: 0.12 }), 500, 400, ctx);
      expect(b.left).toBeGreaterThanOrEqual(-0.001);
      expect(b.top).toBeGreaterThanOrEqual(-0.001);
      expect(b.left + b.width).toBeLessThanOrEqual(500.001);
      expect(b.top + b.height).toBeLessThanOrEqual(400.001);
    }
  });
});

describe('drawLayers', () => {
  it('draws nothing for empty or blank layers', () => {
    const { ctx, calls } = recorder();
    drawLayers(ctx, [createLayer(), createLayer({ text: '   ' })], 400, 300);
    expect(calls.filter((c) => c.op === 'fill' || c.op === 'stroke')).toEqual([]);
  });
  it('outlines first and fills on top, in upper case, with the chosen colour', () => {
    const { ctx, calls } = recorder();
    drawLayers(ctx, [createLayer({ text: 'when the bell rings', color: '#FFE600', size: 0.05 })], 800, 600);
    const draws = calls.filter((c) => c.op === 'fill' || c.op === 'stroke');
    expect(draws.map((c) => c.op)).toEqual(['stroke', 'fill']);
    expect(draws[1]!.text).toBe('WHEN THE BELL RINGS');
    expect(draws[1]!.fill).toBe('#FFE600');
    expect(draws[0]!.stroke).toBe('#000000');
    expect(draws[0]!.lineWidth).toBeGreaterThan(0);
    expect(draws[1]!.font).toContain('Impact');
    // saved and restored, so one layer cannot leak its style into the next
    expect(calls[0]!.op).toBe('save');
    expect(calls[calls.length - 1]!.op).toBe('restore');
  });
  it('skips the outline when it is turned off, and uses the plain font for the plain style', () => {
    const { ctx, calls } = recorder();
    drawLayers(ctx, [createLayer({ text: 'hello', outline: false, style: 'plain', uppercase: false })], 800, 600);
    expect(calls.some((c) => c.op === 'stroke')).toBe(false);
    const fill = calls.find((c) => c.op === 'fill')!;
    expect(fill.text).toBe('hello');
    expect(fill.font).not.toContain('Impact');
  });
  it('draws a wrapped layer line by line, top to bottom, centred on the layer', () => {
    const { ctx, calls } = recorder();
    drawLayers(ctx, [createLayer({ text: 'aaa bbb ccc ddd eee fff ggg hhh iii jjj', size: 0.2, outline: false, x: 0.5 })], 400, 400);
    const fills = calls.filter((c) => c.op === 'fill');
    expect(fills.length).toBeGreaterThan(1);
    expect(fills.map((f) => f.y!)).toEqual([...fills.map((f) => f.y!)].sort((a, b) => a - b));
    expect(new Set(fills.map((f) => f.x)).size).toBe(1);
  });
  it('a layer further down is drawn lower', () => {
    const { ctx, calls } = recorder();
    const [top, bottom] = createMemeLayers().map((l, i) => ({ ...l, text: i ? 'bottom' : 'top' }));
    drawLayers(ctx, [top!, bottom!], 500, 500);
    const f = calls.filter((c) => c.op === 'fill');
    expect(f[0]!.y!).toBeLessThan(250);
    expect(f[1]!.y!).toBeGreaterThan(250);
  });
});

describe('hitTest', () => {
  it('finds the layer under the point, the top-most when they overlap, and null on empty space', () => {
    const { ctx } = recorder();
    const a = createLayer({ text: 'AAAA', x: 0.5, y: 0.2 });
    const b = createLayer({ text: 'BBBB', x: 0.5, y: 0.8 });
    expect(hitTest([a, b], 0.5, 0.2, 400, 400, ctx)).toBe(a.id);
    expect(hitTest([a, b], 0.5, 0.8, 400, 400, ctx)).toBe(b.id);
    expect(hitTest([a, b], 0.5, 0.5, 400, 400, ctx)).toBeNull();
    const same = createLayer({ text: 'CCCC', x: 0.5, y: 0.2 });
    expect(hitTest([a, same], 0.5, 0.2, 400, 400, ctx)).toBe(same.id);
  });
  it('lets an empty layer be grabbed too, so a new caption can be dragged before it has text', () => {
    const { ctx } = recorder();
    const empty = createLayer({ x: 0.5, y: 0.9 });
    expect(hitTest([empty], 0.5, 0.9, 400, 400, ctx)).toBe(empty.id);
    expect(hitTest([empty], 0.5, 0.1, 400, 400, ctx)).toBeNull();
  });
});

describe('renderEdited', () => {
  function fakeEnv(width: number, height: number) {
    const draws: Array<{ size: { width: number; height: number }; mime: string; calls: string[] }> = [];
    const env: MediaEnv = {
      async decode() { return { width, height, source: {} }; },
      async encode(draw, size, mime) {
        const { ctx, calls } = recorder();
        const log: string[] = [];
        draw({ canvas2d: ctx, clear: () => log.push('clear'), drawImage: () => log.push('image') });
        draws.push({ size, mime, calls: [...log, ...calls.filter((c) => c.op === 'fill').map((c) => `text:${c.text}`)] });
        return new Blob([new Uint8Array(1000)], { type: mime });
      },
    };
    return { env, draws };
  }
  it('draws the picture and then the text, at the exported size, in one pass', async () => {
    const { env, draws } = fakeEnv(3200, 2400);
    const layers = createMemeLayers().map((l, i) => ({ ...l, text: i ? 'bottom text' : 'top text' }));
    const out = await renderEdited(new Blob(['x']), layers, env);
    expect(out.width).toBe(1600); // scaled down like any photo
    expect(out.height).toBe(1200);
    const main = draws[0]!;
    expect(main.size).toEqual({ width: 1600, height: 1200 });
    expect(main.calls.slice(0, 2)).toEqual(['clear', 'image']);
    expect(main.calls).toContain('text:TOP TEXT');
    expect(main.calls).toContain('text:BOTTOM TEXT');
    expect(out.thumb).not.toBeNull(); // the thumbnail also carries the text, scaled
    expect(draws.some((d) => d.size.width === 320 && d.calls.includes('text:TOP TEXT'))).toBe(true);
  });
  it('does not change the layers it was given', async () => {
    const { env } = fakeEnv(800, 600);
    const layers = [{ ...createLayer({ text: 'x' }), size: 5 }]; // out of range on purpose
    await renderEdited(new Blob(['x']), layers, env);
    expect(layers[0]!.size).toBe(5);
  });
});
