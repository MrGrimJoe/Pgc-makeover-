import React, { useState } from 'react';
import { Play } from 'lucide-react';
import type { MediaItem } from '../../../shared/schema.ts';
import { usePrefersReducedMotion } from '../../lib/motion.ts';

interface AnimatedMediaProps {
  /** An uploaded file (its URL and type come from the row). */
  media?: MediaItem;
  /** Or a plain source, for bundled GIFs. */
  src?: string;
  video?: boolean;
  width?: number | null;
  height?: number | null;
  className?: string;
  label?: string;
}

/** A GIF or short loop. Autoplays muted; with reduced motion it waits behind a play button. */
export const AnimatedMedia: React.FC<AnimatedMediaProps> = ({ media, src: srcProp, video, width, height, className = '', label = 'GIF' }) => {
  const reduced = usePrefersReducedMotion();
  const [playing, setPlaying] = useState(false);
  const src = srcProp ?? `/api/media/${encodeURIComponent(media?.id ?? '')}`;
  const isVideo = video ?? media?.mime_type.startsWith('video/') ?? false;
  const w = width ?? media?.width;
  const h = height ?? media?.height;
  const style: React.CSSProperties = w && h ? { aspectRatio: `${w} / ${h}` } : {};

  if (reduced && !playing) {
    return (
      <button
        type="button"
        onClick={() => setPlaying(true)}
        aria-label={`Play ${label}`}
        style={style}
        className={`min-h-[44px] min-w-[44px] w-full flex items-center justify-center gap-2 rounded-[8px] bg-[var(--bg2,#F8F9FC)] border border-[var(--line,#E8EBF0)] text-[var(--text,#17233A)] text-[13px] font-semibold cursor-pointer ${className}`}
      >
        <Play className="w-4 h-4" aria-hidden="true" />
        Play {label}
      </button>
    );
  }
  return isVideo ? (
    <video src={src} autoPlay muted loop playsInline aria-label={label} style={style} className={`rounded-[8px] w-full ${className}`} />
  ) : (
    <img src={src} alt={label} style={style} className={`rounded-[8px] w-full ${className}`} loading="lazy" />
  );
};
