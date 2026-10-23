import React, { useState, useEffect } from 'react';
import type { MeResponse, ClassRow } from '../../shared/schema.ts';
import { CampusPicker, type CampusChoice } from '../components/CampusPicker.tsx';
import { findCampus } from '../../shared/campus.ts';
import { Avatar } from '../components/Avatar.tsx';
import { ProfileStylePicker, type ProfileStyleValue } from '../components/ProfileStylePicker.tsx';
import { normalizeUsername, isValidUsername } from '../../shared/username.ts';
import { updateProfileSchema } from '../../shared/schema.ts';
import { prepareProfileBackground } from '../lib/media-upload.ts';

interface ProfileEditPageProps {
  currentUser: MeResponse;
  onProfileUpdated: (updated: MeResponse) => void;
  onViewPublicProfile: (username: string) => void;
  onCancel?: () => void;
}

export const ProfileEditPage: React.FC<ProfileEditPageProps> = ({
  currentUser,
  onProfileUpdated,
  onCancel,
}) => {
  const [username, setUsername] = useState(currentUser.profile.username);
  const [displayName, setDisplayName] = useState(currentUser.profile.display_name);
  const [bio, setBio] = useState(currentUser.profile.bio || '');
  const [classId, setClassId] = useState(currentUser.profile.class_id || '');
  const [realName, setRealName] = useState(currentUser.profile.real_name || '');
  const [campus, setCampus] = useState<CampusChoice | null>(
    currentUser.profile.campus_id
      ? { campus: { id: currentUser.profile.campus_id, name: currentUser.profile.campus_name || 'Your campus', city: findCampus(currentUser.profile.campus_id)?.city ?? '' } }
      : currentUser.profile.campus_other
        ? { other: currentUser.profile.campus_other }
        : null
  );
  const [avatarMediaId, setAvatarMediaId] = useState<string | null>(currentUser.profile.avatar_media_id ?? null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [uploadingBackground, setUploadingBackground] = useState(false);
  const [style, setStyle] = useState<ProfileStyleValue>({
    wallpaper_id: currentUser.profile.wallpaper_id ?? null,
    wallpaper_media_id: currentUser.profile.wallpaper_media_id ?? null,
    theme_id: currentUser.profile.theme_id ?? null,
    text_style_id: currentUser.profile.text_style_id ?? null,
  });

  const [classes, setClasses] = useState<ClassRow[]>([]);

  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Deletion modal state

  // Load campus classes, interests, and blocked users on mount
  useEffect(() => {
    fetch('/api/classes')
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { classes?: ClassRow[] };
        setClasses(data.classes || []);
      })
      .catch(() => {});
  }, []);

  const normalizedPreview = normalizeUsername(username);
  const isUsernameValid = isValidUsername(normalizedPreview);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);

    const current = currentUser.profile;
    const campusIdChanged = (campus?.campus?.id ?? null) !== (current.campus_id ?? null);
    const campusOtherChanged = (campus?.other ?? null) !== (current.campus_other ?? null);
    const payload = {
      username: normalizedPreview !== current.username ? normalizedPreview : undefined,
      display_name: displayName,
      bio: bio,
      class_id: classId || null,
      // Only send what changed, so an unchanged campus or photo is never re-validated
      real_name: realName.trim() && realName.trim() !== (current.real_name || '') ? realName.trim() : undefined,
      // A listed campus and a free-text campus never go together; the server clears the other one.
      campus_id: campusIdChanged && !campus?.other ? (campus?.campus?.id ?? null) : undefined,
      campus_other: campusOtherChanged && !campus?.campus ? (campus?.other ?? null) : undefined,
      avatar_media_id: avatarMediaId !== (current.avatar_media_id ?? null) ? avatarMediaId : undefined,
      // A new image is sent alone (the server makes the wallpaper 'custom'); anything else is a preset change or a removal.
      wallpaper_media_id:
        style.wallpaper_media_id && style.wallpaper_media_id !== (current.wallpaper_media_id ?? null) ? style.wallpaper_media_id : undefined,
      wallpaper_id:
        style.wallpaper_media_id && style.wallpaper_media_id !== (current.wallpaper_media_id ?? null)
          ? undefined
          : style.wallpaper_id !== (current.wallpaper_id ?? null)
            ? style.wallpaper_id
            : undefined,
      theme_id: style.theme_id !== (current.theme_id ?? null) ? style.theme_id : undefined,
      text_style_id: style.text_style_id !== (current.text_style_id ?? null) ? style.text_style_id : undefined,
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

  const handleBackgroundChosen = async (file: File) => {
    setUploadingBackground(true);
    setMessage(null);
    try {
      const uploaded = await prepareProfileBackground(file);
      setStyle((s) => ({ ...s, wallpaper_id: 'custom', wallpaper_media_id: uploaded.id }));
    } catch (err) {
      setMessage({ type: 'error', text: (err as Error).message });
    } finally {
      setUploadingBackground(false);
    }
  };

  const handlePhotoChosen = async (file: File | undefined) => {
    if (!file) return;
    setUploadingPhoto(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/media/uploads', { method: 'POST', body: form });
      const data = (await res.json()) as { id?: string; media?: { id?: string }; error?: string };
      const mediaId = data.id ?? data.media?.id;
      if (!res.ok || !mediaId) throw new Error(data.error || 'Could not upload that photo');
      setAvatarMediaId(mediaId);
    } catch (err) {
      setMessage({ type: 'error', text: (err as Error).message });
    } finally {
      setUploadingPhoto(false);
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
          disabled={saving || uploadingPhoto || uploadingBackground || !isUsernameValid || !displayName.trim()}
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
        {/* Profile photo */}
        <div className="flex items-center gap-4">
          <Avatar mediaId={avatarMediaId} displayName={displayName} username={username} size={64} />
          <div className="flex flex-wrap gap-2">
            <input
              id="profile-photo"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only peer"
              onChange={(e) => {
                handlePhotoChosen(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <label
              htmlFor="profile-photo"
              className="min-h-[44px] px-4 rounded-[8px] border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[var(--text,#17233A)] text-[13px] font-semibold flex items-center cursor-pointer peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--blue,#244C8A)]"
            >
              {uploadingPhoto ? 'Uploading...' : avatarMediaId ? 'Change photo' : 'Add photo'}
            </label>
            {avatarMediaId && (
              <button
                type="button"
                onClick={() => setAvatarMediaId(null)}
                className="min-h-[44px] px-3 text-[13px] font-semibold text-[var(--muted,#5B6577)] cursor-pointer bg-transparent border-0"
              >
                Remove
              </button>
            )}
          </div>
        </div>

        {/* Display name (shown on posts and messages) */}
        <div>
          <label htmlFor="display-name" className="block text-[13px] font-medium text-text-muted mb-1">
            Display name
          </label>
          <input
            id="display-name"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={50}
            required
            aria-describedby="display-name-help"
            className="w-full min-h-[44px] bg-surface border border-border rounded-sm px-3 py-2 text-[15px] text-text focus:outline-none focus:border-primary transition-colors"
          />
          <p id="display-name-help" className="mt-1 text-[12px] text-text-muted">
            Shown on your posts and messages.
          </p>
        </div>

        {/* Real name (profile page only) */}
        <div>
          <label htmlFor="real-name" className="block text-[13px] font-medium text-text-muted mb-1">
            Real name
          </label>
          <input
            id="real-name"
            type="text"
            autoComplete="name"
            value={realName}
            onChange={(e) => setRealName(e.target.value)}
            maxLength={60}
            aria-describedby="real-name-help"
            className="w-full min-h-[44px] bg-surface border border-border rounded-sm px-3 py-2 text-[15px] text-text focus:outline-none focus:border-primary transition-colors"
          />
          <p id="real-name-help" className="mt-1 text-[12px] text-text-muted">
            Shown on your profile page only.
          </p>
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

        {/* Campus */}
        <CampusPicker id="edit-campus" label="Campus" value={campus} onChange={setCampus} />
      </form>

      {/* Profile style */}
      <div className="pt-4 border-t border-border space-y-3">
        <span className="text-[13px] font-semibold text-text">Profile style</span>
        <ProfileStylePicker
          value={style}
          onChange={setStyle}
          displayName={displayName}
          username={normalizedPreview || currentUser.profile.username}
          bio={bio}
          avatarMediaId={avatarMediaId}
          onPickImage={handleBackgroundChosen}
          uploadingImage={uploadingBackground}
        />
      </div>
    </div>
  );
};
