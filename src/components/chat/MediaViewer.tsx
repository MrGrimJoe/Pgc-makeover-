import React, { useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Flag, Forward, Share2, Smile, X } from 'lucide-react';
import type { MessageItem } from '../../../shared/schema.ts';
import { AnimatedMedia } from './AnimatedMedia.tsx';
import { ForwardPicker } from './ForwardPicker.tsx';
import { mediaLabel } from './MessageBubble.tsx';
import { ReportModal } from '../ReportModal.tsx';
import { useFocusTrap } from '../../lib/focus-trap.ts';
import { canShareFiles, downloadBlob, fetchMediaBlob, fileNameFor, saveAsSticker } from '../../lib/media-actions.ts';

interface MediaViewerProps {
  message: MessageItem;
  startIndex: number;
  isSelf: boolean;
  onClose: () => void;
  onNotice: (text: string) => void;
}

const action =
  'min-h-[44px] px-3 rounded-full border border-white/40 bg-black/40 text-white text-[13px] font-semibold cursor-pointer inline-flex items-center gap-1.5';

/** Full-screen view of message media with Download, Share, Forward, Save as sticker and Report. */
export const MediaViewer: React.FC<MediaViewerProps> = ({ message, startIndex, isSelf, onClose, onNotice }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(startIndex);
  const [forwarding, setForwarding] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [shareFile, setShareFile] = useState<File | null>(null);
  const media = message.media ?? [];
  const cur = media[index];
  useFocusTrap(ref, onClose, !forwarding && !reporting);

  // The Share button only appears when this browser can share a file of this type
  const [canShare, setCanShare] = useState(false);
  React.useEffect(() => {
    let cancelled = false;
    setCanShare(false);
    setShareFile(null);
    if (!cur || typeof navigator === 'undefined' || typeof navigator.canShare !== 'function' || typeof navigator.share !== 'function') return;
    // Probe with an empty file of the right type; the real file is fetched when the button is pressed
    const probe = new File([new Uint8Array(1)], fileNameFor(cur), { type: cur.mime_type });
    if (canShareFiles(probe)) {
      if (!cancelled) setCanShare(true);
    }
    return () => { cancelled = true; };
  }, [cur]);

  if (!cur) return null;
  const run = async (name: string, fn: () => Promise<void>, done?: string) => {
    setBusy(name);
    try {
      await fn();
      if (done) onNotice(done);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') onNotice((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={`${mediaLabel(cur)} viewer`} tabIndex={-1} className="fixed inset-0 left-[var(--nav-w,0px)] z-50 bg-black flex flex-col max-w-content mx-auto">
      <header className="h-[48px] flex items-center justify-between px-2 shrink-0">
        <button type="button" onClick={onClose} aria-label="Close viewer" className="w-[44px] h-[44px] flex items-center justify-center bg-transparent border-0 text-white cursor-pointer"><X className="w-6 h-6" aria-hidden="true" /></button>
        {media.length > 1 && <span className="text-white text-[13px]" aria-live="polite">{index + 1} of {media.length}</span>}
        <span className="w-[44px]" />
      </header>

      <div className="flex-1 min-h-0 flex items-center justify-center relative px-2">
        {media.length > 1 && index > 0 && (
          <button type="button" onClick={() => setIndex(index - 1)} aria-label="Previous" className="absolute left-1 z-10 w-[44px] h-[44px] rounded-full bg-black/50 border-0 text-white flex items-center justify-center cursor-pointer"><ChevronLeft className="w-5 h-5" aria-hidden="true" /></button>
        )}
        {cur.kind === 'gif' || cur.kind === 'video' ? (
          <AnimatedMedia media={cur} label={mediaLabel(cur)} className="max-h-full" />
        ) : (
          <img src={`/api/media/${encodeURIComponent(cur.id)}`} alt={mediaLabel(cur)} className="max-w-full max-h-full object-contain" />
        )}
        {media.length > 1 && index < media.length - 1 && (
          <button type="button" onClick={() => setIndex(index + 1)} aria-label="Next" className="absolute right-1 z-10 w-[44px] h-[44px] rounded-full bg-black/50 border-0 text-white flex items-center justify-center cursor-pointer"><ChevronRight className="w-5 h-5" aria-hidden="true" /></button>
        )}
      </div>

      <div className="p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] flex flex-wrap gap-2 justify-center shrink-0">
        <button type="button" className={action} disabled={busy !== null} onClick={() => void run('download', async () => downloadBlob(await fetchMediaBlob(cur.id), fileNameFor(cur)))}>
          <Download className="w-4 h-4" aria-hidden="true" />Download
        </button>
        {canShare && (
          <button type="button" className={action} disabled={busy !== null} onClick={() => void run('share', async () => {
            const blob = await fetchMediaBlob(cur.id);
            const file = shareFile ?? new File([blob], fileNameFor(cur), { type: cur.mime_type });
            setShareFile(file);
            await navigator.share({ files: [file] });
          })}>
            <Share2 className="w-4 h-4" aria-hidden="true" />Share
          </button>
        )}
        <button type="button" className={action} disabled={busy !== null} onClick={() => setForwarding(true)}>
          <Forward className="w-4 h-4" aria-hidden="true" />Forward
        </button>
        <button type="button" className={action} disabled={busy !== null} onClick={() => void run('save', () => saveAsSticker(cur, isSelf), 'Saved to your stickers.')}>
          <Smile className="w-4 h-4" aria-hidden="true" />Save as sticker
        </button>
        {!isSelf && (
          <button type="button" className={action} disabled={busy !== null} onClick={() => setReporting(true)}>
            <Flag className="w-4 h-4" aria-hidden="true" />Report
          </button>
        )}
      </div>

      {forwarding && <ForwardPicker messageId={message.id} onClose={() => setForwarding(false)} onForwarded={() => { setForwarding(false); onNotice('Forwarded.'); }} />}
      {reporting && <ReportModal targetType="message" targetId={message.id} onClose={() => setReporting(false)} onReportSubmitted={() => { setReporting(false); onNotice('Report sent. Thank you.'); }} />}
    </div>
  );
};
