import React, { useEffect, useRef, useState } from 'react';
import { Download, Pencil, Send, Share2, Smile, X } from 'lucide-react';
import { useFocusTrap } from '../lib/focus-trap.ts';
import { canShareFiles, downloadBlob, saveBlobAsSticker } from '../lib/media-actions.ts';

interface EditedResultProps {
  /** The finished picture, with the text on it. */
  file: File;
  onClose: () => void;
  onEditAgain: () => void;
  /** When set, a button sends the picture (for example into the open chat). */
  onSend?: (file: File) => void;
  sendLabel?: string;
}

const action =
  'min-h-[44px] px-3 rounded-full border border-white/40 bg-black/40 text-white text-[13px] font-semibold cursor-pointer inline-flex items-center gap-1.5 disabled:opacity-40';

/** What to do with a picture after text was added: look at it, download it, share it, keep it as a sticker, or send it. */
export const EditedResult: React.FC<EditedResultProps> = ({ file, onClose, onEditAgain, onSend, sendLabel = 'Send' }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  useFocusTrap(ref, () => !busy && onClose());

  useEffect(() => {
    const u = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : '';
    setUrl(u);
    return () => { if (u) URL.revokeObjectURL?.(u); };
  }, [file]);

  const canShare = typeof navigator !== 'undefined' && canShareFiles(file);

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
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Your edited picture" tabIndex={-1} className="fixed inset-0 left-[var(--nav-w,0px)] z-[60] bg-black flex flex-col max-w-content mx-auto">
      <header className="h-[48px] flex items-center px-2 shrink-0">
        <button type="button" onClick={onClose} aria-label="Close" className="w-[44px] h-[44px] flex items-center justify-center bg-transparent border-0 text-white cursor-pointer"><X className="w-6 h-6" aria-hidden="true" /></button>
      </header>
      <div className="flex-1 min-h-0 flex items-center justify-center px-2">
        {url && <img src={url} alt="Your picture with text" className="max-w-full max-h-full object-contain" />}
      </div>
      {note && <p role={note.error ? 'alert' : 'status'} className={`m-0 px-3 pt-2 text-center text-[13px] ${note.error ? 'text-[#FFB4B8]' : 'text-white'}`}>{note.text}</p>}
      <div className="p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] flex flex-wrap gap-2 justify-center shrink-0">
        {onSend && (
          <button type="button" className={`${action} !bg-white !text-black`} disabled={busy} onClick={() => onSend(file)}>
            <Send className="w-4 h-4" aria-hidden="true" />{sendLabel}
          </button>
        )}
        <button type="button" className={action} disabled={busy} onClick={() => downloadBlob(file, file.name)}>
          <Download className="w-4 h-4" aria-hidden="true" />Download
        </button>
        {canShare && (
          <button type="button" className={action} disabled={busy} onClick={() => void run(async () => { await navigator.share({ files: [file] }); })}>
            <Share2 className="w-4 h-4" aria-hidden="true" />Share
          </button>
        )}
        <button type="button" className={action} disabled={busy} onClick={() => void run(() => saveBlobAsSticker(file), 'Saved to your stickers.')}>
          <Smile className="w-4 h-4" aria-hidden="true" />Save as sticker
        </button>
        <button type="button" className={action} disabled={busy} onClick={onEditAgain}>
          <Pencil className="w-4 h-4" aria-hidden="true" />Edit again
        </button>
      </div>
    </div>
  );
};
