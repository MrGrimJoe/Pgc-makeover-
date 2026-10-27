// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import axe from 'axe-core';
import { OnboardingPage } from '../src/pages/OnboardingPage.tsx';

import { CAMPUSES as BUNDLED } from '../shared/campuses.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no camera. The scanner module is replaced by one that "sees" whatever the test sets.
let scanOutcome: { barcode: string } | { error: 'denied' | 'no-camera' | 'unsupported' | 'failed' };
let cameraStopped = 0;
let ocrText: string | null; // null = the scan gives no picture, so OCR is skipped
vi.mock('../src/lib/cardOcr.ts', () => ({ readCardText: async () => ocrText ?? '' }));
vi.mock('../src/lib/cardScan.ts', () => ({
  startCameraScan: async (_video: unknown, onResult: (t: string) => void, onError: (k: string) => void) => {
    queueMicrotask(() => ('barcode' in scanOutcome ? (onResult as (t: string, f?: unknown) => void)(scanOutcome.barcode, ocrText === null ? undefined : { width: 10 }) : onError(scanOutcome.error)));
    return { stop: () => { cameraStopped++; } };
  },
}));

// The picture reader is replaced (jsdom has no canvas); the device rule (prefersPhotoUpload) is the real one.
let photoOutcome: { ok: true; barcode: string } | { ok: false; message: string };
const photoFiles: File[] = [];
vi.mock('../src/lib/cardPhoto.ts', async (orig) => ({
  ...(await orig<typeof import('../src/lib/cardPhoto.ts')>()),
  readCardPhoto: async (f: File) => { photoFiles.push(f); return photoOutcome; },
}));

function setPointer(kind: 'fine' | 'coarse', camera = true) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes(kind), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  Object.defineProperty(navigator, 'mediaDevices', { value: camera ? { getUserMedia: async () => ({}) } : undefined, configurable: true });
}

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

// Campus names ship inside the app, so the picker needs no network calls.
const LISTED = BUNDLED.find((c) => c.city === 'Lahore')!;

let calls: Recorded[];
let sessionValid: boolean;
let completeStatus: number;
let takenUsernames: string[];
let turnstileKey: string | undefined;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const method = (init?.method ?? 'GET').toUpperCase();
  let body: unknown = undefined;
  if (typeof init?.body === 'string') body = JSON.parse(init.body);
  calls.push({ url, method, body });

  if (url === '/api/signup/session') {
    return Promise.resolve(
      sessionValid ? json({ valid: true, suggested_name: 'Ayesha K', email: 'ayesha@gmail.com', card_scan: 'required', ...(turnstileKey ? { turnstile_site_key: turnstileKey } : {}) }) : json({ error: 'expired' }, 401)
    );
  }
  if (url === '/api/classes') return Promise.resolve(json({ classes: [{ id: 'cls_2026', name: 'Class of 2026' }] }));
  if (url.startsWith('/api/username-available')) {
    const u = new URL(url, 'http://x').searchParams.get('u') ?? '';
    return Promise.resolve(
      takenUsernames.includes(u) ? json({ available: false, reason: 'taken', message: 'Username is already taken' }) : json({ available: true })
    );
  }
  if (url === '/api/signup/complete' && method === 'POST') {
    if (completeStatus !== 201) return Promise.resolve(json({ error: 'Username is already taken' }, completeStatus));
    return Promise.resolve(
      json(
        { success: true, me: { user: { id: 'usr_1' }, profile: { username: (body as { username: string }).username, display_name: (body as { username: string }).username } } },
        201
      )
    );
  }
  return Promise.resolve(json({ error: 'not found' }, 404));
}

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 0) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function waitFor(check: () => boolean, label: string, timeout = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for: ${label}`);
    await flush(25);
  }
}

function byId<T = HTMLInputElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as unknown as T;
}

async function type(id: string, value: string) {
  const el = byId<HTMLInputElement>(id);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function choose(id: string, value: string) {
  const el = byId<HTMLSelectElement>(id);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const submitButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Create account')) as HTMLButtonElement;

async function fillValidForm(pickCampus = true) {
  await type('signup-real-name', 'Ayesha Khan');
  await type('signup-username', 'ayesha_k');
  await waitFor(() => /is available/.test(container.textContent ?? ''), 'username availability');
  await choose('signup-class', 'cls_2026');
  await choose('signup-program', 'fsc_pre_engineering');
  await type('signup-session', '2024-2026');
  await type('signup-roll', '2024-0907');
  if (!pickCampus) return;
  // pick a campus with the keyboard: type, arrow down, enter
  const input = byId<HTMLInputElement>('signup-campus-input');
  await act(async () => input.focus());
  await type('signup-campus-input', LISTED.name);
  // the full name leaves exactly one result (and no "not listed" option, because it matches exactly)
  await waitFor(
    () => [...container.querySelectorAll('[role="option"]')].length === 1 && container.querySelector('[role="option"]')!.textContent!.includes(LISTED.name),
    'filtered campus results'
  );
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  calls = [];
  sessionValid = true;
  completeStatus = 201;
  takenUsernames = [];
  photoOutcome = { ok: true, barcode: '20240907' };
  photoFiles.length = 0;
  scanOutcome = { barcode: '20240907' };
  cameraStopped = 0;
  ocrText = null;
  turnstileKey = undefined;
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
});

async function mount(onComplete = () => {}, onRestart = () => {}) {
  await act(async () => {
    root.render(<OnboardingPage onComplete={onComplete} onRestart={onRestart} />);
  });
  await waitFor(() => !!document.getElementById('signup-real-name'), 'form to appear');
}


const buttonText = (t: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(t)) as HTMLButtonElement | undefined;
const fileInput = () => document.getElementById('signup-card-file') as HTMLInputElement | null;

async function chooseFile(type = 'image/png') {
  const input = fileInput()!;
  const file = new File([new Uint8Array(10)], 'card.png', { type });
  await act(async () => {
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush(10);
  return file;
}

describe('Sign-up on a laptop: upload a picture of the student card', () => {
  it('offers the upload and not the camera scanner', async () => {
    setPointer('fine');
    await mount();
    expect(fileInput()).not.toBeNull();
    expect(buttonText('Upload a picture of your student card')).toBeTruthy();
    expect(buttonText('Scan student card')).toBeUndefined();
    expect(container.textContent).not.toContain('Scan the barcode on your card');
  });

  it('is also what a browser with no camera support gets, even on a phone', async () => {
    setPointer('coarse', false);
    await mount();
    expect(buttonText('Upload a picture of your student card')).toBeTruthy();
  });

  it('keeps the camera scanner on phones and tablets, with no upload', async () => {
    setPointer('coarse');
    await mount();
    expect(fileInput()).toBeNull();
    expect(buttonText('Scan student card')).toBeTruthy();
  });

  it('the picture is required on a laptop: nothing else lets the form be sent', async () => {
    setPointer('fine');
    await mount();
    await fillValidForm();
    expect(submitButton().disabled).toBe(true);
    expect(container.textContent).toContain('It is required');
  });

  it('a rejected picture shows why, creates nothing, and a better one then lets the student finish', async () => {
    setPointer('fine');
    await mount();
    await fillValidForm();
    photoOutcome = { ok: false, message: 'The picture is blurry, so the barcode cannot be read. Hold the camera steady, let it focus, and try again.' };
    await chooseFile();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('blurry');
    expect(submitButton().disabled).toBe(true);
    expect(calls.find((c) => c.url === '/api/signup/complete')).toBeUndefined();

    photoOutcome = { ok: true, barcode: '20240907' };
    await chooseFile();
    await waitFor(() => /Card scanned\. The barcode matches/.test(container.textContent ?? ''), 'accepted picture');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(submitButton().disabled).toBe(false);
  });

  it('a barcode that does not match the typed roll number still blocks sign-up', async () => {
    setPointer('fine');
    await mount();
    await fillValidForm();
    photoOutcome = { ok: true, barcode: '20240999' };
    await chooseFile();
    await waitFor(() => /does not match the roll number/.test(container.textContent ?? ''), 'mismatch message');
    expect(submitButton().disabled).toBe(true);
  });

  it('sends the barcode and says it came from a picture; the picture itself is never sent', async () => {
    setPointer('fine');
    await mount();
    await fillValidForm();
    const file = await chooseFile();
    await waitFor(() => !submitButton().disabled, 'form to be valid');
    await click(submitButton());
    await waitFor(() => /Add a profile photo/.test(container.textContent ?? ''), 'photo step');
    const post = calls.find((c) => c.url === '/api/signup/complete')!;
    expect((post.body as { card: unknown }).card).toEqual({ barcode: '20240907', source: 'upload' });
    expect(photoFiles).toEqual([file]);
    expect(JSON.stringify(calls.map((c) => c.body))).not.toContain('card.png');
  });

  it('a camera scan on a phone sends no source, exactly as before', async () => {
    setPointer('coarse');
    await mount();
    await fillValidForm();
    await click(buttonText('Scan student card')!);
    await waitFor(() => /Card scanned/.test(container.textContent ?? ''), 'scan');
    await click(submitButton());
    await waitFor(() => /Add a profile photo/.test(container.textContent ?? ''), 'photo step');
    expect((calls.find((c) => c.url === '/api/signup/complete')!.body as { card: unknown }).card).toEqual({ barcode: '20240907' });
  });

  it('accepts a picture dropped on the card area', async () => {
    setPointer('fine');
    await mount();
    await fillValidForm();
    const zone = fileInput()!.parentElement!;
    const file = new File([new Uint8Array(10)], 'dropped.png', { type: 'image/png' });
    await act(async () => {
      const drop = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } });
      zone.dispatchEvent(drop);
    });
    await flush(10);
    expect(photoFiles).toEqual([file]);
    await waitFor(() => /Card scanned/.test(container.textContent ?? ''), 'dropped picture read');
  });

  it('has no axe violations, with and without a problem showing', async () => {
    setPointer('fine');
    await mount();
    await waitFor(() => byId<HTMLSelectElement>('signup-class').options.length > 1, 'classes to load');
    const run = () => axe.run(container, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] }, rules: { 'color-contrast': { enabled: false } } });
    expect((await run()).violations.map((v) => v.id)).toEqual([]);
    photoOutcome = { ok: false, message: 'No barcode was found.' };
    await chooseFile();
    expect((await run()).violations.map((v) => v.id)).toEqual([]);
  });
});
