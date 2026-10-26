import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, call, seedUser } from './_helpers.ts';

/** The static-files `_headers` block that applies to every path. */
function everyPathBlock(): Record<string, string> {
  const text = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === '/*');
  const out: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith(' ')) break;
    const i = line.indexOf(':');
    out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}
function directives(csp: string): Record<string, string[]> {
  return Object.fromEntries(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [name, ...v] = d.split(/\s+/); return [name!, v]; }));
}

describe('Content-Security-Policy on every static page', () => {
  const block = everyPathBlock();
  const csp = directives(block['content-security-policy'] ?? '');

  it('is present, and locks down framing, plugins and the base URL', () => {
    expect(block['content-security-policy']).toBeTruthy();
    expect(csp['default-src']).toEqual(["'self'"]);
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['base-uri']).toEqual(["'self'"]);
    expect(csp['form-action']).toEqual(["'self'"]);
  });

  it('allows no inline or eval scripts and no wildcard sources', () => {
    const scripts = csp['script-src'] ?? [];
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
    for (const sources of Object.values(csp)) expect(sources).not.toContain('*');
    // The card reader's WebAssembly needs this one, and only this one
    expect(scripts).toContain("'wasm-unsafe-eval'");
  });

  it('allows the Cloudflare Turnstile widget, which the sign-up page loads', () => {
    expect(csp['script-src']).toContain('https://challenges.cloudflare.com');
    expect(csp['frame-src']).toContain('https://challenges.cloudflare.com');
  });

  it('allows the card reader worker and on-device image previews', () => {
    expect(csp['worker-src']).toEqual(expect.arrayContaining(["'self'", 'blob:']));
    expect(csp['img-src']).toEqual(expect.arrayContaining(["'self'", 'data:', 'blob:']));
  });

  it('covers every external https host the app source mentions, so a new one cannot be forgotten', () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
      });
    const allowed = new Set(Object.values(csp).flat().filter((s) => s.startsWith('https://')));
    const used = new Set<string>();
    for (const f of files(new URL('../src', import.meta.url).pathname)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/['"`](https:\/\/[a-z0-9.-]+)/gi)) used.add(m[1]!.toLowerCase());
    }
    expect([...used].filter((h) => !allowed.has(h))).toEqual([]);
  });

  it('keeps the other protective headers', () => {
    expect(block['x-content-type-options']).toBe('nosniff');
    expect(block['x-frame-options']).toBe('DENY');
    expect(block['referrer-policy']).toBeTruthy();
    expect(block['permissions-policy']).toBeTruthy();
  });
});

describe('API answers from the Worker', () => {
  it('are never stored and never sniffed, for success and for errors', async () => {
    const env = await makeEnv();
    const cookie = await seedUser(env, 'usr_a', 'alice_a');
    const ok = await call(env, 'GET', '/api/me', { cookie });
    expect(ok.status).toBe(200);
    const denied = await call(env, 'GET', '/api/me');
    expect(denied.status).toBe(401);
    const missing = await call(env, 'GET', '/api/nothing-here');
    for (const res of [ok, denied, missing]) {
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    }
  });

  it('leave the media and sticker cache rules alone', async () => {
    const env = await makeEnv();
    const cookie = await seedUser(env, 'usr_a', 'alice_a');
    const res = await call(env, 'GET', '/api/media/does-not-exist', { cookie });
    expect(res.status).toBe(404);
  });
});
