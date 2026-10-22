/**
 * Extension point for GIF search from a third-party provider (Tenor, Giphy and the like). NOT IMPLEMENTED and not
 * used anywhere: this version ships only bundled stickers/GIFs and the ones people upload themselves.
 *
 * If a provider is added later, results must be turned into something the app already understands rather than
 * hot-linked: download the GIF through the person's device and upload it as kind "gif" (so size caps, quotas,
 * retention and moderation all apply), then send it as a `usr:<mediaId>` key. Do not store provider URLs in
 * messages, posts or comments: the key forms are `app:` and `usr:` only (see shared/sticker-keys.ts).
 */
export interface GifSearchResult {
  /** Provider's own id, for attribution and de-duplication only. */
  id: string;
  /** Short description for screen readers. */
  alt: string;
  /** A small preview to show in the picker grid. */
  previewUrl: string;
  /** The file to fetch when the person picks it. */
  downloadUrl: string;
  width: number;
  height: number;
}

export interface GifProvider {
  /** Shown in the picker so people know where results come from (many providers require attribution). */
  name: string;
  search(query: string, signal?: AbortSignal): Promise<GifSearchResult[]>;
}
