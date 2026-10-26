import type { Env } from './types.ts';

export function jsonResponse(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // _headers only covers static files; these answers come from the Worker. They are personal to the
      // signed-in viewer, so nothing may store them, and the browser must not guess another type.
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

/** Constant-time string comparison for secrets to prevent timing attacks. */
export function constantTimeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = new TextEncoder().encode(a);
  const bBuf = new TextEncoder().encode(b);
  if (aBuf.byteLength !== bBuf.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < aBuf.byteLength; i++) {
    diff |= aBuf[i]! ^ bBuf[i]!;
  }
  return diff === 0;
}

export interface CookieFlags {
  secure: boolean;
  sameSite: 'Lax' | 'None';
  partitioned: boolean;
}

/**
 * Cookie attributes for the current request. Mirrors the rules used for the session cookie:
 * production is always Secure + SameSite=Lax; development and test relax them only for the
 * preview iframe (HTTPS) and plain localhost (HTTP).
 */
export function cookieFlags(request: Request, env: Env): CookieFlags {
  const url = new URL(request.url);
  const relaxed = env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test';
  const isHttps = url.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
  return {
    secure: relaxed ? isHttps : true,
    sameSite: relaxed && isHttps ? 'None' : 'Lax',
    partitioned: relaxed && isHttps,
  };
}

/**
 * Admin gate shared by the moderation endpoints. Returns an error Response, or null when allowed.
 * In development/test with no ADMIN_SECRET configured the gate is open, as for /api/admin/stats.
 */
export function checkAdmin(request: Request, env: Env): Response | null {
  const header = request.headers.get('x-admin-secret');
  const relaxed = env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test';
  if (!header) {
    if (!(relaxed && !env.ADMIN_SECRET)) {
      return jsonResponse({ error: 'Unauthorized: Admin secret required' }, 401);
    }
    return null;
  }
  if (!env.ADMIN_SECRET || !constantTimeCompare(header, env.ADMIN_SECRET)) {
    return jsonResponse({ error: 'Forbidden: Invalid admin secret' }, 403);
  }
  return null;
}
