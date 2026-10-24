import { describe, it, expect } from 'vitest';
import {
  FeedFrameManager,
  createPooledSource,
  cycleLayout,
  DEFAULT_LAYOUT,
  type FeedSource,
  type Frame,
  type ModerationState,
} from '../src/feed-engine/index.ts';

interface Item { id: string; kind: ModerationState }

/** Infinite source, or one capped per state. */
function source(caps: Partial<Record<ModerationState, number>> = {}, delayMs = 0): FeedSource<Item> {
  const served: Record<ModerationState, number> = { SAFE: 0, WILD: 0 };
  return {
    async load(kind, limit) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const cap = caps[kind] ?? Infinity;
      const n = Math.max(0, Math.min(limit, cap - served[kind]));
      const items = Array.from({ length: n }, (_, i) => ({ id: `${kind}-${served[kind] + i}`, kind }));
      served[kind] += n;
      return { items, done: served[kind] >= cap };
    },
  };
}

const kinds = (m: FeedFrameManager<Item>) => m.getMountedFrames().map((f) => f.kind);
const indexes = (m: FeedFrameManager<Item>) => m.getMountedFrames().map((f) => f.index);

describe('layout', () => {
  it('puts a Mid-Frame after every two SAFE frames, then a WILD frame', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(DEFAULT_LAYOUT)).toEqual(['SAFE', 'SAFE', 'MID', 'WILD', 'SAFE', 'SAFE', 'MID', 'WILD']);
  });
  it('rejects an empty pattern', () => {
    expect(() => cycleLayout([])).toThrow(RangeError);
  });
});

describe('FeedFrameManager', () => {
  it('only holds SAFE items in SAFE frames and WILD items in WILD frames', async () => {
    const m = new FeedFrameManager<Item>({ source: source(), frameSize: 5 });
    const created: Frame<Item>[] = [];
    m.on('frameCreated', ({ frame }) => created.push(frame));
    await m.focus(8);
    expect(created.length).toBeGreaterThan(8);
    for (const f of created) {
      if (f.kind === 'MID') expect(f.items).toHaveLength(0);
      else {
        expect(f.items).toHaveLength(5);
        expect(f.items.every((i) => i.kind === f.kind)).toBe(true);
      }
    }
  });

  it('never exceeds the window, and never has a volatile frame beside a WILD frame, scrolling down then up', async () => {
    const m = new FeedFrameManager<Item>({ source: source() });
    const check = () => {
      const frames = m.getMountedFrames();
      expect(frames.length).toBeLessThanOrEqual(3);
      if (frames.some((f) => f.kind === 'WILD')) expect(frames.some((f) => m.isVolatile(f))).toBe(false);
    };
    m.subscribe(check);
    for (let i = 0; i <= 16; i++) { await m.focus(i); check(); }
    for (let i = 15; i >= 0; i--) { await m.focus(i); check(); }
  });

  it('removes the Mid-Frame before the WILD frame mounts (down) and the WILD frame before the Mid-Frame (up)', async () => {
    const m = new FeedFrameManager<Item>({ source: source() });
    const log: string[] = [];
    m.onFrameMount(({ frame }) => log.push(`+${frame.kind}${frame.index}`));
    m.onFrameUnmount(({ frame, reason }) => log.push(`-${frame.kind}${frame.index}:${reason}`));
    await m.focus(2); // SAFE SAFE [MID]
    await m.focus(3); // WILD arrives
    expect(log.indexOf('-MID2:pre-wild')).toBeGreaterThan(-1);
    expect(log.indexOf('-MID2:pre-wild')).toBeLessThan(log.indexOf('+WILD3'));
    log.length = 0;
    await m.focus(2); // back onto the Mid-Frame: WILD must leave first
    expect(log.indexOf('-WILD3:conflict')).toBeGreaterThan(-1);
    expect(log.indexOf('-WILD3:conflict')).toBeLessThan(log.indexOf('+MID2'));
  });

  it('keeps the focused Mid-Frame mounted and defers the WILD neighbour', async () => {
    const m = new FeedFrameManager<Item>({ source: source() });
    await m.focus(2);
    expect(kinds(m)).toEqual(['SAFE', 'MID']);
    expect(indexes(m)).toEqual([1, 2]);
  });

  it('advance() moves past a Mid-Frame onto the deferred WILD frame, and retreat() comes back', async () => {
    const m = new FeedFrameManager<Item>({ source: source() });
    await m.focus(2);
    expect(kinds(m)).toEqual(['SAFE', 'MID']); // WILD 3 held back, nothing below to scroll onto
    await m.advance();
    expect(m.getFocusIndex()).toBe(3);
    expect(kinds(m)).toEqual(['WILD', 'SAFE']);
    await m.retreat();
    expect(m.getFocusIndex()).toBe(2);
    expect(kinds(m)).toEqual(['SAFE', 'MID']);
  });

  it('advance() and retreat() do nothing while a neighbour is already mounted or at the start', async () => {
    const m = new FeedFrameManager<Item>({ source: source() });
    await m.focus(0);
    await m.retreat();
    expect(m.getFocusIndex()).toBe(0);
    await m.advance(); // frame 1 is already mounted ahead
    expect(m.getFocusIndex()).toBe(0);
  });

  it('rebuilds the exact same frame when scrolling back', async () => {
    const m = new FeedFrameManager<Item>({ source: source() });
    await m.focus(0);
    const first = m.getMountedFrames()[0];
    for (let i = 1; i <= 9; i++) await m.focus(i);
    expect(indexes(m)).not.toContain(0);
    for (let i = 8; i >= 0; i--) await m.focus(i);
    expect(m.getMountedFrames()[0]).toBe(first);
  });

  it('emits onMidFrameReached, including Mid-Frames scrolled past without landing', async () => {
    const m = new FeedFrameManager<Item>({ source: source() });
    const seen: string[] = [];
    m.onMidFrameReached(({ frame, landed }) => seen.push(`${frame.index}:${landed}`));
    await m.focus(0);
    await m.focus(2); // lands on MID 2
    await m.focus(8); // jumps over MID 6 and lands on SAFE 8
    expect(seen).toEqual(['2:true', '6:false']);
  });

  it('skips an exhausted kind instead of ending the feed, and never ends on a Mid-Frame', async () => {
    const m = new FeedFrameManager<Item>({ source: source({ WILD: 0, SAFE: 20 }), frameSize: 5 });
    const created: Frame<Item>[] = [];
    m.on('frameCreated', ({ frame }) => created.push(frame));
    let ended = false;
    m.on('feedEnd', () => { ended = true; });
    await m.focus(50);
    expect(ended).toBe(true);
    expect(m.getStatus().ended).toBe(true);
    expect(created.some((f) => f.kind === 'WILD')).toBe(false);
    expect(created.filter((f) => f.kind === 'SAFE')).toHaveLength(4);
    expect(created[created.length - 1]?.kind).not.toBe('MID');
  });

  it('lets a later focus() win when calls overlap', async () => {
    const m = new FeedFrameManager<Item>({ source: source({}, 5) });
    const slow = m.focus(9);
    const fast = m.focus(1);
    await Promise.all([slow, fast]);
    expect(m.getFocusIndex()).toBe(1);
    expect(indexes(m).every((i) => i <= 2)).toBe(true);
    expect(indexes(m)).toContain(1);
  });

  it('survives a throwing handler, reports load errors, and recovers with retry()', async () => {
    let fail = true;
    const flaky: FeedSource<Item> = {
      load: async (kind, limit) => {
        if (fail) throw new Error('boom');
        return { items: Array.from({ length: limit }, (_, i) => ({ id: `${kind}${i}`, kind })), done: false };
      },
    };
    const m = new FeedFrameManager<Item>({ source: flaky });
    m.onFrameMount(() => { throw new Error('bad listener'); });
    const errors: unknown[] = [];
    m.on('loadError', ({ error }) => errors.push(error));
    await expect(m.focus(0)).rejects.toThrow('boom');
    expect(errors).toHaveLength(1);
    expect(m.getStatus().error).toBeInstanceOf(Error);
    fail = false;
    await m.retry();
    expect(m.getStatus().error).toBeNull();
    expect(m.getMountedFrames().length).toBeGreaterThan(0);
  });

  it('honours markVolatile for any frame', async () => {
    const m = new FeedFrameManager<Item>({ source: source(), windowBehind: 1, windowAhead: 1 });
    await m.focus(4); // SAFE after the first WILD at 3
    expect(kinds(m)).toContain('WILD');
    m.markVolatile('frame-4');
    expect(m.getMountedFrames().some((f) => f.kind === 'WILD')).toBe(false);
  });

  it('destroy() unmounts everything and the manager can be focused again', async () => {
    const m = new FeedFrameManager<Item>({ source: source() });
    const reasons: string[] = [];
    m.onFrameUnmount(({ reason }) => reasons.push(reason));
    await m.focus(1);
    m.destroy();
    expect(m.getMountedFrames()).toHaveLength(0);
    expect(reasons.every((r) => r === 'destroy')).toBe(true);
    await m.focus(0);
    expect(m.getMountedFrames().length).toBeGreaterThan(0);
  });

  it('validates its window options', () => {
    expect(() => new FeedFrameManager<Item>({ source: source(), windowBehind: 2, windowAhead: 2 })).toThrow(RangeError);
  });
});

describe('createPooledSource', () => {
  const page = (n: number, tag: (i: number) => ModerationState) =>
    Array.from({ length: n }, (_, i) => ({ id: `p${i}`, kind: tag(i) }));

  it('sorts a mixed feed into SAFE and WILD pools', async () => {
    const src = createPooledSource<Item>({
      classify: (i) => i.kind,
      fetchPage: async () => ({ items: page(10, (i) => (i % 5 === 0 ? 'WILD' : 'SAFE')), nextCursor: null, hasMore: false }),
    });
    const wild = await src.load('WILD', 8);
    const safe = await src.load('SAFE', 8);
    expect(wild.items).toHaveLength(2);
    expect(wild.items.every((i) => i.kind === 'WILD')).toBe(true);
    expect(wild.done).toBe(true);
    expect(safe.items).toHaveLength(8);
    expect(safe.done).toBe(true);
  });

  it('stops hunting for a missing state after maxPagesPerLoad and keeps the pages for the other state', async () => {
    let calls = 0;
    const src = createPooledSource<Item>({
      classify: (i) => i.kind,
      maxPagesPerLoad: 3,
      fetchPage: async () => {
        calls++;
        return { items: page(10, () => 'SAFE'), nextCursor: `c${calls}`, hasMore: true };
      },
    });
    const wild = await src.load('WILD', 8);
    expect(calls).toBe(3);
    expect(wild).toEqual({ items: [], done: false });
    const safe = await src.load('SAFE', 8);
    expect(calls).toBe(3); // served from the pool, no new fetch
    expect(safe.items).toHaveLength(8);
  });

  it('does not lose its place when a page fetch fails', async () => {
    let fail = true;
    const src = createPooledSource<Item>({
      classify: (i) => i.kind,
      fetchPage: async (cursor) => {
        if (fail) throw new Error('net');
        return { items: page(4, () => 'SAFE'), nextCursor: cursor === null ? 'c1' : null, hasMore: cursor === null };
      },
    });
    await expect(src.load('SAFE', 4)).rejects.toThrow('net');
    fail = false;
    const r = await src.load('SAFE', 4);
    expect(r.items).toHaveLength(4);
  });
});
