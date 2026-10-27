import { parseStickerKey } from '../../shared/sticker-keys.ts';

/** What the server says after a favorite was added. `key` is the key to use from now on (for a copy of someone's upload, the key of the person's own copy). */
export interface FavoriteResult {
  key: string;
  kind: 'sticker' | 'gif';
  already: boolean;
}

async function errorOf(res: Response, fallback: string): Promise<Error> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return new Error(data.error || fallback);
}

/** Adds a sticker or GIF seen in a chat, post or comment to the person's favorites. Bundled ones are only a key; uploads are copied on the server. */
export async function addFavorite(stickerKey: string, fetchImpl: typeof fetch = fetch): Promise<FavoriteResult> {
  if (!parseStickerKey(stickerKey)) throw new Error('This sticker cannot be added.');
  const res = await fetchImpl('/api/stickers/favorites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sticker_key: stickerKey }) });
  if (!res.ok) throw await errorOf(res, 'Could not add it to your favorites.');
  const data = (await res.json()) as { key: string; kind: 'sticker' | 'gif'; already?: boolean };
  return { key: data.key, kind: data.kind, already: data.already === true || res.status === 200 };
}

/** Takes a favorite away. A bundled sticker leaves the favorites list; a saved copy leaves the library (which deletes the copy). */
export async function removeFavorite(stickerKey: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const parsed = parseStickerKey(stickerKey);
  if (!parsed) throw new Error('This sticker cannot be removed.');
  const res =
    parsed.kind === 'app'
      ? await fetchImpl(`/api/stickers/favorites/${encodeURIComponent(stickerKey)}`, { method: 'DELETE' })
      : await fetchImpl(`/api/stickers/library/${encodeURIComponent(parsed.mediaId)}`, { method: 'DELETE' });
  if (!res.ok) throw await errorOf(res, 'Could not remove it.');
}

/** The bundled stickers the person has starred. Saved copies of uploads come with the library. */
export async function fetchFavoriteKeys(fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const res = await fetchImpl('/api/stickers/favorites');
  if (!res.ok) throw await errorOf(res, 'Could not load your favorites.');
  return ((await res.json()) as { keys?: string[] }).keys ?? [];
}
