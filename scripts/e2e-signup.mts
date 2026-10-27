// DEV-ONLY: remove before launch
/**
 * A real browser signs up for real: Chromium with a fake camera that "looks at" the sample student card, so the barcode
 * scan, the printed-text reading and the whole form run exactly as on a phone (the camera picture is a file here).
 *
 *   1. Start the server:   PORT=3111 npm run dev        (the card scan is always required)
 *   2. npm install --no-save playwright           (and a Chromium: CHROMIUM_PATH=/path/to/chrome, or npx playwright install chromium)
 *   3. BASE_URL=http://localhost:3111 npx tsx scripts/e2e-signup.mts
 *
 * Uses the development sign-in, so it only works against a development server. Needs ffmpeg to turn the card picture into video.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAMPUSES } from '../shared/campuses.ts';

const BASE = process.env.BASE_URL || 'http://localhost:3111';
const CARD = process.env.CARD || 'tests/fixtures/card-ok.png';
const ROLL = process.env.ROLL || '20240907';
const CAMPUS = CAMPUSES.find((c) => c.city === 'Lahore')!;
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok, detail]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  ' + detail : ''}`); };

const dir = mkdtempSync(join(tmpdir(), 'cardcam-'));
const video = join(dir, 'card.y4m');
execFileSync('ffmpeg', ['-loglevel', 'error', '-loop', '1', '-i', CARD, '-t', '3', '-r', '10', '-pix_fmt', 'yuv420p', '-vf', 'scale=860:540', video]);

type Playwright = typeof import('playwright');
const pw = (await import('playwright')) as Playwright;
const browser = await pw.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`],
});
const sub = 'e2e_' + Date.now();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
const page = await context.newPage();
const consoleErrors: string[] = [];
page.on('pageerror', (e) => consoleErrors.push(String(e)));

try {
  await page.goto(`${BASE}/api/auth/google?mock=true&intent=signup&mock_sub=${sub}&mock_email=${sub}@gmail.com&mock_name=Ayesha%20Khan`);
  await page.waitForSelector('#signup-real-name', { timeout: 20000 });
  check('sign-up form opens after Google sign-in', true);

  await page.fill('#signup-real-name', 'Ayesha Khan');
  await page.fill('#signup-username', 'e2e_' + String(Date.now()).slice(-8));
  await page.waitForSelector('text=is available', { timeout: 10000 });
  await page.selectOption('#signup-class', 'cls_2026');
  await page.selectOption('#signup-program', 'fsc_pre_medical');
  await page.fill('#signup-session', '2024-2026');
  await page.fill('#signup-roll', '2024-0907');
  await page.fill('#signup-campus-input', CAMPUS.name);
  await page.waitForSelector('[role="option"]', { timeout: 5000 });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  const create = page.getByRole('button', { name: /create account/i });
  check('Create account is disabled before the card is scanned', await create.isDisabled());

  await page.getByRole('button', { name: 'Scan student card' }).click();
  await page.waitForSelector('video', { timeout: 5000 });
  check('camera view opened', true);
  await page.waitForSelector('text=Card scanned. The barcode matches your roll number.', { timeout: 30000 });
  check('barcode read from the camera matches the typed roll number', true);

  await page.waitForSelector('text=Reading the printed details', { timeout: 5000 }).catch(() => {});
  await page.waitForSelector('text=/on your card look right|Could not be sure|do not seem to match|Could not read the printed/', { timeout: 120000 });
  const summary = await page.locator('[role="status"], [role="alert"]').allTextContents();
  console.log('   printed-details summary:', summary.filter((t) => /printed/i.test(t)).join(' | '));
  check('printed name, campus, program and session read and compared', summary.some((t) => /printed name, campus, program, session on your card look right/.test(t)), summary.join(' | '));
  const tracks = await page.evaluate(() => (document.querySelector('video')?.srcObject as MediaStream | null)?.getTracks().filter((t) => t.readyState === 'live').length ?? 0);
  check('camera is switched off after the scan', tracks === 0, `${tracks} live tracks`);

  await create.click();
  await page.waitForSelector('text=/profile photo/i', { timeout: 20000 });
  check('account created after the checks passed', true);

  // The same card again, from another Google account, is a duplicate
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
  const p2 = await ctx2.newPage();
  await p2.goto(`${BASE}/api/auth/google?mock=true&intent=signup&mock_sub=${sub}_b&mock_email=${sub}_b@gmail.com&mock_name=Someone%20Else`);
  await p2.waitForSelector('#signup-real-name');
  await p2.fill('#signup-real-name', 'Someone Else');
  await p2.fill('#signup-username', 'dup_' + String(Date.now()).slice(-8));
  await p2.waitForSelector('text=is available');
  await p2.selectOption('#signup-class', 'cls_2026');
  await p2.selectOption('#signup-program', 'fsc_pre_medical');
  await p2.fill('#signup-session', '2024-2026');
  await p2.fill('#signup-roll', '20240907');
  await p2.fill('#signup-campus-input', CAMPUS.name);
  await p2.waitForSelector('[role="option"]');
  await p2.keyboard.press('ArrowDown');
  await p2.keyboard.press('Enter');
  await p2.getByRole('button', { name: 'Scan student card' }).click();
  await p2.waitForSelector('text=Card scanned.', { timeout: 30000 });
  // This person typed another name than the one printed on the card: the screen must say so and ask them to confirm
  await p2.waitForSelector('text=do not seem to match what you typed', { timeout: 120000 });
  check('a name that differs from the printed one is flagged, and the form is held back', await p2.getByRole('button', { name: /create account/i }).isDisabled());
  await p2.locator('input[type="checkbox"]').check();
  await p2.getByRole('button', { name: /create account/i }).click();
  await p2.waitForSelector('text=already registered at this campus', { timeout: 15000 });
  check('the same card from a second account is refused as a duplicate, kindly', true);
  // The development bar at the bottom lists every test account, so only the app's own messages are checked
  const messages = (await p2.locator('[role="alert"], [role="status"]').allTextContents()).join(' | ');
  check('the refusal reveals nothing about the other account', !/Ayesha|e2e_\d+/.test(messages), messages);
  await ctx2.close();
} catch (e) {
  check('flow completed', false, String(e).split('\n')[0]);
  await page.screenshot({ path: join(dir, 'failure.png') }).catch(() => {});
  console.log('   failure screenshot:', join(dir, 'failure.png'));
}
check('no uncaught errors in the page', consoleErrors.length === 0, consoleErrors.join('; '));
await browser.close();
const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
