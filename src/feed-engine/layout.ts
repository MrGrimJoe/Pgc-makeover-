import type { FrameKind } from './types.ts';

/** Pure mapping from a layout position to a frame kind. */
export type FrameLayout = (position: number) => FrameKind;

export function cycleLayout(pattern: readonly FrameKind[]): FrameLayout {
  if (pattern.length === 0) throw new RangeError('Layout pattern must not be empty');
  return (position) => pattern[position % pattern.length] ?? 'SAFE';
}

/** Every two SAFE frames are followed by a Mid-Frame, then one WILD frame. */
export const DEFAULT_LAYOUT: FrameLayout = cycleLayout(['SAFE', 'SAFE', 'MID', 'WILD']);
