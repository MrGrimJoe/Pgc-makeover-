import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../worker/index.ts';
import { createSqliteD1 } from '../worker/db/sqlite-d1.ts';
import { runMigrations } from '../worker/db/migrate.ts';
import { encodeOAuthState, base64UrlEncode, verifyGoogleIdToken } from '../worker/auth.ts';
import type { Env } from '../worker/types.ts';

describe('Google OAuth & Session Authentication', () => {
  let env: Env;

  beforeEach(async () => {
    const db = createSqliteD1(':memory:');
    await runMigrations(db);
    env = {
      DB: db,
      APP_URL: 'http://localhost:3000',
      GOOGLE_CLIENT_ID: 'test-google-client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
      ENVIRONMENT: 'development',
    };
  });

  // DEV-ONLY: remove before launch
  it('GET /api/auth/google initiates PKCE flow and sets cookie without Secure flag in development', async () => {
    const req = new Request('http://localhost:3000/api/auth/google', { method: 'GET' });
    const res = await worker.fetch(req, env);

    expect(res.status).toBe(302);
    const location = res.headers.get('Location');
    expect(location).toBeDefined();
    expect(location).toContain('code_challenge=');
    expect(location).toContain('code_challenge_method=S256');
    expect(location).toContain('state=');
    expect(location).toContain('nonce=');

    // In development: HttpOnly & SameSite=Lax present, but NOT Secure (so Safari on http://localhost accepts it)
    const setCookie = res.headers.get('Set-Cookie');
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain('oauth_state=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('Secure');
  });

  it('GET /api/auth/google sets Secure flag on cookies in production', async () => {
    const prodEnv: Env = {
      ...env,
      ENVIRONMENT: 'production',
      GOOGLE_CLIENT_ID: 'real-client-id.apps.googleusercontent.com',
    };

    const req = new Request('http://localhost:3000/api/auth/google', { method: 'GET' });
    const res = await worker.fetch(req, prodEnv);

    expect(res.status).toBe(302);
    const setCookie = res.headers.get('Set-Cookie');
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain('oauth_state=');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('Path=/api/auth/callback');
  });

  // DEV-ONLY: remove before launch
  it('rejects mock auth in /api/auth/google when ENVIRONMENT is production', async () => {
    const prodEnv: Env = {
      ...env,
      ENVIRONMENT: 'production',
      GOOGLE_CLIENT_ID: 'real-client-id.apps.googleusercontent.com',
    };

    const req = new Request('http://localhost:3000/api/auth/google?mock=true', { method: 'GET' });
    const res = await worker.fetch(req, prodEnv);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Mock authentication is disabled in production');
  });

  // DEV-ONLY: remove before launch
  it('rejects mock code in /api/auth/callback when ENVIRONMENT is production', async () => {
    const prodEnv: Env = {
      ...env,
      ENVIRONMENT: 'production',
      GOOGLE_CLIENT_ID: 'real-client-id.apps.googleusercontent.com',
    };

    const legitimateState = 'valid_matching_state_456';
    const cookiePayload = encodeOAuthState({
      state: legitimateState,
      codeVerifier: 'verifier_string_abcdef',
      nonce: 'nonce_123',
      createdAt: Date.now(),
    });

    const callbackUrl = `http://localhost:3000/api/auth/callback?code=mock_code&state=${legitimateState}&mock=true`;
    const req = new Request(callbackUrl, {
      method: 'GET',
      headers: {
        Cookie: `oauth_state=${cookiePayload}`,
      },
    });

    const res = await worker.fetch(req, prodEnv);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Mock authorization is disabled in production');
  });

  // DEV-ONLY: remove before launch
  it('rejects as= parameter in /api/auth/google when ENVIRONMENT is production', async () => {
    const prodEnv: Env = {
      ...env,
      ENVIRONMENT: 'production',
      GOOGLE_CLIENT_ID: 'real-client-id.apps.googleusercontent.com',
    };

    const req = new Request('http://localhost:3000/api/auth/google?mock=true&as=alice', { method: 'GET' });
    const res = await worker.fetch(req, prodEnv);

    expect(res.status).toBe(400);
  });

  // DEV-ONLY: remove before launch
  it('rejects as= parameter in /api/auth/callback when ENVIRONMENT is production', async () => {
    const prodEnv: Env = {
      ...env,
      ENVIRONMENT: 'production',
      GOOGLE_CLIENT_ID: 'real-client-id.apps.googleusercontent.com',
    };

    const callbackUrl = 'http://localhost:3000/api/auth/callback?code=mock_code&state=s123&mock=true&as=alice';
    const req = new Request(callbackUrl, { method: 'GET' });
    const res = await worker.fetch(req, prodEnv);

    expect(res.status).toBe(400);
  });

  // DEV-ONLY: remove before launch
  it('allows dev sign-in with as=<username> when ENVIRONMENT is development', async () => {
    const devEnv: Env = {
      ...env,
      ENVIRONMENT: 'development',
    };

    // First ensure user alice exists
    await devEnv.DB.prepare('INSERT INTO users (id, provider_subject, created_at, status) VALUES (?, ?, ?, ?)')
      .bind('usr_alice', 'mock-google-sub-alice', new Date().toISOString(), 'active')
      .run();
    await devEnv.DB.prepare('INSERT INTO profiles (user_id, username, username_normalized, display_name, bio) VALUES (?, ?, ?, ?, ?)')
      .bind('usr_alice', 'alice', 'alice', 'Alice Adams', '')
      .run();

    const callbackUrl = 'http://localhost:3000/api/auth/callback?code=mock_code&state=s123&mock=true&as=alice';
    const req = new Request(callbackUrl, { method: 'GET' });
    const res = await worker.fetch(req, devEnv);

    expect(res.status).toBe(302);
    const setCookie = res.headers.get('Set-Cookie');
    expect(setCookie).toContain('session_id=');

    // Verify session belongs to usr_alice
    const sessionId = setCookie?.match(/session_id=([^;]+)/)?.[1];
    const sessionRow = await devEnv.DB.prepare('SELECT user_id FROM sessions WHERE id = ?').bind(sessionId).first<{ user_id: string }>();
    expect(sessionRow?.user_id).toBe('usr_alice');
  });

  // DEV-ONLY: remove before launch
  it('the seed refuses outside development and when target is not .local-dev-d1.sqlite', async () => {
    const { seedDevDatabase } = await import('../scripts/seed-dev.ts');

    // Refuses when ENVIRONMENT is production
    await expect(seedDevDatabase(undefined, 'production')).rejects.toThrow('Refusing to seed: ENVIRONMENT cannot be production');

    // Refuses when target is remote or not .local-dev-d1.sqlite
    await expect(seedDevDatabase('/tmp/remote-database.sqlite', 'development')).rejects.toThrow('Refusing to seed: target must be .local-dev-d1.sqlite only');
  });

  it('auth callback with a bad state is rejected with 400', async () => {
    const validCookieState = 'valid_secret_state_123';
    const cookiePayload = encodeOAuthState({
      state: validCookieState,
      codeVerifier: 'verifier_string_abcdef',
      nonce: 'nonce_secret_xyz',
      createdAt: Date.now(),
    });

    const badStateUrl = 'http://localhost:3000/api/auth/callback?code=some_code&state=bad_tampered_state';
    const req = new Request(badStateUrl, {
      method: 'GET',
      headers: {
        Cookie: `oauth_state=${cookiePayload}`,
      },
    });

    const res = await worker.fetch(req, env);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Invalid OAuth state parameter');
  });

  it('auth callback with missing state cookie is rejected with 400 for non-mock codes', async () => {
    const req = new Request('http://localhost:3000/api/auth/callback?code=some_code&state=any_state', {
      method: 'GET',
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Missing OAuth state cookie');
  });

  // DEV-ONLY: remove before launch
  it('sign-up callback survives the preview iframe dropping the transient oauth_state cookie', async () => {
    const callbackUrl =
      'http://localhost:3000/api/auth/callback?code=mock_code&state=mock_state_123&mock=true&intent=signup';
    const res = await worker.fetch(new Request(callbackUrl, { method: 'GET' }), env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/?signup=1');

    expect(res.headers.get('Set-Cookie')).toContain('signup_ticket=tkt_');

    // The callback never creates an account: only a ticket exists
    const users = await env.DB.prepare('SELECT * FROM users').all();
    expect(users.results.length).toBe(0);
    const tickets = await env.DB.prepare('SELECT * FROM signup_tickets').all();
    expect(tickets.results.length).toBe(1);
  });

  // DEV-ONLY: remove before launch
  it('log in with an unknown Google account does not create a user and returns to the login screen', async () => {
    const legitimateState = 'valid_matching_state_456';
    const cookiePayload = encodeOAuthState({
      state: legitimateState,
      codeVerifier: 'verifier_string_abcdef',
      nonce: 'nonce_123456789',
      createdAt: Date.now(),
      intent: 'login',
    });

    const callbackUrl = `http://localhost:3000/api/auth/callback?code=mock_code&state=${legitimateState}&mock=true`;
    const res = await worker.fetch(
      new Request(callbackUrl, { method: 'GET', headers: { Cookie: `oauth_state=${cookiePayload}` } }),
      env
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/?auth=no_account');
    expect(res.headers.get('Set-Cookie') ?? '').not.toContain('session_id=');

    expect((await env.DB.prepare('SELECT * FROM users').all()).results.length).toBe(0);
    expect((await env.DB.prepare('SELECT * FROM signup_tickets').all()).results.length).toBe(0);
    expect((await env.DB.prepare('SELECT * FROM sessions').all()).results.length).toBe(0);
  });

  // DEV-ONLY: remove before launch
  it('sign up with an unknown Google account issues a single-use ticket cookie (no Secure flag in development)', async () => {
    const legitimateState = 'valid_matching_state_789';
    const cookiePayload = encodeOAuthState({
      state: legitimateState,
      codeVerifier: 'verifier_string_abcdef',
      nonce: 'nonce_123456789',
      createdAt: Date.now(),
      intent: 'signup',
    });

    const callbackUrl =
      `http://localhost:3000/api/auth/callback?code=mock_code&state=${legitimateState}&mock=true` +
      '&mock_sub=s1&mock_email=new.student%40gmail.com&mock_name=New%20Student';
    const res = await worker.fetch(
      new Request(callbackUrl, { method: 'GET', headers: { Cookie: `oauth_state=${cookiePayload}` } }),
      env
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/?signup=1');
    const setCookie = res.headers.get('Set-Cookie') ?? '';
    expect(setCookie).toContain('signup_ticket=tkt_');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('Secure');
    expect(setCookie).not.toContain('session_id=');

    const ticket = await env.DB.prepare('SELECT * FROM signup_tickets').first<{
      provider_subject: string;
      email: string;
      display_name: string;
    }>();
    expect(ticket?.provider_subject).toBe('mock-google-sub-s1');
    expect(ticket?.email).toBe('new.student@gmail.com');
    expect(ticket?.display_name).toBe('New Student');
    expect((await env.DB.prepare('SELECT * FROM users').all()).results.length).toBe(0);
  });

  // DEV-ONLY: remove before launch
  it('dev mock flow redirects relatively and sets the ticket cookie on the request host when APP_URL is a different host', async () => {
    const diffHostEnv: Env = {
      ...env,
      APP_URL: 'https://different-host.example.com',
      ENVIRONMENT: 'development',
    };

    // Step 1: Initiate mock OAuth from http://localhost:3000
    const initReq = new Request('http://localhost:3000/api/auth/google?mock=true&intent=signup', { method: 'GET' });
    const initRes = await worker.fetch(initReq, diffHostEnv);

    expect(initRes.status).toBe(302);
    const location = initRes.headers.get('Location');
    expect(location).toBeDefined();

    // Verify redirect is relative, not sending the user to different-host.example.com
    expect(location).not.toContain('different-host.example.com');
    expect(location).toMatch(/^\/api\/auth\/callback\?/);

    const initSetCookie = initRes.headers.get('Set-Cookie');
    expect(initSetCookie).toBeDefined();
    expect(initSetCookie).toContain('oauth_state=');

    // Extract cookie value for subsequent callback request
    const cookieMatch = initSetCookie!.match(/oauth_state=([^;]+)/);
    const oauthCookieValue = cookieMatch ? cookieMatch[1] : '';

    // Step 2: Follow relative redirect on http://localhost:3000 with the oauth_state cookie
    const callbackReq = new Request(`http://localhost:3000${location}`, {
      method: 'GET',
      headers: { Cookie: `oauth_state=${oauthCookieValue}` },
    });

    const callbackRes = await worker.fetch(callbackReq, diffHostEnv);
    expect(callbackRes.status).toBe(302);

    // Post-callback redirect is relative and goes to onboarding
    expect(callbackRes.headers.get('Location')).toBe('/?signup=1');
    expect(callbackRes.headers.get('Set-Cookie')).toContain('signup_ticket=tkt_');

    // Still no account until onboarding completes
    const users = await diffHostEnv.DB.prepare('SELECT * FROM users').all();
    expect(users.results.length).toBe(0);
  });

  it('GET /api/auth/google rejects an unknown intent', async () => {
    const res = await worker.fetch(
      new Request('http://localhost:3000/api/auth/google?intent=admin', { method: 'GET' }),
      env
    );
    expect(res.status).toBe(400);
  });

  it('verifyGoogleIdToken requires email_verified', async () => {
    const header = base64UrlEncode(JSON.stringify({ alg: 'none' }));
    const payloadUnverified = base64UrlEncode(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: 'client-123',
        sub: 'sub-123',
        nonce: 'nonce-123',
        exp: Math.floor(Date.now() / 1000) + 3600,
        email_verified: false,
      })
    );
    const fakeToken = `${header}.${payloadUnverified}.signature`;

    await expect(
      verifyGoogleIdToken(fakeToken, 'client-123', 'nonce-123', { allowTestBypass: true })
    ).rejects.toThrow('Email address is not verified');

    // Verified email succeeds
    const payloadVerified = base64UrlEncode(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: 'client-123',
        sub: 'sub-123',
        nonce: 'nonce-123',
        exp: Math.floor(Date.now() / 1000) + 3600,
        email_verified: true,
      })
    );
    const verifiedToken = `${header}.${payloadVerified}.signature`;

    const result = await verifyGoogleIdToken(verifiedToken, 'client-123', 'nonce-123', {
      allowTestBypass: true,
    });
    expect(result.sub).toBe('sub-123');
  });

  it('POST /api/auth/logout deletes the session and clears session cookie', async () => {
    await env.DB.prepare(
      'INSERT INTO users (id, provider_subject, created_at, status) VALUES (?, ?, ?, ?)'
    )
      .bind('usr_1', 'sub_1', new Date().toISOString(), 'active')
      .run();

    await env.DB.prepare(
      'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
    )
      .bind('sess_active_123', 'usr_1', new Date(Date.now() + 86400000).toISOString())
      .run();

    const req = new Request('http://localhost:3000/api/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: 'session_id=sess_active_123',
      },
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);

    const checkSession = await env.DB.prepare('SELECT * FROM sessions WHERE id = ?')
      .bind('sess_active_123')
      .first();
    expect(checkSession).toBeNull();

    const setCookie = res.headers.get('Set-Cookie');
    expect(setCookie).toContain('Max-Age=0');
  });
});
