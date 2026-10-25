// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { getScrollDirection, markProgrammaticScroll, resetScrollDirection, sentinelMayAct } from '../src/feed-engine/scrollDirection.ts';

let y = 0;
function scrollTo(next: number) {
  y = next;
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
  window.dispatchEvent(new Event('scroll'));
}

describe('scroll direction', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'scrollY', { value: 500, configurable: true });
    y = 500;
    resetScrollDirection();
    getScrollDirection(); // attach
  });

  it('is unknown until the viewer scrolls, and then lets only the bottom sentinel act', () => {
    expect(getScrollDirection()).toBeNull();
    expect(sentinelMayAct('down')).toBe(true);
    expect(sentinelMayAct('up')).toBe(false);
  });

  it('follows the viewer up and down', () => {
    scrollTo(600);
    expect(getScrollDirection()).toBe('down');
    expect(sentinelMayAct('down')).toBe(true);
    expect(sentinelMayAct('up')).toBe(false);
    scrollTo(400);
    expect(getScrollDirection()).toBe('up');
    expect(sentinelMayAct('up')).toBe(true);
    expect(sentinelMayAct('down')).toBe(false);
  });

  it('ignores scrolls the app performed itself, and keeps measuring from the new position', () => {
    scrollTo(600); // viewer scrolls down
    markProgrammaticScroll(10_000);
    scrollTo(1200); // the app moves the page to keep it still
    expect(getScrollDirection()).toBe('down'); // not changed by the app's scroll
    markProgrammaticScroll(0);
    scrollTo(1100); // viewer scrolls up from where the app left the page
    expect(getScrollDirection()).toBe('up');
  });

  it('ignores sub-pixel jitter', () => {
    scrollTo(600);
    scrollTo(599.6);
    expect(getScrollDirection()).toBe('down');
  });
});
