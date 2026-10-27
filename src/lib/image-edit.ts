/**
 * Text on pictures (meme captions). Everything here is pure or takes a canvas-like object, so it can be tested
 * without a browser. Positions and sizes are fractions of the picture, so the same layers draw the same way on the
 * small preview and on the full-size export.
 */
import type { Canvas2DLike, MediaEnv, PreparedImage } from './media.ts';
import { compressPhoto } from './media.ts';

export const MAX_LAYERS = 8;
export const MAX_TEXT_LENGTH = 200;
export const SIZE_MIN = 0.03;
export const SIZE_MAX = 0.25;
/** Text never gets wider than this share of the picture; longer text wraps onto more lines. */
export const MAX_TEXT_WIDTH = 0.94;
const LINE_HEIGHT = 1.12;

export type TextStyle = 'meme' | 'plain';

export interface TextLayer {
  id: string;
  text: string;
  /** Centre of the text block, 0 to 1 across and down the picture. */
  x: number;
  y: number;
  /** Letter height as a share of the picture width. */
  size: number;
  color: string;
  outline: boolean;
  style: TextStyle;
  uppercase: boolean;
}

export const TEXT_COLORS: ReadonlyArray<{ id: string; label: string; value: string }> = [
  { id: 'white', label: 'White', value: '#FFFFFF' },
  { id: 'black', label: 'Black', value: '#000000' },
  { id: 'yellow', label: 'Yellow', value: '#FFE600' },
  { id: 'red', label: 'Red', value: '#E5202E' },
  { id: 'blue', label: 'Blue', value: '#2F6BFF' },
  { id: 'green', label: 'Green', value: '#22B14C' },
];

const FONT_FAMILY: Record<TextStyle, string> = {
  meme: 'Impact, "Arial Black", "Helvetica Neue", Arial, sans-serif',
  plain: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
};

export const clamp = (n: number, lo: number, hi: number): number => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);

let counter = 0;
export function newLayerId(): string {
  counter += 1;
  return `t${counter}`;
}

export function createLayer(patch: Partial<TextLayer> = {}): TextLayer {
  return normalizeLayer({
    id: newLayerId(),
    text: '',
    x: 0.5,
    y: 0.5,
    size: 0.07,
    color: '#FFFFFF',
    outline: true,
    style: 'meme',
    uppercase: true,
    ...patch,
  });
}

/** The classic two captions: one at the top, one at the bottom. */
export function createMemeLayers(): TextLayer[] {
  return [createLayer({ y: 0.11 }), createLayer({ y: 0.89 })];
}

/** Keeps every field inside its limits. Layers come from sliders and drags, so this is the single place the limits live. */
export function normalizeLayer(l: TextLayer): TextLayer {
  return {
    ...l,
    text: l.text.slice(0, MAX_TEXT_LENGTH),
    x: clamp(l.x, 0, 1),
    y: clamp(l.y, 0, 1),
    size: clamp(l.size, SIZE_MIN, SIZE_MAX),
    style: l.style === 'plain' ? 'plain' : 'meme',
    color: /^#[0-9a-fA-F]{6}$/.test(l.color) ? l.color : '#FFFFFF',
  };
}

/** Black outline around light text, white around dark text, so it reads on any picture. */
export function outlineColor(fill: string): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(fill);
  if (!m) return '#000000';
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.35 ? '#000000' : '#FFFFFF';
}

export function displayText(l: Pick<TextLayer, 'text' | 'uppercase'>): string {
  return l.uppercase ? l.text.toUpperCase() : l.text;
}

export const fontFor = (style: TextStyle, px: number): string => `${style === 'meme' ? '900' : '700'} ${px}px ${FONT_FAMILY[style]}`;

/** Breaks text into lines no wider than maxWidth. Explicit line breaks are kept and a word wider than a line is split. */
export function wrapText(measure: (s: string) => number, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push('');
      continue;
    }
    let line = '';
    const flush = () => {
      if (line) out.push(line);
      line = '';
    };
    for (const word of words) {
      const trial = line ? `${line} ${word}` : word;
      if (measure(trial) <= maxWidth) {
        line = trial;
        continue;
      }
      flush();
      if (measure(word) <= maxWidth) {
        line = word;
        continue;
      }
      // a single word wider than the line: split it by characters
      let piece = '';
      for (const ch of word) {
        if (piece && measure(piece + ch) > maxWidth) {
          out.push(piece);
          piece = ch;
        } else piece += ch;
      }
      line = piece;
    }
    flush();
  }
  while (out.length > 1 && out[out.length - 1] === '') out.pop();
  return out;
}

export interface LayerBox {
  lines: string[];
  fontPx: number;
  lineHeightPx: number;
  /** Top-left of the block and its size, in pixels of the picture it was laid out for. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Centre of the block after it was kept inside the picture. */
  cx: number;
  cy: number;
}

/** Lays one layer out for a picture of W x H pixels. The block is moved back inside the picture when it would stick out. */
export function layoutLayer(layer: TextLayer, W: number, H: number, ctx: Canvas2DLike): LayerBox {
  const fontPx = Math.max(6, layer.size * W);
  ctx.font = fontFor(layer.style, fontPx);
  const lines = wrapText((s) => ctx.measureText(s).width, displayText(layer), MAX_TEXT_WIDTH * W);
  const lineHeightPx = fontPx * LINE_HEIGHT;
  const width = Math.min(W, Math.max(...lines.map((l) => ctx.measureText(l).width), 0));
  const height = lines.length * lineHeightPx;
  const cx = clamp(layer.x * W, width / 2, Math.max(width / 2, W - width / 2));
  const cy = clamp(layer.y * H, height / 2, Math.max(height / 2, H - height / 2));
  return { lines, fontPx, lineHeightPx, left: cx - width / 2, top: cy - height / 2, width, height, cx, cy };
}

export const hasText = (l: TextLayer): boolean => l.text.trim().length > 0;

/** Draws every layer that has text. Used for the live preview and for the exported file. */
export function drawLayers(ctx: Canvas2DLike, layers: readonly TextLayer[], W: number, H: number): void {
  for (const layer of layers) {
    if (!hasText(layer)) continue;
    ctx.save();
    const box = layoutLayer(layer, W, H, ctx);
    ctx.font = fontFor(layer.style, box.fontPx);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = box.fontPx * (layer.style === 'meme' ? 0.14 : 0.09);
    ctx.strokeStyle = outlineColor(layer.color);
    ctx.fillStyle = layer.color;
    box.lines.forEach((line, i) => {
      const y = box.top + box.lineHeightPx * (i + 0.5);
      if (layer.outline) ctx.strokeText(line, box.cx, y);
      ctx.fillText(line, box.cx, y);
    });
    ctx.restore();
  }
}

/** The top-most layer under a point (fractions of the picture), with a little slack so thin text is easy to grab. */
export function hitTest(layers: readonly TextLayer[], fx: number, fy: number, W: number, H: number, ctx: Canvas2DLike): string | null {
  const slack = Math.max(12, W * 0.02);
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]!;
    // empty layers are drawn as a dashed hint by the editor, so they can be grabbed too
    const probe = hasText(layer) ? layer : { ...layer, text: ' ' };
    if (!hasText(layer)) {
      const w = W * 0.5;
      const h = layer.size * W * LINE_HEIGHT;
      const cx = clamp(layer.x * W, w / 2, W - w / 2);
      const cy = clamp(layer.y * H, h / 2, H - h / 2);
      if (Math.abs(fx * W - cx) <= w / 2 + slack && Math.abs(fy * H - cy) <= h / 2 + slack) return layer.id;
      continue;
    }
    const b = layoutLayer(probe, W, H, ctx);
    if (fx * W >= b.left - slack && fx * W <= b.left + b.width + slack && fy * H >= b.top - slack && fy * H <= b.top + b.height + slack) return layer.id;
  }
  return null;
}

/** True when there is something to draw, so "Done" can be refused for an untouched picture. */
export const hasAnyText = (layers: readonly TextLayer[]): boolean => layers.some(hasText);

/**
 * Draws the layers on the picture and encodes it (scaled to at most 1600 px, WebP or JPEG, under the photo cap).
 * The text is drawn at the final size, not scaled up from the preview, so it stays sharp.
 */
export async function renderEdited(source: Blob, layers: readonly TextLayer[], env: MediaEnv): Promise<PreparedImage> {
  const drawn = layers.map(normalizeLayer);
  return compressPhoto(source, env, {
    overlay: (ctx, size) => drawLayers(ctx, drawn, size.width, size.height),
  });
}

export function editedFileName(mime: string): string {
  return `edited-${Date.now().toString(36)}.${mime === 'image/webp' ? 'webp' : mime === 'image/png' ? 'png' : 'jpg'}`;
}
