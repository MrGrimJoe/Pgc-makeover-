// Install support: what browser we are in, when to offer installing, and the service worker.
// No network calls and nothing about the signed-in person is stored; only a dismissal time on this device.
import { useSyncExternalStore } from 'react';

export type InstallOs = 'ios' | 'android' | 'other';
export type InstallBrowser = 'safari' | 'chrome' | 'other';

export interface InstallEnv {
  os: InstallOs;
  browser: InstallBrowser;
  /** Opened inside another app's built-in browser (Instagram, Facebook, TikTok, a WebView...) */
  inApp: boolean;
  /** Already running as an installed app (home-screen icon) */
  standalone: boolean;
}

export interface EnvInput {
  userAgent: string;
  /** navigator.maxTouchPoints; iPadOS 13+ reports a Mac user agent and is told apart by touch support */
  maxTouchPoints?: number;
  standalone: boolean;
}

// Apps whose built-in browser cannot install a web app (and which Google refuses for sign-in).
const IN_APP_TOKENS = /FBAN|FBAV|FB_IAB|Instagram|Line\/|Snapchat|TikTok|musical_ly|BytedanceWebview|Twitter|LinkedInApp|Pinterest|GSA\/|MicroMessenger|KAKAOTALK|Telegram/i;

/** Pure: decide the environment from a user agent. Exported for tests. */
export function detectInstallEnv({ userAgent: ua, maxTouchPoints = 0, standalone }: EnvInput): InstallEnv {
  const iPadOnMac = /Macintosh/.test(ua) && maxTouchPoints > 1;
  const ios = /iPhone|iPad|iPod/.test(ua) || iPadOnMac;
  const android = /Android/.test(ua);
  const os: InstallOs = ios ? 'ios' : android ? 'android' : 'other';

  let inApp = IN_APP_TOKENS.test(ua);
  // iOS web views leave out the "Safari/" token that real Safari and the iOS Chrome/Firefox/Edge browsers include.
  if (ios && /AppleWebKit/.test(ua) && !/Safari\//.test(ua)) inApp = true;
  // Android WebViews mark themselves with "; wv)".
  if (android && /; wv\)/.test(ua)) inApp = true;

  let browser: InstallBrowser = 'other';
  if (!inApp) {
    if (ios) browser = !/CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|DuckDuckGo|Brave/i.test(ua) && /Safari\//.test(ua) ? 'safari' : 'other';
    else if (/Chrome\/|Chromium\//.test(ua) && !/OPR\/|Edg\/|SamsungBrowser|Firefox/.test(ua)) browser = 'chrome';
    else if (!ios && /Safari\//.test(ua) && !/Chrome\//.test(ua)) browser = 'safari';
  }
  return { os, browser, inApp, standalone };
}

export function readInstallEnv(): InstallEnv {
  const nav = window.navigator as Navigator & { standalone?: boolean };
  const standalone = nav.standalone === true || (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches);
  return detectInstallEnv({ userAgent: nav.userAgent, maxTouchPoints: nav.maxTouchPoints, standalone });
}

// ---- When to interrupt: rarely ----

export const DISMISS_KEY = 'dialtone:install-dismissed-at';
export const INSTALLED_KEY = 'dialtone:installed';
/** After "Not now" the banner stays away this long. Settings always keeps the instructions. */
export const DISMISS_DAYS = 14;

function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

export function isDismissed(now = Date.now()): boolean {
  const s = storage();
  if (!s) return false;
  try {
    if (s.getItem(INSTALLED_KEY) === '1') return true;
    const at = Number(s.getItem(DISMISS_KEY));
    return Number.isFinite(at) && at > 0 && now - at < DISMISS_DAYS * 86_400_000;
  } catch { return false; }
}

export function rememberDismissed(now = Date.now()): void {
  try { storage()?.setItem(DISMISS_KEY, String(now)); } catch { /* private mode: it simply asks again later */ }
}

export function rememberInstalled(): void {
  try { storage()?.setItem(INSTALLED_KEY, '1'); } catch { /* ignore */ }
}

export type BannerKind = 'android-prompt' | 'ios-safari' | 'open-in-browser' | 'none';

/** Pure: which automatic banner to show. Anything else is only reachable from Settings. */
export function bannerKind(env: InstallEnv, canPrompt: boolean, dismissed: boolean): BannerKind {
  if (env.standalone || dismissed) return 'none';
  if (env.inApp) return 'open-in-browser';
  if (env.os === 'ios') return env.browser === 'safari' ? 'ios-safari' : 'open-in-browser';
  if (canPrompt) return 'android-prompt';
  return 'none';
}

// ---- The browser's own install prompt (Chrome, Edge, Samsung Internet...) ----

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
let captureStarted = false;

/** Call once, early (main.tsx): the event fires before React is ready and only once per page load. */
export function startInstallCapture(): void {
  if (captureStarted || typeof window === 'undefined') return;
  captureStarted = true;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // we show our own, dismissible banner instead of the browser's mini-infobar
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    rememberInstalled();
    emit();
  });
}

export function useCanPrompt(): boolean {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => deferred !== null,
    () => false,
  );
}

/** Shows the browser's install dialog. The event can be used once; a refusal is remembered like "Not now". */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const ev = deferred;
  if (!ev) return 'unavailable';
  deferred = null;
  emit();
  try {
    await ev.prompt();
    const { outcome } = await ev.userChoice;
    if (outcome === 'dismissed') rememberDismissed();
    return outcome;
  } catch {
    return 'unavailable';
  }
}

// ---- Service worker ----

/** Registers /sw.js in production builds on secure origins. Failure is harmless: the app works without it. */
export function registerServiceWorker(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  if (!import.meta.env.PROD || !window.isSecureContext) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => { /* no offline page, nothing else lost */ });
  });
}

/** Test helper: forget the captured prompt. */
export function _resetInstallCaptureForTests(): void {
  deferred = null;
  captureStarted = false;
  emit();
}
export function _setDeferredForTests(ev: unknown): void {
  deferred = ev as BeforeInstallPromptEvent | null;
  emit();
}
