// Shared helpers for jsdom UI tests (React 19 act environment, axe, fake fetch).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import axe from 'axe-core';
import { AXE_TAGS } from './_axe.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
  container: HTMLElement;
  root: Root;
  unmount: () => void;
}

export async function mount(el: ReactElement): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(el));
  return { container, root, unmount: () => { act(() => root.unmount()); container.remove(); } };
}

export const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

export async function click(el: Element | null | undefined) {
  if (!el) throw new Error('click target not found');
  await act(async () => { (el as HTMLElement).click(); });
}

/** Sets a controlled input's value the way React expects. */
export async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export const byLabel = (c: Element, label: string) => c.querySelector<HTMLElement>(`[aria-label="${label}"]`);
export const byText = (c: Element, selector: string, text: string) =>
  [...c.querySelectorAll<HTMLElement>(selector)].find((e) => e.textContent?.trim() === text) ?? null;

/** Runs axe on mounted DOM. Contrast is "incomplete" in jsdom, so contrast is covered by the numeric tests. */
export async function axeViolations(container: HTMLElement): Promise<string> {
  const results = await axe.run(container, { runOnly: { type: 'tag', values: AXE_TAGS }, rules: { region: { enabled: false } } });
  return results.violations.map((v) => `[${v.impact}] ${v.id}: ${v.help}\n` + v.nodes.map((n) => `    ${n.html}`).join('\n')).join('\n');
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export interface Recorded { url: string; method: string; body: unknown }

/** Installs a fake fetch that records calls and answers from `routes` (first match by "METHOD /path-prefix"). */
export function installFetch(routes: Record<string, (body: unknown, url: string) => Response | Promise<Response>>) {
  const calls: Recorded[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown = init?.body;
    if (typeof init?.body === 'string') { try { body = JSON.parse(init.body); } catch { /* keep string */ } }
    calls.push({ url, method, body });
    const key = Object.keys(routes).find((k) => { const [m, p] = k.split(' '); return m === method && url.startsWith(p!); });
    return key ? routes[key]!(body, url) : json({ error: 'not found' }, 404);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]);
export const pngFile = (name = 'a.png') => new File([PNG_BYTES], name, { type: 'image/png' });
export const gifFile = (name = 'a.gif') => new File([GIF_BYTES], name, { type: 'image/gif' });

export function stubObjectUrls() {
  const c = URL.createObjectURL, r = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:test';
  URL.revokeObjectURL = () => undefined;
  return () => { URL.createObjectURL = c; URL.revokeObjectURL = r; };
}

export function stubMatchMedia(matches: (q: string) => boolean) {
  const original = window.matchMedia;
  window.matchMedia = ((q: string) => ({ matches: matches(q), media: q, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
  return () => { window.matchMedia = original; };
}
