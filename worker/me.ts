import type { D1Database } from '@cloudflare/workers-types';
import type { MeResponse } from '../shared/schema.ts';
import type { UserRow, UserSettingsRow } from './types.ts';
import { campusName, findCampus } from '../shared/campus.ts';

/**
 * Builds the profile part of GET /api/me. Reads named columns only, so private data
 * (email, roll number) can never be returned by accident.
 */
export async function loadMeProfile(db: D1Database, userId: string): Promise<MeResponse['profile'] | null> {
  const row = await db
    .prepare(
      `SELECT p.username, p.username_normalized, p.display_name, p.bio, p.avatar_media_id,
              p.class_id, p.campus_id, p.campus_other, p.real_name, p.wallpaper_id, p.wallpaper_media_id, p.theme_id, p.text_style_id,
              c.name AS class_name
       FROM profiles p
       LEFT JOIN classes c ON c.id = p.class_id
       WHERE p.user_id = ?`
    )
    .bind(userId)
    .first<{
      username: string;
      username_normalized: string;
      display_name: string;
      bio: string;
      avatar_media_id: string | null;
      class_id: string | null;
      campus_id: string | null;
      campus_other: string | null;
      real_name: string | null;
      wallpaper_id: string | null;
      wallpaper_media_id: string | null;
      theme_id: string | null;
      text_style_id: string | null;
      class_name: string | null;
    }>();

  if (!row) return null;
  return {
    username: row.username,
    username_normalized: row.username_normalized,
    display_name: row.display_name,
    bio: row.bio,
    avatar_media_id: row.avatar_media_id,
    class_id: row.class_id || null,
    class_name: row.class_name || null,
    // An id that is no longer in the bundled list resolves to "no campus".
    campus_id: findCampus(row.campus_id) ? row.campus_id : null,
    campus_name: campusName(row.campus_id),
    campus_other: row.campus_other || null,
    real_name: row.real_name || null,
    wallpaper_id: row.wallpaper_id || null,
    wallpaper_media_id: row.wallpaper_id === 'custom' ? row.wallpaper_media_id || null : null,
    theme_id: row.theme_id || null,
    text_style_id: row.text_style_id || null,
  };
}

export async function buildMeResponse(
  db: D1Database,
  user: Pick<UserRow, 'id' | 'created_at' | 'status'>,
  settings: Pick<UserSettingsRow, 'dm_policy' | 'feed_preferences'>
): Promise<MeResponse | null> {
  const profile = await loadMeProfile(db, user.id);
  if (!profile) return null;
  return {
    user: { id: user.id, created_at: user.created_at, status: user.status },
    profile,
    settings: { dm_policy: settings.dm_policy, feed_preferences: settings.feed_preferences },
  };
}
