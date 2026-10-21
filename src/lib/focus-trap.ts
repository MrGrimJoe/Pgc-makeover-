import { useEffect, type RefObject } from 'react';

// Hidden file inputs (opened by a button) and anything with tabindex -1 are not part of the tab order
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]):not([type="file"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Keeps keyboard focus inside a dialog, closes it on Escape, moves focus in when it opens and gives it back to
 * the element that opened it when it closes.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, onEscape: () => void, active = true): void {
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const opener = document.activeElement as HTMLElement | null;
    const items = () => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute('hidden') && el.getAttribute('tabindex') !== '-1');
    (items()[0] ?? root).focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onEscape();
        return;
      }
      if (e.key !== 'Tab') return;
      const els = items();
      if (els.length === 0) {
        e.preventDefault();
        return;
      }
      const first = els[0]!;
      const last = els[els.length - 1]!;
      const current = document.activeElement;
      if (e.shiftKey && (current === first || !root.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !root.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener('keydown', onKey);
    return () => {
      root.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
