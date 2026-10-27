import React, { useEffect, useState } from 'react';
import { Pencil, Star } from 'lucide-react';
import type { MediaItem } from '../../shared/schema.ts';
import { bundledUrl, parseStickerKey, resolveBundled } from '../../shared/sticker-keys.ts';
import { BottomSheet } from './BottomSheet.tsx';
import { EditFlow } from './EditFlow.tsx';
import { StickerView } from './StickerView.tsx';
import { addFavorite, fetchFavoriteKeys, removeFavorite } from '../lib/favorites.ts';
import { fetchMediaBlob } from '../lib/media-actions.ts';

interface StickerSheetProps {
  stickerKey: string;
  media?: MediaItem[];
  onClose: () => void;
}

const btn =
  'w-full min-h-[44px] rounded-[12px] border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[var(--text,#17233A)] text-[14px] font-semibold cursor-pointer inline-flex items-center justify-center gap-2 disabled:opacity-40';

/** Opens when someone taps a sticker or GIF in a chat, post or comment: add it to your favorites, or put text on it. */
export const StickerSheet: React.FC<StickerSheetProps> = ({ stickerKey, media = [], onClose }) => {
  const parsed = parseStickerKey(stickerKey);
  const [favoriteKey, setFavoriteKey] = useState<string | null>(null); // the key under which it is now a favorite
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const [editing, setEditing] = useState<Blob | null>(null);

  // A bundled sticker can already be a favorite; an uploaded one is copied, so its state is only known after adding
  useEffect(() => {
    if (parsed?.kind !== 'app') return;
    let cancelled = false;
    fetchFavoriteKeys()
      .then((keys) => { if (!cancelled && keys.includes(stickerKey)) setFavoriteKey(stickerKey); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [stickerKey, parsed?.kind]);

  const resolved = parsed?.kind === 'app' ? resolveBundled(parsed.pack, parsed.number) : null;
  const row = parsed?.kind === 'usr' ? media.find((m) => m.id === parsed.mediaId) : undefined;
  const animated = resolved?.status === 'ok' ? resolved.item.kind === 'gif' : row ? row.kind === 'gif' || row.kind === 'video' : false;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setNote({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };

  const toggle = () =>
    run(async () => {
      if (favoriteKey) {
        await removeFavorite(favoriteKey);
        setFavoriteKey(null);
        setNote({ text: 'Removed from your favorites.', error: false });
      } else {
        const r = await addFavorite(stickerKey);
        setFavoriteKey(r.key);
        setNote({ text: r.already ? 'Already in your favorites.' : 'Added to your favorites.', error: false });
      }
    });

  const startEdit = () =>
    run(async () => {
      if (resolved?.status === 'ok') {
        const res = await fetch(bundledUrl(resolved.pack, resolved.item));
        if (!res.ok) throw new Error('Could not load this picture.');
        setEditing(await res.blob());
      } else if (parsed?.kind === 'usr') {
        setEditing(await fetchMediaBlob(parsed.mediaId));
      }
    });

  return (
    <>
      <BottomSheet label="Sticker options" onClose={onClose} className="p-4">
        {({ requestClose }) => (
          <div className="flex flex-col items-center gap-3">
            <StickerView stickerKey={stickerKey} size={200} media={media} />
            <div className="w-full space-y-2">
              <button type="button" onClick={() => void toggle()} disabled={busy} aria-pressed={favoriteKey !== null} className={btn}>
                <Star className={`w-4 h-4 ${favoriteKey ? 'fill-current' : ''}`} aria-hidden="true" />
                {favoriteKey ? 'In your favorites (tap to remove)' : 'Add to favorites'}
              </button>
              {!animated && (
                <button type="button" onClick={() => void startEdit()} disabled={busy} className={btn}>
                  <Pencil className="w-4 h-4" aria-hidden="true" />Add text
                </button>
              )}
              <button type="button" onClick={requestClose} className={`${btn} border-transparent text-[var(--muted,#5B6577)]`}>Close</button>
            </div>
            {note && <p role={note.error ? 'alert' : 'status'} className={`m-0 text-[13px] ${note.error ? 'text-[var(--danger,#B23A40)]' : 'text-[var(--text,#17233A)]'}`}>{note.text}</p>}
          </div>
        )}
      </BottomSheet>
      {editing && <EditFlow source={editing} onClose={() => setEditing(null)} />}
    </>
  );
};
