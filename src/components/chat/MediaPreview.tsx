import React, { useEffect, useMemo, useRef, useState } from 'react';
import { RotateCw, X } from 'lucide-react';
import { sniffMime, type SniffedType } from '../../../shared/media-rules.ts';
import { CROP_ASPECTS, cropForAspect, cropFramePercent, sendAsOptions, type CropAspect, type SendAs } from '../../lib/media.ts';
import { readHead, type PickedItem } from '../../lib/media-upload.ts';
import { useFocusTrap } from '../../lib/focus-trap.ts';

const MAX_ITEMS = 4;
const SEND_AS_LABEL: Record<SendAs, string> = { photo: 'Photo', sticker: 'Sticker', gif: 'GIF / loop' };

interface ItemState extends PickedItem {
  mime: SniffedType | null;
  url: string;
  naturalW: number;
  naturalH: number;
}

interface MediaPreviewProps {
  files: File[];
  /** send: caption and Send. library: no caption, the button adds to "my stickers & GIFs". */
  mode?: 'send' | 'library';
  onCancel: () => void;
  /** Called on Send. Nothing is uploaded before this. Throw to show an error and stay open. */
  onConfirm: (items: PickedItem[], caption: string) => Promise<void>;
}

const chip = (on: boolean) =>
  `min-h-[44px] px-3.5 rounded-full border text-[13px] font-semibold cursor-pointer ${
    on ? 'bg-[var(--blue,#244C8A)] text-[var(--bg,#fff)] border-[var(--blue,#244C8A)]' : 'bg-[var(--bg,#fff)] text-[var(--text,#17233A)] border-[var(--line,#E8EBF0)]'
  }`;

/** Full-screen check before sending: rotate, crop to an aspect, choose what to send as, add a caption. */
export const MediaPreview: React.FC<MediaPreviewProps> = ({ files, mode = 'send', onCancel, onConfirm }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState<ItemState[]>([]);
  const [index, setIndex] = useState(0);
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useFocusTrap(ref, () => !busy && onCancel());

  const limited = useMemo(() => files.slice(0, MAX_ITEMS), [files]);
  const tooMany = files.length > MAX_ITEMS;

  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    (async () => {
      const next: ItemState[] = [];
      for (const file of limited) {
        const mime = sniffMime(await readHead(file));
        const url = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : '';
        urls.push(url);
        const options = sendAsOptions(mime);
        const defaultAs: SendAs = mode === 'library' ? (mime === 'image/gif' || mime?.startsWith('video/') ? 'gif' : 'sticker') : (options[0] ?? 'photo');
        next.push({ file, mime, url, sendAs: defaultAs, rotate: 0, aspect: 'original', ox: 0.5, oy: 0.5, naturalW: 0, naturalH: 0 });
      }
      if (!cancelled) setItems(next);
    })();
    return () => {
      cancelled = true;
      urls.forEach((u) => u && URL.revokeObjectURL?.(u));
    };
  }, [limited, mode]);

  const cur = items[index];
  const patch = (changes: Partial<ItemState>) => setItems((all) => all.map((it, i) => (i === index ? { ...it, ...changes } : it)));
  const isVideo = cur?.mime?.startsWith('video/') ?? false;
  const canEdit = !!cur && !isVideo && cur.mime !== 'image/gif';
  const options = cur ? (mode === 'library' ? sendAsOptions(cur.mime).filter((o) => o !== 'photo') : sendAsOptions(cur.mime)) : [];

  const frame = useMemo(() => {
    if (!cur || !cur.naturalW) return null;
    const crop = cropForAspect(cur.naturalW, cur.naturalH, cur.aspect, cur.rotate, cur.ox, cur.oy);
    return cropFramePercent(cur.naturalW, cur.naturalH, crop, cur.rotate);
  }, [cur]);

  const confirm = async () => {
    if (busy || items.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(items.map(({ file, sendAs, rotate, aspect, ox, oy }) => ({ file, sendAs, rotate, aspect, ox, oy })), caption.trim());
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={mode === 'library' ? 'Add to my stickers and GIFs' : 'Preview before sending'} tabIndex={-1} className="fixed inset-0 left-[var(--nav-w,0px)] z-50 bg-[var(--bg,#fff)] flex flex-col max-w-content mx-auto">
      <header className="h-[48px] flex items-center px-2 border-b border-[var(--line,#E8EBF0)] shrink-0">
        <button type="button" onClick={onCancel} disabled={busy} aria-label="Cancel" className="w-[44px] h-[44px] flex items-center justify-center bg-transparent border-0 text-[var(--text,#17233A)] cursor-pointer disabled:opacity-40">
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
        <h2 className="m-0 text-[16px] font-semibold text-[var(--text,#17233A)]">{mode === 'library' ? 'Add to my stickers' : 'Preview'}</h2>
      </header>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {tooMany && <p role="status" className="m-0 text-[13px] text-[var(--muted,#5B6577)]">Only the first {MAX_ITEMS} pictures are used.</p>}

        {cur && (
          <div className="relative w-full aspect-square bg-[var(--bg2,#F8F9FC)] rounded-[12px] overflow-hidden" data-testid="stage">
            {isVideo ? (
              <video src={cur.url} muted loop playsInline autoPlay aria-label="Selected clip" className="w-full h-full object-contain" />
            ) : (
              <img
                src={cur.url}
                alt="Selected picture"
                onLoad={(e) => patch({ naturalW: e.currentTarget.naturalWidth, naturalH: e.currentTarget.naturalHeight })}
                style={{ transform: `rotate(${cur.rotate * 90}deg)` }}
                className="absolute inset-0 w-full h-full object-contain"
              />
            )}
            {canEdit && frame && cur.aspect !== 'original' && (
              <div
                aria-hidden="true"
                data-testid="crop-frame"
                style={{ left: `${frame.left}%`, top: `${frame.top}%`, width: `${frame.width}%`, height: `${frame.height}%`, boxShadow: '0 0 0 9999px rgba(0,0,0,0.5)' }}
                className="absolute border-2 border-white pointer-events-none"
              />
            )}
          </div>
        )}

        {items.length > 1 && (
          <div role="tablist" aria-label="Pictures" className="flex gap-2">
            {items.map((it, i) => (
              <button key={i} type="button" role="tab" aria-selected={i === index} aria-label={`Picture ${i + 1} of ${items.length}`} onClick={() => setIndex(i)} className={`w-[44px] h-[44px] rounded-[8px] overflow-hidden p-0 cursor-pointer ${i === index ? 'border-2 border-[var(--blue,#244C8A)]' : 'border border-[var(--line,#E8EBF0)]'}`}>
                {it.mime?.startsWith('video/') ? <span className="text-[11px]">Clip</span> : <img src={it.url} alt="" className="w-full h-full object-cover" />}
              </button>
            ))}
          </div>
        )}

        {cur && canEdit && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2 items-center">
              <button type="button" onClick={() => patch({ rotate: (cur.rotate + 1) % 4 })} aria-label="Rotate 90 degrees" className="min-h-[44px] px-3.5 rounded-full border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[var(--text,#17233A)] text-[13px] font-semibold cursor-pointer inline-flex items-center gap-1.5">
                <RotateCw className="w-4 h-4" aria-hidden="true" />Rotate
              </button>
            </div>
            <div role="radiogroup" aria-label="Crop shape" className="flex flex-wrap gap-2">
              {CROP_ASPECTS.map((a) => (
                <button key={a.id} type="button" role="radio" aria-checked={cur.aspect === a.id} onClick={() => patch({ aspect: a.id as CropAspect })} className={chip(cur.aspect === a.id)}>
                  {a.label}
                </button>
              ))}
            </div>
            {cur.aspect !== 'original' && (
              <div className="grid grid-cols-2 gap-3">
                <label className="text-[12px] text-[var(--muted,#5B6577)] block">
                  Move across
                  <input type="range" min={0} max={100} value={Math.round(cur.ox * 100)} onChange={(e) => patch({ ox: Number(e.target.value) / 100 })} className="w-full min-h-[44px]" />
                </label>
                <label className="text-[12px] text-[var(--muted,#5B6577)] block">
                  Move up and down
                  <input type="range" min={0} max={100} value={Math.round(cur.oy * 100)} onChange={(e) => patch({ oy: Number(e.target.value) / 100 })} className="w-full min-h-[44px]" />
                </label>
              </div>
            )}
          </div>
        )}

        {cur && options.length > 0 && mode === 'send' && (
          <fieldset className="border-0 p-0 m-0">
            <legend className="text-[13px] font-semibold text-[var(--text,#17233A)] mb-1.5">Send as</legend>
            <div role="radiogroup" aria-label="Send as" className="flex flex-wrap gap-2">
              {options.map((o) => (
                <button key={o} type="button" role="radio" aria-checked={cur.sendAs === o} onClick={() => patch({ sendAs: o })} className={chip(cur.sendAs === o)}>
                  {SEND_AS_LABEL[o]}
                </button>
              ))}
            </div>
          </fieldset>
        )}

        {mode === 'send' && (
          <div>
            <label htmlFor="preview-caption" className="block text-[13px] font-medium text-[var(--muted,#5B6577)] mb-1">Caption</label>
            <input id="preview-caption" type="text" value={caption} maxLength={500} onChange={(e) => setCaption(e.target.value)} className="w-full min-h-[44px] bg-[var(--bg2,#F8F9FC)] border border-[var(--line,#E8EBF0)] rounded-[12px] px-3.5 text-[15px] text-[var(--text,#17233A)] outline-none" />
          </div>
        )}

        {error && <div role="alert" className="p-2.5 rounded-[8px] border border-[var(--danger,#B23A40)] text-[var(--danger,#B23A40)] text-[13px]">{error}</div>}
      </div>

      <div className="p-3 border-t border-[var(--line,#E8EBF0)] pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] shrink-0">
        <button type="button" onClick={() => void confirm()} disabled={busy || items.length === 0} className="w-full min-h-[44px] rounded-[12px] bg-[var(--blue,#244C8A)] text-[var(--bg,#fff)] text-[15px] font-semibold cursor-pointer border-0 disabled:opacity-40">
          {busy ? 'Working...' : mode === 'library' ? 'Add' : 'Send'}
        </button>
      </div>
    </div>
  );
};
