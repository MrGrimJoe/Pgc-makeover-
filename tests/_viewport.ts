/** A fake window width for jsdom: matchMedia answers (min-width: Npx) from it, and resizeTo() fires the change listeners. */
export function installViewport(initialWidth: number) {
  let width = initialWidth;
  const listeners = new Set<() => void>();
  const original = window.matchMedia;
  window.matchMedia = ((q: string) => {
    const min = /min-width:\s*(\d+)px/.exec(q);
    return {
      get matches() { return min ? width >= Number(min[1]) : false; },
      media: q,
      onchange: null,
      addEventListener: (_t: string, fn: () => void) => { listeners.add(fn); },
      removeEventListener: (_t: string, fn: () => void) => { listeners.delete(fn); },
      addListener: (fn: () => void) => { listeners.add(fn); },
      removeListener: (fn: () => void) => { listeners.delete(fn); },
      dispatchEvent: () => false,
    };
  }) as unknown as typeof window.matchMedia;
  return {
    resizeTo(w: number) { width = w; listeners.forEach((fn) => fn()); },
    restore() { window.matchMedia = original; },
  };
}
