// DEV-ONLY: remove before launch
/**
 * Screenshots of the main pages at phone, tablet, desktop and wide-desktop widths, so the three designs can be
 * looked at without opening a browser by hand. jsdom tests prove which design is chosen; only this shows how it looks.
 *
 *   1. npm run seed:dev && npm run dev            (in another terminal; signs in as a seeded user)
 *   2. npm install --no-save playwright && npx playwright install chromium   (once, not part of package.json)
 *   3. npm run shots                               (writes PNGs to shots/<width>/)
 *
 * Environment: BASE_URL (default http://localhost:3000), AS (seeded username, default alice), CHROMIUM_PATH (optional, use this browser).
 */
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const AS = process.env.AS || 'alice';
const WIDTHS: Array<{ width: number; height: number }> = [
  { width: 390, height: 844 },
  { width: 820, height: 1180 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
];
// Reached the way a person reaches them: through the navigation (aria-label) of the layout in use
const PAGES: Array<{ name: string; nav: string }> = [
  { name: 'feed', nav: 'Feed' },
  { name: 'search', nav: 'Search' },
  { name: 'new-post', nav: 'New post' },
  { name: 'messages', nav: 'Messages' },
  { name: 'profile', nav: 'Profile' },
];

type Playwright = typeof import('playwright');
let pw: Playwright;
try {
  pw = (await import('playwright')) as Playwright;
} catch {
  console.error('Playwright is not installed. Run: npm install --no-save playwright && npx playwright install chromium');
  process.exit(1);
}

// CHROMIUM_PATH: use an existing Chromium/Chrome instead of the one Playwright downloads (needed where downloads are blocked)
const executablePath = process.env.CHROMIUM_PATH || undefined;
const browser = await pw.chromium.launch(executablePath ? { executablePath, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] } : {});
try {
  for (const { width, height } of WIDTHS) {
    const dir = `shots/${width}`;
    mkdirSync(dir, { recursive: true });
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    // Signed out first: the sign-in screen
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${dir}/signin.png` });
    await page.goto(`${BASE}/api/auth/google?mock=true&as=${encodeURIComponent(AS)}`);
    await page.waitForLoadState('networkidle');
    await page.addStyleTag({ content: '[aria-label="Development Toolbar"] { display: none !important; }' }); // the dev bar would cover the bottom of the navigation
    const layout = await page.evaluate(() => document.documentElement.dataset.layout);
    console.log(`${width}px -> ${layout}`);
    for (const { name, nav } of PAGES) {
      // Messages and Profile are not in the phone bottom bar under the same name in every build: skip what is not there
      const target = page.getByRole('button', { name: nav, exact: true }).first();
      if (!(await target.count())) { console.warn(`  ${name}: no "${nav}" button at ${width}px, skipped`); continue; }
      await target.click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(600); // let the page transition finish
      await page.screenshot({ path: `${dir}/${name}.png`, fullPage: false });
    }
    if (width >= 1024) {
      // Settings is a two-pane page on desktop
      const settings = page.getByRole('button', { name: 'Settings', exact: true }).first();
      if (await settings.count()) { await settings.click(); await page.waitForLoadState('networkidle'); await page.waitForTimeout(600); await page.screenshot({ path: `${dir}/settings.png` }); }
    }
    await context.close();
  }
} finally {
  await browser.close();
}
console.log('Done. Look at shots/<width>/*.png');
