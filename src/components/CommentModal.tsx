import React, { useState, useEffect } from 'react';
import type { CommentItem, CommentsResponse } from '../../shared/schema.ts';
import { X, Trash2 } from 'lucide-react';

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
  const [commentText, setCommentText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const handleAddComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!commentText.trim()) return;

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/posts/${postId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: commentText.trim() }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error || 'Failed to add comment');
      }

      const newComment = (await res.json()) as CommentItem;
      setComments((prev) => [...prev, newComment]);
      setCommentText('');
      if (onCommentCountChange) onCommentCountChange(1);
    } catch (err) {
      setError((err as Error).message);
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
    <div className="fixed inset-0 z-50 bg-[#17233A]/40 flex items-center justify-center p-4">
      <div className="bg-surface border border-border rounded-sm p-4 max-w-[480px] w-full max-h-[80vh] flex flex-col shadow-sheet">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-border">
          <span className="text-[15px] font-semibold text-text">Comments</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center text-text-muted hover:text-text cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div className="my-2 p-2 rounded-sm bg-danger-tint text-danger text-[13px]">
            {error}
          </div>
        )}

        {/* Comment list */}
        <div className="flex-1 overflow-y-auto py-3 space-y-3">
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
                className="py-2 border-b border-border/60 space-y-1 text-[15px]"
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
                      className="text-text-muted hover:text-danger min-h-[32px] min-w-[32px] flex items-center justify-center cursor-pointer"
                      title="Delete comment"
                      aria-label="Delete comment"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <p className="text-text text-[15px] whitespace-pre-wrap">{comment.body}</p>
              </div>
            ))}
        </div>

        {/* Input box */}
        <form onSubmit={handleAddComment} className="pt-3 border-t border-border flex items-center gap-2">
          <input
            type="text"
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            placeholder="Add a comment..."
            maxLength={500}
            className="flex-1 min-h-[44px] bg-bg border border-border rounded-sm px-3 py-2 text-[15px] text-text focus:outline-none focus:border-primary transition-colors"
          />
          <button
            type="submit"
            disabled={submitting || !commentText.trim()}
            className="min-h-[44px] px-3 font-semibold text-[14px] text-primary hover:text-primary-hover disabled:opacity-40 cursor-pointer transition-colors"
          >
            {submitting ? 'Posting...' : 'Post'}
          </button>
        </form>
      </div>
    </div>
  );
};
