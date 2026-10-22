import React, { useRef, useState } from 'react';
import type { MediaItem } from '../../shared/schema.ts';
import { Image, Smile, X } from 'lucide-react';
import { PickerPanel } from '../components/chat/PickerPanel.tsx';
import { MediaPreview } from '../components/chat/MediaPreview.tsx';
import { StickerView } from '../components/StickerView.tsx';
import { useFocusTrap } from '../lib/focus-trap.ts';
import { browserMediaEnv, compressPhoto } from '../lib/media.ts';
import { prepareAndUpload, uploadBlob } from '../lib/media-upload.ts';

interface PostComposerPageProps {
  /** The signed-in person (recent stickers are remembered per person on this device). */
  currentUserId: string;
  onPostCreated: () => void;
  onCancel?: () => void;
}

export const PostComposerPage: React.FC<PostComposerPageProps> = ({
  currentUserId,
  onPostCreated,
  onCancel,
}) => {
  const [body, setBody] = useState('');
  const [mediaList, setMediaList] = useState<MediaItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // A post carries photos OR one sticker/GIF (polls join them later), never a mix
  const [stickerKey, setStickerKey] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [addFiles, setAddFiles] = useState<File[] | null>(null);
  const [libraryKey, setLibraryKey] = useState(0);
  const sheetRef = useRef<HTMLDivElement>(null);
  useFocusTrap(sheetRef, () => setPickerOpen(false), pickerOpen);
  const photoPickerDisabled = mediaList.length >= 4 || uploading || !!stickerKey;

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    if (mediaList.length + files.length > 4) {
      setError('Maximum 4 images allowed.');
      return;
    }

    setUploading(true);
    setError(null);

    try {
      const env = browserMediaEnv();
      for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
        // Scaled to 1600 px and re-encoded on the phone before upload: saves data, drops EXIF
        const prepared = await compressPhoto(file, env);
        const mediaItem = await uploadBlob(prepared.blob, 'photo', { width: prepared.width, height: prepared.height, thumb: prepared.thumb });
        setMediaList((prev) => [...prev, mediaItem]);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handleRemoveMedia = (mediaId: string) => {
    setMediaList((prev) => prev.filter((m) => m.id !== mediaId));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim() || submitting) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: body.trim(),
          media_ids: mediaList.map((m) => m.id),
          ...(stickerKey ? { sticker_key: stickerKey } : {}),
        }),
      });

      if (!res.ok) {
        const errData = (await res.json()) as { error?: string };
        throw new Error(errData.error || 'Failed to publish post');
      }

      setBody('');
      setMediaList([]);
      setStickerKey(null);
      onPostCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full max-w-[430px] mx-auto min-h-screen bg-[var(--bg,#fff)] flex flex-col">
      {/* Top bar 48px: Cancel (muted) left, "New post" centered, Post (blue) right */}
      <div className="h-[48px] px-4 flex items-center justify-between border-b border-[var(--line,#E8EBF0)] font-semibold">
        <button
          type="button"
          onClick={onCancel || onPostCreated}
          className="text-[15px] font-normal text-[var(--muted,#5B6577)] hover:text-[var(--text,#17233A)] cursor-pointer min-h-[44px] flex items-center bg-transparent border-0 p-0"
        >
          Cancel
        </button>

        <span className="text-[15px] font-semibold text-[var(--text,#17233A)]">
          New post
        </span>

        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting || !body.trim() || uploading}
          className="text-[15px] font-semibold text-[var(--blue,#244C8A)] disabled:opacity-40 cursor-pointer min-h-[44px] flex items-center bg-transparent border-0 p-0"
        >
          {submitting ? 'Posting...' : 'Post'}
        </button>
      </div>

      {error && (
        <div role="alert" className="m-4 p-2.5 rounded-[8px] bg-[var(--bg2,#F8F9FC)] border border-[var(--danger,#B23A40)] text-[var(--danger,#B23A40)] text-[13px]">
          {error}
        </div>
      )}

      {/* Borderless 17px textarea, min height 150px, 16px padding */}
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="What's happening? Use #topics so classmates can find it"
        aria-label="What's happening? Use #topics so classmates can find it"
        maxLength={1000}
        autoFocus
        className="w-full border-0 outline-none resize-none bg-transparent text-[var(--text,#17233A)] text-[17px] p-4 min-h-[150px] leading-relaxed"
      />

      {/* Image thumbnails 72px square, 8px radius, in a row */}
      {mediaList.length > 0 && (
        <div className="flex gap-2 px-4 py-2 overflow-x-auto">
          {mediaList.map((m) => (
            <div
              key={m.id}
              className="relative w-[72px] h-[72px] rounded-[8px] overflow-hidden bg-[var(--bg2,#F8F9FC)] border border-[var(--line,#E8EBF0)] shrink-0"
            >
              <img
                src={`/api/media/${m.id}`}
                alt="Upload preview"
                className="w-full h-full object-cover"
              />
              <button
                type="button"
                onClick={() => handleRemoveMedia(m.id)}
                aria-label="Remove image"
                className="absolute top-0 right-0 w-[44px] h-[44px] min-w-[44px] min-h-[44px] flex items-center justify-center text-white cursor-pointer"
              >
                <span className="p-1 rounded-full bg-[#17233A]/70 hover:bg-[var(--danger,#B23A40)] transition-colors flex items-center justify-center">
                  <X className="w-3 h-3 stroke-[2]" />
                </span>
              </button>
            </div>
          ))}
        </div>
      )}

      {stickerKey && (
        <div className="flex items-center gap-2 px-4 py-2">
          <StickerView stickerKey={stickerKey} size={96} />
          <button type="button" onClick={() => setStickerKey(null)} aria-label="Remove sticker" className="min-h-[44px] px-3 rounded-full border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[13px] text-[var(--text,#17233A)] cursor-pointer">Remove</button>
        </div>
      )}

      {/* Image attach icon button */}
      <div className="px-4 py-1 flex items-center gap-2">
        {/* A real button (aria-label is not allowed on <label>): focusable, Enter/Space work,
            and disabled is a true disabled state rather than a pointer-events hack. */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={photoPickerDisabled}
          title="Add photo"
          aria-label="Add photo"
          className="w-[44px] h-[44px] flex items-center justify-center text-[var(--blue,#244C8A)] hover:opacity-80 cursor-pointer transition-opacity bg-transparent border-0 p-0 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Image className="w-6 h-6 stroke-[1.7]" aria-hidden="true" />
        </button>
        {/* Hidden native input, driven by the button above. Not focusable or exposed on its own. */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          onChange={handleFileSelect}
          tabIndex={-1}
          aria-hidden="true"
          className="hidden"
        />
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          disabled={mediaList.length > 0 || uploading}
          title="Add sticker or GIF"
          aria-label="Add sticker or GIF"
          className="w-[44px] h-[44px] flex items-center justify-center text-[var(--blue,#244C8A)] hover:opacity-80 cursor-pointer transition-opacity bg-transparent border-0 p-0 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Smile className="w-6 h-6 stroke-[1.7]" aria-hidden="true" />
        </button>
        {uploading && <span className="text-[13px] text-[var(--muted,#5B6577)]">Uploading...</span>}
      </div>

      {/* Subtle-background note with 12px radius, 13px muted text and an 8px yellow dot */}
      <div className="m-4 p-3 rounded-[12px] bg-[var(--bg2,#F8F9FC)] text-[13px] text-[var(--muted,#5B6577)] flex items-center">
        <i className="inline-block w-2 h-2 rounded-full bg-[var(--yellow,#F2C94C)] mr-1.5 shrink-0" />
        <span>Disappears in 7 days, or 14 if 3 classmates engage.</span>
      </div>

      {pickerOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50" onClick={() => setPickerOpen(false)}>
          <div ref={sheetRef} role="dialog" aria-modal="true" aria-label="Choose a sticker or GIF" tabIndex={-1} onClick={(e) => e.stopPropagation()} className="w-full max-w-[430px] h-[60vh] bg-[var(--bg,#fff)] rounded-t-[16px] flex flex-col pb-[env(safe-area-inset-bottom,0px)]">
            <div className="flex-1 min-h-0">
              <PickerPanel userId={currentUserId} reloadKey={libraryKey} onPick={(key) => { setStickerKey(key); setPickerOpen(false); }} onAddFiles={(files) => setAddFiles(files)} />
            </div>
            <button type="button" onClick={() => setPickerOpen(false)} className="min-h-[44px] bg-transparent border-0 text-[14px] font-semibold text-[var(--muted,#5B6577)] cursor-pointer">Close</button>
          </div>
        </div>
      )}
      {addFiles && (
        <MediaPreview
          files={addFiles}
          mode="library"
          onCancel={() => setAddFiles(null)}
          onConfirm={async (items) => {
            for (const item of items) {
              const uploaded = await prepareAndUpload(item);
              const r = await fetch('/api/stickers/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ media_id: uploaded.id }) });
              if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || 'Could not add it.');
            }
            setAddFiles(null);
            setLibraryKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
};
