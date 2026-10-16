# DialtoneApp (Cloudflare-Starter) - Milestone 1 Foundation

Milestone 1 foundation for Dialtone, built with React, strict TypeScript, Vite, Cloudflare Workers, Cloudflare D1 (SQLite), and Cloudflare R2.

---

## Architecture & Layout

- **`src/`**: React 19 single-page application (Sign-In, Profile Edit, Public Profile View).
- **`worker/`**: Cloudflare Worker REST API handling authentication, D1 queries, and session management.
- **`migrations/`**: Cloudflare D1 SQL schema migrations (`001_init.sql`).
- **`shared/`**: Shared validation schemas (Zod) and username normalization utilities used across client and server.
- **`tests/`**: Automated test suite (Vitest) validating authentication, PKCE, schemas, permissions, and database migrations.

---

## Database Schema (`migrations/001_init.sql`)

- **`users`**: `id` (opaque primary key), `provider_subject` (unique OAuth subject), `created_at` (UTC ISO string), `status`.
- **`profiles`**: `user_id` (PK / FK -> users.id CASCADE), `username`, `username_normalized` (UNIQUE), `display_name`, `bio`, `avatar_media_id`.
- **`user_settings`**: `user_id` (PK / FK -> users.id CASCADE), `dm_policy`, `feed_preferences`.
- **`sessions`**: `id` (opaque token), `user_id` (FK -> users.id CASCADE), `expires_at` (UTC ISO string).
- Foreign keys and indexes enabled on `provider_subject`, `username_normalized`, `user_id`, and `expires_at`.

---

## Security Model

1. **Google OAuth 2.0 with PKCE, State & Nonce**:
   - Authorization Code flow using `code_challenge` (SHA-256 / `S256`).
   - Ephemeral `oauth_state` cookie stores `state`, `code_verifier`, and `nonce`.
   - ID Token verification validates issuer, audience (`GOOGLE_CLIENT_ID`), expiration, `nonce`, and requires `email_verified`.
   - Mock login paths (`mock=true`, `mock_` codes) are strictly disabled in production (`env.ENVIRONMENT !== 'development'`).
2. **HttpOnly Cookies**:
   - Session identifiers are stored exclusively in `HttpOnly; Secure; SameSite=Lax; Path=/` cookies.
   - Zero tokens are stored in `localStorage` or `sessionStorage`.
3. **Strict SQL Injection Prevention & Atomic Batches**:
   - 100% parameterized SQL prepared statements (`env.DB.prepare(...).bind(...)`).
   - User signup, account deletion, and multi-field updates utilize `env.DB.batch(...)` transactions.
4. **Access Control**:
   - Profile mutations (`PATCH /api/me`), profile viewing (`GET /api/users/:username`), and account deletions (`DELETE /api/me`) strictly require an active, authenticated session.
   - Profile updates are scoped to the session's user ID. A user can never edit or delete another user's profile.

---

## SQLite Shim vs. Real Cloudflare D1

This project provides dual execution environments:

1. **Local Development & Test SQLite Shim (`worker/db/sqlite-d1.ts`)**:
   - Utilizes Node.js 22's built-in `node:sqlite` (`DatabaseSync`), requiring zero external native compilation or binary dependencies.
   - Implements the exact Cloudflare D1 interface (`prepare`, `bind`, `run`, `all`, `first`, `exec`, `batch`) with SQLite transactions and `PRAGMA foreign_keys = ON;`.
   - Used by `npm run dev` and `npm test` (Vitest) for near-instant boot and isolated in-memory test suites.
2. **Production Cloudflare D1**:
   - Distributed SQLite running on Cloudflare's edge network, configured via `wrangler.toml`.
   - Bound to the worker runtime as `env.DB`.

---

## `wrangler dev` Smoke Test

To verify the worker directly against the Cloudflare Workers runtime and Miniflare's local D1 emulator:

### 1. Apply Migrations Locally with Wrangler
```bash
npx wrangler d1 execute dialtone-db --local --file=./migrations/001_init.sql
```

### 2. Start Worker with Local D1 Binding
```bash
npx wrangler dev --local
```

### 3. Smoke Test Endpoints
In a separate terminal:
```bash
# 1. Verify health & 404 handling on unknown routes
curl -i http://localhost:8787/api/unknown

# 2. Verify initiating Google OAuth with PKCE generates state and redirect
curl -i http://localhost:8787/api/auth/google

# 3. Verify unauthenticated profile lookup returns 401 Unauthorized
curl -i http://localhost:8787/api/users/any_user

# 4. Verify unauthenticated profile patch returns 401 Unauthorized
curl -i -X PATCH http://localhost:8787/api/me -H "Content-Type: application/json" -d '{"display_name":"Test"}'
```

---

## Dev mode (Temporary Sign-In Shortcut)

For rapid local testing without active Google Cloud OAuth credentials, a dev-only sign-in toolbar (`DevBar`) is mounted on every page during development:

- **Visibility**: Rendered strictly when `import.meta.env.DEV === true`. It is completely stripped out of production builds (`npm run build`) via Vite dead-code elimination.
- **Workflow**: Clicking "Sign in as test user" initiates `/api/auth/google?mock=true`. The worker validates state and nonce, generates a random username (`user_` + 6 random chars), creates an isolated D1 session, and sets session cookies without the `Secure` flag so `http://localhost` works across all browsers (including Safari).
- **Production Guardrails**: In any environment other than `ENVIRONMENT === 'development'`, mock codes and mock flags are strictly rejected with HTTP 400.
- **Embedded Preview Cookie Notice**: If the embedded preview or iframe blocks cookies, open the app in its own browser tab so session and state cookies are stored and sent normally.

### How to Remove Dev Mode Before Launch

Every dev-only block is annotated with `// DEV-ONLY: remove before launch`. To completely purge the dev shortcut before launch:
1. Search the codebase for `// DEV-ONLY: remove before launch`.
2. In `src/App.tsx`, remove `<DevBar />` and delete `src/components/DevBar.tsx`.
3. In `worker/index.ts`, remove the `isMockRequested` and `isMockCode` blocks in `/api/auth/google` and `/api/auth/callback`.
4. In `server.ts`, remove the placeholder fallbacks for `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
5. Run `npm test` and `npm run type-check` to confirm clean removal.

---

## Setup & Local Development

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Populate:
- `APP_URL`: Base application URL (`http://localhost:3000` for local dev).
- `GOOGLE_CLIENT_ID`: Google OAuth 2.0 Web Client ID.
- `GOOGLE_CLIENT_SECRET`: Google OAuth 2.0 Client Secret.
- Ensure `http://localhost:3000/api/auth/callback` is added as an Authorized Redirect URI in the Google Cloud Console.

### 3. Run Development Server
```bash
npm run dev
```
Starts the fullstack server on `http://localhost:3000` with the Cloudflare Worker API mounted at `/api/*` and Vite dev server.

### 4. Run Automated Tests
```bash
npm test
```
Executes Vitest tests verifying:
- Username normalization and validation
- Zod schema validation
- Rejection of mock auth in production
- Auth callback rejection on bad OAuth state
- 401 Unauthorized rejection on `PATCH /api/me` and `GET /api/users/:username` without session
- Strict isolation preventing a user from editing another user's profile
- Migrations execution from an empty database

### 5. Strict Type-Checking
```bash
npm run type-check
```

---

## Cloudflare Deployment

### 1. Build Frontend Application
```bash
npm run build
```

### 2. Provision D1 and R2
```bash
npx wrangler d1 create classsync-db
npx wrangler r2 bucket create classsync-media
```
Update `database_id` in `wrangler.toml` with the generated database ID.

### 3. Apply Migrations to Remote D1 (001 to 004)
```bash
npx wrangler d1 execute classsync-db --remote --file=./migrations/001_init.sql
npx wrangler d1 execute classsync-db --remote --file=./migrations/002_social.sql
npx wrangler d1 execute classsync-db --remote --file=./migrations/003_discovery.sql
npx wrangler d1 execute classsync-db --remote --file=./migrations/004_messaging.sql
```

### 4. Set Cloudflare Worker Secrets
```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put APP_URL
npx wrangler secret put ADMIN_SECRET
```

### 5. Deploy
```bash
npx wrangler deploy
```

---

## Database Schemas Overview

- **`001_init.sql`**: Core authentication, `users`, `profiles`, `user_settings`, and `sessions`.
- **`002_social.sql`**: Social posts (7-day base lifecycle), R2 `media`, `post_media` links, `post_reactions` (likes), `comments`, `follows` (no self-follow), and `reports`.
- **`003_discovery.sql`**: Discovery engine schema:
  - `classes`: Campus classes and affiliations (`profiles.class_id`).
  - `topics` & `post_topics`: Normalized hashtag & keyword extraction with confidence scoring.
  - `user_topic_signals`: Dynamic interest scoring with a 14-day exponential decay half-life.
  - `impressions`: View logging with deduplication and 30-day lifecycle retention.
  - `feedback`: Explicit user feedback (`more_like_this`, `show_less`, `not_interested`).
  - `trend_snapshots`: Aggregated trending topics across 24h and 7d rolling windows (minimum 3 distinct authors).
  - `rate_limits`: D1-backed atomic window rate limiting table.
  - Search indexes on `posts.body`.
- **`004_messaging.sql`**: Direct messaging, 1:1 `conversations`, `conversation_members`, ephemeral `messages`, `message_media`, and `blocks` table.

---

## API Routes Reference

| Method | Endpoint | Auth Required | Description |
|---|---|---|---|
| `GET` | `/api/auth/google` | No | Initiates Google OAuth with PKCE, state & nonce |
| `GET` | `/api/auth/callback` | No | Exchanges code, verifies ID token, sets session cookie |
| `POST` | `/api/auth/logout` | No | Deletes session and clears cookie |
| `GET` | `/api/users/:username` | **Yes** | Returns public profile fields only |
| `GET` | `/api/me` | **Yes** | Returns current user profile, class, and settings |
| `PATCH` | `/api/me` | **Yes** | Updates user profile (display name, bio, class_id) and settings |
| `DELETE` | `/api/me` | **Yes** | Permanently deletes user, posts, media, and sessions |
| `GET` | `/api/classes` | No | Returns list of available campus classes |
| `GET` | `/api/feed` | **Yes** | Chronological or ranked discovery feed with cursor pagination |
| `POST` | `/api/posts` | **Yes** | Creates post with #hashtag and keyword topic extraction (rate-limited) |
| `GET` | `/api/posts/:id` | **Yes** | Retrieves single post with media, likes, comments, topics |
| `DELETE` | `/api/posts/:id` | **Yes** | Author-only deletion of post and R2 media |
| `POST` | `/api/posts/:id/likes` | **Yes** | Toggles like reaction on a post (+1 interest signal) |
| `GET` | `/api/posts/:id/comments` | **Yes** | Retrieves comments for a post |
| `POST` | `/api/posts/:id/comments` | **Yes** | Adds comment to a post (+3 interest signal, rate-limited) |
| `DELETE` | `/api/comments/:id` | **Yes** | Author-only comment deletion |
| `POST` | `/api/users/:id/follow` | **Yes** | Follows/unfollows user (no self-follow, rate-limited) |
| `POST` | `/api/media/uploads` | **Yes** | Uploads image with Content-Length, 5MB, and magic bytes check (rate-limited) |
| `GET` | `/api/media/:id` | **Yes** | Serves image bytes from R2 with `X-Content-Type-Options: nosniff` |
| `POST` | `/api/reports` | **Yes** | Reports post, comment, or user (verifies target, single open report, rate-limited) |
| `GET` | `/api/admin/reports` | Admin Secret | Lists moderation reports (401/403 auth check) |
| `PATCH` | `/api/admin/reports/:id` | Admin Secret | Updates report status (`reviewed` or `dismissed`) |
| `GET` | `/api/search` | **Yes** | Searches posts across class, campus, or all scopes (rate-limited) |
| `GET` | `/api/trends` | **Yes** | Returns trending topics for 24h or 7d windows |
| `GET` | `/api/me/interests` | **Yes** | Returns user topic interest profile with decayed weights |
| `DELETE` | `/api/me/interests` | **Yes** | Resets user topic interest signals |
| `POST` | `/api/feedback` | **Yes** | Logs `more_like_this`, `show_less`, or `not_interested` feedback |
| `POST` | `/api/impressions` | **Yes** | Logs post impressions with hourly deduplication |
| `POST` | `/api/jobs/cleanup-expired` | Dev / Admin Secret | Daily cron lifecycle job (deletes expired posts, orphan media, prunes impressions) |

