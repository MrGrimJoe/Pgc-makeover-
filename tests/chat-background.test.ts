import { describe, it, expect } from 'vitest';
import {
  CHAT_BACKGROUNDS, CHAT_BACKGROUND_IDS, IMAGE_SCRIM_ALPHA, WORST_CASE_IMAGE_COLORS, CHAT_TOKENS,
  presetContrast, worstCaseImageContrast, bubbleContrast, chipContrast, presetStyle, blendWithScrim, isChatBackgroundId, presetById,
} from '../shared/chat-background.ts';
import { contrastRatio } from '../shared/presets.ts';
import { readFileSync } from 'node:fs';

const MODES = ['light', 'dark'] as const;
const AA = 4.5;

describe('chat background contrast (WCAG AA, numeric)', () => {
  it('ships exactly the six presets', () => {
    expect(CHAT_BACKGROUNDS.map((p) => p.name)).toEqual(['Plain', 'Paper', 'Mint', 'Sky', 'Night', 'Dots']);
    expect(CHAT_BACKGROUND_IDS).toHaveLength(6);
  });

  for (const mode of MODES) {
    for (const p of CHAT_BACKGROUNDS) {
      it(`${p.name} (${mode}): body text and timestamps reach 4.5:1`, () => {
        expect(presetContrast(p.id, mode)).toBeGreaterThanOrEqual(AA);
      });
    }

    it(`worst-case imported image (${mode}) stays at or above 4.5:1 under the scrim`, () => {
      expect(worstCaseImageContrast(mode)).toBeGreaterThanOrEqual(AA);
    });

    it(`expiry chips on their opaque pill are readable (${mode})`, () => {
      expect(chipContrast(mode)).toBeGreaterThanOrEqual(AA);
    });

    it(`bubble text is readable (${mode})`, () => {
      const b = bubbleContrast(mode);
      expect(b.own).toBeGreaterThanOrEqual(AA);
      expect(b.other).toBeGreaterThanOrEqual(AA);
    });
  }

  it('the scrim is necessary: without it a black or white image fails AA (positive control for the numbers)', () => {
    expect(worstCaseImageContrast('light', 0)).toBeLessThan(AA);
    expect(worstCaseImageContrast('dark', 0)).toBeLessThan(AA);
  });

  it('a weaker scrim than the shipped one fails, so the constant cannot be lowered unnoticed', () => {
    expect(worstCaseImageContrast('light', 0.8)).toBeLessThan(AA);
  });

  it('the old white-on-primary own bubble would have failed in dark mode (why bubbles use the surface color)', () => {
    expect(contrastRatio('#FFFFFF', CHAT_TOKENS.dark.blue)).toBeLessThan(AA);
  });

  it('blends correctly and covers the extremes', () => {
    expect(blendWithScrim('#000000', '#FFFFFF', 0.9)).toBe('#e6e6e6');
    expect(blendWithScrim('#FFFFFF', '#FFFFFF', 0.9)).toBe('#ffffff');
    expect(WORST_CASE_IMAGE_COLORS).toContain('#000000');
    expect(IMAGE_SCRIM_ALPHA).toBe(0.9);
  });

  it('presets are plain CSS: no urls, dots use a gradient', () => {
    for (const mode of MODES) {
      for (const p of CHAT_BACKGROUNDS) {
        const css = JSON.stringify(presetStyle(p.id, mode));
        expect(css).not.toMatch(/url\(/);
      }
    }
    expect(presetStyle('dots', 'light').backgroundImage).toContain('radial-gradient');
    expect(presetStyle('plain', 'light').backgroundImage).toBeUndefined();
  });

  it('unknown ids fall back to Plain', () => {
    expect(isChatBackgroundId('mint')).toBe(true);
    expect(isChatBackgroundId('../x')).toBe(false);
    expect(presetById('nope').id).toBe('plain');
  });

  it('the contrast model matches the real tokens in src/index.css (so it cannot drift from the app)', () => {
    const css = readFileSync('src/index.css', 'utf8');
    const lightBlock = /:root \{([^}]*)\}/.exec(css)![1]!;
    const darkBlock = /:root\[data-theme="dark"\] \{([^}]*)\}/.exec(css)![1]!;
    const names = { surface: '--bg', surface2: '--bg2', text: '--text', muted: '--muted', blue: '--blue', danger: '--danger', accent: '--accent-text' } as const;
    const get = (block: string, name: string) => new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(block)?.[1]?.toUpperCase();
    for (const [mode, block] of [['light', lightBlock], ['dark', darkBlock]] as const) {
      for (const [key, cssName] of Object.entries(names)) {
        expect(get(block, cssName), `${mode} ${cssName}`).toBe(CHAT_TOKENS[mode][key as keyof typeof names].toUpperCase());
      }
    }
    // the media-query copy of the dark tokens must agree with the data-theme copy
    const mq = /prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/.exec(css)![1]!;
    for (const cssName of Object.values(names)) expect(get(mq, cssName), cssName).toBe(get(darkBlock, cssName));
  });
});
