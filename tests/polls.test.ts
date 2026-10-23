import { describe, it, expect, beforeEach } from 'vitest';
import { makeEnv, call, seedUser, uploadPng, deepKeys } from './_helpers.ts';
import { hydratePolls } from '../worker/polls.ts';
import { checkPollOptions, POLL_OPTION_MAX } from '../shared/poll.ts';
import type { Env } from '../worker/types.ts';

const KEY = 'app:test/1';

describe('Polls on posts', () => {
  let env: Env;
  let alice: string; // author
  let bob: string;
  let carol: string;

  // The 10-posts-per-hour limit is not what these tests are about
  const resetPostLimit = () => env.DB.prepare("DELETE FROM rate_limits WHERE key LIKE 'post:%'").run();
  const makePoll = async (options: string[] = ['Pizza', 'Biryani', 'Burgers'], body = 'Lunch?') => {
    await resetPostLimit();
    const res = await call(env, 'POST', '/api/posts', { cookie: alice, json: { body, poll: { options } } });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return res.json as { id: string; poll: { options: { id: string; text: string; votes?: number }[]; my_vote: string | null; total_votes?: number; closed: boolean } };
  };
  const vote = (cookie: string, postId: string, optionId: string) =>
    call(env, 'PUT', `/api/posts/${postId}/poll/vote`, { cookie, json: { option_id: optionId } });
  const voteRows = async (postId: string) =>
    (await env.DB.prepare('SELECT COUNT(*) AS n FROM poll_votes WHERE poll_id = ?').bind(postId).first<{ n: number }>())!.n;
  const feedPosts = (r: { json: any }): any[] => r.json.items ?? r.json.posts ?? r.json.results ?? [];

  beforeEach(async () => {
    env = await makeEnv();
    alice = await seedUser(env, 'usr_alice', 'alice');
    bob = await seedUser(env, 'usr_bob', 'bob');
    carol = await seedUser(env, 'usr_carol', 'carol');
  });

  describe('creating', () => {
    it('accepts 2 to 6 options of 1 to 60 characters (positive controls) and returns the poll with zero counts to the author', async () => {
      const two = await makePoll(['Yes', 'No']);
      expect(two.poll.options.map((o) => o.text)).toEqual(['Yes', 'No']);
      expect(two.poll.options.every((o) => o.votes === 0)).toBe(true);
      expect(two.poll.my_vote).toBeNull();
      expect(two.poll.total_votes).toBe(0);
      expect(two.poll.closed).toBe(false);
      const six = await makePoll(['a', 'b', 'c', 'd', 'e', 'x'.repeat(POLL_OPTION_MAX)]);
      expect(six.poll.options).toHaveLength(6);
    });

    it('rejects too few, too many, empty, over-long, markup, duplicate and non-string options', async () => {
      const bad: unknown[] = [
        ['only one'],
        [],
        ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
        ['ok', '   '],
        ['ok', 'x'.repeat(POLL_OPTION_MAX + 1)],
        ['ok', '<b>bold</b>'],
        ['Same', ' same '],
        ['ok', 42],
        'Pizza,Biryani',
        { 0: 'a', 1: 'b' },
      ];
      for (const options of bad) {
        await resetPostLimit();
        const res = await call(env, 'POST', '/api/posts', { cookie: alice, json: { body: 'q', poll: { options } } });
        expect(res.status, JSON.stringify(options)).toBe(400);
      }
      // unknown keys inside poll are refused too
      await resetPostLimit();
      expect((await call(env, 'POST', '/api/posts', { cookie: alice, json: { body: 'q', poll: { options: ['a', 'b'], multiple: true } } })).status).toBe(400);
      expect((await call(env, 'GET', '/api/feed?author=alice', { cookie: alice })).json).toBeTruthy();
      const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM polls').first<{ n: number }>();
      expect(rows!.n).toBe(0);
    });

    it('cleans option text like other text (whitespace collapsed, invisible characters removed)', async () => {
      const p = await makePoll(['  Pizza \n  time ', 'Bir\u200Byani']);
      expect(p.poll.options.map((o) => o.text)).toEqual(['Pizza time', 'Biryani']);
    });

    it('a post carries one of photos, a poll or a sticker, never a mix', async () => {
      const photo = await uploadPng(env, alice);
      const base = { body: 'q', poll: { options: ['a', 'b'] } };
      expect((await call(env, 'POST', '/api/posts', { cookie: alice, json: { ...base, media_ids: [photo] } })).status).toBe(400);
      expect((await call(env, 'POST', '/api/posts', { cookie: alice, json: { ...base, sticker_key: KEY } })).status).toBe(400);
      expect((await call(env, 'POST', '/api/posts', { cookie: alice, json: base })).status).toBe(201);
    });

    it('shared option rules match what the server enforces', () => {
      expect(checkPollOptions(['a', 'b']).ok).toBe(true);
      expect(checkPollOptions(['a']).ok).toBe(false);
    });
  });

  describe('voting', () => {
    it('one vote per account: voting again changes the vote and never adds a row', async () => {
      const p = await makePoll();
      const [pizza, biryani] = p.poll.options;
      const first = await vote(bob, p.id, pizza!.id);
      expect(first.status).toBe(200);
      expect(first.json.poll.my_vote).toBe(pizza!.id);
      expect(await voteRows(p.id)).toBe(1);

      const second = await vote(bob, p.id, biryani!.id);
      expect(second.json.poll.my_vote).toBe(biryani!.id);
      expect(await voteRows(p.id)).toBe(1);
      const counts = Object.fromEntries(second.json.poll.options.map((o: any) => [o.text, o.votes]));
      expect(counts).toEqual({ Pizza: 0, Biryani: 1, Burgers: 0 });
      expect(second.json.poll.total_votes).toBe(1);
    });

    it('parallel votes from one account end as exactly one row', async () => {
      const p = await makePoll();
      const results = await Promise.all(p.poll.options.flatMap((o) => [vote(bob, p.id, o.id), vote(bob, p.id, o.id)]));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(await voteRows(p.id)).toBe(1);
      // positive control: different accounts each get their own row
      await Promise.all([vote(carol, p.id, p.poll.options[0]!.id), vote(alice, p.id, p.poll.options[1]!.id)]);
      expect(await voteRows(p.id)).toBe(3);
    });

    it('rejects an option from another poll, an unknown option, a post without a poll and bad bodies', async () => {
      const a = await makePoll(['A1', 'A2']);
      const b = await makePoll(['B1', 'B2']);
      expect((await vote(bob, a.id, b.poll.options[0]!.id)).status).toBe(400);
      expect((await vote(bob, a.id, 'opt_missing')).status).toBe(400);
      const plain = await call(env, 'POST', '/api/posts', { cookie: alice, json: { body: 'no poll' } });
      expect((await vote(bob, plain.json.id, a.poll.options[0]!.id)).status).toBe(404);
      expect((await vote(bob, 'pst_missing', a.poll.options[0]!.id)).status).toBe(404);
      expect((await call(env, 'PUT', `/api/posts/${a.id}/poll/vote`, { cookie: bob, json: {} })).status).toBe(400);
      expect((await call(env, 'PUT', `/api/posts/${a.id}/poll/vote`, { cookie: bob, json: { option_id: 'x', extra: 1 } })).status).toBe(400);
      expect((await call(env, 'PUT', `/api/posts/${a.id}/poll/vote`, { cookie: bob, raw: 'not json' })).status).toBe(400);
      expect(await voteRows(a.id)).toBe(0);
      // positive control
      expect((await vote(bob, a.id, a.poll.options[0]!.id)).status).toBe(200);
    });

    it('needs a signed-in caller', async () => {
      const p = await makePoll();
      expect((await call(env, 'PUT', `/api/posts/${p.id}/poll/vote`, { json: { option_id: p.poll.options[0]!.id } })).status).toBe(401);
    });

    it('blocked pairs cannot vote on each other\'s polls, in either direction', async () => {
      const mine = await makePoll(['A', 'B']);
      const bobPoll = await call(env, 'POST', '/api/posts', { cookie: bob, json: { body: 'bob q', poll: { options: ['X', 'Y'] } } });
      expect((await vote(bob, mine.id, mine.poll.options[0]!.id)).status).toBe(200); // positive control before the block
      await call(env, 'POST', '/api/blocks/usr_bob', { cookie: alice, json: { user_id: 'usr_bob' } });
      expect((await vote(bob, mine.id, mine.poll.options[1]!.id)).status).toBe(404);
      expect((await vote(alice, bobPoll.json.id, bobPoll.json.poll.options[0].id)).status).toBe(404);
      // the old vote did not change
      expect((await env.DB.prepare('SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?').bind(mine.id, 'usr_bob').first<{ option_id: string }>())!.option_id).toBe(mine.poll.options[0]!.id);
      // someone not blocked is unaffected
      expect((await vote(carol, mine.id, mine.poll.options[0]!.id)).status).toBe(200);
    });

    it('a poll closes when its post expires (positive control: open before)', async () => {
      const p = await makePoll();
      expect((await vote(bob, p.id, p.poll.options[0]!.id)).status).toBe(200);
      await env.DB.prepare('UPDATE posts SET expires_at = ? WHERE id = ?').bind(new Date(Date.now() - 1000).toISOString(), p.id).run();
      const late = await vote(bob, p.id, p.poll.options[1]!.id);
      expect(late.status).toBe(409);
      expect(await voteRows(p.id)).toBe(1);
      expect((await env.DB.prepare('SELECT option_id FROM poll_votes WHERE poll_id = ?').bind(p.id).first<{ option_id: string }>())!.option_id).toBe(p.poll.options[0]!.id);
    });

    it('rate limits votes (60 per hour) and tells the caller when to retry', async () => {
      const p = await makePoll(['A', 'B']);
      let last = 200;
      for (let i = 0; i < 60; i++) last = (await vote(bob, p.id, p.poll.options[i % 2]!.id)).status;
      expect(last).toBe(200);
      const over = await vote(bob, p.id, p.poll.options[0]!.id);
      expect(over.status).toBe(429);
      expect(over.headers.get('Retry-After')).toBeTruthy();
      // someone else is not affected
      expect((await vote(carol, p.id, p.poll.options[0]!.id)).status).toBe(200);
    });
  });

  describe('who sees the counts', () => {
    it('hidden until the viewer votes, in the single read, the feed, the profile grid and search', async () => {
      const p = await makePoll(['Pizza', 'Biryani']);
      expect((await call(env, 'POST', '/api/users/alice/follow', { cookie: bob })).status).toBeLessThan(300);
      await vote(carol, p.id, p.poll.options[0]!.id); // a vote exists, so there is something to hide

      const check = (poll: any, voted: boolean) => {
        expect(poll.options.map((o: any) => o.text)).toEqual(['Pizza', 'Biryani']);
        expect(poll.options.every((o: any) => ('votes' in o) === voted)).toBe(true);
        expect('total_votes' in poll).toBe(voted);
      };

      const one = await call(env, 'GET', `/api/posts/${p.id}`, { cookie: bob });
      check(one.json.poll, false);
      expect(one.json.poll.my_vote).toBeNull();
      const raw = JSON.stringify(one.json.poll);
      expect(raw).not.toMatch(/votes/);

      const surfaces = [
        feedPosts(await call(env, 'GET', '/api/feed?mode=following', { cookie: bob })),
        feedPosts(await call(env, 'GET', '/api/feed?author=alice', { cookie: bob })),
        feedPosts(await call(env, 'GET', '/api/search?q=Lunch', { cookie: bob })),
      ];
      for (const [i, list] of surfaces.entries()) {
        const found = list.find((x) => x.id === p.id);
        expect(found, `surface ${i} lists the poll post (positive control)`).toBeTruthy();
        check(found.poll, false);
      }

      // after voting, the same reads include the counts
      await vote(bob, p.id, p.poll.options[1]!.id);
      const after = await call(env, 'GET', `/api/posts/${p.id}`, { cookie: bob });
      check(after.json.poll, true);
      expect(after.json.poll.total_votes).toBe(2);
      expect(after.json.poll.my_vote).toBe(p.poll.options[1]!.id);
      const afterFeed = feedPosts(await call(env, 'GET', '/api/feed?author=alice', { cookie: bob })).find((x) => x.id === p.id);
      check(afterFeed.poll, true);
    });

    it('the author sees counts without voting; another non-voter still does not', async () => {
      const p = await makePoll(['Pizza', 'Biryani']);
      await vote(bob, p.id, p.poll.options[0]!.id);
      const asAuthor = await call(env, 'GET', `/api/posts/${p.id}`, { cookie: alice });
      expect(asAuthor.json.poll.total_votes).toBe(1);
      expect(asAuthor.json.poll.my_vote).toBeNull();
      const asCarol = await call(env, 'GET', `/api/posts/${p.id}`, { cookie: carol });
      expect('total_votes' in asCarol.json.poll).toBe(false);
    });

    it('never exposes who voted', async () => {
      const p = await makePoll();
      await vote(bob, p.id, p.poll.options[0]!.id);
      for (const cookie of [alice, bob, carol]) {
        const keys = deepKeys((await call(env, 'GET', `/api/posts/${p.id}`, { cookie })).json);
        for (const forbidden of ['voter', 'voters', 'user_id', 'voted_at']) expect(keys.has(forbidden), forbidden).toBe(false);
      }
    });

    it('posts without a poll return poll: null, and a closed poll says so', async () => {
      const plain = await call(env, 'POST', '/api/posts', { cookie: alice, json: { body: 'no poll' } });
      expect((await call(env, 'GET', `/api/posts/${plain.json.id}`, { cookie: bob })).json.poll).toBeNull();
      const p = await makePoll();
      await env.DB.prepare('UPDATE posts SET expires_at = ? WHERE id = ?').bind(new Date(Date.now() - 1000).toISOString(), p.id).run();
      const open = await call(env, 'GET', `/api/posts/${p.id}`, { cookie: carol });
      // an expired post may already be hidden from reads; when it is still readable, the poll must say it is closed
      if (open.status === 200) expect(open.json.poll.closed).toBe(true);
    });
  });

  describe('hydration', () => {
    it('uses the same number of queries for 1 poll and for 20 polls (no N+1)', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) ids.push((await makePoll(['a', 'b'], `q${i}`)).id);
      await vote(bob, ids[0]!, (await env.DB.prepare('SELECT id FROM poll_options WHERE poll_id = ?').bind(ids[0]).first<{ id: string }>())!.id);

      let queries = 0;
      const counting = new Proxy(env.DB, {
        get(target, prop, receiver) {
          if (prop === 'prepare') return (sql: string) => { queries++; return target.prepare(sql); };
          return Reflect.get(target, prop, receiver);
        },
      }) as D1Database;
      const ref = (id: string) => ({ id, author_id: 'usr_alice', expires_at: new Date(Date.now() + 86_400_000).toISOString(), status: 'active' });

      const one = await hydratePolls(counting, ids.slice(0, 1).map(ref), 'usr_bob');
      const oneCount = queries;
      queries = 0;
      const many = await hydratePolls(counting, ids.map(ref), 'usr_bob');
      expect(many.size).toBe(20);
      expect(one.size).toBe(1);
      expect(queries).toBe(oneCount);
      expect(oneCount).toBeLessThanOrEqual(3);
      // positive control: the counter does count (a loop of single hydrations scales with the page)
      queries = 0;
      for (const id of ids.slice(0, 5)) await hydratePolls(counting, [ref(id)], 'usr_bob');
      // two queries each for polls the viewer has not voted on (no counts are read), so it grows with the page
      expect(queries).toBeGreaterThanOrEqual(2 * 5);
      expect(queries).toBeGreaterThan(oneCount);
    });

    it('a post without polls costs one query', async () => {
      let queries = 0;
      const counting = new Proxy(env.DB, {
        get(target, prop, receiver) {
          if (prop === 'prepare') return (sql: string) => { queries++; return target.prepare(sql); };
          return Reflect.get(target, prop, receiver);
        },
      }) as D1Database;
      const plain = await call(env, 'POST', '/api/posts', { cookie: alice, json: { body: 'x' } });
      const got = await hydratePolls(counting, [{ id: plain.json.id, author_id: 'usr_alice', expires_at: new Date(Date.now() + 1e6).toISOString(), status: 'active' }], 'usr_bob');
      expect(got.size).toBe(0);
      expect(queries).toBe(1);
    });
  });

  describe('lifecycle', () => {
    it('deleting an account removes that person\'s votes (counts drop) and the polls on their posts', async () => {
      const p = await makePoll(['A', 'B']);
      await vote(bob, p.id, p.poll.options[0]!.id);
      await vote(carol, p.id, p.poll.options[0]!.id);
      expect(await voteRows(p.id)).toBe(2);
      expect((await call(env, 'DELETE', '/api/me', { cookie: bob })).status).toBe(200);
      expect(await voteRows(p.id)).toBe(1);
      const asAuthor = await call(env, 'GET', `/api/posts/${p.id}`, { cookie: alice });
      expect(asAuthor.json.poll.total_votes).toBe(1);

      expect((await call(env, 'DELETE', '/api/me', { cookie: alice })).status).toBe(200);
      for (const table of ['polls', 'poll_options', 'poll_votes']) {
        expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n, table).toBe(0);
      }
    });

    it('deleting the post removes its poll rows (cascade)', async () => {
      const p = await makePoll();
      await vote(bob, p.id, p.poll.options[0]!.id);
      await env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(p.id).run();
      for (const table of ['polls', 'poll_options', 'poll_votes']) {
        expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n, table).toBe(0);
      }
    });
  });
});
