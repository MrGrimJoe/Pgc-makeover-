import React, { useState, useEffect } from 'react';
import type { PublicProfileResponse, PostItem } from '../../shared/schema.ts';
import { MoreVertical } from 'lucide-react';
import { ReportModal } from '../components/ReportModal.tsx';
import { avatarInitial } from '../lib/initial.ts';

interface ProfileViewPageProps {
  initialUsername?: string;
  currentUserId?: string;
  currentUsername?: string;
  onNavigateToEditProfile?: () => void;
  onLogout?: () => Promise<void> | void;
  onOpenDirectMessage?: (user: {
    id?: string;
    username: string;
    display_name: string;
    avatar_media_id: string | null;
  }) => void;
}

export const ProfileViewPage: React.FC<ProfileViewPageProps> = ({
  initialUsername = '',
  currentUserId,
  currentUsername,
  onNavigateToEditProfile,
  onLogout,
  onOpenDirectMessage,
}) => {
  const [profile, setProfile] = useState<PublicProfileResponse | null>(null);
  const [userPosts, setUserPosts] = useState<PostItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [togglingFollow, setTogglingFollow] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [isBlocked, setIsBlocked] = useState(false);
  const [showReport, setShowReport] = useState(false);

  const targetUsername = initialUsername || currentUsername || '';

  const fetchProfile = async (u: string) => {
    if (!u.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(u.trim())}`);
      if (!res.ok) {
        if (res.status === 401) {
          throw new Error('Please sign in to view profiles.');
        }
        if (res.status === 404) {
          throw new Error(`@${u.trim()} not found.`);
        }
        throw new Error(`Failed to load profile (${res.status})`);
      }
      const data = (await res.json()) as PublicProfileResponse;
      setProfile(data);

      // Fetch user's posts for the 3-column grid
      const postsRes = await fetch(`/api/feed?author=${encodeURIComponent(u.trim())}`);
      if (postsRes.ok) {
        const postsData = (await postsRes.json()) as { posts: PostItem[] };
        setUserPosts(postsData.posts || []);
      } else {
        setUserPosts([]);
      }

      // Check block status
      fetch('/api/blocks')
        .then(async (bRes) => {
          if (bRes.ok) {
            const bData = (await bRes.json()) as { blocks?: { username: string }[] };
            const blocked = (bData.blocks || []).some(
              (b) => b.username.toLowerCase() === u.trim().toLowerCase()
            );
            setIsBlocked(blocked);
          }
        })
        .catch(() => {});
    } catch (err) {
      setProfile(null);
      setUserPosts([]);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (targetUsername) {
      fetchProfile(targetUsername);
    }
  }, [targetUsername]);

  const handleToggleFollow = async () => {
    if (!profile || !profile.username) return;
    setTogglingFollow(true);

    const isCurrentlyFollowing = !!profile.is_following;
    const method = isCurrentlyFollowing ? 'DELETE' : 'POST';

    try {
      const res = await fetch(`/api/users/${encodeURIComponent(profile.username)}/follow`, { method });
      if (res.ok) {
        setProfile((prev) =>
          prev
            ? {
                ...prev,
                is_following: !isCurrentlyFollowing,
                followers_count: Math.max(
                  0,
                  (prev.followers_count || 0) + (isCurrentlyFollowing ? -1 : 1)
                ),
              }
            : null
        );
      }
    } catch {
      // Ignore network error on follow toggle
    } finally {
      setTogglingFollow(false);
    }
  };

  const handleBlockToggle = async () => {
    if (!profile || !profile.username) return;
    setShowMenu(false);
    try {
      if (isBlocked) {
        const res = await fetch(`/api/blocks/${encodeURIComponent(profile.username)}`, {
          method: 'DELETE',
        });
        if (res.ok) {
          setIsBlocked(false);
        }
      } else {
        const res = await fetch('/api/blocks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: profile.username }),
        });
        if (res.ok) {
          setIsBlocked(true);
          setError(`You blocked @${profile.username}`);
          setProfile(null);
        }
      }
    } catch {
      // Ignore
    }
  };

  // Determine if this profile is the current authenticated user's own profile
  const isSelf =
    Boolean(profile && currentUsername && profile.username.toLowerCase() === currentUsername.toLowerCase()) ||
    Boolean(profile && currentUserId && (profile.user_id === currentUserId || profile.id === currentUserId));

  return (
    <div className="w-full max-w-[430px] mx-auto min-h-screen bg-[var(--bg,#fff)] text-[var(--text,#17233A)]">
      {/* Loading Skeleton */}
      {loading && (
        <div className="p-4 space-y-4">
          <div className="flex items-center gap-6">
            <div className="w-[80px] h-[80px] rounded-full bg-[var(--line,#E8EBF0)] animate-pulse shrink-0" />
            <div className="flex flex-1 justify-around">
              <div className="w-12 h-8 bg-[var(--line,#E8EBF0)] rounded animate-pulse" />
              <div className="w-12 h-8 bg-[var(--line,#E8EBF0)] rounded animate-pulse" />
              <div className="w-12 h-8 bg-[var(--line,#E8EBF0)] rounded animate-pulse" />
            </div>
          </div>
          <div className="w-32 h-4 bg-[var(--line,#E8EBF0)] rounded animate-pulse" />
          <div className="w-48 h-3 bg-[var(--line,#E8EBF0)] rounded animate-pulse" />
          <div className="w-full h-9 bg-[var(--line,#E8EBF0)] rounded animate-pulse" />
        </div>
      )}

      {/* Error state */}
      {error && !loading && (
        <div role="alert" className="py-16 text-center space-y-2 px-4">
          <p className="text-[14px] text-[var(--muted,#5B6577)]">{error}</p>
        </div>
      )}

      {/* Profile screen */}
      {profile && !loading && (
        <div>
          {/* Header row: 80px avatar and three stats */}
          <div className="flex items-center gap-6 p-4">
            <div className="w-[80px] h-[80px] rounded-full bg-[var(--tint,#EAF0FA)] text-[var(--blue,#244C8A)] font-semibold text-[30px] flex items-center justify-center shrink-0">
              {avatarInitial(profile.display_name, profile.username)}
            </div>
            <div className="flex flex-1 justify-around text-center text-[13px] text-[var(--muted,#5B6577)]">
              <div>
                <b className="block text-[17px] text-[var(--text,#17233A)] font-semibold leading-tight">
                  {userPosts.length || profile.posts_count || 0}
                </b>
                posts
              </div>
              <div>
                <b className="block text-[17px] text-[var(--text,#17233A)] font-semibold leading-tight">
                  {profile.followers_count ?? 0}
                </b>
                followers
              </div>
              <div>
                <b className="block text-[17px] text-[var(--text,#17233A)] font-semibold leading-tight">
                  {profile.following_count ?? 0}
                </b>
                following
              </div>
            </div>
          </div>

          {/* Identity & Bio */}
          <div className="px-4 text-[14px]">
            <b className="font-semibold text-[15px] block text-[var(--text,#17233A)]">
              {profile.display_name}
            </b>
            <span className="text-[var(--muted,#5B6577)] text-[13px] block">
              @{profile.username}
              {profile.class_name ? ` · ${profile.class_name}` : ''}
            </span>
            {profile.bio && (
              <div className="mt-1 text-[14px] text-[var(--text,#17233A)] whitespace-pre-wrap">
                {profile.bio}
              </div>
            )}
          </div>

          {/* Action Row */}
          <div className="flex gap-2 p-3 px-4">
            {isSelf ? (
              <>
                <button
                  type="button"
                  onClick={onNavigateToEditProfile}
                  className="flex-1 min-h-[44px] rounded-[8px] border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[var(--text,#17233A)] text-[13px] font-semibold hover:bg-[var(--bg2,#F8F9FC)] cursor-pointer flex items-center justify-center transition-colors"
                >
                  Edit profile
                </button>
                {onLogout && (
                  <button
                    type="button"
                    onClick={onLogout}
                    className="flex-1 min-h-[44px] rounded-[8px] border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[var(--text,#17233A)] text-[13px] font-semibold hover:bg-[var(--bg2,#F8F9FC)] cursor-pointer flex items-center justify-center transition-colors"
                  >
                    Sign out
                  </button>
                )}
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleToggleFollow}
                  disabled={togglingFollow}
                  className={`flex-1 min-h-[44px] rounded-[8px] font-semibold text-[13px] transition-colors cursor-pointer flex items-center justify-center ${
                    profile.is_following
                      ? 'border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[var(--text,#17233A)] hover:bg-[var(--bg2,#F8F9FC)]'
                      : 'border border-[var(--blue,#244C8A)] bg-[var(--blue,#244C8A)] text-white hover:opacity-95'
                  }`}
                >
                  {profile.is_following ? 'Following' : 'Follow'}
                </button>
                {onOpenDirectMessage && (
                  <button
                    type="button"
                    onClick={() =>
                      onOpenDirectMessage({
                        username: profile.username,
                        display_name: profile.display_name,
                        avatar_media_id: profile.avatar_media_id,
                      })
                    }
                    className="flex-1 min-h-[44px] rounded-[8px] border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[var(--text,#17233A)] text-[13px] font-semibold hover:bg-[var(--bg2,#F8F9FC)] cursor-pointer flex items-center justify-center transition-colors"
                  >
                    Message
                  </button>
                )}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowMenu((prev) => !prev)}
                    className="w-[44px] h-[44px] min-w-[44px] min-h-[44px] rounded-[8px] border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[var(--text,#17233A)] flex items-center justify-center cursor-pointer hover:bg-[var(--bg2,#F8F9FC)] transition-colors"
                    title="User options"
                    aria-label="User options"
                  >
                    <MoreVertical className="w-4 h-4" />
                  </button>
                  {showMenu && (
                    <div className="absolute right-0 mt-1 w-32 bg-[var(--bg,#fff)] border border-[var(--line,#E8EBF0)] rounded-[8px] shadow-lg py-1 z-30">
                      <button
                        type="button"
                        onClick={handleBlockToggle}
                        className="w-full text-left px-3 py-2 min-h-[44px] flex items-center text-[13px] font-semibold text-[var(--danger,#B23A40)] hover:bg-[var(--bg2,#F8F9FC)] cursor-pointer"
                      >
                        {isBlocked ? 'Unblock' : 'Block'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowMenu(false);
                          setShowReport(true);
                        }}
                        className="w-full text-left px-3 py-2 min-h-[44px] flex items-center text-[13px] font-medium text-[var(--text,#17233A)] hover:bg-[var(--bg2,#F8F9FC)] cursor-pointer"
                      >
                        Report
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* 3-column grid with 2px gaps and square tiles under 1px top line */}
          <div className="grid grid-cols-3 gap-[2px] border-t border-[var(--line,#E8EBF0)] mt-1">
            {userPosts.map((post) => (
              <div
                key={post.id}
                className="aspect-square bg-[var(--bg2,#F8F9FC)] relative overflow-hidden flex items-center justify-center"
              >
                {post.media && post.media.length > 0 && post.media[0] ? (
                  <img
                    src={`/api/media/${post.media[0].id}`}
                    alt={`Post by @${profile.username}`}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full bg-gradient-to-br from-[var(--tint,#EAF0FA)] to-[#c9d8f0] p-2 flex items-center justify-center text-[12px] text-[var(--text,#17233A)] overflow-hidden font-normal text-center select-none">
                    <span className="line-clamp-3 leading-tight">{post.body}</span>
                  </div>
                )}
              </div>
            ))}
          </div>

          {userPosts.length === 0 && (
            <div className="py-12 text-center text-[13px] text-[var(--muted,#5B6577)] border-t border-[var(--line,#E8EBF0)] mt-1">
              No posts yet
            </div>
          )}
        </div>
      )}

      {/* Report Modal */}
      {showReport && profile && (
        <ReportModal
          targetType="user"
          targetId={profile.username}
          onClose={() => setShowReport(false)}
          onReportSubmitted={() => {
            setShowReport(false);
          }}
        />
      )}
    </div>
  );
};
