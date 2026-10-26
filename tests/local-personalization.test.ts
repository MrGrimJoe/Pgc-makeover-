// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { LocalPersonalization, normalizeTag, type StorageLike } from '../src/feed-pipeline/LocalPersonalization.ts';
import { makePost, T0 } from './_pipeline.ts';

const DAY = 86_400_000;
let clock: { t: number };

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const make = (storage: StorageLike | null = memoryStorage(), userId = 'u1') =>
  new LocalPersonalization({ userId, storage, now: () => clock.t });
const ids = (ps: Array<{ id: string }>) => ps.map((p) => p.id);

beforeEach(() => {
  clock = { t: T0 };
});

describe('ranking with nothing learned yet', () => {
  it('prefers newer, better-liked and trending posts, in that blend', () => {
    const p = make();
    const old = makePost(1, { ageMin: 6 * 24 * 60, author: 'a' });
    const fresh = makePost(2, { ageMin: 5, author: 'b' });
    const liked = makePost(3, { ageMin: 6 * 24 * 60, likes: 40, author: 'c' });
    const hot = makePost(4, { ageMin: 6 * 24 * 60, trending: 0.5, author: 'd' });
    const ranked = ids(p.rank([old, liked, hot, fresh]));
    expect(ranked[0]).toBe(fresh.id);
    expect(ranked.at(-1)).toBe(old.id);
    expect(ranked.indexOf(hot.id)).toBeLessThan(ranked.indexOf(old.id));
    expect(ranked.indexOf(liked.id)).toBeLessThan(ranked.indexOf(old.id));
  });

  it('is deterministic and does not touch the input array', () => {
    const p = make();
    const input = [makePost(5), makePost(2), makePost(9), makePost(1)];
    const copy = [...input];
    const a = ids(p.rank(input));
    expect(input).toEqual(copy);
    expect(ids(p.rank([...input].reverse()))).toEqual(a);
  });

  it('handles an empty list', () => {
    expect(make().rank([])).toEqual([]);
  });
});

describe('learning from what the person does', () => {
  it('tag clicks lift posts with that tag above newer posts without it', () => {
    const p = make();
    const sports = makePost(40, { tags: ['sports'], author: 'a' }); // 40 minutes old
    const other = makePost(2, { tags: ['music'], author: 'b' });
    expect(ids(p.rank([sports, other]))[0]).toBe(other.id); // before: newer wins
    p.recordTagClick('#Sports');
    p.recordTagClick('sports');
    expect(ids(p.rank([sports, other]))[0]).toBe(sports.id);
  });

  it.each(['show_less', 'not_interested'] as const)('%s pushes a tag down, even for a very new post', (kind) => {
    const p = make();
    const meme = makePost(1, { tags: ['memes'], author: 'a' });
    const plain = makePost(300, { tags: [], author: 'b' });
    expect(ids(p.rank([meme, plain]))[0]).toBe(meme.id);
    p.recordInteraction(meme, kind);
    expect(p.getTagWeights().memes).toBeLessThan(0);
    expect(ids(p.rank([meme, plain]))[0]).toBe(plain.id);
  });

  it('views under 3 seconds teach nothing; longer views teach more', () => {
    const p = make();
    const post = makePost(1, { tags: ['exams'] });
    p.recordView(post, 2999);
    expect(p.getTagWeights()).toEqual({});
    p.recordView(post, 3000);
    const short = p.getTagWeights().exams!;
    p.recordView(makePost(2, { tags: ['labs'] }), 15_000);
    const long = p.getTagWeights().labs!;
    expect(short).toBeCloseTo(0.1, 2);
    expect(long).toBeCloseTo(0.6, 2);
  });

  it('uses the same steps as the server for likes and comments, and clamps the total', () => {
    const p = make();
    const post = makePost(1, { tags: ['a'] });
    p.recordInteraction(post, 'like');
    p.recordInteraction(post, 'comment');
    expect(p.getTagWeights().a).toBe(4);
    for (let i = 0; i < 20; i++) p.recordInteraction(post, 'more_like_this');
    expect(p.getTagWeights().a).toBe(25);
    for (let i = 0; i < 20; i++) p.recordInteraction(post, 'not_interested');
    expect(p.getTagWeights().a).toBe(-10);
  });

  it('forgets over time: a preference halves after 14 days', () => {
    const p = make();
    p.recordTagClick('sports');
    const before = p.getTagWeights().sports!;
    clock.t += 14 * DAY;
    expect(p.getTagWeights().sports!).toBeCloseTo(before / 2, 2);
    clock.t += 14 * DAY;
    expect(p.getTagWeights().sports!).toBeCloseTo(before / 4, 2);
  });

  it('ignores empty or absurd tags and keeps at most 200', () => {
    const p = make();
    p.recordTagClick('   ');
    p.recordTagClick('#');
    p.recordTagClick('x'.repeat(41));
    expect(p.getTagWeights()).toEqual({});
    expect(normalizeTag(' #Hello ')).toBe('hello');
    for (let i = 0; i < 230; i++) p.recordTagClick(`tag${i}`);
    expect(Object.keys(p.getTagWeights()).length).toBeLessThanOrEqual(200);
  });
});

describe('trending, seen posts and variety', () => {
  it('the batch\'s trending weights lift matching posts without any server call', () => {
    const p = make();
    const a = makePost(30, { tags: ['election'], author: 'a' });
    const b = makePost(10, { tags: ['lunch'], author: 'b' });
    expect(ids(p.rank([a, b]))[0]).toBe(b.id);
    expect(ids(p.rank([a, b], { trending: { election: 1 } }))[0]).toBe(a.id);
  });

  it('sinks posts that were already seen', () => {
    const p = make();
    const seen = makePost(1, { author: 'a' });
    const unseen = makePost(60, { author: 'b' });
    expect(ids(p.rank([seen, unseen]))[0]).toBe(seen.id);
    expect(ids(p.rank([seen, unseen], { seen: new Set([seen.id]) }))[0]).toBe(unseen.id);
  });

  it('does not let one author fill slots in a row while other authors are available', () => {
    const p = make();
    const loud = [1, 2, 3, 4, 5].map((n) => makePost(n, { author: 'loud' }));
    const quiet = [6, 7].map((n) => makePost(n, { author: `q${n}` }));
    const raw = [...loud, ...quiet].sort((a, b) => b.meta.timestamp - a.meta.timestamp).map((x) => x.author_id);
    expect(raw.slice(0, 3)).toEqual(['loud', 'loud', 'loud']); // without the pass, the loud author owns the top
    const order = p.rank([...loud, ...quiet]).map((x) => x.author_id);
    expect(order.slice(0, 3).filter((a) => a === 'loud')).toHaveLength(1);
    expect(order).toHaveLength(7); // nothing dropped
    expect(new Set(ids(p.rank([...loud, ...quiet]))).size).toBe(7);
  });

  it('explains its score', () => {
    const p = make();
    p.recordTagClick('sports');
    const [entry] = p.rankWithScores([makePost(1, { tags: ['sports'], likes: 5 })]);
    expect(entry!.score.preference).toBeGreaterThan(0);
    expect(entry!.score.total).toBeCloseTo(
      0.4 * entry!.score.preference + 0.25 * entry!.score.trending + 0.2 * entry!.score.recency + 0.15 * entry!.score.engagement,
      6,
    );
  });
});

describe('local storage', () => {
  it('survives a reload', () => {
    const storage = memoryStorage();
    make(storage).recordTagClick('sports');
    expect(make(storage).getTagWeights().sports).toBe(1.5);
  });

  it('two accounts on one phone never share preferences, and reset only clears one', () => {
    const storage = memoryStorage();
    const alice = make(storage, 'alice');
    const bob = make(storage, 'bob');
    alice.recordTagClick('sports');
    expect(bob.getTagWeights()).toEqual({});
    bob.recordTagClick('music');
    alice.reset();
    expect(make(storage, 'alice').getTagWeights()).toEqual({});
    expect(make(storage, 'bob').getTagWeights().music).toBe(1.5);
  });

  it('starts clean on a corrupt or foreign entry', () => {
    for (const junk of ['{not json', '{"v":2,"tags":{}}', '{"v":1,"tags":"x"}', '{"v":1,"tags":{"a":["x",1]}}', 'null']) {
      const storage = memoryStorage();
      storage.data.set('pgc:feed-prefs:v1:u1', junk);
      expect(make(storage).getTagWeights()).toEqual({});
    }
  });

  it('keeps working when storage throws (private mode, quota)', () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    const p = make(broken);
    p.recordTagClick('sports');
    expect(p.getTagWeights().sports).toBe(1.5); // still learns for this session
    expect(() => p.reset()).not.toThrow();
  });

  it('works with no storage at all, and uses real localStorage by default', () => {
    expect(() => make(null).recordTagClick('a')).not.toThrow();
    localStorage.clear();
    const p = new LocalPersonalization({ userId: 'real', now: () => clock.t });
    p.recordTagClick('sports');
    expect(localStorage.getItem('pgc:feed-prefs:v1:real')).toContain('sports');
  });
});
