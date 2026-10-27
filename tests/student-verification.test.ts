import { describe, it, expect, beforeEach } from 'vitest';
import { makeEnv, call, seedClassCampus, startSignup, CAMPUS_X } from './_helpers.ts';
import { CAMPUSES } from '../shared/campuses.ts';
import { normalizeRoll, rollLast3, barcodeMatchesRoll, campusKey } from '../shared/roll.ts';
import type { Env } from '../worker/types.ts';

const CAMPUS_Y = CAMPUSES.find((c) => c.id !== CAMPUS_X)!.id;
const base = { real_name: 'Ayesha Khan', username: 'ayesha_k', campus_id: CAMPUS_X, class_id: 'cls_2026', program: 'fsc_pre_engineering', session: '2024-2026', roll_number: '2024-0907', card: { barcode: '20240907' } };

async function signup(env: Env, sub: string, body: Record<string, unknown>) {
  const { cookie } = await startSignup(env, { sub, email: `${sub}@gmail.com` });
  return call(env, 'POST', '/api/signup/complete', { cookie, json: body });
}
const count = async (env: Env, sql: string) => (await env.DB.prepare(sql).first<{ n: number }>())!.n;

describe('roll numbers', () => {
  it('normalizes spelling differences to one student', () => {
    expect(normalizeRoll('ab-0123')).toBe('AB0123');
    expect(normalizeRoll(' AB 0123 ')).toBe('AB0123');
    expect(normalizeRoll('ab/0123')).toBe('AB0123');
    expect(normalizeRoll('0000123')).toBe('123');
    expect(normalizeRoll('12<3')).toBe('');
  });
  it('last three digits only when there are three', () => {
    expect(rollLast3('AB0123')).toBe('123');
    expect(rollLast3('AB12')).toBeNull();
  });
  it('a barcode must equal the roll number, nothing looser', () => {
    expect(barcodeMatchesRoll('20240907', '2024-0907')).toBe(true);
    expect(barcodeMatchesRoll('20240908', '2024-0907')).toBe(false);
    expect(barcodeMatchesRoll('', '')).toBe(false);
    expect(barcodeMatchesRoll('0907', '2024-0907')).toBe(false);
  });
  it('typed campuses are keyed by normalized text, bundled ones by id', () => {
    expect(campusKey(null, '  Green   Valley College ')).toBe(campusKey(null, 'green valley college'));
    expect(campusKey('x', null)).not.toBe(campusKey(null, 'x'));
  });
});

describe('student verification at sign-up', () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv();
    await seedClassCampus(env);
  });

  it('a matching barcode creates a provisional account; the roll number itself is not stored', async () => {
    const res = await signup(env, 'a', base);
    expect(res.status).toBe(201);
    const row = await env.DB.prepare('SELECT * FROM user_private').first<Record<string, string | null>>();
    expect(row?.verification_status).toBe('provisional');
    expect(row?.verification_method).toBe('barcode');
    expect(row?.verified_at).toBeTruthy();
    expect(row?.roll_last3).toBe('907');
    expect(row?.roll_key).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain('20240907');
  });

  it('a barcode read from a picture on a laptop is recorded as barcode-photo, and is checked exactly like a camera scan', async () => {
    const ok = await signup(env, 'p', { ...base, card: { barcode: '20240907', source: 'upload' } });
    expect(ok.status).toBe(201);
    const row = await env.DB.prepare('SELECT verification_status, verification_method FROM user_private').first<Record<string, string | null>>();
    expect(row).toEqual({ verification_status: 'provisional', verification_method: 'barcode-photo' });

    const { cookie } = await startSignup(env, { sub: 'p2', email: 'p2@gmail.com' });
    const bad = await call(env, 'POST', '/api/signup/complete', { cookie, json: { ...base, username: 'second_one', roll_number: '2024-0908', card: { barcode: '20240907', source: 'upload' } } });
    expect(bad.status).toBe(422);
    expect(bad.json.code).toBe('card_mismatch');
  });

  it('refuses an unknown card source', async () => {
    const res = await signup(env, 'q', { ...base, card: { barcode: '20240907', source: 'telepathy' } });
    expect(res.status).toBe(400);
    expect(await count(env, 'SELECT COUNT(*) AS n FROM users')).toBe(0);
  });

  it('with the scan required, a sign-up with no card at all is refused whatever the device', async () => {
    const { card: _omit, ...noCard } = base;
    const res = await signup(env, 'r', noCard);
    expect(res.status).toBe(422);
    expect(res.json.code).toBe('card_required');
  });

  it('a mismatching barcode is refused with a reason and creates nothing, and a retry works', async () => {
    const { cookie } = await startSignup(env, { sub: 'm' });
    const bad = await call(env, 'POST', '/api/signup/complete', { cookie, json: { ...base, card: { barcode: '20240908' } } });
    expect(bad.status).toBe(422);
    expect(bad.json.code).toBe('card_mismatch');
    expect(await count(env, 'SELECT COUNT(*) AS n FROM users')).toBe(0);
    const retry = await call(env, 'POST', '/api/signup/complete', { cookie, json: base });
    expect(retry.status).toBe(201);
  });

  it('keeps what the browser said about the printed text (as information only), and refuses nonsense in it', async () => {
    const printed = { name: 'match', campus: 'uncertain', program: 'unreadable', session: 'mismatch' };
    expect((await signup(env, 'p1', { ...base, card: { ...base.card, printed } })).status).toBe(201);
    const row = await env.DB.prepare('SELECT verification_detail, verification_status FROM user_private').first<Record<string, string>>();
    expect(JSON.parse(row!.verification_detail!)).toEqual(printed);
    expect(row!.verification_status).toBe('provisional'); // a printed-text mismatch does not change what the server concluded
    for (const bad of [{ ...printed, name: 'perfect' }, { ...printed, extra: 'match' }, { name: 'match' }]) {
      expect((await signup(env, 'p2', { ...base, username: 'other_name', roll_number: '9999', card: { barcode: '9999', printed: bad } })).status).toBe(400);
    }
  });

  it('the scan is required', async () => {
    const { card: _c, ...noCard } = base;
    const res = await signup(env, 'n', noCard);
    expect(res.status).toBe(422);
    expect(res.json.code).toBe('card_required');
    expect(await count(env, 'SELECT COUNT(*) AS n FROM users')).toBe(0);
  });

  it('the scan is not negotiable: an old REQUIRE_CARD_SCAN=false setting is ignored', async () => {
    const env2 = await makeEnv({ REQUIRE_CARD_SCAN: 'false' } as Partial<Env>);
    await seedClassCampus(env2);
    const { card: _c, ...noCard } = base;
    const { cookie } = await startSignup(env2, { sub: 'o' });
    expect((await call(env2, 'GET', '/api/signup/session', { cookie })).json.card_scan).toBe('required');
    const res = await call(env2, 'POST', '/api/signup/complete', { cookie, json: noCard });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe('card_required');
    expect(await count(env2, 'SELECT COUNT(*) AS n FROM users')).toBe(0);
  });
});

describe('one registration per student per campus', () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv();
    await seedClassCampus(env);
  });

  it.each([
    ['the same roll number', { program: 'fsc_pre_engineering', session: '2024-2026', roll_number: '2024-0907', card: { barcode: '20240907' } }],
    ['different punctuation and case', { roll_number: '2024 0907', card: { barcode: '2024/0907' } }],
    ['another class (section, class and session are not in the key)', { class_id: 'cls_2025', program: 'fsc_pre_engineering', session: '2024-2026', roll_number: '2024-0907', card: { barcode: '20240907' } }],
  ])('refuses %s as a duplicate, without revealing the other account', async (_label, patch) => {
    expect((await signup(env, 'first', base)).status).toBe(201);
    const dup = await signup(env, 'second', { ...base, username: 'someone_else', ...patch });
    expect(dup.status).toBe(409);
    expect(dup.json.code).toBe('duplicate_registration');
    expect(dup.text).not.toMatch(/ayesha|first@gmail/i);
    expect(await count(env, 'SELECT COUNT(*) AS n FROM users')).toBe(1);
  });

  it('keeps the attempt for an administrator once, and does not block or ban the student', async () => {
    await signup(env, 'first', base);
    const { cookie } = await startSignup(env, { sub: 'second', email: 'second@gmail.com' });
    for (let i = 0; i < 3; i++) {
      const r = await call(env, 'POST', '/api/signup/complete', { cookie, json: { ...base, username: 'someone_else' } });
      expect(r.status).toBe(409);
    }
    const rows = await env.DB.prepare('SELECT status, email FROM registration_disputes').all<{ status: string; email: string }>();
    expect(rows.results).toEqual([{ status: 'open', email: 'second@gmail.com' }]);
    // still able to sign up with the roll number that is really theirs
    const ok = await call(env, 'POST', '/api/signup/complete', { cookie, json: { ...base, username: 'someone_else', roll_number: '555', card: { barcode: '555' } } });
    expect(ok.status).toBe(201);
  });

  it('the same roll number at another campus is a different student', async () => {
    expect((await signup(env, 'first', base)).status).toBe(201);
    const other = await signup(env, 'second', { ...base, username: 'second_one', campus_id: CAMPUS_Y });
    expect(other.status).toBe(201);
  });

  it('simultaneous sign-ups with one roll number create exactly one account', async () => {
    const tickets = await Promise.all(Array.from({ length: 6 }, (_, i) => startSignup(env, { sub: `r${i}`, email: `r${i}@gmail.com` })));
    const results = await Promise.all(
      tickets.map((t, i) => call(env, 'POST', '/api/signup/complete', { cookie: t.cookie, json: { ...base, username: `racer_${i}` } }))
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(results.some((r) => r.status >= 500)).toBe(false);
    expect(await count(env, 'SELECT COUNT(*) AS n FROM users')).toBe(1);
    expect(await count(env, 'SELECT COUNT(*) AS n FROM registration_disputes')).toBe(5);
  });

  it('the database itself refuses a second row for the same student', async () => {
    await signup(env, 'first', base);
    const row = await env.DB.prepare('SELECT campus_key, roll_key FROM user_private').first<{ campus_key: string; roll_key: string }>();
    await env.DB.prepare("INSERT INTO users (id, provider_subject, created_at, status) VALUES ('usr_x', 'sub_x', 'now', 'active')").run();
    await expect(
      env.DB.prepare("INSERT INTO user_private (user_id, campus_key, roll_key) VALUES ('usr_x', ?, ?)").bind(row!.campus_key, row!.roll_key).run()
    ).rejects.toThrow(/unique/i);
  });

  it('a deleted account frees the roll number', async () => {
    await signup(env, 'first', base);
    await env.DB.prepare('DELETE FROM users').run();
    expect((await signup(env, 'again', { ...base, username: 'back_again' })).status).toBe(201);
  });

  it('too many tries from one Google account are slowed down, even with a fresh ticket each time', async () => {
    await signup(env, 'first', base);
    const statuses: number[] = [];
    for (let i = 0; i < 24; i++) statuses.push((await signup(env, 'guesser', { ...base, username: 'guess_user' })).status);
    expect(statuses.slice(0, 20).every((s) => s === 409)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429, 429, 429]);
  });
});

describe('roll key secret', () => {
  // The ticket comes from the development sign-in; the completing request is judged as production.
  async function inProduction(secret: string | undefined, sub: string) {
    const env = await makeEnv();
    await seedClassCampus(env);
    const { cookie } = await startSignup(env, { sub });
    const prod = { ...env, ENVIRONMENT: 'production', ROLL_KEY_SECRET: secret } as Env;
    const res = await call(prod, 'POST', '/api/signup/complete', { cookie, json: base });
    return { env, res };
  }

  it('production without ROLL_KEY_SECRET refuses sign-up instead of using a known key', async () => {
    const { env, res } = await inProduction(undefined, 'p');
    expect(res.status).toBe(503);
    expect(await count(env, 'SELECT COUNT(*) AS n FROM users')).toBe(0);
  });

  it('the stored key depends on the secret', async () => {
    const a = await inProduction('secret-one', 'p');
    const b = await inProduction('secret-two', 'p');
    expect(a.res.status).toBe(201);
    expect(b.res.status).toBe(201);
    const ka = (await a.env.DB.prepare('SELECT roll_key FROM user_private').first<{ roll_key: string }>())!.roll_key;
    const kb = (await b.env.DB.prepare('SELECT roll_key FROM user_private').first<{ roll_key: string }>())!.roll_key;
    expect(ka).not.toBe(kb);
  });
});
