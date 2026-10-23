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
- **Workflow**: Clicking "Sign up as test user" initiates `/api/auth/google?mock=true&intent=signup`. The worker validates state and nonce and, because no account exists yet, issues a sign-up ticket and sends you to the real onboarding screen (name, username, campus, class, roll number). Once the account exists, the same button logs you in. Session cookies are set without the `Secure` flag so `http://localhost` works across all browsers (including Safari). Tests and previews can sign up as different mock Google accounts with `mock_sub`, `mock_email` and `mock_name` query parameters (development and test only).
- **Production Guardrails**: In any environment other than `ENVIRONMENT === 'development'`, mock codes and mock flags are strictly rejected with HTTP 400.
- **Embedded Preview Cookie Notice**: If the embedded preview or iframe blocks cookies, open the app in its own browser tab so session and state cookies are stored and sent normally.

### How to Remove Dev Mode Before Launch

Every dev-only block is annotated with `// DEV-ONLY: remove before launch`. To completely purge the dev shortcut before launch:
1. Search the codebase for `// DEV-ONLY: remove before launch`.
2. In `src/App.tsx`, remove `<DevBar />` and delete `src/components/DevBar.tsx`.
3. In `worker/index.ts`, remove the `isMockRequested` and `isMockCode` blocks (and the `mock_sub` / `mock_email` / `mock_name` handling) in `/api/auth/google` and `/api/auth/callback`.
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
- Log in vs sign up, sign-up tickets, onboarding validation, username availability and the privacy of the roll number and email
- The bundled campus list and its generator, free-text campuses, search scopes, the Settings page, chat with photos, stickers and GIFs, and a phone-only chat background, suggested people and profile style presets (including WCAG contrast of every preset)
- Profile pictures: ownership, visibility, blocks, and survival of the cleanup job
- Accessibility (axe-core) and interactive tests of the sign-in, onboarding, campus picker and style picker screens

### 4b. Adversarial Suite
```bash
npm run attack
```
Runs `scripts/attack-suite.mts` (Node 22+): about 150 abuse cases against the Worker and an in-memory D1 (IDOR, mass assignment, forged and replayed sign-up tickets, SQL injection and LIKE wildcards in search inputs, private-data leaks, blocks, uploads, rate limits, expiry and account deletion). It must report `BROKEN: 0` and `5xx-crashes: 0`; it exits non-zero otherwise. Every check that asserts something is hidden has a positive control next to it.

### 5. Strict Type-Checking
```bash
npm run type-check
```

---

## Cloudflare Deployment

Follow this step-by-step numbered guide to deploy ClassSync to Cloudflare Workers, Cloudflare D1, and Cloudflare R2:

### 1. Create Cloudflare Account & Authenticate
1. Sign up for a Cloudflare account at https://dash.cloudflare.com if you do not already have one.
2. Log in via Wrangler CLI from the project root:
   ```bash
   npx wrangler login
   ```
   This will open a browser window to authenticate Wrangler with your Cloudflare account.

### 2. Create D1 Database and R2 Bucket
1. Create the production D1 SQLite database:
   ```bash
   npx wrangler d1 create classsync-db
   ```
   Take note of the `database_id` returned in the command output (a UUID format).
2. Create the production R2 storage bucket:
   ```bash
   npx wrangler r2 bucket create classsync-media
   ```

### 3. Configure Database ID in `wrangler.toml`
Open `wrangler.toml` and update `database_id` under `[[d1_databases]]` with the real ID from Step 2:
```toml
[[d1_databases]]
binding = "DB"
database_name = "classsync-db"
database_id = "<YOUR_D1_DATABASE_ID>"
```

### 4. Run Migrations on Remote D1
Apply all database schema migrations (`001_init.sql` through `005_onboarding.sql`) to your remote production D1 database:
```bash
npm run db:migrate:remote
```
*(Alternatively: `npx wrangler d1 migrations apply classsync-db --remote`)*

Migration `005_onboarding.sql` adds the private sign-up data table, sign-up tickets and the profile style columns. People who already have an account keep working: their campus, real name and styles start empty and can be filled in from Edit profile.

#### Campus list
Campus names are bundled into the app (`shared/campuses.ts`, generated from `data/campuses.csv` by `npm run generate:campuses`, also run by `prebuild`). Migration `006_bundled_campuses.sql` drops the old `campuses` and `campus_requests` tables and adds `profiles.campus_other`; nothing needs loading. See "Campuses" in `docs/operations.md`.

### 5. Create Google OAuth Client Credentials
1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create or select your project.
2. Navigate to **APIs & Services > OAuth consent screen**:
   - Choose **External** (or **Internal** if using Google Workspace for your school).
   - Fill in App name (e.g. `ClassSync`), User support email, and Developer contact information.
   - Under **Publishing status**:
     - **Testing**: Only users explicitly added to the "Test users" list can authenticate (up to 100 users). Google will show an unverified app warning.
     - **In production**: Available to all Google accounts without individual whitelisting. For basic sign-in scopes (`openid`, `email`, `profile`), full verification is not required for standard deployment. Switch to "In production" when ready to launch.
3. Navigate to **APIs & Services > Credentials > Create Credentials > OAuth client ID**:
   - Application type: **Web application**.
   - Name: `ClassSync Web Client`.
   - **Authorized redirect URIs**:
     ```text
     https://<APP_URL>/api/auth/callback
     ```
     *(Replace `<APP_URL>` with your actual deployment domain, e.g. `classsync.<your-subdomain>.workers.dev` or custom domain)*.
4. Save and copy the generated **Client ID** and **Client Secret**.

### 6. Set Cloudflare Worker Secrets
Store the four production secrets securely using Wrangler:
```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put APP_URL
npx wrangler secret put ADMIN_SECRET
```
When prompted for each secret:
- `GOOGLE_CLIENT_ID`: Your Google OAuth client ID (e.g., `*.apps.googleusercontent.com`).
- `GOOGLE_CLIENT_SECRET`: Your Google OAuth client secret.
- `APP_URL`: Your canonical production application URL including protocol, with no trailing slash (e.g., `https://classsync.<your-subdomain>.workers.dev`).
- `ADMIN_SECRET`: A high-entropy random secret key for admin APIs and cron tasks (e.g., generated with `openssl rand -hex 32`).

### 7. Build and Deploy
Build the client application and deploy the worker to Cloudflare:
```bash
npm run deploy
```
*(Runs `npm run build && wrangler deploy` to compile Vite assets into `dist/` and upload Worker and static assets)*.

---

### 8. Post-Deploy Smoke Checklist
Verify that your deployed instance functions properly at `https://<APP_URL>`:
- [ ] **Home route**: `GET https://<APP_URL>/` returns HTTP 200 with HTML application shell.
- [ ] **SPA client-side routing**: Direct navigation to `https://<APP_URL>/search` loads the SPA without 404.
- [ ] **Unauthenticated session check**: `GET https://<APP_URL>/api/me` returns HTTP 401 with `{"error":"Unauthorized"}`:
  ```bash
  curl -i https://<APP_URL>/api/me
  ```
- [ ] **OAuth sign-in initiation**: Clicking "Continue with Google" redirects to `accounts.google.com` with valid `client_id`, `state`, and `redirect_uri=https://<APP_URL>/api/auth/callback`.
- [ ] **OAuth callback**: Completing Google sign-in redirects to the app with a secure `session` cookie.
- [ ] **Profile edit**: Updating your display name, bio, and class via `PATCH /api/me` saves and persists.
- [ ] **Post & media upload**: Uploading an image post creates the post and serves the R2 object at `/api/media/<id>` with `X-Content-Type-Options: nosniff`.
- [ ] **Admin authentication**:
  ```bash
  # 1. Missing secret returns 401:
  curl -i https://<APP_URL>/api/admin/stats
  # 2. Invalid secret returns 403:
  curl -i https://<APP_URL>/api/admin/stats -H "X-Admin-Secret: wrong-secret"
  # 3. Valid secret returns 200 with counts:
  curl -i https://<APP_URL>/api/admin/stats -H "X-Admin-Secret: <ADMIN_SECRET>"
  ```
- [ ] **Cleanup cron trigger**:
  ```bash
  curl -i -X POST https://<APP_URL>/api/jobs/cleanup-expired -H "X-Admin-Secret: <ADMIN_SECRET>"
  ```

---

### 9. "Before Inviting Students" Checklist
Before opening the platform to real students, verify all production hardening criteria:
- [ ] **Remove DEV-ONLY code**: Remove all development bars, mock sign-in shortcuts, and test helpers marked with the dev-only comment marker.
- [ ] **Verify `wrangler.toml` configuration**:
  - `database_id` is set to the real provisioned D1 UUID (not `placeholder-d1-id`).
  - `ENVIRONMENT = "production"` under `[vars]`.
- [ ] **Replace the placeholder stickers and GIFs** with the real ones (see "Stickers and GIFs" above). `npm run build` warns until `public/stickers/placeholder/` is gone.
- [ ] **Run Prelaunch Check**:
  Execute the prelaunch verification gate and verify it passes:
  ```bash
  npm run prelaunch-check
  ```
  Must print `Prelaunch Check: PASS` before students are invited.
- [ ] **Google OAuth Status**: Move Google OAuth Consent Screen publishing status from "Testing" to "In production" so any school student can sign in without needing manual inclusion on a whitelist.
- [ ] **Establish Database Backups**: Verify backup commands work as documented in `docs/operations.md` (`npm run db:backup`).

---

## Polls and profile backgrounds

**Polls.** A post can carry a poll (2 to 6 options, each 1 to 60 characters, cleaned like other short text, no `<` or `>`, no duplicates). A post has exactly one of photos, a poll or one sticker/GIF; the text is still required. One vote per account, changeable until the poll closes with its post (7 to 14 days). Results are hidden until you vote: the server returns vote counts only to people who have voted and to the author, so they cannot be read from the page. Nobody is shown who voted what. Deleting an account removes its votes (the counts drop).

**Profile background.** On Edit profile, "Use your own image" compresses a picture on the phone (at most 1080 px, WebP, under 400 KB) and uploads it as kind `background`. It is shown behind the profile header under a dark layer with white text so the name and bio stay readable (`tests/custom-wallpaper.test.ts` computes the worst case, a pure white picture, at about 4.7:1). Everyone signed in can see it; blocked people cannot. It lives as long as it is your background, and is removed when you replace it, pick a preset, or delete the account. A user report records the image so a moderator can identify it.

## Stickers and GIFs

> ### TODO BEFORE LAUNCH: replace the placeholder stickers
> The app ships with **stand-in stickers and GIFs** so the whole feature works today: `public/stickers/placeholder/` (8 stickers numbered 1 to 8 and 4 GIFs, each drawn with the word PLACEHOLDER). The pack is called **"Placeholders (replace me)"** in the picker on purpose, so it cannot be forgotten. `npm run build` also prints a `WARNING: A PLACEHOLDER pack is still in the catalog` line until they are gone.
>
> **To replace them with the real art:**
> 1. Make a folder per pack: `public/stickers/<pack-id>/` (lowercase letters, digits and dashes, for example `cats`). Put a `pack.json` in it: `{ "name": "Cats", "order": 1 }` (lower `order` shows first). Optional `"alts": { "happy-cat.webp": "A happy cat" }` gives screen-reader text; otherwise the file name is used.
> 2. Drop the images in. **Stickers:** 512 x 512, transparent WebP (or PNG), at most 300 KB each. **GIFs:** animated GIF or animated WebP, at most 3 MB each (keep them far smaller; every student downloads them). Keep the **whole** `public/stickers` folder under about 8 MB (the build warns above that).
> 3. Delete `public/stickers/placeholder/` (and its `pack.json`).
> 4. Run `npm run build:stickers`, then commit `shared/stickers.ts` and `public/stickers/numbering.json` together with the images. `npm run build` does this for you, and a test fails if the committed files are out of date.
>
> The placeholder numbers are then retired. Any test message that used one shows an "Unavailable" tile instead of breaking. Nothing else needs to change.

**How it works.** A sticker or GIF is referred to by a **key**, never a URL: `app:<pack>/<number>` for a bundled one, `usr:<mediaId>` for one a student uploaded. Messages, posts and comments store only the key and the screen looks it up. Using a bundled sticker writes **nothing to R2** (only the key is stored in D1); the images are static files cached for a year. Uploaded ones are stored in R2 like any media and counted in the person's quota. The server rejects any other key shape, unknown bundled numbers, retired numbers and uploads the sender cannot read.

**Numbering is permanent and append-only** (`public/stickers/numbering.json`, maintained by `scripts/build-stickers.ts`):
- A file keeps its number forever. New files get the next free number in their pack.
- A removed file is marked *retired*. Its number is never reused, and old messages that used it show a placeholder.
- A renamed file keeps its number only if its content is unchanged. **Replacing a file's content under the same file name keeps its number**, so you can improve a sticker later without breaking old messages.
- Never edit `numbering.json` by hand and never delete it: it is the memory that keeps numbers from being reused.

**Where they work:** chats, posts (one sticker/GIF instead of photos; text is still required) and comments (text and/or one sticker/GIF). The picker has Stickers and GIFs tabs with **Recent** (remembered on the device only), **Mine** (your uploads; "Manage" removes them, "Add from phone" turns a picture or a clip into one) and a chip per bundled pack. There is no third-party GIF search in this version; `src/lib/gif-providers.ts` only documents where one could be added.

---

## Recent Fixes & Open Items

Changes made on top of baseline commit `6f12617`. Each is its own commit.

### Fixed

- **Ranked feed returned an empty list when the user had any block** (`worker/index.ts`, `mode=ranked` / `for_you`). The SQL placeholders run: engagers block list, comments block list, `expires_at > ?`, candidate block list, but params were built as `[nowIso, ...blocked x3]`, so the timestamp landed in a block-list slot. Params are now built in placeholder order. Every other query that mixes a timestamp with an `IN (...)` block list (chronological and author feeds, search, trends, comments, like counts, profile counts) was audited and already bound correctly.
- **Hardcoded sample data removed from `SearchPage.tsx`**: the fake people, the `|| 12` fallback and the `#campus / 18 posts this week` entry. Trending shows only real `/api/trends` results (the API returns a ranking score, not a post count, so no count is shown). Empty states are one muted line each ("No trending topics yet", "No people to show") with no buttons. No other hardcoded sample data exists in `src/`.
- **Posts show only hashtags the author typed in the text.** `PostCard` no longer renders derived topics as a separate tag row.
- **Avatars show one uppercase initial** everywhere (`avatarInitial()` in `src/lib/initial.ts`, used by `PostCard`, `MessagesPage`, `SearchPage`, `ProfileViewPage`). Previously several showed two letters.
- **Compose photo picker accessibility.** axe-core (`wcag2a`, `wcag2aa`, `wcag21aa`) reported a serious `aria-prohibited-attr` for `aria-label` on a `<label>`. The picker is now a real `<button aria-label="Add photo">` that drives the hidden file input, which also makes it keyboard accessible (the old hidden input could not be reached by keyboard). Scan result after the fix: 0 violations.
- **`scripts/prelaunch-check.ts`** scans only `src/`, `worker/`, `server.ts` and `wrangler.toml` for DEV-ONLY markers (`tests/`, `scripts/`, the README and docs no longer count), and fails if `src/` contains placeholder strings.

### Regression tests added

- `tests/ranked-feed-blocks.test.ts`: blocker and blocked user, `ranked` and `for_you`, multiple blocks. Asserts the feed is non-empty and still contains other people's posts, so an empty feed fails.
- `tests/placeholder-data.test.ts`: fails if `src/` contains "ayesha", "hamza", "posts this week" or "Class 12-".
- `tests/initial.test.ts`: avatar initial is always exactly one character.
- `tests/a11y.test.tsx`: axe-core scans of the Compose screen and the Search empty state must have no violations.
- `tests/prelaunch-check.test.ts`: scan scope and placeholder failure, run against temp trees.

### Dependencies

`axe-core`, `jsdom` and `@types/jsdom` were added as devDependencies. Saving them also resynced `package-lock.json`, which previously lacked wrangler entries and made `npm ci` fail.

### Log in, sign up, campuses and profile styles

Built on top of `2971c1d`. Each change is its own commit.

- **Log in and Sign up are separate.** The sign-in screen has "Log in with Google" and "Sign up with Google". The OAuth callback never creates an account any more. Log in with an unknown Google account returns to the sign-in screen with a message (`/?auth=no_account`). Sign up issues a 15-minute, single-use ticket (stored in D1 as `signup_tickets`, sent as an HttpOnly cookie) and continues to onboarding (`/?signup=1`). An existing account logs in with either button.
- **Onboarding** (`POST /api/signup/complete`) creates the user, profile, settings, private record and session in one D1 batch. Fields: real name, unique username (live availability check, reserved names such as `admin` and `support` are refused), campus, class, last three digits of the roll number. The profile photo is an optional last step. A forged, expired or reused ticket is rejected, two people racing for one username get one winner and one `409`, and a double submit creates one account.
- **Private data.** Email and `roll_last3` live in `user_private`, not in `profiles`, so no `SELECT *` can leak them; `GET/PATCH /api/me` now build their response from named columns only. They are never returned by any endpoint and cannot be set through `PATCH /api/me`. Deleting an account removes them.
- **Real name** is stored in `profiles.real_name` and shown on the profile page only. Posts, feeds, search, suggestions and messages keep using the display name, which starts as the username.
- **Campuses.** Searchable picker over the list bundled in the app (filtered on the device, no network call). Search ranks name-prefix matches first, then name-contains, then city matches, and can be narrowed by city. A student whose campus is missing types it in (`campus_other`); it is shown on their profile but never drives campus search or suggestions. The server validates `campus_id` against the bundled list; ids no longer in the list read as no campus.
- **Search tabs work.** `GET /api/search?scope=class|campus|all` filters by the caller's class or campus. If the caller has none set, the response says so (`scope_missing`) instead of silently searching everyone.
- **Suggested people.** `GET /api/people/suggested` returns classmates first, then people on the same campus, never yourself, people you follow, or anyone blocked in either direction.
- **Profile pictures are visible.** Avatars now render as images with the one-letter fallback. Setting a profile picture requires owning the upload (previously any media id was accepted), and a profile picture can be read by signed-in people who are not blocked with its owner.
- **Profile style.** Wallpaper, accent color and text style are fixed presets (`shared/presets.ts`); the database stores only the preset id and the server rejects anything else. There are no user-uploaded wallpapers. Every wallpaper keeps text at WCAG AA (4.5:1) and every accent reaches 3:1 on every wallpaper and on the light and dark app surfaces; a test enforces this for all combinations.
- **Missing style tokens.** `bg-primary`, `text-text`, `border-border`, `bg-surface` and similar classes were used across the app but never defined, so Tailwind generated no CSS for them (the old sign-in button, Edit profile and the comment and report modals were affected). `src/index.css` now maps them to the existing light and dark color variables.

### Regression tests added

- `tests/signup.test.ts`, `tests/campuses.test.ts`, `tests/people-and-scope.test.ts`, `tests/presets.test.ts`, `tests/avatars.test.ts`, `tests/generate-campuses.test.ts` (backend behavior, privacy and abuse cases).
- `tests/a11y-onboarding.test.tsx` and `tests/onboarding-ui.test.tsx` (axe scans plus a jsdom walk through the whole sign-up form, including keyboard selection of a campus).
- `scripts/attack-suite.mts` (`npm run attack`) is now part of the repository.
- Mutation-checked: deliberately breaking the scope bind order, the block filter on suggestions and the private-data query makes the matching tests fail.

### Open items

- Color contrast of the UI is still not verified in a real browser (jsdom has no layout engine). The style presets are checked numerically.
- The roll number is not editable after sign-up and is not verified; it only helps place students in their class. Treat it as a hint, not proof of enrollment.
- Classes are still one global list (for example "Class of 2026"), not per campus.
- **Placeholder stickers and GIFs are still bundled** (see "Stickers and GIFs"): replace them before launch.
- The sticker picker, the chat composer and the media preview have not been run on a real phone (see `docs/STATUS.md` for the full not-verified list).
- Only Google sign-in exists. Other email providers need email verification and a mail service, and are left for later.
- `npm run prelaunch-check` is expected to fail until the DEV-ONLY code is removed (including the "Sign up as test user" button in `SignInPage.tsx`) and `database_id` in `wrangler.toml` is replaced.
- The block/unblock menu and blocked-users list in the UI have not been tested in a browser (the backend is covered by the attack suite).

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
- **`005_onboarding.sql`**: `campuses` and `campus_requests` (approved list plus student-requested pending entries), `profiles.campus_id / real_name / wallpaper_id / theme_id / text_style_id`, `user_private` (email and roll number, never returned by any API) and `signup_tickets` (15-minute single-use sign-up proof).
- **`007_media_foundation.sql`**: media `kind`, size metadata, `sha256` (per-owner dedupe), thumbnails, and the `sticker_library` table.
- **`010_wallpaper_polls.sql`**: `profiles.wallpaper_media_id` (a profile background from the person's own image) and the poll tables `polls`, `poll_options`, `poll_votes` (primary key `(poll_id, user_id)`, so one vote per account).
- **`006_bundled_campuses.sql`**: rebuilds `profiles` without the `campus_id` foreign key, adds `campus_other`, drops `campuses` and `campus_requests`.

---

## API Routes Reference

| Method | Endpoint | Auth Required | Description |
|---|---|---|---|
| `GET` | `/api/auth/google?intent=login\|signup` | No | Initiates Google OAuth with PKCE, state & nonce |
| `GET` | `/api/auth/callback` | No | Exchanges code, verifies ID token. Existing account: sets session cookie. Unknown account: back to login (`login`) or a sign-up ticket (`signup`). Never creates an account |
| `GET` | `/api/signup/session` | Sign-up ticket | Checks the ticket and returns the Google name and email to prefill |
| `POST` | `/api/signup/complete` | Sign-up ticket | Creates the account (real name, username, campus, class, roll last 3) and a session (rate-limited) |
| `GET` | `/api/username-available?u=` | Session or ticket | Whether a username is free, reserved or invalid (rate-limited) |
| `POST` | `/api/auth/logout` | No | Deletes session and clears cookie |
| `GET` | `/api/users/:username` | **Yes** | Returns public profile fields only |
| `GET` | `/api/me` | **Yes** | Returns current user profile (including campus, real name and style ids), class, and settings |
| `PATCH` | `/api/me` | **Yes** | Updates profile (display name, real name, bio, class, campus, profile picture, wallpaper/theme/text style) and settings |
| `DELETE` | `/api/me` | **Yes** | Permanently deletes user, posts, media, and sessions |
| `GET` | `/api/classes` | Session or ticket | Returns list of available classes |
| `GET` | `/api/people/suggested` | **Yes** | Classmates, then campus mates; excludes yourself, followed and blocked people |
| `GET` | `/api/feed` | **Yes** | Chronological or ranked discovery feed with cursor pagination |
| `POST` | `/api/posts` | **Yes** | Creates post with #hashtag and keyword topic extraction (rate-limited). Optional `poll: { options: [2 to 6 strings, 1 to 60 characters each] }`, exclusive with photos and stickers |
| `GET` | `/api/posts/:id` | **Yes** | Retrieves single post with media, likes, comments, topics |
| `DELETE` | `/api/posts/:id` | **Yes** | Author-only deletion of post and R2 media |
| `PUT` | `/api/posts/:id/poll/vote` | **Yes** | Casts or changes your vote (`{ option_id }`). One vote per account, 60 per hour, `404` for blocked pairs, `409` once the post has expired |
| `POST` | `/api/posts/:id/likes` | **Yes** | Toggles like reaction on a post (+1 interest signal) |
| `GET` | `/api/posts/:id/comments` | **Yes** | Retrieves comments for a post |
| `POST` | `/api/posts/:id/comments` | **Yes** | Adds comment to a post (+3 interest signal, rate-limited) |
| `DELETE` | `/api/comments/:id` | **Yes** | Author-only comment deletion |
| `POST` | `/api/users/:id/follow` | **Yes** | Follows/unfollows user (no self-follow, rate-limited) |
| `POST` | `/api/media/uploads` | **Yes** | Uploads a photo, sticker, GIF, background or short clip (`kind` field). Per-kind size caps, per-kind hourly limits, 200 MB quota, magic bytes check, JPEG metadata stripped, per-owner dedupe (see `docs/operations.md` section 8) |
| `DELETE` | `/api/media/:id` | **Yes** | Owner only; `409` while a post, message or profile picture still uses it |
| `GET` | `/api/media/:id/thumb` | **Yes** | Thumbnail, same read rules |
| `GET` `POST` | `/api/stickers/library` | **Yes** | List or add to your sticker/GIF library (max 200) |
| `DELETE` | `/api/stickers/library/:mediaId` | **Yes** | Remove from your library |
| `POST` | `/api/messages/:id/forward` | **Yes** | Forward a message you can read to another conversation (references the same media) |
| `GET` | `/api/media/:id` | **Yes** | Serves image bytes from R2 with `X-Content-Type-Options: nosniff` (owner, attached to a visible post or message, or a profile picture of someone not blocked with you) |
| `POST` | `/api/reports` | **Yes** | Reports post, comment, or user (verifies target, single open report, rate-limited) |
| `GET` | `/api/admin/reports` | Admin Secret | Lists moderation reports (401/403 auth check) |
| `PATCH` | `/api/admin/reports/:id` | Admin Secret | Updates report status (`reviewed` or `dismissed`) |
| `GET` | `/api/search?q=&scope=class\|campus\|all` | **Yes** | Searches posts, optionally within your class or campus (rate-limited) |
| `GET` | `/api/trends` | **Yes** | Returns trending topics for 24h or 7d windows |
| `GET` | `/api/me/interests` | **Yes** | Returns user topic interest profile with decayed weights |
| `DELETE` | `/api/me/interests` | **Yes** | Resets user topic interest signals |
| `POST` | `/api/feedback` | **Yes** | Logs `more_like_this`, `show_less`, or `not_interested` feedback |
| `POST` | `/api/impressions` | **Yes** | Logs post impressions with hourly deduplication |
| `POST` | `/api/jobs/cleanup-expired` | Dev / Admin Secret | Daily cron lifecycle job (deletes expired posts, orphan media, prunes impressions) |

