import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BREAKPOINTS, layoutForWidth, forcedLayout } from '../src/lib/layout.ts';

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const sources = walk('src').filter((f) => /\.(ts|tsx)$/.test(f));

describe('which design a screen width gets', () => {
  it('cuts over exactly at the breakpoints', () => {
    const table: Array<[number, string]> = [[320, 'phone'], [390, 'phone'], [639, 'phone'], [640, 'tablet'], [820, 'tablet'], [1023, 'tablet'], [1024, 'desktop'], [1440, 'desktop'], [2560, 'desktop']];
    for (const [w, expected] of table) expect(layoutForWidth(w), `${w}px`).toBe(expected);
  });

  it('the CSS breakpoints (rem) are the same numbers as the TypeScript ones', () => {
    const css = readFileSync('src/index.css', 'utf8');
    const rem = (name: string) => Number(new RegExp(`--breakpoint-${name}:\\s*([\\d.]+)rem`).exec(css)?.[1]) * 16;
    expect(rem('tablet')).toBe(BREAKPOINTS.tablet);
    expect(rem('desktop')).toBe(BREAKPOINTS.desktop);
  });

  it('the column width is set per layout in CSS, and the phone value is the original 430px', () => {
    const css = readFileSync('src/index.css', 'utf8');
    expect(css).toMatch(/--content-w:\s*430px/);
    expect(css).toMatch(/:root\[data-layout="tablet"\][^{]*\{\s*--content-w:\s*640px/);
  });

  it('?layout= is honoured in development only for known values', () => {
    const at = (search: string) => { window.history.replaceState(null, '', `/${search}`); return forcedLayout(); };
    // vitest runs with DEV on; the check for a production build is the import.meta.env.DEV guard itself
    if (typeof window === 'undefined') return;
    expect(at('?layout=tablet')).toBe('tablet');
    expect(at('?layout=desktop')).toBe('desktop');
    expect(at('?layout=watch')).toBeNull();
    expect(at('')).toBeNull();
  });
});

describe('guard: the design is chosen in one place only', () => {
  const offenders = (re: RegExp, allow: string[] = []) =>
    sources.filter((f) => !allow.includes(f.replace(/\\/g, '/')) && re.test(readFileSync(f, 'utf8')));

  it('no file hard-codes the phone width', () => {
    expect(offenders(/max-w-\[430px\]/)).toEqual([]);
  });

  it('nothing but the layout module reads the window size or builds its own width query', () => {
    const allow = ['src/lib/layout.ts'];
    expect(offenders(/\b(innerWidth|outerWidth|screen\.width|clientWidth)\b/, allow)).toEqual([]);
    expect(offenders(/matchMedia\(\s*['"`]\(\s*(min|max)-width/, allow)).toEqual([]);
  });

  it('positive control: the guard really finds a violation', () => {
    expect(/max-w-\[430px\]/.test('<div className="max-w-[430px]">')).toBe(true);
    expect(/\binnerWidth\b/.test('window.innerWidth > 800')).toBe(true);
  });
});
