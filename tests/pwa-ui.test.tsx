// @vitest-environment jsdom
// Install banner, Settings share card and QR code: what is shown when, that it is dismissible, and accessibility.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { InstallBanner } from '../src/components/InstallBanner.tsx';
import { ShareApp, canonicalAppUrl } from '../src/components/ShareApp.tsx';
import { QrCode } from '../src/components/QrCode.tsx';
import { _resetInstallCaptureForTests, _setDeferredForTests, DISMISS_KEY } from '../src/lib/pwa.ts';
import { axeViolations, byText, click, mount, flush, type Mounted } from './_ui.tsx';

const IOS_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IOS_INSTAGRAM = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.0.0';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const DESKTOP_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function setUa(ua: string, standalone = false) {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
  Object.defineProperty(window.navigator, 'standalone', { value: standalone, configurable: true });
}

let m: Mounted | null = null;
beforeEach(() => { localStorage.clear(); _resetInstallCaptureForTests(); });
afterEach(() => { m?.unmount(); m = null; _resetInstallCaptureForTests(); });

describe('InstallBanner', () => {
  it('iOS Safari: shows Share, then Add to Home Screen, and no install button (iOS has none)', async () => {
    setUa(IOS_SAFARI);
    m = await mount(<InstallBanner />);
    expect(m.container.textContent).toContain('Add to Home Screen');
    expect(m.container.textContent).toContain('Share');
    expect(byText(m.container, 'button', 'Install')).toBeNull();
    expect(await axeViolations(m.container)).toBe('');
  });

  it('Not now hides it and remembers for later visits', async () => {
    setUa(IOS_SAFARI);
    m = await mount(<InstallBanner />);
    await click(m.container.querySelector('button[aria-label="Not now"]'));
    expect(m.container.textContent).toBe('');
    expect(localStorage.getItem(DISMISS_KEY)).toBeTruthy();
    m.unmount();
    m = await mount(<InstallBanner />);
    expect(m.container.textContent).toBe('');
  });

  it('already installed (standalone): nothing is shown', async () => {
    setUa(IOS_SAFARI, true);
    m = await mount(<InstallBanner />);
    expect(m.container.textContent).toBe('');
  });

  it('in-app browser: tells the person to open Safari, and the signed-out page gets only that notice', async () => {
    setUa(IOS_INSTAGRAM);
    m = await mount(<InstallBanner signedOut />);
    expect(m.container.textContent).toContain('Open this page in Safari');
    expect(m.container.textContent).toContain('Google sign-in does not work inside other apps');
    expect(await axeViolations(m.container)).toBe('');
  });

  it('signed-out page does not push installing in a normal browser', async () => {
    setUa(IOS_SAFARI);
    m = await mount(<InstallBanner signedOut />);
    expect(m.container.textContent).toBe('');
  });

  it('Android Chrome: no banner until the browser offers the prompt; Install triggers it once', async () => {
    setUa(ANDROID_CHROME);
    m = await mount(<InstallBanner />);
    expect(m.container.textContent).toBe('');
    const prompt = vi.fn(async () => {});
    _setDeferredForTests({ prompt, userChoice: Promise.resolve({ outcome: 'accepted' as const }) });
    await flush();
    expect(m.container.textContent).toContain('Add Dialtone to your home screen');
    await click(byText(m.container, 'button', 'Install'));
    await flush();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(m.container.textContent).toBe('');
  });

  it('declining the browser prompt counts as Not now', async () => {
    setUa(ANDROID_CHROME);
    m = await mount(<InstallBanner />);
    _setDeferredForTests({ prompt: async () => {}, userChoice: Promise.resolve({ outcome: 'dismissed' as const }) });
    await flush();
    await click(byText(m.container, 'button', 'Install'));
    await flush();
    expect(localStorage.getItem(DISMISS_KEY)).toBeTruthy();
  });
});

describe('ShareApp (Settings)', () => {
  it('always shows instructions that work without any prompt, per platform', async () => {
    setUa(DESKTOP_CHROME);
    m = await mount(<ShareApp className="card" />);
    expect(m.container.textContent).toContain('install icon');
    m.unmount();
    setUa(ANDROID_CHROME);
    m = await mount(<ShareApp className="card" />);
    expect(m.container.textContent).toContain('Install app or Add to Home screen');
    m.unmount();
    setUa(IOS_SAFARI);
    m = await mount(<ShareApp className="card" />);
    expect(m.container.textContent).toContain('Share, then Add to Home Screen');
  });

  it('the QR code holds only the public address and appears on request', async () => {
    setUa(DESKTOP_CHROME);
    m = await mount(<ShareApp className="card" />);
    expect(m.container.querySelector('svg')).toBeNull();
    await click(byText(m.container, 'button', 'Show QR code'));
    const svg = m.container.querySelector('svg[role="img"]');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('aria-label')).toContain('QR code');
    expect(canonicalAppUrl()).toBe(`${window.location.origin}/`);
    expect(canonicalAppUrl()).not.toMatch(/[?#]/); // no query, no fragment, so no token can ride along
    expect(await axeViolations(m.container)).toBe('');
  });

  it('Share link uses the share sheet when there is one, otherwise copies', async () => {
    setUa(DESKTOP_CHROME);
    const share = vi.fn(async () => {});
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    m = await mount(<ShareApp className="card" />);
    await click(byText(m.container, 'button', 'Share link'));
    expect(share).toHaveBeenCalledWith({ title: 'Dialtone', url: canonicalAppUrl() });
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await click(byText(m.container, 'button', 'Share link'));
    await flush();
    expect(writeText).toHaveBeenCalledWith(canonicalAppUrl());
    expect(m.container.textContent).toContain('Link copied.');
  });
});

describe('QrCode', () => {
  it('draws a square code with a quiet zone and one path', async () => {
    m = await mount(<QrCode value="https://example.test/" label="QR" />);
    const svg = m.container.querySelector('svg')!;
    const [, , w, h] = svg.getAttribute('viewBox')!.split(' ').map(Number);
    expect(w).toBe(h);
    expect(m.container.querySelectorAll('path')).toHaveLength(1);
    expect(svg.innerHTML).not.toContain('script');
  });
});
