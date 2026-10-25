import type { FrameKind } from './types.ts';

/** Pure mapping from a layout position to a frame kind. */
export type FrameLayout = (position: number) => FrameKind;

export function cycleLayout(pattern: readonly FrameKind[]): FrameLayout {
  if (pattern.length === 0) throw new RangeError('Layout pattern must not be empty');
  return (position) => pattern[position % pattern.length] ?? 'SAFE';
}

/** v1 default: one continuous run of SAFE frames. No Mid-Frames, nothing WILD. */
export const DEFAULT_LAYOUT: FrameLayout = cycleLayout(['SAFE']);

/**
 * The moderation-phase layout: every two SAFE frames are followed by a Mid-Frame, then one WILD frame.
 * Pass it as `layout` once posts carry a SAFE / WILD tag and something fills the Mid-Frame slot.
 */
export const MODERATED_LAYOUT: FrameLayout = cycleLayout(['SAFE', 'SAFE', 'MID', 'WILD']);
