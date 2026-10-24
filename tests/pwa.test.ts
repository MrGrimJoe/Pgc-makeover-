// @vitest-environment jsdom
// PWA install support: environment detection, banner rules, manifest, and the service worker's cache rules.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { bannerKind, detectInstallEnv, DISMISS_DAYS, DISMISS_KEY, isDismissed, rememberDismissed, rememberInstalled } from '../src/lib/pwa.ts';

const root = path.resolve(import.meta.dirname, '..');
const UA = {
  iosSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iosChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1',
  iosInstagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.0.0',
  iosWebView: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  ipadSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  androidWebView: 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36',
  androidFacebook: 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/450.0.0.0;]',
  desktopChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  desktopEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
};
const env = (userAgent: string, extra: { maxTouchPoints?: number; standalone?: boolean } = {}) =>
  detectInstallEnv({ userAgent, maxTouchPoints: extra.maxTouchPoints, standalone: extra.standalone ?? false });

describe('environment detection', () => {
  it('recognises Safari on iPhone and on iPadOS (Mac user agent with touch)', () => {
    expect(env(UA.iosSafari)).toMatchObject({ os: 'ios', browser: 'safari', inApp: false });
    expect(env(UA.ipadSafari, { maxTouchPoints: 5 })).toMatchObject({ os: 'ios', browser: 'safari', inApp: false });
    expect(env(UA.ipadSafari, { maxTouchPoints: 0 }).os).toBe('other'); // a real Mac
  });
  it('treats iOS web views and social apps as in-app browsers', () => {
    expect(env(UA.iosInstagram).inApp).toBe(true);
    expect(env(UA.iosWebView).inApp).toBe(true);
    expect(env(UA.androidWebView).inApp).toBe(true);
    expect(env(UA.androidFacebook).inApp).toBe(true);
  });
  it('does not call Chrome on iOS Safari, and does not call real browsers in-app', () => {
    expect(env(UA.iosChrome)).toMatchObject({ os: 'ios', browser: 'other', inApp: false });
    expect(env(UA.androidChrome)).toMatchObject({ os: 'android', browser: 'chrome', inApp: false });
    expect(env(UA.desktopChrome)).toMatchObject({ os: 'other', browser: 'chrome', inApp: false });
    expect(env(UA.desktopEdge).browser).toBe('other');
  });
  it('passes standalone through', () => {
    expect(env(UA.iosSafari, { standalone: true }).standalone).toBe(true);
  });
});

describe('banner rules', () => {
  it('shows nothing when installed or dismissed', () => {
    expect(bannerKind(env(UA.iosSafari, { standalone: true }), true, false)).toBe('none');
    expect(bannerKind(env(UA.iosSafari), false, true)).toBe('none');
    expect(bannerKind(env(UA.iosInstagram), false, true)).toBe('none');
  });
  it('iOS Safari gets the Share instructions without any prompt; other iOS browsers are sent to Safari', () => {
    expect(bannerKind(env(UA.iosSafari), false, false)).toBe('ios-safari');
    expect(bannerKind(env(UA.iosChrome), false, false)).toBe('open-in-browser');
  });
  it('in-app browsers are told to open the real browser, whatever else is true', () => {
    expect(bannerKind(env(UA.androidFacebook), true, false)).toBe('open-in-browser');
    expect(bannerKind(env(UA.iosInstagram), false, false)).toBe('open-in-browser');
  });
  it('Android and desktop only get a banner when the browser actually offered an install prompt', () => {
    expect(bannerKind(env(UA.androidChrome), true, false)).toBe('android-prompt');
    expect(bannerKind(env(UA.androidChrome), false, false)).toBe('none');
    expect(bannerKind(env(UA.desktopChrome), false, false)).toBe('none');
  });
});

describe('dismissal', () => {
  beforeEach(() => localStorage.clear());
  it('hides the banner for the cooldown, then lets it return', () => {
    const t0 = 1_700_000_000_000;
    expect(isDismissed(t0)).toBe(false);
    rememberDismissed(t0);
    expect(isDismissed(t0 + 86_400_000)).toBe(true);
    expect(isDismissed(t0 + (DISMISS_DAYS - 1) * 86_400_000)).toBe(true);
    expect(isDismissed(t0 + (DISMISS_DAYS + 1) * 86_400_000)).toBe(false);
  });
  it('installed hides it for good', () => {
    rememberInstalled();
    expect(isDismissed(Date.now() + 365 * 86_400_000)).toBe(true);
  });
  it('ignores a garbage value and survives storage that throws', () => {
    localStorage.setItem(DISMISS_KEY, 'not-a-number');
    expect(isDismissed()).toBe(false);
    const real = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); }, configurable: true });
    expect(isDismissed()).toBe(false);
    expect(() => rememberDismissed()).not.toThrow();
    Object.defineProperty(window, 'localStorage', real);
  });
});

describe('manifest and page metadata', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public/manifest.webmanifest'), 'utf8'));
  it('has what browsers need to offer installing', () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(manifest.background_color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
  it('lists 192 and 512 icons plus a maskable one, and every icon file exists with the stated size', () => {
    const sizes = manifest.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes}:${i.purpose}`);
    expect(sizes).toEqual(expect.arrayContaining(['192x192:any', '512x512:any', '512x512:maskable']));
    for (const icon of manifest.icons) {
      const file = path.join(root, 'public', icon.src);
      expect(fs.existsSync(file), icon.src).toBe(true);
      const buf = fs.readFileSync(file);
      expect(buf.subarray(1, 4).toString()).toBe('PNG');
      const [w, h] = icon.sizes.split('x').map(Number);
      expect(buf.readUInt32BE(16)).toBe(w);
      expect(buf.readUInt32BE(20)).toBe(h);
    }
  });
  it('index.html links the manifest, theme colour and an opaque 180px Apple icon', () => {
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('name="theme-color"');
    expect(html).toContain('rel="apple-touch-icon" href="/icons/apple-touch-icon.png"');
    expect(html).toContain('name="apple-mobile-web-app-capable"');
    const apple = fs.readFileSync(path.join(root, 'public/icons/apple-touch-icon.png'));
    expect([apple.readUInt32BE(16), apple.readUInt32BE(20)]).toEqual([180, 180]);
    expect(apple[25]).toBe(2); // PNG colour type 2 = RGB, no alpha channel (iOS fills transparency with black)
    expect(html).not.toContain('viewport-fit'); // layout was not changed for notched phones
  });
});

// ---- The service worker's rules, run for real against fake caches and a fake network ----

function loadWorker() {
  const store = new Map<string, Map<string, Response>>();
  const listeners: Record<string, (e: any) => void> = {};
  const networkHits: string[] = [];
  let offline = false;
  let responder: (url: string) => Response = () => new Response('ok', { status: 200 });
  const cachesApi = {
    open: async (name: string) => {
      if (!store.has(name)) store.set(name, new Map());
      const m = store.get(name)!;
      return {
        addAll: async (urls: string[]) => { for (const u of urls) m.set(new URL(u, 'https://app.test').href, responder(u)); },
        put: async (req: Request, res: Response) => { m.set(req.url, res); },
      };
    },
    match: async (req: Request | string) => {
      const key = typeof req === 'string' ? new URL(req, 'https://app.test').href : req.url;
      for (const m of store.values()) if (m.has(key)) return m.get(key)!.clone();
      return undefined;
    },
    keys: async () => [...store.keys()],
    delete: async (name: string) => store.delete(name),
  };
  const sandbox: any = {
    self: { location: { origin: 'https://app.test' }, addEventListener: (t: string, f: any) => { listeners[t] = f; }, skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: cachesApi, URL, Response, Request, Promise,
    fetch: async (req: Request) => {
      networkHits.push(new URL(req.url).pathname);
      if (offline) throw new TypeError('offline');
      const res = responder(req.url);
      Object.defineProperty(res, 'type', { value: 'basic' }); // what a same-origin network response reports
      return res;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8'), sandbox);
  const run = async (type: string, extra: Record<string, unknown> = {}) => {
    let pending: Promise<unknown> | undefined;
    let handled = false;
    const event = { ...extra, waitUntil: (p: Promise<unknown>) => { pending = p; }, respondWith: (p: Promise<unknown>) => { handled = true; pending = Promise.resolve(p); } };
    listeners[type]!(event);
    const value = await pending;
    return { handled, value: value as Response | undefined };
  };
  const get = (p: string, init: { mode?: string; headers?: Record<string, string>; method?: string } = {}) => {
    const req = new Request(`https://app.test${p}`, { method: init.method ?? 'GET', headers: init.headers });
    if (init.mode) Object.defineProperty(req, 'mode', { value: init.mode });
    return run('fetch', { request: req });
  };
  return { store, run, get, networkHits, setOffline: (v: boolean) => { offline = v; }, setResponder: (f: typeof responder) => { responder = f; } };
}

describe('service worker', () => {
  it('precaches only the offline page and icons on install', async () => {
    const sw = loadWorker();
    await sw.run('install');
    const urls = [...sw.store.get('dialtone-static-v1')!.keys()].map((u) => new URL(u).pathname);
    expect(urls.sort()).toEqual(['/icons/apple-touch-icon.png', '/icons/icon-192.png', '/icons/icon-512.png', '/offline.html']);
  });

  it('never touches /api/ (feeds, media, auth, messages): not intercepted, not cached', async () => {
    const sw = loadWorker();
    await sw.run('install');
    for (const p of ['/api/feed', '/api/me', '/api/media/abc', '/api/media/abc/thumb', '/api/auth/google', '/api/messages/threads']) {
      const r = await sw.get(p);
      expect(r.handled, p).toBe(false);
    }
    for (const m of sw.store.values()) for (const k of m.keys()) expect(new URL(k).pathname.startsWith('/api/')).toBe(false);
  });

  it('ignores non-GET, range requests and other origins', async () => {
    const sw = loadWorker();
    expect((await sw.get('/assets/app.js', { method: 'POST' })).handled).toBe(false);
    expect((await sw.get('/assets/app.js', { headers: { range: 'bytes=0-10' } })).handled).toBe(false);
    const other = new Request('https://elsewhere.test/assets/app.js');
    expect((await sw.run('fetch', { request: other })).handled).toBe(false);
  });

  it('page loads go to the network, are never cached, and fall back to the offline page', async () => {
    const sw = loadWorker();
    sw.setResponder((u) => new Response(u.endsWith('offline.html') ? 'OFFLINE' : '<html>private shell</html>', { status: 200 }));
    await sw.run('install');
    const online = await sw.get('/', { mode: 'navigate' });
    expect(await online.value!.text()).toContain('private shell');
    const keys = [...sw.store.get('dialtone-static-v1')!.keys()].map((u) => new URL(u).pathname);
    expect(keys).not.toContain('/');
    sw.setOffline(true);
    const off = await sw.get('/messages', { mode: 'navigate' });
    expect(await off.value!.text()).toBe('OFFLINE');
  });

  it('keeps hashed build files, serves them from the cache next time, and skips error responses', async () => {
    const sw = loadWorker();
    await sw.run('install');
    sw.setResponder(() => new Response('js', { status: 200 }));
    const first = await sw.get('/assets/index-abc123.js');
    expect(await first.value!.text()).toBe('js');
    await new Promise((r) => setTimeout(r, 0));
    const hitsBefore = sw.networkHits.length;
    const second = await sw.get('/assets/index-abc123.js');
    expect(await second.value!.text()).toBe('js');
    expect(sw.networkHits.length).toBe(hitsBefore); // served from the cache
    sw.setResponder(() => new Response('nope', { status: 404 }));
    await sw.get('/assets/missing.js');
    await new Promise((r) => setTimeout(r, 0));
    expect([...sw.store.get('dialtone-static-v1')!.keys()].some((k) => k.endsWith('/assets/missing.js'))).toBe(false);
  });

  it('leaves everything outside the static folders to the browser', async () => {
    const sw = loadWorker();
    for (const p of ['/sw.js', '/manifest.webmanifest', '/some/other.json', '/profile/someone']) {
      expect((await sw.get(p)).handled, p).toBe(false);
    }
  });

  it('removes old Dialtone caches on activate and leaves foreign ones alone', async () => {
    const sw = loadWorker();
    await sw.run('install');
    sw.store.set('dialtone-static-v0', new Map());
    sw.store.set('someone-elses-cache', new Map());
    await sw.run('activate');
    expect([...sw.store.keys()].sort()).toEqual(['dialtone-static-v1', 'someone-elses-cache']);
  });
});
