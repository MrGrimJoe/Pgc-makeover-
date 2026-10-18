import React, { useState } from 'react';
import type { MediaItem } from '../../shared/schema.ts';
import { Image, X } from 'lucide-react';

interface PostComposerPageProps {
  onPostCreated: () => void;
  onCancel?: () => void;
}

export const PostComposerPage: React.FC<PostComposerPageProps> = ({
  onPostCreated,
  onCancel,
}) => {
  const [body, setBody] = useState('');
  const [mediaList, setMediaList] = useState<MediaItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      for (let i = 0; i < files.length; i++) {
        const file = files[i]!;

        // Validate size (5MB max)
        if (file.size > 5 * 1024 * 1024) {
          throw new Error(`"${file.name}" exceeds 5 MB limit.`);
        }

        const formData = new FormData();
        formData.append('file', file);

        const res = await fetch('/api/media/uploads', {
          method: 'POST',
          body: formData,
        });

        if (!res.ok) {
          const errData = (await res.json()) as { error?: string };
          throw new Error(errData.error || `Upload failed for "${file.name}"`);
        }

        const mediaItem = (await res.json()) as MediaItem;
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
        }),
      });

      if (!res.ok) {
        const errData = (await res.json()) as { error?: string };
        throw new Error(errData.error || 'Failed to publish post');
      }

      setBody('');
      setMediaList([]);
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

      {/* Image attach icon button */}
      <div className="px-4 py-1 flex items-center gap-2">
        <label
          htmlFor="composer-photo-input"
          className={`w-[44px] h-[44px] flex items-center justify-center text-[var(--blue,#244C8A)] hover:opacity-80 cursor-pointer transition-opacity ${
            mediaList.length >= 4 || uploading ? 'opacity-40 pointer-events-none' : ''
          }`}
          title="Add photo"
          aria-label="Add photo"
        >
          <Image className="w-6 h-6 stroke-[1.7]" />
        </label>
        <input
          id="composer-photo-input"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          onChange={handleFileSelect}
          aria-label="Upload photo"
          className="hidden"
        />
        {uploading && <span className="text-[13px] text-[var(--muted,#5B6577)]">Uploading...</span>}
      </div>

      {/* Subtle-background note with 12px radius, 13px muted text and an 8px yellow dot */}
      <div className="m-4 p-3 rounded-[12px] bg-[var(--bg2,#F8F9FC)] text-[13px] text-[var(--muted,#5B6577)] flex items-center">
        <i className="inline-block w-2 h-2 rounded-full bg-[var(--yellow,#F2C94C)] mr-1.5 shrink-0" />
        <span>Disappears in 7 days, or 14 if 3 classmates engage.</span>
      </div>
    </div>
  );
};
