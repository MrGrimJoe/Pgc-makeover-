// The worker must hand the PWA files to the static-asset binding untouched, and still keep /api/ for itself.
import { describe, it, expect } from 'vitest';
import worker from '../worker/index.ts';
import { makeEnv } from './_helpers.ts';

describe('serving the PWA files', () => {
  it.each(['/sw.js', '/manifest.webmanifest', '/offline.html', '/icons/icon-192.png', '/icons/apple-touch-icon.png'])('%s goes to the static assets, unchanged', async (p) => {
    const seen: string[] = [];
    const env = await makeEnv({
      ENVIRONMENT: 'production',
      ASSETS: { fetch: async (req: Request) => { seen.push(new URL(req.url).pathname); return new Response('asset-body', { status: 200, headers: { 'Content-Type': 'text/plain', 'X-Marker': 'asset' } }); } },
    });
    const res = await worker.fetch(new Request(`https://app.test${p}`), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Marker')).toBe('asset');
    expect(await res.text()).toBe('asset-body');
    expect(seen).toEqual([p]);
  });

  it('an unknown /api/ path is still answered by the worker, never by the assets', async () => {
    let hit = false;
    const env = await makeEnv({ ENVIRONMENT: 'production', ASSETS: { fetch: async () => { hit = true; return new Response('x'); } } });
    const res = await worker.fetch(new Request('https://app.test/api/sw.js'), env);
    expect(res.status).toBe(404);
    expect(hit).toBe(false);
  });
});
