import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import type { FeedFrameManager } from './FeedFrameManager.ts';
import type { FeedStatus, Frame } from './types.ts';

/** The frames that should currently be in the React tree (3 at most by default). */
export function useMountedFrames<T>(manager: FeedFrameManager<T>): readonly Frame<T>[] {
  return useSyncExternalStore(manager.subscribe, manager.getMountedFrames, manager.getMountedFrames);
}

export function useFeedStatus<T>(manager: FeedFrameManager<T>): FeedStatus {
  return useSyncExternalStore(manager.subscribe, manager.getStatus, manager.getStatus);
}

/**
 * Put the returned ref on a frame's root element: the frame crossing the middle of the viewport
 * becomes the manager's focus. Load failures are reported through getStatus().error.
 */
export function useFrameFocus<T>(manager: FeedFrameManager<T>, index: number): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void manager.focus(index).catch(() => undefined);
      },
      { rootMargin: '-50% 0px -50% 0px', threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [manager, index]);
  return ref;
}

/**
 * Fires onEnter whenever the returned element is in view, and again after `watch` changes while it
 * still is (a plain observer would only report the first crossing). Use one below the last frame
 * (manager.advance) and one above the first (manager.retreat).
 */
export function useEdgeSentinel(onEnter: () => void, watch: unknown): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  const callback = useRef(onEnter);
  callback.current = onEnter;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) callback.current();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [watch]);
  return ref;
}

const FRAME_SELECTOR = '[data-frame-index]';

function measureTops(container: HTMLElement | null): Map<number, number> {
  const tops = new Map<number, number>();
  container?.querySelectorAll<HTMLElement>(FRAME_SELECTOR).forEach((el) => {
    tops.set(Number(el.dataset.frameIndex), el.getBoundingClientRect().top);
  });
  return tops;
}

/**
 * Keeps the page still while frames above the viewport are added or removed (scrolling either way).
 * Frame elements need a data-frame-index attribute. The position is measured when the manager
 * announces a change (before React commits) and corrected right after the commit.
 */
export function useScrollAnchor<T>(
  manager: FeedFrameManager<T>,
  containerRef: RefObject<HTMLElement | null>,
  mounted: readonly Frame<T>[],
): void {
  const tops = useRef(new Map<number, number>());

  useEffect(
    () =>
      manager.subscribe(() => {
        tops.current = measureTops(containerRef.current);
      }),
    [manager, containerRef],
  );

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const before = tops.current;
    const focus = manager.getFocusIndex();

    let anchor: { index: number; el: HTMLElement } | null = null;
    container.querySelectorAll<HTMLElement>(FRAME_SELECTOR).forEach((el) => {
      const index = Number(el.dataset.frameIndex);
      if (!before.has(index)) return; // newly mounted: nothing to compare against
      if (!anchor || Math.abs(index - focus) < Math.abs(anchor.index - focus)) anchor = { index, el };
    });

    const found = anchor as { index: number; el: HTMLElement } | null;
    const previousTop = found ? before.get(found.index) : undefined;
    if (found && previousTop !== undefined) {
      const delta = found.el.getBoundingClientRect().top - previousTop;
      if (Math.abs(delta) > 0.5) window.scrollBy({ top: delta, behavior: 'instant' });
    }
    tops.current = measureTops(container);
  }, [mounted, manager, containerRef]);
}
