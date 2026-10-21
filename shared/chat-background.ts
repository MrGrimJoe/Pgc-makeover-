/**
 * Chat backgrounds. Six plain-CSS presets plus the person's own image (stored on the phone only, see
 * src/lib/chat-background.ts). A scrim in the app surface color sits between the background and the messages so
 * timestamps and other text drawn directly on the background keep WCAG AA contrast (4.5:1).
 */
import { contrastRatio } from './presets.ts';

export type ThemeMode = 'light' | 'dark';

export const CHAT_BACKGROUND_IDS = ['plain', 'paper', 'mint', 'sky', 'night', 'dots'] as const;
export type ChatBackgroundId = (typeof CHAT_BACKGROUND_IDS)[number];

/** Surface and text colors of the app in each mode (mirrors the tokens in src/index.css). */
export const CHAT_TOKENS = {
  light: { surface: '#FFFFFF', surface2: '#F8F9FC', text: '#17233A', muted: '#5B6577', blue: '#244C8A' },
  dark: { surface: '#0F1522', surface2: '#0B101B', text: '#EEF1F7', muted: '#9AA5BA', blue: '#7FA6E6' },
} as const satisfies Record<ThemeMode, Record<string, string>>;

/** How much of the app surface color covers an imported image. Chosen so the worst-case image still passes AA. */
export const IMAGE_SCRIM_ALPHA = 0.9;

export interface ChatBackgroundPreset {
  id: ChatBackgroundId;
  name: string;
  /** Flat colors that can sit behind text, per mode. For Dots this is the base; `dot` is the pattern color. */
  color: Record<ThemeMode, string>;
  dot?: Record<ThemeMode, string>;
}

export const CHAT_BACKGROUNDS: readonly ChatBackgroundPreset[] = [
  { id: 'plain', name: 'Plain', color: { light: '#FFFFFF', dark: '#0F1522' } },
  { id: 'paper', name: 'Paper', color: { light: '#F4EEE1', dark: '#1B1812' } },
  { id: 'mint', name: 'Mint', color: { light: '#DDF1E6', dark: '#12261D' } },
  { id: 'sky', name: 'Sky', color: { light: '#DCEBFA', dark: '#12233A' } },
  { id: 'night', name: 'Night', color: { light: '#DDE3F1', dark: '#070B14' } },
  { id: 'dots', name: 'Dots', color: { light: '#F8F9FC', dark: '#0B101B' }, dot: { light: '#E2E6EF', dark: '#2A3550' } },
];

export const DEFAULT_CHAT_BACKGROUND: ChatBackgroundId = 'plain';

export function isChatBackgroundId(v: unknown): v is ChatBackgroundId {
  return typeof v === 'string' && (CHAT_BACKGROUND_IDS as readonly string[]).includes(v);
}

export function presetById(id: unknown): ChatBackgroundPreset {
  return CHAT_BACKGROUNDS.find((p) => p.id === id) ?? CHAT_BACKGROUNDS[0]!;
}

/** Inline style for a preset in a mode. Plain CSS, no images. */
export function presetStyle(id: unknown, mode: ThemeMode): Record<string, string> {
  const p = presetById(id);
  const style: Record<string, string> = { backgroundColor: p.color[mode] };
  if (p.dot) {
    style.backgroundImage = `radial-gradient(${p.dot[mode]} 1.5px, transparent 1.5px)`;
    style.backgroundSize = '18px 18px';
  }
  return style;
}

const toRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const toHex = (c: number[]) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/** The color a viewer sees when `image` is covered by the surface color at `alpha`. */
export function blendWithScrim(image: string, surface: string, alpha: number): string {
  const a = toRgb(image);
  const s = toRgb(surface);
  return toHex(a.map((v, i) => v * (1 - alpha) + s[i]! * alpha));
}

/** Colors an imported picture can have at its extremes: black, white, the three primaries and secondaries, mid-gray. */
export const WORST_CASE_IMAGE_COLORS = ['#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#00FFFF', '#FF00FF', '#808080'] as const;

/** Lowest text contrast (body text and timestamps) over the worst-case images when covered by the scrim. */
export function worstCaseImageContrast(mode: ThemeMode, alpha = IMAGE_SCRIM_ALPHA): number {
  const t = CHAT_TOKENS[mode];
  let min = Infinity;
  for (const img of WORST_CASE_IMAGE_COLORS) {
    const bg = blendWithScrim(img, t.surface, alpha);
    min = Math.min(min, contrastRatio(t.text, bg), contrastRatio(t.muted, bg));
  }
  return min;
}

/** Lowest text contrast on a preset (flat color, and the dot color for patterns). */
export function presetContrast(id: ChatBackgroundId, mode: ThemeMode): number {
  const t = CHAT_TOKENS[mode];
  const p = presetById(id);
  const colors = [p.color[mode], ...(p.dot ? [p.dot[mode]] : [])];
  return Math.min(...colors.flatMap((bg) => [contrastRatio(t.text, bg), contrastRatio(t.muted, bg)]));
}

/** Contrast of message bubble text against its bubble: own bubbles use the primary color with the surface as text. */
export function bubbleContrast(mode: ThemeMode): { own: number; other: number } {
  const t = CHAT_TOKENS[mode];
  return { own: contrastRatio(t.surface, t.blue), other: contrastRatio(t.text, t.surface2) };
}
