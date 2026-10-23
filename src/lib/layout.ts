import { createContext, createElement, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';

/**
 * The one place that decides which design a screen gets.
 *   phone   under 640 px   bottom tab bar, one column, slide-up sheets
 *   tablet  640 to 1023    icon rail on the left, centered column, centered dialogs
 *   desktop 1024 and up    sidebar with labels, centered column, comments as a side drawer
 * The same two numbers are in src/index.css (--breakpoint-tablet / --breakpoint-desktop, in rem) and
 * tests/layout.test.ts fails if they ever disagree. Nothing else may read the window width.
 */
export type Layout = 'phone' | 'tablet' | 'desktop';

export const BREAKPOINTS = { tablet: 640, desktop: 1024 } as const;
export const LAYOUTS: Layout[] = ['phone', 'tablet', 'desktop'];

/** Pure rule, used by tests and as documentation of the cut-offs. */
export function layoutForWidth(width: number): Layout {
  if (width >= BREAKPOINTS.desktop) return 'desktop';
  if (width >= BREAKPOINTS.tablet) return 'tablet';
  return 'phone';
}

const query = (px: number) => `(min-width: ${px}px)`;
const canMatch = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function';

function detect(): Layout {
  if (!canMatch()) return 'phone';
  if (window.matchMedia(query(BREAKPOINTS.desktop)).matches) return 'desktop';
  if (window.matchMedia(query(BREAKPOINTS.tablet)).matches) return 'tablet';
  return 'phone';
}

/** Dev only: ?layout=tablet forces a design while building. Ignored in a production build. */
export function forcedLayout(): Layout | null {
  if (typeof window === 'undefined' || !(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) return null;
  const v = new URLSearchParams(window.location.search).get('layout');
  return LAYOUTS.includes(v as Layout) ? (v as Layout) : null;
}

/** Follows the window: re-evaluates when it is resized or rotated across a breakpoint. */
function useDetectedLayout(): Layout {
  const [layout, setLayout] = useState<Layout>(detect);
  useEffect(() => {
    if (!canMatch()) return;
    const lists = [window.matchMedia(query(BREAKPOINTS.tablet)), window.matchMedia(query(BREAKPOINTS.desktop))];
    const update = () => setLayout(detect());
    lists.forEach((l) => (l.addEventListener ? l.addEventListener('change', update) : l.addListener?.(update)));
    update();
    return () => lists.forEach((l) => (l.removeEventListener ? l.removeEventListener('change', update) : l.removeListener?.(update)));
  }, []);
  return layout;
}

const LayoutContext = createContext<Layout>('phone');

/** Wrap the app once. Also writes data-layout on <html> so CSS, tests and debugging can see the active design. */
export function LayoutProvider({ children, force }: { children: ReactNode; force?: Layout }) {
  const detected = useDetectedLayout();
  const [forced] = useState<Layout | null>(() => force ?? forcedLayout());
  const layout = forced ?? detected;
  useLayoutEffect(() => {
    document.documentElement.dataset.layout = layout;
    return () => { delete document.documentElement.dataset.layout; };
  }, [layout]);
  return createElement(LayoutContext.Provider, { value: layout }, children);
}

/** Without a provider (a single component in a test) the phone design is used. */
export const useLayout = (): Layout => useContext(LayoutContext);
