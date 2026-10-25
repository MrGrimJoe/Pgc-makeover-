import React from 'react';
import type { FeedFrameManager, Frame } from '../feed-engine/index.ts';
import { useFrameFocus } from '../feed-engine/react.ts';

interface FeedFrameProps<T> {
  manager: FeedFrameManager<T>;
  frame: Frame<T>;
  children?: React.ReactNode;
}

/**
 * One frame in the DOM. A MID frame is an empty, zero-height buffer slot (no visible gap) that another
 * manager can fill later; find it with [data-frame-kind="MID"].
 */
export function FeedFrame<T>({ manager, frame, children }: FeedFrameProps<T>) {
  const ref = useFrameFocus(manager, frame.index);
  return (
    <div
      ref={ref}
      data-frame-index={frame.index}
      data-frame-kind={frame.kind}
      aria-hidden={frame.kind === 'MID' ? true : undefined}
    >
      {children}
    </div>
  );
}
