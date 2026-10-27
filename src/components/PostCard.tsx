import { StickerView } from './StickerView.tsx';
import { PollView } from './PollView.tsx';
import React, { useEffect, useState } from 'react';
import type { PostItem } from '../../shared/schema.ts';
import { ExpiryChip } from './ExpiryChip.tsx';
import { Heart, MessageSquare, Flag, Trash2 } from 'lucide-react';
import { CommentModal } from './CommentModal.tsx';
import { ReportModal } from './ReportModal.tsx';
import { Avatar } from './Avatar.tsx';
import { PhotoViewer } from './PhotoViewer.tsx';

interface PostCardProps {
  post: PostItem;
  currentUserId: string;
  onPostDeleted?: (postId: string) => void;
  onViewAuthorProfile?: (username: string) => void;
  onTopicClick?: (topicSlug: string) => void;
  /** Reports like/comment changes so a parent that unmounts and re-creates this card can restore them. */
  onEngagementChange?: (postId: string, state: { likes_count: number; has_liked: boolean; comments_count: number }) => void;
}

export const PostCard: React.FC<PostCardProps> = ({
  post,
  currentUserId,
  onPostDeleted,
  onViewAuthorProfile,
  onTopicClick,
  onEngagementChange,
}) => {
  const [likesCount, setLikesCount] = useState(post.likes_count);
  const [hasLiked, setHasLiked] = useState(post.has_liked);
  const [commentsCount, setCommentsCount] = useState(post.comments_count);
  const [showComments, setShowComments] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [likePopping, setLikePopping] = useState(false);
  const [viewingPhotos, setViewingPhotos] = useState(false);

  useEffect(() => {
    onEngagementChange?.(post.id, { likes_count: likesCount, has_liked: hasLiked, comments_count: commentsCount });
  }, [post.id, likesCount, hasLiked, commentsCount, onEngagementChange]);


  const handleToggleLike = async () => {
    const nextLiked = !hasLiked;
    const nextCount = nextLiked ? likesCount + 1 : Math.max(0, likesCount - 1);

    setHasLiked(nextLiked);
    setLikesCount(nextCount);
    if (nextLiked) {
      setLikePopping(true);
      setTimeout(() => setLikePopping(false), 200);
    }

    try {
      const method = nextLiked ? 'POST' : 'DELETE';
      const res = await fetch(`/api/posts/${post.id}/likes`, { method });
      if (!res.ok) {
        setHasLiked(!nextLiked);
        setLikesCount(likesCount);
      }
    } catch {
      setHasLiked(!nextLiked);
      setLikesCount(likesCount);
    }
  };

  const handleDeletePost = async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/posts/${post.id}`, { method: 'DELETE' });
      if (res.ok) {
        if (onPostDeleted) onPostDeleted(post.id);
      } else {
        setConfirmDelete(false);
        setDeleting(false);
      }
    } catch {
      setConfirmDelete(false);
      setDeleting(false);
    }
  };

  // Photos only: an uploaded sticker or GIF is shown through sticker_key, not as a full-bleed picture
  const photos = (post.media ?? []).filter((m) => !m.kind || m.kind === 'photo');
  const hasImage = photos.length > 0;
  const isAuthor = post.author_id === currentUserId;

  const renderBodyWithTags = (text: string) => {
    const parts = text.split(/(#[\w-]+)/g);
    return parts.map((part, idx) => {
      if (part.startsWith('#')) {
        const slug = part.slice(1);
        return (
          <span
            key={idx}
            onClick={(e) => {
              e.stopPropagation();
              if (onTopicClick) onTopicClick(slug);
            }}
            className="text-[var(--blue,#244C8A)] cursor-pointer hover:underline font-normal"
          >
            {part}
          </span>
        );
      }
      return part;
    });
  };

  return (
    <article className="rise-in border-b border-[var(--line,#E8EBF0)] pt-3 pb-2 text-[var(--text,#17233A)]">
      {/* Header Row: 32px avatar, name + class below, time-left on right */}
      <div className="flex items-center gap-2.5 px-4 pb-2.5">
        <button
          type="button"
          onClick={() => onViewAuthorProfile && onViewAuthorProfile(post.author_username)}
          className="rounded-full shrink-0 cursor-pointer border-0 p-0 bg-transparent"
          title={`View @${post.author_username}`}
          aria-label={`View @${post.author_username}`}
        >
          <Avatar
            mediaId={post.author_avatar_media_id}
            displayName={post.author_display_name}
            username={post.author_username}
            size={32}
          />
        </button>

        <div className="flex-1 min-w-0">
          <button
            type="button"
            onClick={() => onViewAuthorProfile && onViewAuthorProfile(post.author_username)}
            className="font-semibold text-[14px] leading-tight text-[var(--text,#17233A)] hover:underline block text-left truncate cursor-pointer bg-transparent border-0 p-0"
          >
            {post.author_username}
          </button>
          {post.author_class_name && (
            <span className="block text-[12px] font-normal text-[var(--muted,#5B6577)] leading-tight truncate">
              {post.author_class_name}
            </span>
          )}
        </div>

        <div className="shrink-0 flex items-center gap-2">
          <ExpiryChip expiresAt={post.expires_at} />
          {isAuthor && (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={deleting}
              title="Delete post"
              aria-label="Delete post"
              className="w-[44px] h-[44px] min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--muted,#5B6577)] hover:text-[var(--danger,#B23A40)] cursor-pointer bg-transparent border-0 p-0 -mr-2"
            >
              <Trash2 className="w-4 h-4 stroke-[1.7]" />
            </button>
          )}
        </div>
      </div>

      {/* Delete confirmation inline banner */}
      {confirmDelete && (
        <div role="alert" className="mx-4 mb-2 p-2 rounded-[8px] bg-[var(--bg2,#F8F9FC)] border border-[var(--danger,#B23A40)] text-[var(--danger,#B23A40)] text-[13px] flex items-center justify-between">
          <span>Delete post permanently?</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleDeletePost}
              disabled={deleting}
              className="px-2.5 py-1 min-h-[44px] rounded-[6px] bg-[var(--danger,#B23A40)] text-white font-semibold text-[12px] cursor-pointer flex items-center"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="px-2 py-1 min-h-[44px] rounded-[6px] border border-[var(--line,#E8EBF0)] text-[var(--text,#17233A)] text-[12px] cursor-pointer hover:bg-[var(--bg,#fff)] flex items-center"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Content Rendering */}
      {hasImage ? (
        <>
          {/* Full-bleed image at 4:5 aspect ratio */}
          <div className="w-full aspect-[4/5] bg-[var(--bg2,#F8F9FC)] overflow-hidden">
            <button
              type="button"
              onClick={() => setViewingPhotos(true)}
              aria-label={`Open photo by @${post.author_username}`}
              className="block w-full h-full p-0 border-0 bg-transparent cursor-pointer"
            >
              <img
                src={`/api/media/${photos[0]!.id}`}
                alt={`Photo post by @${post.author_username}`}
                className="w-full h-full object-cover"
                loading="lazy"
              />
            </button>
          </div>
          {viewingPhotos && <PhotoViewer photos={photos} label={`Photo by @${post.author_username}`} onClose={() => setViewingPhotos(false)} />}

          {/* Action Row: 24px icons with 44px tap targets, report flag on the far right */}
          <div className="flex items-center gap-4 px-4 pt-2.5">
            <button
              type="button"
              onClick={handleToggleLike}
              title={hasLiked ? 'Unlike' : 'Like'}
              aria-label={hasLiked ? 'Unlike' : 'Like'}
              className={`w-[44px] h-[44px] -my-2.5 -ml-2.5 flex items-center justify-center cursor-pointer bg-transparent hover:bg-[var(--bg2,#F8F9FC)] rounded-full border-0 ${
                hasLiked ? 'text-[var(--danger,#B23A40)]' : 'text-[var(--text,#17233A)]'
              }`}
            >
              <Heart
                className={`w-6 h-6 stroke-[1.7] ${
                  hasLiked ? 'fill-[var(--danger,#B23A40)] stroke-[var(--danger,#B23A40)]' : ''
                } ${likePopping ? 'like-pop' : ''}`}
              />
            </button>

            <button
              type="button"
              onClick={() => setShowComments(true)}
              title="Comment"
              aria-label="Comment"
              className="w-[44px] h-[44px] -my-2.5 -ml-2.5 flex items-center justify-center text-[var(--text,#17233A)] cursor-pointer bg-transparent hover:bg-[var(--bg2,#F8F9FC)] rounded-full border-0"
            >
              <MessageSquare className="w-6 h-6 stroke-[1.7]" />
            </button>

            <button
              type="button"
              onClick={() => setShowReport(true)}
              title="Report"
              aria-label="Report"
              className="w-[44px] h-[44px] -my-2.5 -mr-2.5 ml-auto flex items-center justify-center text-[var(--text,#17233A)] hover:text-[var(--danger,#B23A40)] cursor-pointer bg-transparent hover:bg-[var(--bg2,#F8F9FC)] rounded-full border-0"
            >
              <Flag className="w-6 h-6 stroke-[1.7]" />
            </button>
          </div>

          {/* Likes count */}
          <div className="px-4 pt-0.5 text-[13px] text-[var(--muted,#5B6577)]">
            <b className="font-semibold text-[var(--text,#17233A)]">
              {likesCount} {likesCount === 1 ? 'like' : 'likes'}
            </b>
          </div>

          {/* Caption */}
          <div className="px-4 pt-2 text-[15px] leading-normal break-words">
            <b className="font-semibold text-[var(--text,#17233A)] mr-1.5">
              {post.author_username}
            </b>
            {renderBodyWithTags(post.body)}
          </div>

          {post.sticker_key && (
            <div className="px-4 pt-2">
              <StickerView stickerKey={post.sticker_key} size={160} media={post.media} favoritable />
            </div>
          )}

          {/* Comments link */}
          <div className="px-4 pt-1 pb-1 text-[13px] text-[var(--muted,#5B6577)]">
            <button
              type="button"
              onClick={() => setShowComments(true)}
              className="text-[var(--muted,#5B6577)] hover:underline cursor-pointer bg-transparent border-0 p-0 text-[13px]"
            >
              {commentsCount > 0
                ? `View all ${commentsCount} comments`
                : 'Add a comment'}
            </button>
          </div>
        </>
      ) : (
        <>
          {/* Text-only post: text at 17px directly under header */}
          <div className="px-4 pt-0 pb-1 text-[17px] leading-normal break-words">
            {renderBodyWithTags(post.body)}
          </div>

          {post.sticker_key && (
            <div className="px-4 pt-2">
              <StickerView stickerKey={post.sticker_key} size={160} media={post.media} favoritable />
            </div>
          )}

          {post.poll && <PollView postId={post.id} poll={post.poll} />}

          {/* Action Row */}
          <div className="flex items-center gap-4 px-4 pt-2.5">
            <button
              type="button"
              onClick={handleToggleLike}
              title={hasLiked ? 'Unlike' : 'Like'}
              aria-label={hasLiked ? 'Unlike' : 'Like'}
              className={`w-[44px] h-[44px] -my-2.5 -ml-2.5 flex items-center justify-center cursor-pointer bg-transparent hover:bg-[var(--bg2,#F8F9FC)] rounded-full border-0 ${
                hasLiked ? 'text-[var(--danger,#B23A40)]' : 'text-[var(--text,#17233A)]'
              }`}
            >
              <Heart
                className={`w-6 h-6 stroke-[1.7] ${
                  hasLiked ? 'fill-[var(--danger,#B23A40)] stroke-[var(--danger,#B23A40)]' : ''
                } ${likePopping ? 'like-pop' : ''}`}
              />
            </button>

            <button
              type="button"
              onClick={() => setShowComments(true)}
              title="Comment"
              aria-label="Comment"
              className="w-[44px] h-[44px] -my-2.5 -ml-2.5 flex items-center justify-center text-[var(--text,#17233A)] cursor-pointer bg-transparent hover:bg-[var(--bg2,#F8F9FC)] rounded-full border-0"
            >
              <MessageSquare className="w-6 h-6 stroke-[1.7]" />
            </button>

            <button
              type="button"
              onClick={() => setShowReport(true)}
              title="Report"
              aria-label="Report"
              className="w-[44px] h-[44px] -my-2.5 -mr-2.5 ml-auto flex items-center justify-center text-[var(--text,#17233A)] hover:text-[var(--danger,#B23A40)] cursor-pointer bg-transparent hover:bg-[var(--bg2,#F8F9FC)] rounded-full border-0"
            >
              <Flag className="w-6 h-6 stroke-[1.7]" />
            </button>
          </div>

          {/* Meta line: "3 likes · 2 comments" */}
          <div className="px-4 pt-0.5 pb-1 text-[13px] text-[var(--muted,#5B6577)]">
            <b className="font-semibold text-[var(--text,#17233A)]">
              {likesCount} {likesCount === 1 ? 'like' : 'likes'}
            </b>
            {commentsCount > 0 && ` · ${commentsCount} ${commentsCount === 1 ? 'comment' : 'comments'}`}
          </div>
        </>
      )}

      {/* Modals */}
      {showComments && (
        <CommentModal
          postId={post.id}
          currentUserId={currentUserId}
          onClose={() => setShowComments(false)}
          onCommentCountChange={(delta) => setCommentsCount((c) => Math.max(0, c + delta))}
        />
      )}

      {showReport && (
        <ReportModal
          targetType="post"
          targetId={post.id}
          onClose={() => setShowReport(false)}
          onReportSubmitted={() => {
            setShowReport(false);
          }}
        />
      )}
    </article>
  );
};
