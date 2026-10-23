import { describe, it, expect, beforeEach } from 'vitest';
import { makeEnv, call, seedUser } from './_helpers.ts';
import { assessSpam, POST_LIMIT_MAX, SPAM_LOCK_MS } from '../worker/content/spam.ts';
import type { Env } from '../worker/types.ts';

const SPAMMY = 'FREE MONEY!!! click here https://win.xyz and https://cash.top whatsapp +923001234567';

describe('assessSpam', () => {
  it('lets ordinary posts through, including one link, shouting, short repeats and Roman Urdu', () => {
    const fine = [
      'Anyone have the notes for chapter 4? Exam is on Monday.',
      'Check this out https://example.com it helped me a lot',
      'GO TEAM!!!',
      'haha yes yes yes yes',
      'Kal ka test bohat mushkil tha, kisi ko answer key mili?',
      'Selling my old calculator, message me in class tomorrow',
      'See https://a.com and https://b.com for the two options',
    ];
    for (const t of fine) expect(assessSpam(t).spam, t).toBe(false);
  });

  it('flags typical spam and reports which signals fired', () => {
    const v = assessSpam(SPAMMY);
    expect(v.spam).toBe(true);
    expect(v.signals).toEqual(expect.arrayContaining(['several_links', 'promo_phrase', 'contact_bait']));
    expect(assessSpam('buy now buy now buy now buy now buy now buy now buy now buy now').spam).toBe(true);
    expect(assessSpam('free money https://x.top').spam).toBe(true); // promo phrase + a link
    expect(assessSpam('Lunch?', { duplicateOfRecent: true }).spam).toBe(true); // the duplicate signal alone is enough
  });

  it('one signal alone is not enough (the threshold is real)', () => {
    expect(assessSpam('free money').spam).toBe(false);
    expect(assessSpam('visit https://example.com').spam).toBe(false);
    expect(assessSpam('aaaaaaaaaaaaaaaaaaaa').spam).toBe(false);
  });
});

describe('posting rules', () => {
  let env: Env;
  let alice: string;
  const post = (json: unknown, cookie = alice) => call(env, 'POST', '/api/posts', { cookie, json });
  const normal = (i: number) => post({ body: `A normal thought, number ${i}, about nothing in particular` });
  const strikes = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM spam_strikes WHERE user_id = ?').bind('usr_alice').first<{ n: number }>())!.n;
  const clear = () => env.DB.prepare("DELETE FROM rate_limits WHERE key LIKE 'post:%'").run();

  beforeEach(async () => {
    env = await makeEnv();
    alice = await seedUser(env, 'usr_alice', 'alice');
  });

  it('allows 3 posts per 15 minutes and refuses the 4th with Retry-After', async () => {
    expect(POST_LIMIT_MAX).toBe(3);
    for (let i = 0; i < 3; i++) expect((await normal(i)).status).toBe(201);
    const fourth = await normal(3);
    expect(fourth.status).toBe(429);
    expect(fourth.json.error).toContain('3 posts per 15 minutes');
    expect(Number(fourth.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(Number(fourth.headers.get('Retry-After'))).toBeLessThanOrEqual(15 * 60);
  });

  it('rejected attempts do not use up the limit (bad poll, bad body, spam)', async () => {
    for (let i = 0; i < 5; i++) expect((await post({ body: 'q', poll: { options: ['only one'] } })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ body: SPAMMY })).status).toBe(422);
    for (let i = 0; i < 3; i++) expect((await normal(i)).status, `valid post ${i}`).toBe(201);
    expect((await normal(9)).status).toBe(429);
  });

  it('a spam-looking post is refused with 422 and recorded as a strike, not published', async () => {
    const res = await post({ body: SPAMMY });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe('spam');
    expect(await strikes()).toBe(1);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM posts').first<{ n: number }>())!.n).toBe(0);
  });

  it('the same long post twice is treated as spam; short repeats are fine', async () => {
    const text = 'This is a perfectly ordinary sentence about lunch today';
    expect((await post({ body: text })).status).toBe(201);
    expect((await post({ body: `  ${text.toUpperCase()}  ` })).status).toBe(422);
    expect((await post({ body: 'Lunch?' })).status).toBe(201);
    await clear();
    expect((await post({ body: 'Lunch?' })).status).toBe(201);
  });

  it('spam in the poll options counts too', async () => {
    const res = await post({ body: 'Vote please', poll: { options: ['free money click here', 'https://win.xyz whatsapp me'] } });
    expect(res.status).toBe(422);
  });

  it('three spam attempts in a row lock posting for 3 days, even for normal posts', async () => {
    expect((await post({ body: SPAMMY })).status).toBe(422);
    expect((await post({ body: SPAMMY })).status).toBe(422);
    const third = await post({ body: SPAMMY });
    expect(third.status).toBe(403);
    expect(third.json.code).toBe('spam_locked');
    const until = Date.parse(third.json.locked_until);
    expect(until - Date.now()).toBeGreaterThan(SPAM_LOCK_MS - 60_000);
    expect(until - Date.now()).toBeLessThanOrEqual(SPAM_LOCK_MS);

    const normalNow = await normal(1);
    expect(normalNow.status).toBe(403);
    expect(Number(normalNow.headers.get('Retry-After'))).toBeGreaterThan(2 * 24 * 3600);
    expect(await strikes()).toBe(3); // a locked person adds no more strikes
    // someone else is not affected
    const bob = await seedUser(env, 'usr_bob', 'bob');
    expect((await post({ body: 'Hello from bob, a normal post here' }, bob)).status).toBe(201);
  });

  it('the lock ends after 3 days by itself', async () => {
    for (let i = 0; i < 3; i++) await post({ body: SPAMMY });
    expect((await normal(1)).status).toBe(403);
    const past = new Date(Date.now() - SPAM_LOCK_MS - 60_000).toISOString();
    await env.DB.prepare('UPDATE spam_strikes SET created_at = ? WHERE user_id = ?').bind(past, 'usr_alice').run();
    expect((await normal(2)).status).toBe(201);
  });

  it('a normal post in between clears the streak (2 spam, 1 normal, 2 spam is not a lock)', async () => {
    expect((await post({ body: SPAMMY })).status).toBe(422);
    expect((await post({ body: SPAMMY })).status).toBe(422);
    await new Promise((r) => setTimeout(r, 5)); // strikes must be older than the post
    expect((await normal(1)).status).toBe(201);
    expect((await post({ body: SPAMMY })).status).toBe(422);
    expect((await post({ body: SPAMMY })).status).toBe(422);
    expect((await normal(2)).status).toBe(201); // still not locked: only 2 strikes since the last post
  });

  it('strikes are removed with the account', async () => {
    await post({ body: SPAMMY });
    expect(await strikes()).toBe(1);
    expect((await call(env, 'DELETE', '/api/me', { cookie: alice })).status).toBe(200);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM spam_strikes').first<{ n: number }>())!.n).toBe(0);
  });
});
