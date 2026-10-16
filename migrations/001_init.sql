-- Dialtone Milestone 1 Initial Migration: D1 Database Schema
PRAGMA foreign_keys = ON;

-- users: Core authentication identity
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  provider_subject TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);

-- profiles: Public and private profile data
CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  username_normalized TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  avatar_media_id TEXT
);

-- user_settings: User configuration and preferences
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dm_policy TEXT NOT NULL DEFAULT 'everyone',
  feed_preferences TEXT NOT NULL DEFAULT '{}'
);

-- sessions: Authenticated HTTP sessions
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_provider_subject ON users(provider_subject);
CREATE INDEX IF NOT EXISTS idx_profiles_username_normalized ON profiles(username_normalized);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
