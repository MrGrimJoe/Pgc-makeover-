import React, { useEffect, useRef } from 'react';
import type { ImpressionTracker } from '../lib/impressions.ts';

interface TrackedPostProps {
  tracker: ImpressionTracker;
  postId: string;
  position: number;
  children: React.ReactNode;
}

/** Wraps one post so the tracker can measure how long it is visible. Adds no layout of its own. */
export const TrackedPost: React.FC<TrackedPostProps> = ({ tracker, postId, position, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    return el ? tracker.observe(el, postId, position) : undefined;
  }, [tracker, postId, position]);
  return <div ref={ref}>{children}</div>;
};
