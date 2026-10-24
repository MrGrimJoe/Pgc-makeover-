// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import axe from 'axe-core';
import { SignInPage } from '../src/pages/SignInPage.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
let container: HTMLDivElement;
let root: Root;
let mine: Response;
let posted: unknown[];

const flush = (ms = 20) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

beforeEach(() => {
  posted = [];
  mine = json({ account_status: 'suspended', appeal: null });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/appeals/mine') return mine.clone();
    if (url === '/api/appeals' && init?.method === 'POST') { posted.push(JSON.parse(init.body as string)); return json({ success: true }, 201); }
    return json({}, 404);
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const mount = async (notice: 'suspended' | 'banned' | 'error') => { await act(async () => root.render(<SignInPage notice={notice} />)); await flush(); };

describe('appeal form on the sign-in screen', () => {
  it('is not shown for ordinary sign-in problems', async () => {
    await mount('error');
    expect(container.querySelector('#appeal-message')).toBeNull();
  });

  it('sends the message and then says it is waiting; no axe violations', async () => {
    await mount('suspended');
    const box = container.querySelector<HTMLTextAreaElement>('#appeal-message')!;
    expect(box).toBeTruthy();
    const results = await axe.run(container, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] });
    expect(results.violations.map((v) => v.id)).toEqual([]);
    const send = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Send request')!;
    expect(send.disabled).toBe(true);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, '  It was my brother.  ');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { send.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(posted).toEqual([{ message: 'It was my brother.' }]);
    expect(container.textContent).toContain('waiting for an administrator');
  });

  it('shows the answer to an earlier request instead of the form', async () => {
    mine = json({ account_status: 'suspended', appeal: { status: 'denied', decision_note: 'Repeated spam' } });
    await mount('suspended');
    expect(container.querySelector('#appeal-message')).toBeNull();
    expect(container.textContent).toContain('stays blocked');
    expect(container.textContent).toContain('Repeated spam');
  });

  it('without a ticket it explains how to get the form', async () => {
    mine = json({ error: 'no' }, 401);
    await mount('banned');
    expect(container.querySelector('#appeal-message')).toBeNull();
    expect(container.textContent).toContain('Log in with Google again');
  });
});
