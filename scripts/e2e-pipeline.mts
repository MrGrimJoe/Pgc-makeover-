// DEV-ONLY: remove before launch
/**
 * Real-browser check of the feed pipeline (jsdom tests use a fake IndexedDB; this uses the browser's own).
 * Signs in with the dev shortcut, then in a real Chromium: fetches a real packaged batch, stores it in IndexedDB,
 * records history, reloads the page, goes completely offline, and checks everything still reads from the phone.
 *
 *   1. npm run seed:dev && PORT=3111 npm run dev        (another terminal)
 *   2. npm install --no-save playwright                 (once; add @sparticuz/chromium if downloads are blocked)
 *   3. BASE_URL=http://localhost:3111 npm run e2e:feed
 *
 * Environment: BASE_URL (default http://localhost:3000), AS (seeded username, default alice), CHROMIUM_PATH (optional).
 */
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const AS = process.env.AS || 'alice';

type Playwright = typeof import('playwright');
let pw: Playwright;
try {
  pw = (await import('playwright')) as Playwright;
} catch {
  console.error('Playwright is not installed. Run: npm install --no-save playwright');
  process.exit(1);
}

const executablePath = process.env.CHROMIUM_PATH || undefined;
const browser = await pw.chromium.launch(
  executablePath ? { executablePath, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] } : {},
);

let failed = 0;
const check = (name: string, pass: boolean, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `  (${detail})`}`);
  if (!pass) failed++;
};

try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/api/auth/google?mock=true&as=${encodeURIComponent(AS)}`);
  await page.waitForLoadState('networkidle');

  const userId: string = await page.evaluate(async () => (await (await fetch('/api/me')).json()).user.id);
  check('signed in as a seeded user', typeof userId === 'string' && userId.length > 0, String(userId));

  // 1. the real endpoint
  const raw = await page.evaluate(async () => {
    const res = await fetch('/api/v1/feed/bootstrap?mode=for_you&size=30');
    const body = await res.json();
    return {
      status: res.status,
      cache: res.headers.get('cache-control'),
      posts: body.batch.posts.length,
      allMeta: body.batch.posts.every((p: any) => typeof p.meta.isWild === 'boolean' && typeof p.meta.trendingScore === 'number' && Array.isArray(p.meta.tags)),
      counts: body.batch.counts,
    };
  });
  check('real /api/v1/feed/bootstrap answers with a tagged batch', raw.status === 200 && raw.posts > 0 && raw.allMeta, JSON.stringify(raw));
  check('the batch is private, no-store', raw.cache === 'private, no-store', String(raw.cache));

  // 2. real IndexedDB: cold start, history
  const first = await page.evaluate(async (uid) => {
    // @ts-expect-error resolved by the dev server in the browser
    const m = await import('/src/feed-pipeline/index.ts');
    const cache = new m.FeedCacheManager({ userId: uid, mode: 'for_you' });
    await cache.clear();
    const started = await cache.start();
    const stats = await cache.getStats();
    const pool = await cache.getPool();
    await cache.markViewed(pool.slice(0, 4).map((p: any) => p.id));
    await cache.markViewed(pool.slice(4, 8).map((p: any) => p.id));
    const frames = await cache.getHistoryFrames({ frameSize: 4, frames: 3 });
    const db = (await indexedDB.databases?.())?.map((d) => d.name) ?? [];
    return { started, backend: stats.backend, total: stats.total, firstIds: pool.slice(0, 8).map((p: any) => p.id), frames: frames.map((f: any) => f.items.map((p: any) => p.id)), db };
  }, userId);
  check('cold start fetched from the network and stored in real IndexedDB', first.started.source === 'network' && first.backend === 'indexeddb' && first.total > 0, JSON.stringify(first.started) + first.backend);
  check('the database really exists in the browser', first.db.includes('pgc-feed-cache'), String(first.db));
  const expectFrames = first.firstIds.length >= 8 ? [first.firstIds.slice(4, 8), first.firstIds.slice(0, 4)] : null;
  check('history frames come back nearest first, in the order they were shown', !expectFrames || JSON.stringify(first.frames) === JSON.stringify(expectFrames), JSON.stringify(first.frames));

  // 3. reload: a new JS context. No /api/v1 request may be made.
  const seen: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/v1/feed')) seen.push(r.url()); });
  await page.reload();
  await page.waitForLoadState('networkidle');
  const second = await page.evaluate(async (uid) => {
    // @ts-expect-error resolved by the dev server in the browser
    const m = await import('/src/feed-pipeline/index.ts');
    const cache = new m.FeedCacheManager({ userId: uid, mode: 'for_you' });
    const started = await cache.start();
    const history = await cache.getHistory({ limit: 50 });
    return { started, viewed: history.length, unviewed: (await cache.getPool()).length };
  }, userId);
  check('after a reload the cache is used with no network call', second.started.source === 'cache' && seen.length === 0, JSON.stringify(second.started) + ` requests=${seen.length}`);
  check('history survived the reload', second.viewed === 8 || second.viewed === Math.min(8, first.total), `viewed ${second.viewed}`);

  // 4. completely offline
  await context.setOffline(true);
  const offline = await page.evaluate(async (uid) => {
    // @ts-expect-error resolved by the dev server in the browser
    const m = await import('/src/feed-pipeline/index.ts');
    const pipeline = m.createFeedPipeline({ userId: uid, mode: 'for_you', cache: { freshMs: 0 } }); // "stale" on purpose: it will try the network and must fall back
    const online = navigator.onLine;
    const started = await pipeline.cache.start();
    const batch = await pipeline.source.load('SAFE', 4);
    const snapshot = await pipeline.cache.readOffline();
    return { online, started, got: batch.items.length, unviewed: snapshot.unviewed.length, history: snapshot.history.length };
  }, userId);
  check('the browser really is offline', offline.online === false, String(offline.online));
  check('offline: the feed starts from the phone and serves posts', offline.started.source === 'cache' && offline.got > 0, JSON.stringify(offline));
  await context.setOffline(false);

  // 5. sign-out
  const wiped = await page.evaluate(async (uid) => {
    // @ts-expect-error resolved by the dev server in the browser
    const m = await import('/src/feed-pipeline/index.ts');
    await m.forgetFeedDataFor(uid);
    const stats = await new m.FeedCacheManager({ userId: uid, mode: 'for_you' }).getStats();
    return stats.total;
  }, userId);
  check('sign-out clears the stored posts', wiped === 0, `total ${wiped}`);
} finally {
  await browser.close();
}
console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
