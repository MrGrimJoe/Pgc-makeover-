import React, { useRef } from 'react';
import { Camera, Image as ImageIcon, Smile, Film } from 'lucide-react';
import { useFocusTrap } from '../../lib/focus-trap.ts';

interface AttachSheetProps {
  onClose: () => void;
  /** Files chosen from the camera or gallery. */
  onFiles: (files: File[]) => void;
  onSticker: () => void;
  onGif: () => void;
}

const GALLERY_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm';

const btn =
  'min-h-[72px] flex flex-col items-center justify-center gap-1.5 rounded-[12px] border border-[var(--line,#E8EBF0)] bg-[var(--bg2,#F8F9FC)] text-[var(--text,#17233A)] text-[13px] font-semibold cursor-pointer';

/** Bottom sheet with Camera, Gallery, Sticker and GIF. Focus is trapped; Escape closes it. */
export const AttachSheet: React.FC<AttachSheetProps> = ({ onClose, onFiles, onSticker, onGif }) => {
  const ref = useRef<HTMLDivElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  useFocusTrap(ref, onClose);

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    if (files.length > 0) onFiles(files);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Attach"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[430px] bg-[var(--bg,#fff)] rounded-t-[16px] p-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] space-y-3"
      >
        <div className="grid grid-cols-4 gap-2">
          <button type="button" className={btn} onClick={() => camera.current?.click()}>
            <Camera className="w-6 h-6" aria-hidden="true" />Camera
          </button>
          <button type="button" className={btn} onClick={() => gallery.current?.click()}>
            <ImageIcon className="w-6 h-6" aria-hidden="true" />Gallery
          </button>
          <button type="button" className={btn} onClick={onSticker}>
            <Smile className="w-6 h-6" aria-hidden="true" />Sticker
          </button>
          <button type="button" className={btn} onClick={onGif}>
            <Film className="w-6 h-6" aria-hidden="true" />GIF
          </button>
        </div>
        <button type="button" onClick={onClose} className="w-full min-h-[44px] rounded-[10px] bg-transparent border-0 text-[var(--muted,#5B6577)] text-[14px] font-semibold cursor-pointer">
          Cancel
        </button>
        <input ref={camera} type="file" accept="image/*" capture="environment" onChange={pick} className="hidden" aria-label="Take a photo" data-testid="camera-input" />
        <input ref={gallery} type="file" accept={GALLERY_ACCEPT} multiple onChange={pick} className="hidden" aria-label="Choose from gallery" data-testid="gallery-input" />
      </div>
    </div>
  );
};
