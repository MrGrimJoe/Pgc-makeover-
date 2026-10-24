import type { Env } from './types.ts';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Is the Cloudflare Turnstile check switched on? It is when both keys are set. Off means "no check", not "fail". */
export function turnstileEnabled(env: Env): boolean {
  return !!env.TURNSTILE_SECRET_KEY && !!env.TURNSTILE_SITE_KEY;
}

/**
 * Checks a Turnstile token with Cloudflare. Returns true when the check is off or the token is valid.
 * Fails closed when it is on: a missing token, an unreachable verifier or any unexpected answer is a "no".
 */
export async function verifyTurnstile(env: Env, token: string | undefined, ip: string | null): Promise<boolean> {
  if (!turnstileEnabled(env)) return true;
  if (!token || token.length > 2048) return false;
  try {
    const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY!, response: token });
    if (ip) form.set('remoteip', ip);
    const res = await fetch(VERIFY_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { success?: unknown };
    return body.success === true;
  } catch {
    return false;
  }
}
