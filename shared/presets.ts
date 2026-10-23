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
  /** Fill for buttons and chips that sit on the wallpaper. */
  surface: string;
  /** Borders on the wallpaper. */
  line: string;
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
  { id: 'plain', label: 'Plain', tone: 'none', stops: [], text: '', muted: '', surface: '', line: '' },
  { id: 'dawn', label: 'Dawn', tone: 'light', stops: ['#FFF1E6', '#FFDFC9'], text: '#2B1B12', muted: '#6B4733', surface: '#FFFFFF', line: '#00000033' },
  { id: 'mist', label: 'Mist', tone: 'light', stops: ['#EAF1FB', '#D6E4F6'], text: '#14233A', muted: '#44566F', surface: '#FFFFFF', line: '#00000033' },
  { id: 'meadow', label: 'Meadow', tone: 'light', stops: ['#EAF6EC', '#D3EBD8'], text: '#12261A', muted: '#3D5845', surface: '#FFFFFF', line: '#00000033' },
  { id: 'dusk', label: 'Dusk', tone: 'dark', stops: ['#1B2440', '#2C2150'], text: '#F1F3FA', muted: '#B8BFD6', surface: '#0F1522', line: '#FFFFFF40' },
  { id: 'ink', label: 'Ink', tone: 'dark', stops: ['#12151C', '#242831'], text: '#F2F3F5', muted: '#B5BAC5', surface: '#0F1522', line: '#FFFFFF40' },
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
/** Wallpaper id used when the person chose their own image (profiles.wallpaper_media_id). */
export const CUSTOM_WALLPAPER_ID = 'custom';
/**
 * A custom image is always drawn under this dark layer with light text. Worst case is a pure white image:
 * white at 45% through the layer is #737373, and white text on that is about 4.7:1 (tests/custom-wallpaper.test.ts).
 */
export const CUSTOM_WALLPAPER_SCRIM_ALPHA = 0.55;
export const CUSTOM_WALLPAPER_SCRIM = `rgba(0,0,0,${CUSTOM_WALLPAPER_SCRIM_ALPHA})`;
export const CUSTOM_WALLPAPER_TEXT = '#ffffff';
/** Muted text stays white too: any lighter-than-white value would not exist, and a grey would lose contrast on white images. */
export const CUSTOM_WALLPAPER_MUTED = '#ffffff';
/** Opaque fill for buttons and chips on a custom image, so they never depend on the picture behind them. */
export const CUSTOM_WALLPAPER_SURFACE = '#1c1c1e';

export const CUSTOM_WALLPAPER: WallpaperPreset = {
  id: CUSTOM_WALLPAPER_ID,
  label: 'Your image',
  tone: 'dark',
  stops: [],
  text: CUSTOM_WALLPAPER_TEXT,
  muted: CUSTOM_WALLPAPER_MUTED,
  surface: CUSTOM_WALLPAPER_SURFACE,
  line: 'rgba(255,255,255,0.45)',
};

/** Worst-case background under the scrim for a white image: the color white text has to be readable on. */
export function scrimmedWorstCase(): string {
  const v = Math.round(255 * (1 - CUSTOM_WALLPAPER_SCRIM_ALPHA));
  const h = v.toString(16).padStart(2, '0');
  return `#${h}${h}${h}`;
}

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
  /**
   * Inline style for the profile header block. Empty object for the default wallpaper. It also
   * remaps the app's color variables (--text, --muted, --bg, --bg2, --line) inside the block so the
   * existing text, buttons and chips stay readable on the wallpaper in both light and dark mode.
   */
  headerStyle: Record<string, string>;
  /** Inline style for name and bio text. */
  textStyleCss: Record<string, string | number>;
  /** Accent color for the avatar ring and divider, or null to use the app's own. */
  accent: string | null;
}

/** Resolves stored ids to CSS. Unknown or missing ids fall back to the defaults. */
export function resolveProfileStyle(ids: {
  wallpaper_id?: string | null;
  /** Needed for the 'custom' wallpaper; without it the default is used. */
  wallpaper_media_id?: string | null;
  theme_id?: string | null;
  text_style_id?: string | null;
}): ResolvedProfileStyle {
  const isCustom = ids.wallpaper_id === CUSTOM_WALLPAPER_ID && !!ids.wallpaper_media_id;
  const wallpaper = isCustom ? CUSTOM_WALLPAPER : (WALLPAPERS.find((w) => w.id === ids.wallpaper_id) ?? WALLPAPERS[0]!);
  const theme = THEMES.find((t) => t.id === ids.theme_id) ?? THEMES[0]!;
  const textStyle = TEXT_STYLES.find((t) => t.id === ids.text_style_id) ?? TEXT_STYLES[0]!;

  const headerStyle: Record<string, string> = isCustom
    ? {
        // The scrim is the top layer of the same background, so it is on even while the image loads or fails.
        backgroundImage: `linear-gradient(${CUSTOM_WALLPAPER_SCRIM}, ${CUSTOM_WALLPAPER_SCRIM}), url(/api/media/${encodeURIComponent(ids.wallpaper_media_id!)})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundColor: '#3a3a3c',
        color: wallpaper.text,
        '--text': wallpaper.text,
        '--muted': wallpaper.muted,
        '--bg': wallpaper.surface,
        '--bg2': wallpaper.surface,
        '--line': wallpaper.line,
      }
    : wallpaper.stops.length === 2
      ? {
          background: `linear-gradient(160deg, ${wallpaper.stops[0]}, ${wallpaper.stops[1]})`,
          color: wallpaper.text,
          '--text': wallpaper.text,
          '--muted': wallpaper.muted,
          '--bg': wallpaper.surface,
          '--bg2': wallpaper.surface,
          '--line': wallpaper.line,
        }
      : {};

  const textStyleCss: Record<string, string | number> = {};
  if (textStyle.fontFamily) textStyleCss.fontFamily = textStyle.fontFamily;
  if (textStyle.fontWeight) textStyleCss.fontWeight = textStyle.fontWeight;
  if (textStyle.letterSpacing) textStyleCss.letterSpacing = textStyle.letterSpacing;

  // Accent colors are only checked against the preset wallpapers, so a custom image keeps the plain light ring.
  return { wallpaper, theme, textStyle, headerStyle, textStyleCss, accent: isCustom ? null : theme.accent || null };
}
