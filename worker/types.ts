import type { D1Database, R2Bucket } from '@cloudflare/workers-types';

export interface Env {
  // Cloudflare D1 Database binding
  DB: D1Database;

  // Cloudflare R2 Bucket binding for media storage
  MEDIA_BUCKET?: R2Bucket;

  // Cloudflare Workers Static Assets binding
  ASSETS?: { fetch: (request: Request) => Promise<Response> };

  // Google OAuth 2.0 Web Client ID
  GOOGLE_CLIENT_ID: string;

  // Google OAuth 2.0 Client Secret
  GOOGLE_CLIENT_SECRET: string;

  // Canonical base application URL (e.g. http://localhost:3000 or production domain)
  APP_URL: string;

  // Environment mode (e.g., development, production, test)
  ENVIRONMENT?: string;

  // Admin secret for privileged jobs and moderation endpoints
  ADMIN_SECRET?: string;
}

export interface ClassRow {
  id: string;
  name: string;
}

export interface UserRow {
  id: string;
  provider_subject: string;
  created_at: string;
  status: string;
  /** 'user' | 'admin' | 'master' as stored; use effectiveRole() in worker/admin.ts to decide what someone may do */
  role?: string;
}

export interface ProfileRow {
  user_id: string;
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
}

export interface UserSettingsRow {
  user_id: string;
  dm_policy: string;
  feed_preferences: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  expires_at: string;
}

export interface PostRow {
  id: string;
  author_id: string;
  body: string;
  created_at: string;
  expires_at: string;
  status: string;
}

export interface MediaRow {
  id: string;
  owner_id: string;
  object_key: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  expires_at: string;
}

export interface PostMediaRow {
  post_id: string;
  media_id: string;
}

export interface PostReactionRow {
  post_id: string;
  user_id: string;
  type: string;
  created_at: string;
}

export interface CommentRow {
  id: string;
  post_id: string;
  author_id: string;
  body: string;
  created_at: string;
  expires_at: string;
}

export interface FollowRow {
  follower_id: string;
  followed_id: string;
  created_at: string;
}

export interface ReportRow {
  id: string;
  reporter_id: string;
  target_type: string;
  target_id: string;
  reason: string;
  status: string;
  created_at: string;
}

export interface OAuthStatePayload {
  state: string;
  codeVerifier: string;
  nonce: string;
  createdAt: number;
  /** Whether the person pressed "Log in" or "Sign up". Missing means login. */
  intent?: 'login' | 'signup';
}

export interface ConversationRow {
  id: string;
  created_at: string;
}

export interface ConversationMemberRow {
  conversation_id: string;
  user_id: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  sticker_key?: string | null;
  sent_at: string;
  expires_at: string;
}

export interface MessageMediaRow {
  message_id: string;
  media_id: string;
}

export interface BlockRow {
  blocker_id: string;
  blocked_id: string;
  created_at: string;
}

export interface ReportEvidenceRow {
  id: string;
  report_id: string;
  snapshot: string;
  created_at: string;
  expires_at: string;
}

export interface SignupTicketRow {
  id: string;
  provider_subject: string;
  email: string | null;
  display_name: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}
