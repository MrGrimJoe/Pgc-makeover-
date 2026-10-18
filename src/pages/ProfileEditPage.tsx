import React, { useState, useEffect } from 'react';
import type { MeResponse, ClassRow, UserInterestTopic, BlockItem } from '../../shared/schema.ts';
import { normalizeUsername, isValidUsername } from '../../shared/username.ts';
import { updateProfileSchema } from '../../shared/schema.ts';
import { X } from 'lucide-react';

interface ProfileEditPageProps {
  currentUser: MeResponse;
  onProfileUpdated: (updated: MeResponse) => void;
  onAccountDeleted: () => void;
  onViewPublicProfile: (username: string) => void;
  onLogout?: () => Promise<void> | void;
  onCancel?: () => void;
}

export const ProfileEditPage: React.FC<ProfileEditPageProps> = ({
  currentUser,
  onProfileUpdated,
  onAccountDeleted,
  onLogout,
  onCancel,
}) => {
  const [username, setUsername] = useState(currentUser.profile.username);
  const [displayName, setDisplayName] = useState(currentUser.profile.display_name);
  const [bio, setBio] = useState(currentUser.profile.bio || '');
  const [classId, setClassId] = useState(currentUser.profile.class_id || '');
  const [dmPolicy, setDmPolicy] = useState(currentUser.settings.dm_policy || 'everyone');

  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [interests, setInterests] = useState<UserInterestTopic[]>([]);
  const [blockedUsers, setBlockedUsers] = useState<BlockItem[]>([]);
  const [resettingInterests, setResettingInterests] = useState(false);

  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Deletion modal state
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmationText, setDeleteConfirmationText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Load campus classes, interests, and blocked users on mount
  useEffect(() => {
    fetch('/api/classes')
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { classes?: ClassRow[] };
        setClasses(data.classes || []);
      })
      .catch(() => {});

    fetch('/api/me/interests')
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { interests?: UserInterestTopic[] };
        setInterests(data.interests || []);
      })
      .catch(() => {});

    fetch('/api/blocks')
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { blocks?: BlockItem[] };
        setBlockedUsers(data.blocks || []);
      })
      .catch(() => {});
  }, []);

  const handleResetInterests = async () => {
    setResettingInterests(true);
    try {
      const res = await fetch('/api/me/interests', { method: 'DELETE' });
      if (res.ok) {
        setInterests([]);
        setMessage({ type: 'success', text: 'Interests reset.' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to reset interests.' });
    } finally {
      setResettingInterests(false);
    }
  };

  const handleRemoveInterest = async (topicId: string) => {
    try {
      const res = await fetch(`/api/me/interests/${topicId}`, { method: 'DELETE' });
      if (res.ok) {
        setInterests((prev) => prev.filter((i) => i.topic_id !== topicId));
      }
    } catch {
      // Ignored
    }
  };

  const handleUnblock = async (blockedUserId: string) => {
    try {
      const res = await fetch(`/api/blocks/${encodeURIComponent(blockedUserId)}`, { method: 'DELETE' });
      if (res.ok) {
        setBlockedUsers((prev) => prev.filter((b) => b.user_id !== blockedUserId));
      }
    } catch {
      // Ignored
    }
  };

  const normalizedPreview = normalizeUsername(username);
  const isUsernameValid = isValidUsername(normalizedPreview);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);

    const payload = {
      username: normalizedPreview !== currentUser.profile.username ? normalizedPreview : undefined,
      display_name: displayName,
      bio: bio,
      class_id: classId || null,
      dm_policy: dmPolicy as 'everyone' | 'following' | 'none',
    };

    const parsed = updateProfileSchema.safeParse(payload);
    if (!parsed.success) {
      setMessage({
        type: 'error',
        text: parsed.error.issues[0]?.message || 'Invalid input data',
      });
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errData = (await res.json()) as { error?: string };
        throw new Error(errData.error || 'Failed to update profile');
      }

      const updated = (await res.json()) as MeResponse;
      onProfileUpdated(updated);
      setMessage({ type: 'success', text: 'Profile updated.' });
    } catch (err) {
      setMessage({ type: 'error', text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (deleteConfirmationText !== currentUser.profile.username) {
      setDeleteError(`Type "${currentUser.profile.username}" to confirm`);
      return;
    }

    setDeleting(true);
    setDeleteError(null);

    try {
      const res = await fetch('/api/me', { method: 'DELETE' });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error || 'Failed to delete account');
      }
      onAccountDeleted();
    } catch (err) {
      setDeleteError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="w-full max-w-[640px] mx-auto px-4 py-3 space-y-5">
      {/* Top action bar: Cancel on left, Save on right */}
      <div className="flex items-center justify-between pb-3 border-b border-border">
        <button
          type="button"
          onClick={onCancel}
          className="text-[15px] text-text-muted hover:text-text cursor-pointer min-h-[44px] flex items-center transition-colors"
        >
          Cancel
        </button>
        <span className="text-[15px] font-semibold text-text">Edit profile</span>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={saving || !isUsernameValid || !displayName.trim()}
          className="text-[15px] font-semibold text-primary hover:text-primary-hover disabled:opacity-40 cursor-pointer min-h-[44px] flex items-center transition-colors"
        >
          {saving ? 'Saving...' : 'Done'}
        </button>
      </div>

      {message && (
        <div
          role="alert"
          className={`p-3 rounded-sm text-[13px] ${
            message.type === 'success'
              ? 'bg-primary-tint text-primary'
              : 'bg-danger-tint text-danger'
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Form Fields */}
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Name */}
        <div>
          <label htmlFor="display-name" className="block text-[13px] font-medium text-text-muted mb-1">
            Name
          </label>
          <input
            id="display-name"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={50}
            required
            className="w-full min-h-[44px] bg-surface border border-border rounded-sm px-3 py-2 text-[15px] text-text focus:outline-none focus:border-primary transition-colors"
          />
        </div>

        {/* Username */}
        <div>
          <label htmlFor="username" className="block text-[13px] font-medium text-text-muted mb-1">
            Username
          </label>
          <input
            id="username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            maxLength={30}
            required
            className="w-full min-h-[44px] bg-surface border border-border rounded-sm px-3 py-2 text-[15px] text-text font-mono focus:outline-none focus:border-primary transition-colors"
          />
          {username && !isUsernameValid && (
            <span className="text-[12px] text-danger mt-1 block">
              3-30 letters, numbers, underscores only
            </span>
          )}
        </div>

        {/* Bio */}
        <div>
          <label htmlFor="bio" className="block text-[13px] font-medium text-text-muted mb-1">
            Bio
          </label>
          <textarea
            id="bio"
            rows={3}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={500}
            placeholder="Add a bio..."
            className="w-full bg-surface border border-border rounded-sm p-3 text-[15px] text-text focus:outline-none focus:border-primary resize-none transition-colors"
          />
          <span className="text-[12px] text-text-muted font-mono block text-right mt-0.5">
            {bio.length} / 500
          </span>
        </div>

        {/* Class Association */}
        <div>
          <label htmlFor="class-select" className="block text-[13px] font-medium text-text-muted mb-1">
            Class
          </label>
          <select
            id="class-select"
            value={classId}
            onChange={(e) => setClassId(e.target.value)}
            className="w-full min-h-[44px] bg-surface border border-border rounded-sm px-3 py-2 text-[15px] text-text focus:outline-none focus:border-primary transition-colors cursor-pointer"
          >
            <option value="">None selected</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {/* DM Policy */}
        <div>
          <label htmlFor="dm-policy-select" className="block text-[13px] font-medium text-text-muted mb-1">
            Direct Messages
          </label>
          <select
            id="dm-policy-select"
            value={dmPolicy}
            onChange={(e) => setDmPolicy(e.target.value)}
            className="w-full min-h-[44px] bg-surface border border-border rounded-sm px-3 py-2 text-[15px] text-text focus:outline-none focus:border-primary transition-colors cursor-pointer"
          >
            <option value="everyone">Everyone</option>
            <option value="following">People I follow</option>
            <option value="none">No one</option>
          </select>
        </div>
      </form>

      {/* Discovery Interests */}
      {interests.length > 0 && (
        <div className="pt-4 border-t border-border space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-text-muted">Interests</span>
            <button
              type="button"
              onClick={handleResetInterests}
              disabled={resettingInterests}
              className="text-[13px] text-text-muted hover:text-danger cursor-pointer"
            >
              {resettingInterests ? 'Resetting...' : 'Reset'}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {interests.map((item) => (
              <span
                key={item.topic_id}
                className="text-[13px] text-text-muted bg-surface border border-border pl-2.5 pr-1.5 py-1 rounded-sm flex items-center space-x-1"
              >
                <span>#{item.slug}</span>
                <button
                  type="button"
                  onClick={() => handleRemoveInterest(item.topic_id)}
                  title={`Remove #${item.slug}`}
                  aria-label={`Remove #${item.slug}`}
                  className="min-h-[44px] min-w-[44px] -my-2 -mr-1.5 p-0.5 hover:text-danger cursor-pointer flex items-center justify-center"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Blocked users list */}
      <div className="pt-6 border-t border-[var(--line,#E8EBF0)] space-y-3">
        <label className="text-[13px] font-semibold text-[var(--muted,#5B6577)] uppercase tracking-[0.4px] block">
          Blocked users
        </label>
        {blockedUsers.length === 0 ? (
          <p className="text-[13px] text-[var(--muted,#5B6577)]">No blocked users</p>
        ) : (
          <div className="divide-y divide-[var(--line,#E8EBF0)] border border-[var(--line,#E8EBF0)] rounded-[8px] overflow-hidden">
            {blockedUsers.map((bu) => (
              <div key={bu.user_id} className="flex items-center justify-between p-3 bg-[var(--bg,#fff)]">
                <div>
                  <span className="font-semibold text-[14px] text-[var(--text,#17233A)] block">
                    {bu.display_name}
                  </span>
                  <span className="text-[12px] text-[var(--muted,#5B6577)] block">
                    @{bu.username}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleUnblock(bu.user_id)}
                  aria-label={`Unblock @${bu.username}`}
                  className="min-h-[44px] px-3.5 rounded-[6px] border border-[var(--line,#E8EBF0)] text-[12px] font-semibold text-[var(--text,#17233A)] hover:bg-[var(--bg2,#F8F9FC)] cursor-pointer flex items-center justify-center"
                >
                  Unblock
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Account actions: Logout & Delete */}
      <div className="pt-6 border-t border-border space-y-3">
        {onLogout && (
          <button
            type="button"
            onClick={onLogout}
            className="w-full min-h-[44px] text-center text-[14px] font-semibold text-text hover:text-danger transition-colors cursor-pointer"
          >
            Log out
          </button>
        )}

        <button
          type="button"
          onClick={() => setShowDeleteModal(true)}
          className="w-full min-h-[44px] text-center text-[14px] text-danger hover:underline transition-colors cursor-pointer"
        >
          Delete account
        </button>
      </div>

      {/* Delete Confirmation Sheet Modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 bg-[#17233A]/40 flex items-center justify-center p-4">
          <div className="bg-surface border border-border rounded-sm p-4 max-w-[400px] w-full space-y-4 shadow-sheet">
            <h3 className="text-[16px] font-semibold text-danger">Delete account</h3>
            <p className="text-[14px] text-text-muted leading-relaxed">
              This will permanently delete your account, posts, comments, and media. To confirm, type your username <strong>@{currentUser.profile.username}</strong> below:
            </p>

            {deleteError && (
              <div role="alert" className="p-2 rounded-sm bg-danger-tint text-danger text-[13px]">
                {deleteError}
              </div>
            )}

            <input
              type="text"
              value={deleteConfirmationText}
              onChange={(e) => setDeleteConfirmationText(e.target.value)}
              placeholder={currentUser.profile.username}
              aria-label="Confirm username to delete account"
              className="w-full min-h-[44px] bg-bg border border-border rounded-sm px-3 py-2 text-[15px] text-text font-mono focus:outline-none focus:border-danger transition-colors"
            />

            <div className="flex justify-end space-x-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setShowDeleteModal(false);
                  setDeleteConfirmationText('');
                  setDeleteError(null);
                }}
                disabled={deleting}
                className="min-h-[44px] px-3 text-[14px] text-text-muted hover:text-text cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteAccount}
                disabled={deleting || deleteConfirmationText !== currentUser.profile.username}
                className="min-h-[44px] px-4 rounded-sm bg-danger text-on-primary font-semibold text-[14px] hover:bg-danger/90 disabled:opacity-40 cursor-pointer transition-colors"
              >
                {deleting ? 'Deleting...' : 'Delete permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
