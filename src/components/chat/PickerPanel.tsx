import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Settings2 } from 'lucide-react';
import { STICKER_PACKS } from '../../../shared/stickers.ts';
import { appKey, bundledUrl, parseStickerKey, resolveBundled } from '../../../shared/sticker-keys.ts';
import { loadRecent, saveRecent } from '../../lib/recent-stickers.ts';
import { usePrefersReducedMotion } from '../../lib/motion.ts';

export interface LibraryEntry {
  media_id: string;
  kind: 'sticker' | 'gif';
  mime_type: string;
  width: number | null;
  height: number | null;
}

interface PickerPanelProps {
  /** The signed-in person; recent stickers are remembered per person on this device only. */
  userId: string;
  /** Called with the key to send: app:<pack>/<number> or usr:<mediaId>. */
  onPick: (key: string, kind: 'sticker' | 'gif') => void;
  /** Files chosen with "Add from phone"; the parent opens the preview in library mode. */
  onAddFiles: (files: File[]) => void;
  /** Bumped by the parent after an item was added, so the list reloads. */
  reloadKey?: number;
  initialTab?: 'stickers' | 'gifs';
}

interface Tile {
  key: string;
  kind: 'sticker' | 'gif';
  src: string;
  alt: string;
}

const KIND_OF_TAB = { stickers: 'sticker', gifs: 'gif' } as const;

/** Thumbnail in the grid. With reduced motion, GIFs are a still label until sent. */
const Thumb: React.FC<{ tile: Tile; reduced: boolean }> = ({ tile, reduced }) =>
  tile.kind === 'gif' && reduced ? (
    <span className="w-full h-full flex items-center justify-center text-[12px] font-semibold text-[var(--muted,#5B6577)]">GIF</span>
  ) : (
    <img src={tile.src} alt={tile.alt} loading="lazy" className="w-full h-full object-contain" />
  );

/**
 * Sticker and GIF picker. Chips: Recent (this device only), Mine (your uploads), then each bundled pack.
 * "Manage" removes your uploads; "Add from phone" opens the preview to turn a picture or a clip into one.
 */
export const PickerPanel: React.FC<PickerPanelProps> = ({ userId, onPick, onAddFiles, reloadKey = 0, initialTab = 'stickers' }) => {
  const reduced = usePrefersReducedMotion();
  const [tab, setTab] = useState<'stickers' | 'gifs'>(initialTab);
  const [chip, setChip] = useState<string | null>(null); // 'recent' | 'mine' | pack id
  const [items, setItems] = useState<LibraryEntry[] | null>(null);
  const [recent, setRecent] = useState<string[]>(() => loadRecent(userId));
  const [manage, setManage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const kind = KIND_OF_TAB[tab];

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

  const recentTiles = useMemo<Tile[]>(
    () =>
      recent.flatMap((key) => {
        const p = parseStickerKey(key);
        if (p?.kind !== 'app') return [];
        const r = resolveBundled(p.pack, p.number);
        return r.status === 'ok' && r.item.kind === kind ? [{ key, kind, src: bundledUrl(r.pack, r.item), alt: r.item.alt }] : [];
      }),
    [recent, kind]
  );
  const mineTiles = useMemo<Tile[]>(
    () => (items ?? []).filter((i) => i.kind === kind).map((i) => ({ key: `usr:${i.media_id}`, kind, src: `/api/media/${encodeURIComponent(i.media_id)}`, alt: kind === 'gif' ? 'GIF' : 'Sticker' })),
    [items, kind]
  );
  const packs = useMemo(
    () => STICKER_PACKS.map((p) => ({ pack: p, tiles: p.items.filter((i) => i.kind === kind).map((i): Tile => ({ key: appKey(p.id, i.number), kind, src: bundledUrl(p, i), alt: i.alt })) })).filter((x) => x.tiles.length > 0),
    [kind]
  );

  // The first chip that has something in it
  const chips = [
    ...(recentTiles.length > 0 ? [{ id: 'recent', label: 'Recent' }] : []),
    { id: 'mine', label: 'Mine' },
    ...packs.map(({ pack }) => ({ id: pack.id, label: pack.name })),
  ];
  const active = chips.some((c) => c.id === chip) ? chip! : recentTiles.length > 0 ? 'recent' : mineTiles.length > 0 || packs.length === 0 ? 'mine' : packs[0]!.pack.id;
  const tiles = active === 'recent' ? recentTiles : active === 'mine' ? mineTiles : packs.find((p) => p.pack.id === active)?.tiles ?? [];

  const pick = (tile: Tile) => {
    if (parseStickerKey(tile.key)?.kind === 'app') setRecent(saveRecent(userId, tile.key));
    onPick(tile.key, tile.kind);
  };
  const remove = async (tile: Tile) => {
    const id = tile.key.slice('usr:'.length);
    const res = await fetch(`/api/stickers/library/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.ok) setItems((all) => (all ?? []).filter((i) => i.media_id !== id));
    else setError('Could not remove it.');
  };

  const tabBtn = (on: boolean) => `flex-1 min-h-[44px] text-[14px] font-semibold cursor-pointer border-0 border-b-2 bg-transparent ${on ? 'border-[var(--blue,#244C8A)] text-[var(--blue,#244C8A)]' : 'border-transparent text-[var(--muted,#5B6577)]'}`;
  const chipBtn = (on: boolean) => `shrink-0 min-h-[44px] px-3.5 rounded-full border text-[13px] font-semibold cursor-pointer ${on ? 'bg-[var(--blue,#244C8A)] text-[var(--bg,#fff)] border-[var(--blue,#244C8A)]' : 'bg-[var(--bg,#fff)] text-[var(--text,#17233A)] border-[var(--line,#E8EBF0)]'}`;

  return (
    <div className="flex flex-col h-full">
      <div role="tablist" aria-label="Stickers and GIFs" className="flex shrink-0">
        <button type="button" role="tab" aria-selected={tab === 'stickers'} onClick={() => { setTab('stickers'); setManage(false); }} className={tabBtn(tab === 'stickers')}>Stickers</button>
        <button type="button" role="tab" aria-selected={tab === 'gifs'} onClick={() => { setTab('gifs'); setManage(false); }} className={tabBtn(tab === 'gifs')}>GIFs</button>
      </div>
      <div className="flex items-center gap-2 px-2 py-1.5 shrink-0">
        <div role="radiogroup" aria-label="Collection" className="flex gap-2 overflow-x-auto flex-1">
          {chips.map((c) => (
            <button key={c.id} type="button" role="radio" aria-checked={active === c.id} onClick={() => { setChip(c.id); setManage(false); }} className={chipBtn(active === c.id)}>{c.label}</button>
          ))}
        </div>
        {active === 'mine' && mineTiles.length > 0 && (
          <button type="button" onClick={() => setManage((m) => !m)} aria-pressed={manage} className="shrink-0 min-h-[44px] px-3 rounded-full border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[var(--text,#17233A)] text-[13px] font-semibold cursor-pointer inline-flex items-center gap-1.5">
            <Settings2 className="w-4 h-4" aria-hidden="true" />{manage ? 'Done' : 'Manage'}
          </button>
        )}
      </div>
      {error && <p role="alert" className="m-0 px-3 text-[13px] text-[var(--danger,#B23A40)]">{error}</p>}
      <div className="flex-1 overflow-y-auto p-2">
        {items === null && active === 'mine' && <p className="text-[13px] text-[var(--muted,#5B6577)] p-2 m-0" aria-busy="true">Loading...</p>}
        {items !== null && tiles.length === 0 && (
          <p className="text-[13px] text-[var(--muted,#5B6577)] p-3 m-0">
            {active === 'mine'
              ? kind === 'sticker' ? 'No stickers yet. Add a picture from your phone to make one.' : 'No GIFs yet. Add a GIF or a short clip from your phone.'
              : 'Nothing here yet.'}
          </p>
        )}
        <ul className="grid grid-cols-4 gap-2 list-none m-0 p-0">
          {tiles.map((tile) => (
            <li key={tile.key} className="relative">
              <button type="button" onClick={() => (manage ? undefined : pick(tile))} disabled={manage} aria-label={`Send ${tile.alt}`} className="w-full aspect-square min-h-[44px] bg-[var(--bg,#fff)] border border-[var(--line,#E8EBF0)] rounded-[8px] p-1 cursor-pointer disabled:cursor-default">
                <Thumb tile={tile} reduced={reduced} />
              </button>
              {manage && (
                <button type="button" onClick={() => void remove(tile)} aria-label={`Remove ${tile.alt}`} className="absolute inset-x-0 bottom-0 min-h-[44px] rounded-b-[8px] bg-[var(--danger,#B23A40)] text-[var(--bg,#fff)] text-[12px] font-semibold border-0 cursor-pointer">Remove</button>
              )}
            </li>
          ))}
        </ul>
      </div>
      <div className="p-2 shrink-0">
        <button type="button" onClick={() => file.current?.click()} className="w-full min-h-[44px] rounded-[10px] border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[var(--text,#17233A)] text-[13px] font-semibold cursor-pointer inline-flex items-center justify-center gap-1.5">
          <Plus className="w-4 h-4" aria-hidden="true" />Add from phone
        </button>
        <input ref={file} type="file" tabIndex={-1} accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm" multiple aria-label="Choose pictures to add" className="hidden" data-testid="library-input"
          onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; if (f.length) onAddFiles(f); }} />
      </div>
    </div>
  );
};
