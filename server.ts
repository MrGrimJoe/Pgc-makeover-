import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import worker from './worker/index.ts';
import { createSqliteD1 } from './worker/db/sqlite-d1.ts';
import { runMigrations } from './worker/db/migrate.ts';
import { createMemoryR2Bucket } from './worker/db/r2-shim.ts';
import type { Env } from './worker/types.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const isDev = (process.env.NODE_ENV || 'development') === 'development';
  const PORT = Number(process.env.PORT || 3000);

  // Outside development, strictly require all credentials and fail fast without fallback secrets
  if (!isDev) {
    const missing: string[] = [];
    if (!process.env.GOOGLE_CLIENT_ID) missing.push('GOOGLE_CLIENT_ID');
    if (!process.env.GOOGLE_CLIENT_SECRET) missing.push('GOOGLE_CLIENT_SECRET');
    if (!process.env.APP_URL) missing.push('APP_URL');

    if (missing.length > 0) {
      console.error(`[Fatal] Missing required environment variables in production: ${missing.join(', ')}`);
      process.exit(1);
    }
  }

  const app = express();

  // Initialize SQLite-backed D1 database for local development
  const dbPath = path.resolve(__dirname, '.local-dev-d1.sqlite');
  const d1 = createSqliteD1(dbPath);
  const mediaBucket = createMemoryR2Bucket();

  // Run migrations on startup
  console.log('[D1] Applying migrations...');
  const migrationResult = await runMigrations(d1);
  if (migrationResult.applied.length > 0) {
    console.log(`[D1] Applied migrations: ${migrationResult.applied.join(', ')}`);
  } else {
    console.log('[D1] Database schema is up-to-date.');
  }

  const env: Env = {
    DB: d1,
    MEDIA_BUCKET: mediaBucket,
    APP_URL: process.env.APP_URL || `http://localhost:${PORT}`,
    // DEV-ONLY: remove before launch
    // Env vars may default to placeholder values ONLY in development
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || (isDev ? 'PLACEHOLDER' : ''),
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || (isDev ? 'PLACEHOLDER' : ''),
    ENVIRONMENT: isDev ? 'development' : 'production',
  };

  // Mount API router directly to the Cloudflare Worker fetch handler
  app.all('/api/*', async (req, res) => {
    try {
      // DEV-ONLY: remove before launch
      // Build request URL from x-forwarded-proto and x-forwarded-host when present,
      // so the worker sees the real public origin behind AI Studio's reverse proxy.
      const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
      const host = (req.headers['x-forwarded-host'] as string) || req.get('host') || 'localhost:3000';
      const fullUrl = `${proto}://${host}${req.originalUrl}`;

      // Convert Express request to standard Web Request
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const v of value) headers.append(key, v);
        } else {
          headers.set(key, value);
        }
      }

      const init: RequestInit = {
        method: req.method,
        headers,
      };

      if (['POST', 'PUT', 'PATCH'].includes(req.method.toUpperCase())) {
        // Collect raw body buffer
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        init.body = Buffer.concat(chunks);
      }

      const webRequest = new Request(fullUrl, init);

      // Execute Cloudflare Worker fetch handler
      const webResponse = await worker.fetch(webRequest, env);

      // Write status
      res.status(webResponse.status);

      // Write headers
      webResponse.headers.forEach((val, key) => {
        if (key.toLowerCase() === 'set-cookie') {
          const rawCookies = (webResponse.headers as any).getSetCookie
            ? (webResponse.headers as any).getSetCookie()
            : [val];
          res.setHeader('Set-Cookie', rawCookies);
        } else {
          res.setHeader(key, val);
        }
      });

      // Stream body
      if (webResponse.body) {
        const reader = webResponse.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) res.write(Buffer.from(value));
        }
      }
      res.end();
    } catch (err) {
      console.error('[Worker Error]', err);
      // Generic error response without leaking internal server details to client
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Vite middlewares in dev mode or static files in production
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Dialtone] App server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[Dialtone Server Fatal]', err);
  process.exit(1);
});
