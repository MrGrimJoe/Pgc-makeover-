import React from 'react';
import type { FeedFrameManager, Frame } from '../feed-engine/index.ts';
import { useFrameFocus } from '../feed-engine/react.ts';

interface FeedFrameProps<T> {
  manager: FeedFrameManager<T>;
  frame: Frame<T>;
  children?: React.ReactNode;
}

/** One frame in the DOM. MID frames are an empty buffer slot that other managers may fill. */
export function FeedFrame<T>({ manager, frame, children }: FeedFrameProps<T>) {
  const ref = useFrameFocus(manager, frame.index);
  return (
    <div
      ref={ref}
      data-frame-index={frame.index}
      data-frame-kind={frame.kind}
      aria-hidden={frame.kind === 'MID' ? true : undefined}
      style={frame.kind === 'MID' ? { minHeight: 32 } : undefined}
    >
      {children}
    </div>
  );
}
