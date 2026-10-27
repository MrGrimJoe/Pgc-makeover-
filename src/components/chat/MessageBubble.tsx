import React from 'react';
import type { MessageItem, MediaItem } from '../../../shared/schema.ts';
import { ExpiryChip } from '../ExpiryChip.tsx';
import { AnimatedMedia } from './AnimatedMedia.tsx';
import { StickerView } from '../StickerView.tsx';

interface MessageBubbleProps {
  msg: MessageItem;
  isSelf: boolean;
  onOpenMedia: (msg: MessageItem, index: number) => void;
  onReport?: (msg: MessageItem) => void;
}

const isSticker = (m: MediaItem) => m.kind === 'sticker';
const isLoop = (m: MediaItem) => m.kind === 'gif' || m.kind === 'video';

/** Human label for a media item, used for alt text and previews. */
export function mediaLabel(m: MediaItem): string {
  return m.kind === 'sticker' ? 'Sticker' : m.kind === 'gif' ? 'GIF' : m.kind === 'video' ? 'Video' : 'Photo';
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({ msg, isSelf, onOpenMedia, onReport }) => {
  const stickerKey = msg.sticker_key ?? null;
  // An uploaded sticker named by the key is also attached; show it once, through the key
  const media = (msg.media ?? []).filter((m) => !(stickerKey && stickerKey === `usr:${m.id}`));
  const stickersOnly = !msg.body && (!!stickerKey || media.length > 0) && media.every(isSticker);
  const keyedSticker = stickerKey ? (
    <div className="flex flex-col items-start">
      <StickerView stickerKey={stickerKey} size={160} media={msg.media} favoritable />
    </div>
  ) : null;

  const renderMedia = (m: MediaItem, i: number) => {
    const open = () => onOpenMedia(msg, i);
    if (isSticker(m)) {
      return (
        <button key={m.id} type="button" onClick={open} aria-label="Open sticker" className="block bg-transparent border-0 p-0 cursor-pointer min-h-[44px] min-w-[44px]">
          <img src={`/api/media/${encodeURIComponent(m.id)}`} alt="Sticker" width={160} height={160} className="w-[160px] h-[160px] object-contain" loading="lazy" />
        </button>
      );
    }
    if (isLoop(m)) {
      return (
        <div key={m.id} className="relative">
          <AnimatedMedia media={m} label={mediaLabel(m)} />
          <button type="button" onClick={open} aria-label={`Open ${mediaLabel(m)}`} className="absolute inset-0 w-full h-full bg-transparent border-0 cursor-pointer" />
        </div>
      );
    }
    return (
      <button key={m.id} type="button" onClick={open} aria-label="Open photo" className="block p-0 border-0 bg-transparent cursor-pointer w-full min-h-[44px]">
        <img src={`/api/media/${encodeURIComponent(m.id)}`} alt="Photo attachment" className="rounded-[8px] w-full max-h-[260px] object-cover" loading="lazy" />
      </button>
    );
  };

  const mediaBlock =
    media.length > 0 ? (
      <div className={`${media.length > 1 && media.every((m) => !isSticker(m) && !isLoop(m)) ? 'grid grid-cols-2 gap-1' : 'space-y-1'} ${msg.body ? 'mb-1.5' : ''}`}>
        {media.map(renderMedia)}
      </div>
    ) : null;

  return (
    <div className={`flex flex-col ${isSelf ? 'items-end' : 'items-start'}`}>
      {stickersOnly ? (
        <div className="flex flex-wrap gap-1 justify-end">{keyedSticker}{mediaBlock}</div>
      ) : (
        <div
          className={`max-w-[80%] px-3.5 py-2 text-[15px] leading-relaxed break-words whitespace-pre-wrap ${
            isSelf
              ? 'bg-[var(--blue,#244C8A)] text-[var(--bg,#fff)] rounded-[16px] rounded-br-[4px]'
              : 'bg-[var(--bg2,#F8F9FC)] border border-[var(--line,#E8EBF0)] text-[var(--text,#17233A)] rounded-[16px] rounded-bl-[4px]'
          }`}
        >
          {keyedSticker}
          {mediaBlock}
          {msg.body}
        </div>
      )}
      {/* Expiry sits on an opaque pill so it stays readable on any chat background */}
      <div className="mt-1 px-1 flex items-center gap-2">
        <span className="rounded-full bg-[var(--bg,#fff)] px-2 py-0.5 inline-flex">
          <ExpiryChip expiresAt={msg.expires_at} />
        </span>
        {!isSelf && onReport && (
          <button
            type="button"
            onClick={() => onReport(msg)}
            aria-label="Report this message"
            className="min-h-[44px] px-2 rounded-full bg-[var(--bg,#fff)] text-[12px] text-[var(--muted,#5B6577)] hover:text-[var(--danger,#B23A40)] cursor-pointer border-0"
          >
            Report
          </button>
        )}
      </div>
    </div>
  );
};
