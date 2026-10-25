// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ImpressionTracker, type ImpressionReport } from '../src/lib/impressions.ts';

let fire: (el: Element, isIntersecting: boolean) => void;

class FakeIO {
  constructor(private cb: IntersectionObserverCallback) {
    ios.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  emit(el: Element, isIntersecting: boolean) {
    this.cb([{ target: el, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}
const ios: FakeIO[] = [];

describe('ImpressionTracker', () => {
  let clock = 0;
  let sent: ImpressionReport[][];
  let tracker: ImpressionTracker;

  beforeEach(() => {
    ios.length = 0;
    clock = 0;
    sent = [];
    vi.stubGlobal('IntersectionObserver', FakeIO);
    fire = (el, v) => ios[0]!.emit(el, v);
    tracker = new ImpressionTracker((b) => { sent.push(b); }, { now: () => clock, flushIntervalMs: 60_000 });
  });
  afterEach(() => {
    tracker.dispose();
    vi.unstubAllGlobals();
  });

  it('reports how long a post was on screen', () => {
    const el = document.createElement('div');
    tracker.observe(el, 'p1', 4);
    fire(el, true);
    clock = 3500;
    fire(el, false);
    tracker.flush();
    expect(sent).toEqual([[{ post_id: 'p1', position: 4, duration_ms: 3500 }]]);
  });

  it('ignores fly-by views shorter than the minimum', () => {
    const el = document.createElement('div');
    tracker.observe(el, 'p1', 0);
    fire(el, true);
    clock = 400;
    fire(el, false);
    tracker.flush();
    expect(sent).toEqual([]);
  });

  it('records a view still in progress when the post is removed (a frame leaving the window)', () => {
    const el = document.createElement('div');
    const stop = tracker.observe(el, 'p9', 2);
    fire(el, true);
    clock = 2000;
    stop();
    tracker.flush();
    expect(sent[0]).toEqual([{ post_id: 'p9', position: 2, duration_ms: 2000 }]);
  });

  it('does not double count a long view across flushes', () => {
    const el = document.createElement('div');
    tracker.observe(el, 'p1', 0);
    fire(el, true);
    clock = 4000;
    tracker.flush(); // 4000 so far
    clock = 6000;
    fire(el, false); // 2000 more
    tracker.flush();
    expect(sent.map((b) => b[0]?.duration_ms)).toEqual([4000, 2000]);
  });

  it('survives a failing sender', async () => {
    const failing = new ImpressionTracker(() => Promise.reject(new Error('offline')), { now: () => clock });
    const el = document.createElement('div');
    failing.observe(el, 'p1', 0);
    ios[1]!.emit(el, true);
    clock = 2000;
    ios[1]!.emit(el, false);
    expect(() => failing.flush()).not.toThrow();
    await Promise.resolve();
    failing.dispose();
  });

  it('is a harmless no-op without IntersectionObserver', () => {
    vi.unstubAllGlobals();
    const t = new ImpressionTracker(() => undefined);
    expect(() => t.observe(document.createElement('div'), 'p', 0)()).not.toThrow();
    t.dispose();
  });
});
