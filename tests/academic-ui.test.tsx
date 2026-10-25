// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import axe from 'axe-core';
import { AcademicCard } from '../src/components/AcademicCard.tsx';
import { AcademicBanner } from '../src/components/AcademicBanner.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
const INFO = { program: 'fsc_pre_medical', program_name: 'F.Sc. Pre-Medical', session: '2024-2026', section: 'B', class_id: 'cls_2026', class_name: 'Class of 2026', status: 'current', confirm_due: false };

let container: HTMLDivElement; let root: Root; let calls: Array<{ method: string; url: string; body?: unknown }>; let info: Record<string, unknown>;
const flush = (ms = 20) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const q = <T = HTMLInputElement & HTMLSelectElement>(sel: string) => container.querySelector(sel) as unknown as T;
const setValue = async (el: HTMLInputElement | HTMLSelectElement, v: string) => act(async () => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
});
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement | undefined;
const click = async (el: Element | undefined) => { await act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); await flush(); };

beforeEach(() => {
  calls = []; info = { ...INFO };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url === '/api/classes') return json({ classes: [{ id: 'cls_2026', name: 'Class of 2026' }, { id: 'cls_2027', name: 'Class of 2027' }] });
    if (url === '/api/me/academic' && method === 'PUT') { info = { ...info, ...(calls.at(-1)!.body as object), confirm_due: false }; return json(info); }
    if (url === '/api/me/academic/confirm') { info = { ...info, confirm_due: false }; return json(info); }
    if (url === '/api/me/academic/graduate') { info = { ...info, status: 'graduated', class_id: 'cls_alumni' }; return json(info); }
    if (url === '/api/me/academic') return json(info);
    return json({}, 404);
  }));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('Academic details card', () => {
  it('shows current values, saves changes as one request, and has no axe violations', async () => {
    await act(async () => root.render(<AcademicCard />)); await flush();
    expect(q<HTMLSelectElement>('#acad-program').value).toBe('fsc_pre_medical');
    expect(q<HTMLInputElement>('#acad-session').value).toBe('2024-2026');
    expect((await axe.run(container, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] })).violations.map((v) => v.id)).toEqual([]);
    await setValue(q('#acad-class'), 'cls_2027');
    await setValue(q('#acad-section'), 'A');
    await click(button('Save changes'));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ program: 'fsc_pre_medical', session: '2024-2026', class_id: 'cls_2027', section: 'A' });
    expect(container.textContent).toContain('Saved.');
  });

  it('will not send an invalid session, and typing keeps only digits and a dash', async () => {
    await act(async () => root.render(<AcademicCard />)); await flush();
    await setValue(q('#acad-session'), '20x24');
    expect(q<HTMLInputElement>('#acad-session').value).toBe('2024');
    expect(button('Save changes')!.disabled).toBe(true);
  });

  it('asks before graduating, and then explains nothing is deleted', async () => {
    await act(async () => root.render(<AcademicCard />)); await flush();
    await click(button('I have graduated'));
    expect(container.textContent).toContain('Nothing you posted or sent is deleted');
    expect(calls.some((c) => c.url.endsWith('/graduate'))).toBe(false);
    await click(button('Cancel'));
    expect(calls.some((c) => c.url.endsWith('/graduate'))).toBe(false);
    await click(button('I have graduated'));
    await click(button('Yes, I have graduated'));
    expect(calls.some((c) => c.url.endsWith('/graduate'))).toBe(true);
    expect(container.textContent).toContain('marked as graduated');
    expect(q('#acad-program')).toBeNull();
  });
});

describe('Renewal banner', () => {
  it('stays away when nothing is due', async () => {
    await act(async () => root.render(<AcademicBanner onOpenSettings={() => {}} />)); await flush();
    expect(container.textContent).toBe('');
  });
  it('asks, confirms in one tap, and can open Settings', async () => {
    info = { ...INFO, confirm_due: true };
    const open = vi.fn();
    await act(async () => root.render(<AcademicBanner onOpenSettings={open} />)); await flush();
    expect(container.textContent).toContain('F.Sc. Pre-Medical, Class of 2026, 2024-2026');
    await click(button('Update'));
    expect(open).toHaveBeenCalled();
    await click(button('Yes, nothing changed'));
    expect(calls.some((c) => c.url === '/api/me/academic/confirm' && c.method === 'POST')).toBe(true);
    expect(container.textContent).toBe('');
  });
});
