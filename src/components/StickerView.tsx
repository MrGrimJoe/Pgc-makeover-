import React, { useState } from 'react';
import { ImageOff } from 'lucide-react';
import type { MediaItem } from '../../shared/schema.ts';
import { bundledUrl, parseStickerKey, resolveBundled } from '../../shared/sticker-keys.ts';
import { AnimatedMedia } from './chat/AnimatedMedia.tsx';

interface StickerViewProps {
  /** app:<pack>/<number> or usr:<mediaId>. Anything else shows the placeholder. */
  stickerKey: string;
  /** Edge length in px. Messages use 160. */
  size?: number;
  className?: string;
  /** Rows already loaded with the message, post or comment, so uploaded loops can play as video. */
  media?: MediaItem[];
}

/** The tile shown when a sticker cannot be shown: removed, unknown, or an uploaded file that is gone. */
export const StickerPlaceholder: React.FC<{ size: number; className?: string }> = ({ size, className = '' }) => (
  <div
    role="img"
    aria-label="Sticker unavailable"
    style={{ width: size, height: size }}
    className={`flex flex-col items-center justify-center gap-1 rounded-[12px] border border-dashed border-[var(--line,#E8EBF0)] bg-[var(--bg2,#F8F9FC)] text-[var(--muted,#5B6577)] text-[11px] ${className}`}
  >
    <ImageOff className="w-5 h-5" aria-hidden="true" />
    <span>Unavailable</span>
  </div>
);

/**
 * Renders a sticker or GIF from its key alone. Bundled ones come from the static path (long-cached); uploaded ones
 * come from /api/media/:id. A key that cannot be resolved shows a placeholder instead of breaking the screen.
 */
export const StickerView: React.FC<StickerViewProps> = ({ stickerKey, size = 160, className = '', media = [] }) => {
  const [failed, setFailed] = useState(false);
  const parsed = parseStickerKey(stickerKey);
  if (!parsed || failed) return <StickerPlaceholder size={size} className={className} />;

  if (parsed.kind === 'app') {
    const r = resolveBundled(parsed.pack, parsed.number);
    if (r.status !== 'ok') return <StickerPlaceholder size={size} className={className} />;
    const url = bundledUrl(r.pack, r.item);
    if (r.item.kind === 'gif') {
      return (
        <div style={{ width: size }} className={className}>
          <AnimatedMedia src={url} width={r.item.width} height={r.item.height} label={r.item.alt || 'GIF'} />
        </div>
      );
    }
    return <img src={url} alt={r.item.alt || 'Sticker'} width={size} height={size} onError={() => setFailed(true)} style={{ width: size, height: size }} className={`object-contain ${className}`} loading="lazy" />;
  }

  const row = media.find((m) => m.id === parsed.mediaId);
  const src = `/api/media/${encodeURIComponent(parsed.mediaId)}`;
  if (row && (row.kind === 'gif' || row.kind === 'video')) {
    return (
      <div style={{ width: size }} className={className}>
        <AnimatedMedia media={row} label="GIF" />
      </div>
    );
  }
  return <img src={src} alt={row?.kind === 'gif' ? 'GIF' : 'Sticker'} width={size} height={size} onError={() => setFailed(true)} style={{ width: size, height: size }} className={`object-contain ${className}`} loading="lazy" />;
};
