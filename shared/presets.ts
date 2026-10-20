/**
 * Profile style presets: wallpapers, accent themes and text styles.
 *
 * Profiles store only a preset id (or NULL for the default). The server validates every id against
 * these lists, and the UI resolves ids to CSS here, so there is one source of truth. Colors are
 * checked by tests/presets.test.ts: text on every wallpaper must reach WCAG AA (4.5:1) and every
 * accent must reach 3:1 against every wallpaper and against the app's light and dark surfaces.
 */

export interface WallpaperPreset {
  id: string;
  label: string;
  /** 'none' means the profile keeps the app's own light/dark colors. */
  tone: 'none' | 'light' | 'dark';
  /** Two gradient stops; both are checked for contrast. Empty for the default. */
  stops: [string, string] | [];
  text: string;
  muted: string;
}

export interface ThemePreset {
  id: string;
  label: string;
  accent: string;
}

export interface TextStylePreset {
  id: string;
  label: string;
  fontFamily: string;
  fontWeight: number;
  letterSpacing: string;
}

export const WALLPAPERS: readonly WallpaperPreset[] = [
  { id: 'plain', label: 'Plain', tone: 'none', stops: [], text: '', muted: '' },
  { id: 'dawn', label: 'Dawn', tone: 'light', stops: ['#FFF1E6', '#FFDFC9'], text: '#2B1B12', muted: '#6B4733' },
  { id: 'mist', label: 'Mist', tone: 'light', stops: ['#EAF1FB', '#D6E4F6'], text: '#14233A', muted: '#44566F' },
  { id: 'meadow', label: 'Meadow', tone: 'light', stops: ['#EAF6EC', '#D3EBD8'], text: '#12261A', muted: '#3D5845' },
  { id: 'dusk', label: 'Dusk', tone: 'dark', stops: ['#1B2440', '#2C2150'], text: '#F1F3FA', muted: '#B8BFD6' },
  { id: 'ink', label: 'Ink', tone: 'dark', stops: ['#12151C', '#242831'], text: '#F2F3F5', muted: '#B5BAC5' },
] as const;

export const THEMES: readonly ThemePreset[] = [
  { id: 'default', label: 'Default', accent: '' },
  { id: 'ocean', label: 'Ocean', accent: '#2A7DC0' },
  { id: 'coral', label: 'Coral', accent: '#CC4F36' },
  { id: 'forest', label: 'Forest', accent: '#368A5C' },
  { id: 'violet', label: 'Violet', accent: '#8660DA' },
  { id: 'amber', label: 'Amber', accent: '#A8701A' },
] as const;

export const TEXT_STYLES: readonly TextStylePreset[] = [
  { id: 'clean', label: 'Clean', fontFamily: '', fontWeight: 0, letterSpacing: '' },
  { id: 'serif', label: 'Serif', fontFamily: 'Georgia, "Times New Roman", serif', fontWeight: 0, letterSpacing: '' },
  {
    id: 'rounded',
    label: 'Rounded',
    fontFamily: 'ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", system-ui, sans-serif',
    fontWeight: 0,
    letterSpacing: '',
  },
  {
    id: 'mono',
    label: 'Mono',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontWeight: 0,
    letterSpacing: '-0.01em',
  },
  { id: 'bold', label: 'Bold', fontFamily: '', fontWeight: 800, letterSpacing: '-0.02em' },
] as const;

export const WALLPAPER_IDS = WALLPAPERS.map((w) => w.id) as [string, ...string[]];
export const THEME_IDS = THEMES.map((t) => t.id) as [string, ...string[]];
export const TEXT_STYLE_IDS = TEXT_STYLES.map((t) => t.id) as [string, ...string[]];

/** Colors of the app itself, used to check accents on the default (plain) wallpaper. */
export const APP_SURFACES = { light: '#FFFFFF', dark: '#0F1522' } as const;

/** Preset ids that mean "use the default"; stored as NULL. */
export const DEFAULT_PRESET_IDS = { wallpaper: 'plain', theme: 'default', textStyle: 'clean' } as const;

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Expected #RRGGBB color, got "${hex}"`);
  const n = parseInt(m[1]!, 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG 2.x contrast ratio between two #RRGGBB colors (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export interface ResolvedProfileStyle {
  wallpaper: WallpaperPreset;
  theme: ThemePreset;
  textStyle: TextStylePreset;
  /** Inline style for the profile header block. Empty object for the default wallpaper. */
  headerStyle: Record<string, string>;
  /** Inline style for name and bio text. */
  textStyleCss: Record<string, string | number>;
  /** Accent color for the avatar ring and divider, or null to use the app's own. */
  accent: string | null;
}

/** Resolves stored ids to CSS. Unknown or missing ids fall back to the defaults. */
export function resolveProfileStyle(ids: {
  wallpaper_id?: string | null;
  theme_id?: string | null;
  text_style_id?: string | null;
}): ResolvedProfileStyle {
  const wallpaper = WALLPAPERS.find((w) => w.id === ids.wallpaper_id) ?? WALLPAPERS[0]!;
  const theme = THEMES.find((t) => t.id === ids.theme_id) ?? THEMES[0]!;
  const textStyle = TEXT_STYLES.find((t) => t.id === ids.text_style_id) ?? TEXT_STYLES[0]!;

  const headerStyle: Record<string, string> =
    wallpaper.stops.length === 2
      ? {
          background: `linear-gradient(160deg, ${wallpaper.stops[0]}, ${wallpaper.stops[1]})`,
          color: wallpaper.text,
        }
      : {};

  const textStyleCss: Record<string, string | number> = {};
  if (textStyle.fontFamily) textStyleCss.fontFamily = textStyle.fontFamily;
  if (textStyle.fontWeight) textStyleCss.fontWeight = textStyle.fontWeight;
  if (textStyle.letterSpacing) textStyleCss.letterSpacing = textStyle.letterSpacing;

  return { wallpaper, theme, textStyle, headerStyle, textStyleCss, accent: theme.accent || null };
}
