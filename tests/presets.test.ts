import { describe, it, expect, beforeEach } from 'vitest';
import {
  WALLPAPERS,
  THEMES,
  TEXT_STYLES,
  APP_SURFACES,
  contrastRatio,
  relativeLuminance,
  resolveProfileStyle,
} from '../shared/presets.ts';
import { updateProfileSchema } from '../shared/schema.ts';
import { makeEnv, call, seedUser } from './_helpers.ts';
import type { Env } from '../worker/types.ts';

describe('Profile style presets', () => {
  it('contrast helper matches known WCAG values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 5);
    expect(() => relativeLuminance('red')).toThrow();
  });

  it('ids are unique and every list starts with its default', () => {
    for (const list of [WALLPAPERS, THEMES, TEXT_STYLES]) {
      const ids = list.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(WALLPAPERS[0]!.id).toBe('plain');
    expect(THEMES[0]!.id).toBe('default');
    expect(TEXT_STYLES[0]!.id).toBe('clean');
  });

  describe('contrast (WCAG)', () => {
    for (const w of WALLPAPERS.filter((x) => x.stops.length === 2)) {
      for (const stop of w.stops) {
        it(`wallpaper ${w.id}: body text is at least 4.5:1 on ${stop}`, () => {
          expect(contrastRatio(w.text, stop)).toBeGreaterThanOrEqual(4.5);
        });
        it(`wallpaper ${w.id}: muted text is at least 4.5:1 on ${stop}`, () => {
          expect(contrastRatio(w.muted, stop)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }

    const backgrounds = [APP_SURFACES.light, APP_SURFACES.dark, ...WALLPAPERS.flatMap((w) => w.stops)];
    for (const t of THEMES.filter((x) => x.accent)) {
      it(`theme ${t.id}: accent is at least 3:1 on every wallpaper and on the light and dark app surfaces`, () => {
        for (const bg of backgrounds) {
          expect(contrastRatio(t.accent, bg), `${t.accent} on ${bg}`).toBeGreaterThanOrEqual(3);
        }
      });
    }
  });

  describe('resolveProfileStyle', () => {
    it('gives plain defaults for missing or unknown ids', () => {
      for (const ids of [{}, { wallpaper_id: null, theme_id: null, text_style_id: null }, { wallpaper_id: 'nope', theme_id: 'nope', text_style_id: 'nope' }]) {
        const r = resolveProfileStyle(ids);
        expect(r.headerStyle).toEqual({});
        expect(r.accent).toBeNull();
        expect(r.textStyleCss).toEqual({});
      }
    });

    it('resolves real presets to CSS', () => {
      const r = resolveProfileStyle({ wallpaper_id: 'dusk', theme_id: 'coral', text_style_id: 'serif' });
      expect(r.headerStyle.background).toContain('linear-gradient');
      expect(r.headerStyle.color).toBe('#F1F3FA');
      expect(r.accent).toBe('#CC4F36');
      expect(r.textStyleCss.fontFamily).toContain('Georgia');
    });
  });

  describe('validation', () => {
    it('accepts known ids and null, rejects anything else', () => {
      expect(updateProfileSchema.safeParse({ wallpaper_id: 'dawn', theme_id: 'ocean', text_style_id: 'mono' }).success).toBe(true);
      expect(updateProfileSchema.safeParse({ wallpaper_id: null, theme_id: null, text_style_id: null }).success).toBe(true);
      for (const bad of [
        { wallpaper_id: 'url(http://evil.example/x.png)' },
        { wallpaper_id: 'red; background:url(javascript:1)' },
        { theme_id: '#ff0000' },
        { text_style_id: 'Comic Sans' },
        { wallpaper_id: 5 },
      ]) {
        expect(updateProfileSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      }
    });
  });

  describe('API', () => {
    let env: Env;
    let alice: string;
    let bob: string;

    beforeEach(async () => {
      env = await makeEnv();
      alice = await seedUser(env, 'usr_alice', 'alice');
      bob = await seedUser(env, 'usr_bob', 'bob');
    });

    it('saves choices and returns them on /api/me and the public profile', async () => {
      const res = await call(env, 'PATCH', '/api/me', { cookie: alice, json: { wallpaper_id: 'mist', theme_id: 'forest', text_style_id: 'rounded' } });
      expect(res.status).toBe(200);
      expect(res.json.profile).toMatchObject({ wallpaper_id: 'mist', theme_id: 'forest', text_style_id: 'rounded' });

      const publicProfile = await call(env, 'GET', '/api/users/alice', { cookie: bob });
      expect(publicProfile.json).toMatchObject({ wallpaper_id: 'mist', theme_id: 'forest', text_style_id: 'rounded' });
    });

    it('stores the default as NULL and keeps other choices when one changes', async () => {
      await call(env, 'PATCH', '/api/me', { cookie: alice, json: { wallpaper_id: 'ink', theme_id: 'amber' } });
      const reset = await call(env, 'PATCH', '/api/me', { cookie: alice, json: { wallpaper_id: 'plain' } });
      expect(reset.json.profile.wallpaper_id).toBeNull();
      expect(reset.json.profile.theme_id).toBe('amber');
      const row = await env.DB.prepare('SELECT wallpaper_id, theme_id, text_style_id FROM profiles WHERE user_id = ?').bind('usr_alice').first();
      expect(row).toEqual({ wallpaper_id: null, theme_id: 'amber', text_style_id: null });

      const cleared = await call(env, 'PATCH', '/api/me', { cookie: alice, json: { theme_id: 'default', text_style_id: 'clean' } });
      expect(cleared.json.profile.theme_id).toBeNull();
      expect(cleared.json.profile.text_style_id).toBeNull();
    });

    it('rejects unknown ids with 400 and changes nothing', async () => {
      await call(env, 'PATCH', '/api/me', { cookie: alice, json: { wallpaper_id: 'dawn' } });
      for (const bad of [{ wallpaper_id: 'nope' }, { theme_id: '<script>' }, { text_style_id: 'x'.repeat(5000) }]) {
        expect((await call(env, 'PATCH', '/api/me', { cookie: alice, json: bad })).status).toBe(400);
      }
      expect((await call(env, 'GET', '/api/me', { cookie: alice })).json.profile.wallpaper_id).toBe('dawn');
    });

    it("cannot change someone else's style through the API", async () => {
      await call(env, 'PATCH', '/api/me', { cookie: bob, json: { wallpaper_id: 'ink', user_id: 'usr_alice' } });
      expect((await call(env, 'GET', '/api/me', { cookie: alice })).json.profile.wallpaper_id).toBeNull();
    });
  });
});
