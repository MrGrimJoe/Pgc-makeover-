import React from 'react';
import { WALLPAPERS, THEMES, TEXT_STYLES, resolveProfileStyle, CUSTOM_WALLPAPER_SCRIM } from '../../shared/presets.ts';
import { Avatar } from './Avatar.tsx';

export interface ProfileStyleValue {
  wallpaper_id: string | null;
  /** The person's own background image; set when wallpaper_id is 'custom'. */
  wallpaper_media_id?: string | null;
  theme_id: string | null;
  text_style_id: string | null;
}

interface ProfileStylePickerProps {
  value: ProfileStyleValue;
  onChange: (next: ProfileStyleValue) => void;
  /** Used only for the live preview. */
  displayName: string;
  username: string;
  bio: string;
  avatarMediaId: string | null;
  /** Called with the chosen file; the page compresses and uploads it. Omit to hide the own-image controls. */
  onPickImage?: (file: File) => void;
  uploadingImage?: boolean;
}

const optionBase =
  'block rounded-[8px] border border-[var(--line,#E8EBF0)] cursor-pointer text-center text-[13px] text-[var(--text,#17233A)] ' +
  'peer-checked:border-[var(--blue,#244C8A)] peer-checked:ring-2 peer-checked:ring-[var(--blue,#244C8A)] ' +
  'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--blue,#244C8A)]';

/** Wallpaper, accent and text style choices with a live preview. All choices are fixed presets. */
export const ProfileStylePicker: React.FC<ProfileStylePickerProps> = ({
  value,
  onChange,
  displayName,
  username,
  bio,
  avatarMediaId,
  onPickImage,
  uploadingImage = false,
}) => {
  const style = resolveProfileStyle(value);
  const current = {
    wallpaper: value.wallpaper_id === 'custom' && value.wallpaper_media_id ? 'custom' : (value.wallpaper_id ?? 'plain'),
    theme: value.theme_id ?? 'default',
    textStyle: value.text_style_id ?? 'clean',
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[13px] font-medium text-[var(--muted,#5B6577)] mb-1">Preview</p>
        <div
          className="rounded-[12px] border border-[var(--line,#E8EBF0)] p-4 text-[var(--text,#17233A)]"
          style={{
            ...(style.headerStyle as React.CSSProperties),
            ...(style.accent ? { borderBottom: `3px solid ${style.accent}` } : {}),
          }}
          data-testid="style-preview"
        >
          <div className="flex items-center gap-3">
            <Avatar mediaId={avatarMediaId} displayName={displayName} username={username} size={48} ringColor={style.accent} />
            <div className="min-w-0" style={style.textStyleCss as React.CSSProperties}>
              <b className="block text-[15px] truncate" style={{ fontWeight: style.textStyleCss.fontWeight ?? 600 }}>
                {displayName || username}
              </b>
              <span className="block text-[13px] text-[var(--muted,#5B6577)] truncate">@{username}</span>
            </div>
          </div>
          {bio && (
            <p className="mt-2 text-[14px] whitespace-pre-wrap" style={style.textStyleCss as React.CSSProperties}>
              {bio}
            </p>
          )}
        </div>
      </div>

      <fieldset>
        <legend className="text-[13px] font-medium text-[var(--muted,#5B6577)] mb-1">Wallpaper</legend>
        <div className="grid grid-cols-3 gap-2">
          {WALLPAPERS.map((w) => (
            <label key={w.id} className="relative">
              <input
                type="radio"
                name="profile-wallpaper"
                value={w.id}
                checked={current.wallpaper === w.id}
                onChange={() => onChange({ ...value, wallpaper_id: w.id === 'plain' ? null : w.id, wallpaper_media_id: null })}
                className="sr-only peer"
              />
              <span className={`${optionBase} overflow-hidden`}>
                <span
                  aria-hidden="true"
                  className="block h-10"
                  style={w.stops.length === 2 ? { background: `linear-gradient(160deg, ${w.stops[0]}, ${w.stops[1]})` } : { background: 'var(--bg2,#F8F9FC)' }}
                />
                <span className="block py-1.5">{w.label}</span>
              </span>
            </label>
          ))}
          {value.wallpaper_media_id && (
            <label className="relative">
              <input
                type="radio"
                name="profile-wallpaper"
                value="custom"
                checked={current.wallpaper === 'custom'}
                onChange={() => onChange({ ...value, wallpaper_id: 'custom' })}
                className="sr-only peer"
              />
              <span className={`${optionBase} overflow-hidden`}>
                <span
                  aria-hidden="true"
                  className="block h-10"
                  style={{
                    backgroundImage: `linear-gradient(${CUSTOM_WALLPAPER_SCRIM}, ${CUSTOM_WALLPAPER_SCRIM}), url(/api/media/${encodeURIComponent(value.wallpaper_media_id)})`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                    backgroundColor: '#3a3a3c',
                  }}
                />
                <span className="block py-1.5">Your image</span>
              </span>
            </label>
          )}
        </div>
        {onPickImage && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center justify-center min-h-[44px] px-4 rounded-[8px] border border-[var(--line,#E8EBF0)] text-[14px] text-[var(--text,#17233A)] cursor-pointer focus-within:outline focus-within:outline-2 focus-within:outline-[var(--blue,#244C8A)]">
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                disabled={uploadingImage}
                aria-label={value.wallpaper_media_id ? 'Replace your background image' : 'Choose your own background image'}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) onPickImage(file);
                }}
              />
              {uploadingImage ? 'Preparing image...' : value.wallpaper_media_id ? 'Replace image' : 'Use your own image'}
            </label>
            {value.wallpaper_media_id && (
              <button
                type="button"
                onClick={() => onChange({ ...value, wallpaper_id: null, wallpaper_media_id: null })}
                className="min-h-[44px] px-4 rounded-[8px] text-[14px] text-[var(--danger,#B3261E)] cursor-pointer"
              >
                Remove image
              </button>
            )}
          </div>
        )}
        <p className="mt-1 text-[12px] text-[var(--muted,#5B6577)]">
          Your image is darkened so the text on top stays readable. Everyone signed in can see it.
        </p>
      </fieldset>

      <fieldset>
        <legend className="text-[13px] font-medium text-[var(--muted,#5B6577)] mb-1">Accent color</legend>
        <div className="grid grid-cols-3 gap-2">
          {THEMES.map((t) => (
            <label key={t.id} className="relative">
              <input
                type="radio"
                name="profile-theme"
                value={t.id}
                checked={current.theme === t.id}
                onChange={() => onChange({ ...value, theme_id: t.id === 'default' ? null : t.id })}
                className="sr-only peer"
              />
              <span className={`${optionBase} py-2 flex items-center justify-center gap-2`}>
                <span
                  aria-hidden="true"
                  className="inline-block w-4 h-4 rounded-full border border-[var(--line,#E8EBF0)]"
                  style={{ background: t.accent || 'var(--blue,#244C8A)' }}
                />
                {t.label}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-[13px] font-medium text-[var(--muted,#5B6577)] mb-1">Text style</legend>
        <div className="grid grid-cols-3 gap-2">
          {TEXT_STYLES.map((t) => (
            <label key={t.id} className="relative">
              <input
                type="radio"
                name="profile-text-style"
                value={t.id}
                checked={current.textStyle === t.id}
                onChange={() => onChange({ ...value, text_style_id: t.id === 'clean' ? null : t.id })}
                className="sr-only peer"
              />
              <span
                className={`${optionBase} py-2`}
                style={{
                  ...(t.fontFamily ? { fontFamily: t.fontFamily } : {}),
                  ...(t.fontWeight ? { fontWeight: t.fontWeight } : {}),
                }}
              >
                {t.label}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
};
