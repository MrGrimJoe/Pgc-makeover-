import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeEnv, call, startSignup, CAMPUS_X } from './_helpers.ts';
import type { Env } from '../worker/types.ts';

const body = { real_name: 'Ayesha Khan', username: 'ayesha_k', campus_id: CAMPUS_X, class_id: 'cls_2026', program: 'fsc_pre_engineering', session: '2024-2026', roll_number: '2024-0907', card: { barcode: '20240907' } };

describe('Turnstile on sign-up', () => {
  let verifier: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    verifier = vi.fn();
    vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) =>
      String(url).includes('challenges.cloudflare.com') ? verifier(String(url), init) : realFetch(url as string, init));
  });
  afterEach(() => vi.unstubAllGlobals());

  const on = (): Promise<Env> => makeEnv({ TURNSTILE_SECRET_KEY: 'sec', TURNSTILE_SITE_KEY: 'site-key-public' });
  const answer = (success: boolean, status = 200) => verifier.mockResolvedValue(new Response(JSON.stringify({ success }), { status }));

  it('is off when the keys are not set: no token needed, Cloudflare never called', async () => {
    const env = await makeEnv();
    const { cookie } = await startSignup(env);
    expect((await call(env, 'GET', '/api/signup/session', { cookie })).json.turnstile_site_key).toBeUndefined();
    expect((await call(env, 'POST', '/api/signup/complete', { cookie, json: body })).status).toBe(201);
    expect(verifier).not.toHaveBeenCalled();
  });

  it('when on: the site key is offered, a missing token is refused, a good token passes', async () => {
    const env = await on();
    const { cookie } = await startSignup(env);
    expect((await call(env, 'GET', '/api/signup/session', { cookie })).json.turnstile_site_key).toBe('site-key-public');
    const none = await call(env, 'POST', '/api/signup/complete', { cookie, json: body });
    expect(none.status).toBe(403);
    expect(none.json.code).toBe('turnstile_failed');
    answer(true);
    const ok = await call(env, 'POST', '/api/signup/complete', { cookie, json: { ...body, turnstile_token: 'good' } });
    expect(ok.status).toBe(201);
    const [url, init] = verifier.mock.calls[0]!;
    expect(url).toContain('siteverify');
    expect(String((init as RequestInit).body)).toContain('secret=sec');
    expect(String((init as RequestInit).body)).toContain('response=good');
  });

  it.each([
    ['a token Cloudflare rejects', () => answer(false)],
    ['Cloudflare answering with an error', () => answer(true, 500)],
    ['Cloudflare being unreachable', () => verifier.mockRejectedValue(new Error('network down'))],
  ])('fails closed on %s, and creates nothing', async (_l, arrange) => {
    const env = await on();
    const { cookie } = await startSignup(env);
    arrange();
    const res = await call(env, 'POST', '/api/signup/complete', { cookie, json: { ...body, turnstile_token: 'x' } });
    expect(res.status).toBe(403);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n).toBe(0);
  });

  it('a refused check does not use up the ticket', async () => {
    const env = await on();
    const { cookie } = await startSignup(env);
    answer(false);
    await call(env, 'POST', '/api/signup/complete', { cookie, json: { ...body, turnstile_token: 'bad' } });
    answer(true);
    expect((await call(env, 'POST', '/api/signup/complete', { cookie, json: { ...body, turnstile_token: 'good' } })).status).toBe(201);
  });
});
