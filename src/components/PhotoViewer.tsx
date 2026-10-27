import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Pencil, Share2, Smile, X } from 'lucide-react';
import type { MediaItem } from '../../shared/schema.ts';
import { useFocusTrap } from '../lib/focus-trap.ts';
import { canShareFiles, downloadBlob, fetchMediaBlob, fileNameFor, saveBlobAsSticker } from '../lib/media-actions.ts';
import { EditFlow } from './EditFlow.tsx';

interface PhotoViewerProps {
  photos: MediaItem[];
  startIndex?: number;
  /** Used in the accessible name, for example "Photo by @mia". */
  label: string;
  onClose: () => void;
}

const action =
  'min-h-[44px] px-3 rounded-full border border-white/40 bg-black/40 text-white text-[13px] font-semibold cursor-pointer inline-flex items-center gap-1.5 disabled:opacity-40';

/** Full-screen look at a post's picture, with Edit (add text), Download, Share and Save as sticker. */
export const PhotoViewer: React.FC<PhotoViewerProps> = ({ photos, startIndex = 0, label, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(startIndex);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Blob | null>(null);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const [canShare, setCanShare] = useState(false);
  const cur = photos[index];
  useFocusTrap(ref, onClose, !editing);

  useEffect(() => {
    setCanShare(false);
    if (!cur || typeof navigator === 'undefined') return;
    setCanShare(canShareFiles(new File([new Uint8Array(1)], fileNameFor(cur), { type: cur.mime_type })));
  }, [cur]);

  if (!cur) return null;
  const run = async (fn: () => Promise<void>, done?: string) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      if (done) setNote({ text: done, error: false });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setNote({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} className="fixed inset-0 left-[var(--nav-w,0px)] z-50 bg-black flex flex-col max-w-content mx-auto">
      <header className="h-[48px] flex items-center justify-between px-2 shrink-0">
        <button type="button" onClick={onClose} aria-label="Close viewer" className="w-[44px] h-[44px] flex items-center justify-center bg-transparent border-0 text-white cursor-pointer"><X className="w-6 h-6" aria-hidden="true" /></button>
        {photos.length > 1 && <span className="text-white text-[13px]" aria-live="polite">{index + 1} of {photos.length}</span>}
        <span className="w-[44px]" />
      </header>
      <div className="flex-1 min-h-0 flex items-center justify-center relative px-2">
        {photos.length > 1 && index > 0 && (
          <button type="button" onClick={() => setIndex(index - 1)} aria-label="Previous" className="absolute left-1 z-10 w-[44px] h-[44px] rounded-full bg-black/50 border-0 text-white flex items-center justify-center cursor-pointer"><ChevronLeft className="w-5 h-5" aria-hidden="true" /></button>
        )}
        <img src={`/api/media/${encodeURIComponent(cur.id)}`} alt={label} className="max-w-full max-h-full object-contain" />
        {photos.length > 1 && index < photos.length - 1 && (
          <button type="button" onClick={() => setIndex(index + 1)} aria-label="Next" className="absolute right-1 z-10 w-[44px] h-[44px] rounded-full bg-black/50 border-0 text-white flex items-center justify-center cursor-pointer"><ChevronRight className="w-5 h-5" aria-hidden="true" /></button>
        )}
      </div>
      {note && <p role={note.error ? 'alert' : 'status'} className={`m-0 px-3 pt-2 text-center text-[13px] ${note.error ? 'text-[#FFB4B8]' : 'text-white'}`}>{note.text}</p>}
      <div className="p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] flex flex-wrap gap-2 justify-center shrink-0">
        <button type="button" className={action} disabled={busy} onClick={() => void run(async () => setEditing(await fetchMediaBlob(cur.id)))}>
          <Pencil className="w-4 h-4" aria-hidden="true" />Edit
        </button>
        <button type="button" className={action} disabled={busy} onClick={() => void run(async () => downloadBlob(await fetchMediaBlob(cur.id), fileNameFor(cur)))}>
          <Download className="w-4 h-4" aria-hidden="true" />Download
        </button>
        {canShare && (
          <button type="button" className={action} disabled={busy} onClick={() => void run(async () => {
            const blob = await fetchMediaBlob(cur.id);
            await navigator.share({ files: [new File([blob], fileNameFor(cur), { type: cur.mime_type })] });
          })}>
            <Share2 className="w-4 h-4" aria-hidden="true" />Share
          </button>
        )}
        <button type="button" className={action} disabled={busy} onClick={() => void run(async () => saveBlobAsSticker(await fetchMediaBlob(cur.id)), 'Saved to your stickers.')}>
          <Smile className="w-4 h-4" aria-hidden="true" />Save as sticker
        </button>
      </div>
      {editing && <EditFlow source={editing} onClose={() => setEditing(null)} />}
    </div>
  );
};
