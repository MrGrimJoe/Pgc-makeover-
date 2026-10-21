import { useEffect, useRef, useState } from 'react';

/** Default panel height when no keyboard has been seen yet. */
export const FALLBACK_KEYBOARD_HEIGHT = 280;
/** A viewport change smaller than this is browser chrome (address bar), not a keyboard. */
const MIN_KEYBOARD_HEIGHT = 120;

/** How much of the layout viewport the on-screen keyboard covers, from the visual viewport. Pure. */
export function computeKeyboardInset(layoutHeight: number, vv: { height: number; offsetTop: number } | null | undefined): number {
  if (!vv) return 0;
  const covered = layoutHeight - vv.height - vv.offsetTop;
  return covered >= MIN_KEYBOARD_HEIGHT ? Math.round(covered) : 0;
}

/** The height to give a panel that replaces the keyboard: the last keyboard height seen, or 280 px. */
export function panelHeight(lastKeyboardHeight: number): number {
  return lastKeyboardHeight >= MIN_KEYBOARD_HEIGHT ? lastKeyboardHeight : FALLBACK_KEYBOARD_HEIGHT;
}

/**
 * Tracks the on-screen keyboard with window.visualViewport (resize and scroll). Returns the current inset in px and
 * the last non-zero keyboard height so a picker panel can take its place. Where the page already resizes with the
 * keyboard (viewport meta interactive-widget=resizes-content) the inset stays 0.
 */
export function useKeyboardInset(): { inset: number; lastKeyboardHeight: number } {
  const [inset, setInset] = useState(0);
  const last = useRef(0);
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;
    const update = () => {
      const next = computeKeyboardInset(window.innerHeight, vv);
      if (next > 0) last.current = next;
      setInset(next);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return { inset, lastKeyboardHeight: last.current };
}
