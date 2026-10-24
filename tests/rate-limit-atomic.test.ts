import { describe, it, expect } from 'vitest';
import { checkRateLimit } from '../worker/rate-limit.ts';
import { makeEnv } from './_helpers.ts';

describe('checkRateLimit', () => {
  it('lets exactly `max` of 40 simultaneous requests through', async () => {
    const env = await makeEnv({});
    const results = await Promise.all(Array.from({ length: 40 }, () => checkRateLimit(env.DB, 'burst:test', 10, 60_000)));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(results.filter((r) => !r.allowed).every((r) => r.retryAfterSeconds >= 1)).toBe(true);
  });

  it('a denied request is not counted, and keys do not share a budget', async () => {
    const env = await makeEnv({});
    for (let i = 0; i < 3; i++) await checkRateLimit(env.DB, 'a', 3, 60_000);
    expect((await checkRateLimit(env.DB, 'a', 3, 60_000)).allowed).toBe(false);
    const row = await env.DB.prepare("SELECT count FROM rate_limits WHERE key = 'a'").first<{ count: number }>();
    expect(row?.count).toBe(3);
    expect((await checkRateLimit(env.DB, 'b', 3, 60_000)).allowed).toBe(true);
  });

  it('a limit below 1 always denies', async () => {
    const env = await makeEnv({});
    expect((await checkRateLimit(env.DB, 'zero', 0, 60_000)).allowed).toBe(false);
  });
});
