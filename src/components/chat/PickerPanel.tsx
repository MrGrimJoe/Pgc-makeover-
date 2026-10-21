import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Settings2 } from 'lucide-react';
import { LibraryImage } from './LibraryImage.tsx';

export interface LibraryEntry {
  media_id: string;
  kind: 'sticker' | 'gif';
  mime_type: string;
  width: number | null;
  height: number | null;
}

interface PickerPanelProps {
  /** Send this library item. */
  onPick: (entry: LibraryEntry) => void;
  /** Files chosen with "Add from phone"; the parent opens the preview in library mode. */
  onAddFiles: (files: File[]) => void;
  /** Bumped by the parent after an item was added, so the list reloads. */
  reloadKey?: number;
  initialTab?: 'stickers' | 'gifs';
}

/** Sticker and GIF picker with the person's own library. Bundled packs plug in here in a later step. */
export const PickerPanel: React.FC<PickerPanelProps> = ({ onPick, onAddFiles, reloadKey = 0, initialTab = 'stickers' }) => {
  const [tab, setTab] = useState<'stickers' | 'gifs'>(initialTab);
  const [items, setItems] = useState<LibraryEntry[] | null>(null);
  const [manage, setManage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/stickers/library');
      if (!res.ok) throw new Error('Could not load your stickers.');
      setItems(((await res.json()) as { items: LibraryEntry[] }).items ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setItems([]);
    }
  }, []);
  useEffect(() => { void load(); }, [load, reloadKey]);

  const remove = async (entry: LibraryEntry) => {
    const res = await fetch(`/api/stickers/library/${encodeURIComponent(entry.media_id)}`, { method: 'DELETE' });
    if (res.ok) setItems((all) => (all ?? []).filter((i) => i.media_id !== entry.media_id));
    else setError('Could not remove it.');
  };

  const shown = (items ?? []).filter((i) => (tab === 'stickers' ? i.kind === 'sticker' : i.kind === 'gif'));
  const tabBtn = (on: boolean) => `flex-1 min-h-[44px] text-[14px] font-semibold cursor-pointer border-0 border-b-2 bg-transparent ${on ? 'border-[var(--blue,#244C8A)] text-[var(--blue,#244C8A)]' : 'border-transparent text-[var(--muted,#5B6577)]'}`;

  return (
    <div className="flex flex-col h-full">
      <div role="tablist" aria-label="Stickers and GIFs" className="flex shrink-0">
        <button type="button" role="tab" aria-selected={tab === 'stickers'} onClick={() => setTab('stickers')} className={tabBtn(tab === 'stickers')}>Stickers</button>
        <button type="button" role="tab" aria-selected={tab === 'gifs'} onClick={() => setTab('gifs')} className={tabBtn(tab === 'gifs')}>GIFs</button>
      </div>
      <div className="flex items-center gap-2 px-2 py-1.5 shrink-0">
        <span className="min-h-[44px] px-3.5 inline-flex items-center rounded-full bg-[var(--blue,#244C8A)] text-[var(--bg,#fff)] text-[13px] font-semibold" aria-current="true">Mine</span>
        <span className="flex-1" />
        <button type="button" onClick={() => setManage((m) => !m)} aria-pressed={manage} className="min-h-[44px] px-3 rounded-full border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[var(--text,#17233A)] text-[13px] font-semibold cursor-pointer inline-flex items-center gap-1.5">
          <Settings2 className="w-4 h-4" aria-hidden="true" />{manage ? 'Done' : 'Manage'}
        </button>
      </div>
      {error && <p role="alert" className="m-0 px-3 text-[13px] text-[var(--danger,#B23A40)]">{error}</p>}
      <div className="flex-1 overflow-y-auto p-2">
        {items === null && <p className="text-[13px] text-[var(--muted,#5B6577)] p-2" aria-busy="true">Loading...</p>}
        {items !== null && shown.length === 0 && (
          <p className="text-[13px] text-[var(--muted,#5B6577)] p-3 m-0">
            {tab === 'stickers' ? 'No stickers yet. Add a picture from your phone to make one.' : 'No GIFs yet. Add a GIF or a short clip from your phone.'}
          </p>
        )}
        <ul className="grid grid-cols-4 gap-2 list-none m-0 p-0">
          {shown.map((entry) => (
            <li key={entry.media_id} className="relative">
              <button type="button" onClick={() => (manage ? undefined : onPick(entry))} disabled={manage} aria-label={`Send ${entry.kind}`} className="w-full aspect-square min-h-[44px] bg-[var(--bg,#fff)] border border-[var(--line,#E8EBF0)] rounded-[8px] p-1 cursor-pointer disabled:cursor-default">
                <LibraryImage mediaId={entry.media_id} kind={entry.kind} />
              </button>
              {manage && (
                <button type="button" onClick={() => void remove(entry)} aria-label={`Remove ${entry.kind}`} className="absolute inset-x-0 bottom-0 min-h-[44px] rounded-b-[8px] bg-[var(--danger,#B23A40)] text-[var(--bg,#fff)] text-[12px] font-semibold border-0 cursor-pointer">
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
      <div className="p-2 shrink-0">
        <button type="button" onClick={() => file.current?.click()} className="w-full min-h-[44px] rounded-[10px] border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[var(--text,#17233A)] text-[13px] font-semibold cursor-pointer inline-flex items-center justify-center gap-1.5">
          <Plus className="w-4 h-4" aria-hidden="true" />Add from phone
        </button>
        <input ref={file} type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm" multiple aria-label="Choose pictures to add" className="hidden" data-testid="library-input"
          onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; if (f.length) onAddFiles(f); }} />
      </div>
    </div>
  );
};
