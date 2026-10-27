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

async function mouseDown(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  });
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const submitButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Create account')) as HTMLButtonElement;

/** Completes the card step: a scan whose barcode matches the roll number typed by fillValidForm. */
async function scanCardOk() {
  await click([...container.querySelectorAll('button')].find((b) => /Scan (student card|again)/.test(b.textContent ?? ''))!);
  await waitFor(() => /barcode matches your roll number/.test(container.textContent ?? ''), 'card scanned');
}

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
});

async function mount(onComplete = () => {}, onRestart = () => {}) {
  await act(async () => {
    root.render(<OnboardingPage onComplete={onComplete} onRestart={onRestart} />);
  });
  await waitFor(() => !!document.getElementById('signup-real-name'), 'form to appear');
}

describe('Onboarding page (interactive)', () => {
  it('prefills the name and email from the Google account and has no axe violations', async () => {
    await mount();
    expect(byId<HTMLInputElement>('signup-real-name').value).toBe('Ayesha K');
    expect(container.textContent).toContain('Signing up as ayesha@gmail.com');
    await waitFor(() => byId<HTMLSelectElement>('signup-class').options.length > 1, 'classes to load');

    const results = await axe.run(container, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] }, rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`)).toEqual([]);
  });

  it('keeps Create account disabled until every field is valid', async () => {
    await mount();
    expect(submitButton().disabled).toBe(true);
    await type('signup-username', 'Bad Name!');
    expect(container.textContent).toContain('3 to 20 lowercase letters');
    expect(submitButton().disabled).toBe(true);
    await fillValidForm();
    await scanCardOk();
    expect(submitButton().disabled).toBe(false);
  });

  it('drops characters a roll number cannot contain, and keeps letters, digits and separators', async () => {
    await mount(vi.fn());
    await type('signup-roll', 'ab<12>-3$4');
    expect(byId<HTMLInputElement>('signup-roll').value).toBe('ab12-34');
  });

  it('shows when a username is taken and blocks submitting', async () => {
    takenUsernames = ['ayesha_k'];
    await mount();
    await type('signup-username', 'ayesha_k');
    await waitFor(() => /already taken/.test(container.textContent ?? ''), 'taken message');
    expect(byId<HTMLInputElement>('signup-username').getAttribute('aria-invalid')).toBe('true');
    expect(submitButton().disabled).toBe(true);
  });

  it('chooses a campus by keyboard and submits the right data, then offers a photo step', async () => {
    await mount();
    await fillValidForm();
    await scanCardOk();
    expect(container.textContent).toContain(LISTED.name);
    expect(container.textContent).toContain('Change');
    await click(submitButton());
    await waitFor(() => /Add a profile photo/.test(container.textContent ?? ''), 'photo step');

    const post = calls.find((c) => c.url === '/api/signup/complete');
    expect(post?.body).toEqual({
      real_name: 'Ayesha Khan',
      username: 'ayesha_k',
      campus_id: LISTED.id,
      class_id: 'cls_2026',
      program: 'fsc_pre_engineering', session: '2024-2026', roll_number: '2024-0907',
      card: { barcode: '20240907' },
    });
  });

  it('the photo step can be skipped', async () => {
    const onComplete = vi.fn();
    await mount(onComplete);
    await fillValidForm();
    await scanCardOk();
    await click(submitButton());
    await waitFor(() => /Skip for now/.test(container.textContent ?? ''), 'skip button');
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Skip for now')!);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('shows the server error and stays on the form when sign-up fails', async () => {
    completeStatus = 409;
    await mount();
    await fillValidForm();
    await scanCardOk();
    await click(submitButton());
    await waitFor(() => !!container.querySelector('[role="alert"]'), 'error message');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('already taken');
    expect(byId<HTMLInputElement>('signup-username').value).toBe('ayesha_k');
  });

  it('offers to start again when the sign-up session has expired', async () => {
    sessionValid = false;
    const onRestart = vi.fn();
    await act(async () => {
      root.render(<OnboardingPage onComplete={() => {}} onRestart={onRestart} />);
    });
    await waitFor(() => /sign-up session ended/.test(container.textContent ?? ''), 'expired message');
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Start again')!);
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('filters the bundled list on the device without any campus request', async () => {
    await mount();
    await fillValidForm();
    expect(calls.some((c) => c.url.startsWith('/api/campuses'))).toBe(false);
  });

  it('takes a campus that is not listed as free text and submits campus_other (never campus_id)', async () => {
    await mount();
    await fillValidForm(false);
    await scanCardOk();
    const input = byId<HTMLInputElement>('signup-campus-input');
    await act(async () => input.focus());
    await type('signup-campus-input', 'Green Valley College');
    await waitFor(() => /My campus is not listed/.test(container.textContent ?? ''), 'not listed option');
    await mouseDown([...container.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes('not listed'))!);
    await type('signup-campus-other', 'Green Valley College');
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Use this campus')!);
    await waitFor(() => /Other campus/.test(container.textContent ?? '') && /Change/.test(container.textContent ?? ''), 'other campus selected');
    await click(submitButton());
    await waitFor(() => /Add a profile photo/.test(container.textContent ?? ''), 'photo step');
    const post = calls.find((c) => c.url === '/api/signup/complete');
    expect(post?.body).toEqual({
      real_name: 'Ayesha Khan',
      username: 'ayesha_k',
      campus_other: 'Green Valley College',
      class_id: 'cls_2026',
      program: 'fsc_pre_engineering', session: '2024-2026', roll_number: '2024-0907',
      card: { barcode: '20240907' },
    });
  });
});

describe('Student card step', () => {
  const scanButton = () => [...container.querySelectorAll('button')].find((b) => /Scan (student card|again)/.test(b.textContent ?? '')) as HTMLButtonElement;
  const sheetClose = () => [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Close') as HTMLButtonElement | undefined;

  async function scanAndWait() {
    await click(scanButton());
    await waitFor(() => !document.querySelector('[role="dialog"]') || !!document.querySelector('[role="dialog"] [role="alert"]'), 'scanner result');
    await flush(50);
  }

  it('needs a scan when the server asks for one, and sends the barcode with the form', async () => {
    await mount();
    await fillValidForm();
    expect(submitButton().disabled).toBe(true);
    expect(container.textContent).toContain('Scan the barcode on your card to finish');
    await scanAndWait();
    await waitFor(() => /barcode matches your roll number/.test(container.textContent ?? ''), 'match message');
    expect(cameraStopped).toBeGreaterThan(0);
    expect(submitButton().disabled).toBe(false);
    await click(submitButton());
    await waitFor(() => /Add a profile photo/.test(container.textContent ?? ''), 'photo step');
    const post = calls.find((c) => c.url === '/api/signup/complete');
    expect(post?.body).toMatchObject({ program: 'fsc_pre_engineering', session: '2024-2026', roll_number: '2024-0907', card: { barcode: '20240907' } });
  });

  it('a barcode that disagrees with the typed roll number blocks sign-up and says why; fixing the number clears it', async () => {
    scanOutcome = { barcode: '20240999' };
    await mount();
    await fillValidForm();
    await scanAndWait();
    await waitFor(() => /does not match the roll number you typed/.test(container.textContent ?? ''), 'mismatch message');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('20240999');
    expect(submitButton().disabled).toBe(true);
    await type('signup-roll', '2024-0999');
    await waitFor(() => /barcode matches your roll number/.test(container.textContent ?? ''), 'match after fixing');
    expect(submitButton().disabled).toBe(false);
  });

  it('the card is not optional: with everything else valid, Create account stays disabled until it is scanned', async () => {
    await mount();
    await fillValidForm();
    expect(container.textContent).toContain('It is required');
    expect(submitButton().disabled).toBe(true);
    await click(scanButton());
    await waitFor(() => /barcode matches your roll number/.test(container.textContent ?? ''), 'match');
    expect(submitButton().disabled).toBe(false);
  });

  it.each([
    ['denied', /camera is blocked/],
    ['no-camera', /No camera was found/],
    ['unsupported', /cannot open the camera/],
  ] as const)('explains a camera problem (%s) and leaves the form usable', async (error, text) => {
    scanOutcome = { error };
    await mount();
    await fillValidForm();
    await click(scanButton());
    await waitFor(() => text.test(document.body.textContent ?? ''), 'camera message');
    expect([...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent === 'Try again')).toBe(true);
    await click(sheetClose()!);
    await flush(400);
    expect(submitButton().disabled).toBe(true);
  });

  it('server refusals are shown as given (mismatch and duplicate)', async () => {
    completeStatus = 409;
    await mount();
    await fillValidForm();
    await scanCardOk();
    await click(submitButton());
    await waitFor(() => /already taken|already registered/.test(container.textContent ?? ''), 'error text');
    expect(submitButton().disabled).toBe(false);
  });

  it('has no accessibility violations with the card step shown', async () => {
    await mount();
    await fillValidForm();
    await scanAndWait();
    const results = await axe.run(container, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] });
    expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});

describe('Bot check step', () => {
  it('is absent when the server does not ask for it', async () => {
    await mount();
    expect(container.querySelector('[aria-label="Security check"]')).toBeNull();
  });

  it('blocks Create account until the check passes, sends the token, and asks for a new check after a refusal', async () => {
    turnstileKey = 'site-key';
    let onToken: (t: string | null) => void = () => {};
    const resets: number[] = [];
    (window as unknown as { turnstile: unknown }).turnstile = {
      render: (_el: HTMLElement, o: { callback: (t: string) => void; 'expired-callback': () => void }) => { onToken = (t) => (t ? o.callback(t) : o['expired-callback']()); return 'w1'; },
      reset: () => resets.push(1),
      remove: () => {},
    };
    completeStatus = 409;
    await mount();
    await fillValidForm();
    await scanCardOk();
    await waitFor(() => !!container.querySelector('[aria-label="Security check"]'), 'widget host');
    await flush(30);
    expect(submitButton().disabled).toBe(true);
    await act(async () => onToken('tok-1'));
    expect(submitButton().disabled).toBe(false);
    await click(submitButton());
    await waitFor(() => !!calls.find((c) => c.url === '/api/signup/complete'), 'post');
    expect((calls.find((c) => c.url === '/api/signup/complete')!.body as Record<string, unknown>).turnstile_token).toBe('tok-1');
    await waitFor(() => resets.length > 0, 'widget reset after a refused sign-up');
    expect(submitButton().disabled).toBe(true); // the used token is gone until a new check passes
    delete (window as unknown as { turnstile?: unknown }).turnstile;
  });
});

describe('Printed details on the card (OCR)', () => {
  const scanButton = () => [...container.querySelectorAll('button')].find((b) => /Scan (student card|again)/.test(b.textContent ?? '')) as HTMLButtonElement;
  const CARD = `sample student card ${LISTED.name} name ayesha khan program pre medical session 2024-2026 roll no 20240907`;
  async function scan() {
    await click(scanButton());
    await waitFor(() => /barcode matches your roll number/.test(container.textContent ?? ''), 'match message');
    await flush(80);
  }

  it('says what looks right when the card agrees with the form', async () => {
    ocrText = CARD;
    await mount();
    await fillValidForm();
    await choose('signup-program', 'fsc_pre_medical');
    await scan();
    expect(container.textContent).toMatch(/printed name, campus, program, session on your card look right/);
    expect(submitButton().disabled).toBe(false);
    await click(submitButton());
    await waitFor(() => !!calls.find((c) => c.url === '/api/signup/complete'), 'post');
    const card = (calls.find((c) => c.url === '/api/signup/complete')!.body as { card: { printed: unknown } }).card;
    expect(card.printed).toEqual({ name: 'match', campus: 'match', program: 'match', session: 'match' });
  });

  it('a clear mismatch is shown plainly and needs the student to confirm; nothing is changed for them', async () => {
    ocrText = 'sample student card multan campus name bilal ahmed program commerce session 2022-2024 roll no 20240907';
    await mount();
    await fillValidForm();
    await scan();
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/do not seem to match what you typed/);
    expect(byId<HTMLInputElement>('signup-real-name').value).toBe('Ayesha Khan');
    expect(submitButton().disabled).toBe(true);
    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => box.click());
    expect(submitButton().disabled).toBe(false);
    await scan();
    expect(submitButton().disabled).toBe(true); // scanning again starts over
  });

  it('unreadable text never blocks sign-up', async () => {
    ocrText = '~~ ..';
    await mount();
    await fillValidForm();
    await scan();
    expect(container.textContent).toMatch(/Could not read the printed/);
    expect(submitButton().disabled).toBe(false);
  });
});
