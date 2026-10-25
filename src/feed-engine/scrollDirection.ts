/**
 * Which way the viewer is scrolling, read from real scroll events. Scrolls the app performs itself
 * (keeping the page still while frames change) are ignored, so they never flip the direction.
 */
export type ScrollIntent = 'up' | 'down';

let attached = false;
let lastY = 0;
let direction: ScrollIntent | null = null;
let ignoreUntil = 0;

function onScroll(): void {
  const y = window.scrollY;
  const dy = y - lastY;
  lastY = y;
  if (Math.abs(dy) >= 1 && performance.now() >= ignoreUntil) direction = dy > 0 ? 'down' : 'up';
}

function attach(): void {
  if (attached || typeof window === 'undefined') return;
  attached = true;
  lastY = window.scrollY;
  window.addEventListener('scroll', onScroll, { passive: true });
}

/** null until the viewer has scrolled at all. */
export function getScrollDirection(): ScrollIntent | null {
  attach();
  return direction;
}

/** Call right before scrolling the page programmatically so that scroll is not mistaken for the viewer's. */
export function markProgrammaticScroll(ms = 150): void {
  attach();
  ignoreUntil = performance.now() + ms;
}

/** Whether an edge sentinel may act: it must match the viewer's direction ("down" may also act before any scroll). */
export function sentinelMayAct(when: ScrollIntent): boolean {
  const current = getScrollDirection();
  return current === null ? when === 'down' : current === when;
}

/** Test helper. */
export function resetScrollDirection(): void {
  direction = null;
  ignoreUntil = 0;
  lastY = typeof window === 'undefined' ? 0 : window.scrollY;
}
