import React, { useEffect, useState } from 'react';
import { avatarInitial } from '../lib/initial.ts';

interface AvatarProps {
  /** Uploaded profile picture. Falls back to one letter when missing or when it fails to load. */
  mediaId?: string | null;
  displayName?: string | null;
  username?: string | null;
  /** Pixel size of the circle. */
  size: number;
  /** Ring color (a profile theme accent). */
  ringColor?: string | null;
  className?: string;
}

/** Round avatar: the profile picture, or a single initial on the app's tint color. */
export const Avatar: React.FC<AvatarProps> = ({ mediaId, displayName, username, size, ringColor, className = '' }) => {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [mediaId]);

  const style: React.CSSProperties = {
    width: size,
    height: size,
    fontSize: Math.round(size * 0.4),
    ...(ringColor ? { boxShadow: `0 0 0 3px ${ringColor}` } : {}),
  };

  return (
    <span
      className={`rounded-full bg-[var(--tint,#EAF0FA)] text-[var(--blue,#244C8A)] font-semibold flex items-center justify-center shrink-0 overflow-hidden ${className}`}
      style={style}
    >
      {mediaId && !failed ? (
        <img
          src={`/api/media/${encodeURIComponent(mediaId)}`}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          onError={() => setFailed(true)}
          className="w-full h-full object-cover"
        />
      ) : (
        avatarInitial(displayName, username)
      )}
    </span>
  );
};
