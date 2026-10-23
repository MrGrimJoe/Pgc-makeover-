import { Composer } from './chat/Composer.tsx';
import { PickerPanel } from './chat/PickerPanel.tsx';
import { MediaPreview } from './chat/MediaPreview.tsx';
import { ReportModal } from './ReportModal.tsx';
import { StickerView } from './StickerView.tsx';
import { prepareAndUpload } from '../lib/media-upload.ts';
import React, { useState, useEffect } from 'react';
import type { CommentItem, CommentsResponse } from '../../shared/schema.ts';
import { X, Trash2 } from 'lucide-react';
import { BottomSheet } from './BottomSheet.tsx';

interface CommentModalProps {
  postId: string;
  currentUserId: string;
  onClose: () => void;
  onCommentCountChange?: (delta: number) => void;
}

export const CommentModal: React.FC<CommentModalProps> = ({
  postId,
  currentUserId,
  onClose,
  onCommentCountChange,
}) => {
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [stickerKey, setStickerKey] = useState<string | null>(null);
  const [reportingId, setReportingId] = useState<string | null>(null);
  const [addFiles, setAddFiles] = useState<File[] | null>(null);
  const [libraryKey, setLibraryKey] = useState(0);

  const fetchComments = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/posts/${postId}/comments`);
      if (res.ok) {
        const data = (await res.json()) as CommentsResponse;
        setComments(data.comments || []);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchComments();
  }, [postId]);

  const addComment = async (text: string) => {
    if (!text.trim() && !stickerKey) return;

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/posts/${postId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text.trim(), ...(stickerKey ? { sticker_key: stickerKey } : {}) }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error || 'Failed to add comment');
      }

      const newComment = (await res.json()) as CommentItem;
      setStickerKey(null);
      setPickerOpen(false);
      setComments((prev) => [...prev, newComment]);
      if (onCommentCountChange) onCommentCountChange(1);
    } catch (err) {
      setError((err as Error).message);
      throw err; // keeps the text in the box so nothing typed is lost
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    try {
      const res = await fetch(`/api/comments/${commentId}`, { method: 'DELETE' });
      if (res.ok) {
        setComments((prev) => prev.filter((c) => c.id !== commentId));
        if (onCommentCountChange) onCommentCountChange(-1);
      }
    } catch {
      // Ignore deletion network error
    }
  };

  return (
    <BottomSheet label="Comments" onClose={onClose} className="h-[78vh] max-h-[78vh] px-4 pb-4">
      {({ requestClose }) => (
      <>
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-border">
          <span className="text-[15px] font-semibold text-text">Comments</span>
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center text-text-muted hover:text-text cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div role="alert" className="my-2 p-2 rounded-sm bg-danger-tint text-danger text-[13px]">
            {error}
          </div>
        )}

        {/* Comment list */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain py-3 space-y-3">
          {loading && (
            <div className="space-y-3 py-2">
              {[1, 2].map((i) => (
                <div key={i} className="space-y-1 animate-skeleton">
                  <div className="w-24 h-3.5 bg-border rounded-sm" />
                  <div className="w-48 h-3 bg-border rounded-sm" />
                </div>
              ))}
            </div>
          )}

          {!loading && comments.length === 0 && (
            <div className="text-center py-8 text-text-muted text-[15px]">
              No comments yet.
            </div>
          )}

          {!loading &&
            comments.map((comment) => (
              <div
                key={comment.id}
                className="rise-in py-2 border-b border-border/60 space-y-1 text-[15px]"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-1.5 truncate">
                    <span className="font-semibold text-text text-[14px]">
                      {comment.author_username}
                    </span>
                    <span className="text-[12px] text-text-muted">
                      · {new Date(comment.created_at).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  {comment.author_id === currentUserId && (
                    <button
                      type="button"
                      onClick={() => handleDeleteComment(comment.id)}
                      className="text-text-muted hover:text-danger min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer"
                      title="Delete comment"
                      aria-label="Delete comment"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
                {comment.body && <p className="text-text text-[15px] whitespace-pre-wrap">{comment.body}</p>}
                {comment.sticker_key && <StickerView stickerKey={comment.sticker_key} size={120} />}
                {comment.author_id !== currentUserId && (
                  <button type="button" onClick={() => setReportingId(comment.id)} aria-label="Report this comment" className="min-h-[44px] px-1 bg-transparent border-0 text-[12px] text-text-muted hover:text-danger cursor-pointer">Report</button>
                )}
              </div>
            ))}
        </div>

        {/* Input box */}
        <div className="pt-3 border-t border-border">
          {stickerKey && (
            <div className="flex items-center gap-2 pb-2">
              <StickerView stickerKey={stickerKey} size={56} />
              <button type="button" onClick={() => setStickerKey(null)} aria-label="Remove sticker" className="min-h-[44px] px-3 rounded-full border border-border bg-transparent text-[13px] text-text cursor-pointer">Remove</button>
            </div>
          )}
          <Composer
            variant="compact"
            onSend={addComment}
            busy={submitting}
            placeholder="Add a comment..."
            label="Add a comment"
            maxLength={500}
            canSendEmpty={!!stickerKey}
            pickerOpen={pickerOpen}
            onTogglePicker={() => setPickerOpen((o) => !o)}
            picker={
              <PickerPanel
                userId={currentUserId}
                reloadKey={libraryKey}
                onPick={(key) => { setStickerKey(key); setPickerOpen(false); }}
                onAddFiles={(files) => setAddFiles(files)}
              />
            }
          />
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
          {reportingId && (
            <ReportModal targetType="comment" targetId={reportingId} onClose={() => setReportingId(null)} onReportSubmitted={() => setReportingId(null)} />
          )}
        </div>
      </>
      )}
    </BottomSheet>
  );
};
