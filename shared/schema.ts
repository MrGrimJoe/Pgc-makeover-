import { z } from 'zod';
import { WALLPAPER_IDS, THEME_IDS, TEXT_STYLE_IDS } from './presets.ts';

/**
 * Username constraints:
 * - 3 to 20 characters
 * - Only lowercase alphanumeric characters and underscores
 * - Cannot start or end with an underscore
 * - Cannot contain consecutive underscores
 */
export const usernameRegex = /^[a-z0-9](?:[a-z0-9]|_(?=[a-z0-9])){1,18}[a-z0-9]$/;

/**
 * Username rules, shared by sign-up, profile edit and the availability check.
 */
export const usernameSchema = z
  .string()
  .trim()
  .min(3, { message: 'Username must be at least 3 characters' })
  .max(20, { message: 'Username cannot exceed 20 characters' })
  .regex(usernameRegex, {
    message: 'Username must be lowercase letters, digits, and underscores, without leading/trailing/consecutive underscores',
  });

/** Real (legal) name collected at sign-up. Shown on the person's own profile page only. */
export const realNameSchema = z
  .string()
  .trim()
  .min(2, { message: 'Enter your real name' })
  .max(60, { message: 'Real name cannot exceed 60 characters' })
  .refine((v) => !/[\u0000-\u001F\u007F<>]/.test(v), { message: 'Real name contains invalid characters' });

/** Last three digits of the roll number. Private: stored, never returned by any API. */
export const rollLast3Schema = z
  .string()
  .regex(/^[0-9]{3}$/, { message: 'Enter exactly the last three digits of your roll number' });

/**
 * Profile update schema for PATCH /api/me
 */
export const updateProfileSchema = z
  .object({
    username: usernameSchema.optional(),
    display_name: z
      .string()
      .trim()
      .min(1, { message: 'Display name cannot be empty' })
      .max(50, { message: 'Display name cannot exceed 50 characters' })
      .optional(),
    bio: z
      .string()
      .max(500, { message: 'Bio cannot exceed 500 characters' })
      .optional(),
    avatar_media_id: z.string().nullable().optional(),
    class_id: z.string().nullable().optional(),
    campus_id: z.string().min(1).max(100).nullable().optional(),
    /** Free-text campus for people whose campus is not on the bundled list. Exclusive with campus_id. */
    campus_other: z.string().max(80).nullable().optional(),
    real_name: realNameSchema.optional(),
    wallpaper_id: z.enum(WALLPAPER_IDS).nullable().optional(),
    theme_id: z.enum(THEME_IDS).nullable().optional(),
    text_style_id: z.enum(TEXT_STYLE_IDS).nullable().optional(),
    dm_policy: z.enum(['everyone', 'followed_only', 'nobody', 'following', 'none']).optional(),
    feed_preferences: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  })
  .strict();

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/**
 * Sign-up completion schema for POST /api/signup/complete
 */
export const signupCompleteSchema = z
  .object({
    real_name: realNameSchema,
    username: usernameSchema,
    campus_id: z.string().min(1).max(100).optional(),
    campus_other: z.string().min(2).max(80).optional(),
    class_id: z.string().min(1).max(100),
    roll_last3: rollLast3Schema,
  })
  .strict()
  .refine((v) => (v.campus_id ? 1 : 0) + (v.campus_other ? 1 : 0) === 1, {
    message: 'Choose a campus from the list or enter another campus, not both',
    path: ['campus_id'],
  });

export type SignupCompleteInput = z.infer<typeof signupCompleteSchema>;

/** A campus from the bundled list (shared/campuses.ts). */
export interface CampusItem {
  id: string;
  name: string;
  city: string;
}

/** A person suggested on the search screen (GET /api/people/suggested) */
export interface SuggestedPersonItem {
  username: string;
  display_name: string;
  avatar_media_id: string | null;
  class_name: string | null;
  campus_name: string | null;
  /** Why this person is suggested. */
  relation: 'class' | 'campus';
}

/** Response of GET /api/signup/session */
export interface SignupSessionResponse {
  valid: true;
  /** Name from the Google account, to prefill the form. */
  suggested_name: string;
  /** The verified Google email, shown back to the person signing up. */
  email: string | null;
}

/**
 * Create post schema for POST /api/posts
 */
export const createPostSchema = z
  .object({
    body: z
      .string()
      .trim()
      .min(1, { message: 'Post content cannot be empty' })
      .max(1000, { message: 'Post content cannot exceed 1000 characters' }),
    media_ids: z
      .array(z.string().min(1))
      .max(4, { message: 'Maximum 4 images allowed per post' })
      .optional()
      .default([]),
  })
  .strict();

export type CreatePostInput = z.infer<typeof createPostSchema>;

/**
 * Create comment schema for POST /api/posts/:id/comments
 */
export const createCommentSchema = z
  .object({
    body: z
      .string()
      .trim()
      .min(1, { message: 'Comment cannot be empty' })
      .max(500, { message: 'Comment cannot exceed 500 characters' }),
  })
  .strict();

export type CreateCommentInput = z.infer<typeof createCommentSchema>;

/**
 * Create conversation schema for POST /api/conversations
 */
export const createConversationSchema = z
  .object({
    user_id: z.string().min(1, { message: 'Target user ID is required' }),
  })
  .strict();

export type CreateConversationInput = z.infer<typeof createConversationSchema>;

/**
 * Create message schema for POST /api/conversations/:id/messages
 */
export const createMessageSchema = z
  .object({
    /** Text is optional when the message carries media. */
    body: z
      .string()
      .trim()
      .max(2000, { message: 'Message content cannot exceed 2000 characters' })
      .optional()
      .default(''),
    media_ids: z
      .array(z.string().min(1))
      .max(4, { message: 'Maximum 4 attachments per message' })
      .optional()
      .default([]),
  })
  .strict()
  .refine((v) => v.body.length > 0 || v.media_ids.length > 0, {
    message: 'Message content cannot be empty',
    path: ['body'],
  });

export type CreateMessageInput = z.infer<typeof createMessageSchema>;

/**
 * Create block schema for POST /api/blocks
 */
export const createBlockSchema = z
  .object({
    user_id: z.string().min(1, { message: 'Target user ID is required' }),
  })
  .strict();

export type CreateBlockInput = z.infer<typeof createBlockSchema>;

/**
 * Create report schema for POST /api/reports
 */
export const createReportSchema = z
  .object({
    target_type: z.enum(['post', 'comment', 'user', 'message']),
    target_id: z.string().min(1, { message: 'Target ID required' }),
    reason: z
      .string()
      .trim()
      .min(1, { message: 'Reason cannot be empty' })
      .max(500, { message: 'Reason cannot exceed 500 characters' }),
  })
  .strict();

export type CreateReportInput = z.infer<typeof createReportSchema>;

/**
 * Post feedback schema ('more_like_this', 'show_less', 'not_interested')
 */
export const createFeedbackSchema = z
  .object({
    post_id: z.string().min(1, { message: 'Post ID required' }),
    type: z.enum(['more_like_this', 'show_less', 'not_interested']),
  })
  .strict();

export type CreateFeedbackInput = z.infer<typeof createFeedbackSchema>;

/**
 * Admin report update schema
 */
export const updateReportSchema = z
  .object({
    status: z.enum(['reviewed', 'dismissed', 'pending']),
  })
  .strict();

export type UpdateReportInput = z.infer<typeof updateReportSchema>;

/**
 * Public Profile Response (GET /api/users/:username)
 */
export interface PublicProfileResponse {
  id?: string;
  user_id?: string;
  username: string;
  display_name: string;
  bio: string;
  avatar_media_id: string | null;
  class_id?: string | null;
  class_name?: string | null;
  campus_id?: string | null;
  campus_name?: string | null;
  /** Free-text campus; never used for campus search scope. */
  campus_other?: string | null;
  /** Shown on the profile page only. */
  real_name?: string | null;
  wallpaper_id?: string | null;
  theme_id?: string | null;
  text_style_id?: string | null;
  created_at: string;
  is_following?: boolean;
  followers_count?: number;
  following_count?: number;
  posts_count?: number;
}

/**
 * Current Authenticated User Response (GET /api/me)
 */
export interface MeResponse {
  user: {
    id: string;
    created_at: string;
    status: string;
  };
  profile: {
    username: string;
    username_normalized: string;
    display_name: string;
    bio: string;
    avatar_media_id: string | null;
    class_id?: string | null;
    class_name?: string | null;
    campus_id?: string | null;
    campus_name?: string | null;
    campus_other?: string | null;
    real_name?: string | null;
    wallpaper_id?: string | null;
    theme_id?: string | null;
    text_style_id?: string | null;
  };
  settings: {
    dm_policy: string;
    feed_preferences: string;
  };
}

/**
 * Media item interface
 */
export interface MediaItem {
  id: string;
  object_key: string;
  mime_type: string;
  size_bytes: number;
  /** photo | sticker | gif | video | background */
  kind?: string;
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
}

/**
 * Topic item interface
 */
export interface TopicItem {
  id?: string;
  slug: string;
  display_name: string;
  confidence?: number;
}

/**
 * Post item interface
 */
export interface PostItem {
  id: string;
  author_id: string;
  author_username: string;
  author_display_name: string;
  author_avatar_media_id: string | null;
  author_class_name?: string | null;
  body: string;
  created_at: string;
  expires_at: string;
  status: string;
  media: MediaItem[];
  topics?: TopicItem[];
  likes_count: number;
  has_liked: boolean;
  comments_count: number;
  _debug?: {
    interestScore: number;
    socialScore: number;
    recencyScore: number;
    engagementScore: number;
    classScore: number;
    totalScore: number;
    pool?: string;
  };
}

/**
 * Comment item interface
 */
export interface CommentItem {
  id: string;
  post_id: string;
  author_id: string;
  author_username: string;
  author_display_name: string;
  body: string;
  created_at: string;
}

/**
 * Feed pagination response
 */
export interface FeedResponse {
  posts: PostItem[];
  next_cursor: string | null;
  has_more: boolean;
}

/**
 * Comments pagination response
 */
export interface CommentsResponse {
  comments: CommentItem[];
  next_cursor: string | null;
  has_more: boolean;
}

/**
 * User Interest Signal
 */
export interface UserInterestTopic {
  topic_id: string;
  slug: string;
  display_name: string;
  raw_weight: number;
  effective_weight: number;
  updated_at: string;
}

/**
 * Campus Class Item
 */
export interface ClassItem {
  id: string;
  name: string;
}
export type ClassRow = ClassItem;

/**
 * Trend Snapshot Item
 */
export interface TrendItem {
  topic_id: string;
  slug: string;
  display_name: string;
  window: '24h' | '7d';
  score: number;
}

/**
 * Conversation item interface
 */
export interface ConversationItem {
  id: string;
  created_at: string;
  other_user: {
    id: string;
    username: string;
    display_name: string;
    avatar_media_id: string | null;
  };
  last_message?: {
    id: string;
    sender_id: string;
    body: string;
    sent_at: string;
    expires_at: string;
    /** Kind of the first attachment (photo, sticker, gif, video), or null for a text-only message. */
    media_kind?: string | null;
  } | null;
}

/**
 * Message item interface
 */
export interface MessageItem {
  id: string;
  conversation_id: string;
  sender_id: string;
  sender_username: string;
  sender_display_name: string;
  body: string;
  sent_at: string;
  expires_at: string;
  media: MediaItem[];
}

/**
 * Block item interface
 */
export interface BlockItem {
  user_id: string;
  username: string;
  display_name: string;
  created_at: string;
}

/**
 * Report evidence interface
 */
export interface ReportEvidenceItem {
  id: string;
  report_id: string;
  snapshot: {
    message_id: string;
    conversation_id?: string;
    sender_id: string;
    body: string;
    sent_at: string;
    expires_at: string;
    attachment_keys: string[];
  };
  created_at: string;
  expires_at: string;
}


