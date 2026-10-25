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
- `ROLL_KEY_SECRET`: keys the hash that stops one student registering twice (see "Student sign-up checks"). Required in production: without it sign-up answers 503. Set it once with `npx wrangler secret put ROLL_KEY_SECRET` (any long random value) and never change it afterwards, or old accounts stop matching their roll numbers.
- `ADMIN_SECRET`: A high-entropy random secret key for the cron job and scripts that call the admin APIs without signing in (it is not how people use the admin page; see "Admin and moderation"). Windows CMD has no `openssl`; generate one with:
  ```bat
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```

### 7. Build and Deploy
Build the client application and deploy the worker to Cloudflare:
```bash
npm run deploy
```
*(Runs `npm run build && wrangler deploy` to compile Vite assets into `dist/` and upload Worker and static assets)*.

### 8. Become the master admin (once, after you have signed up)
1. Open your deployed app, sign up with Google, finish onboarding.
2. Open **Settings**, scroll to **Account**: the line **Account ID** shows `usr_...`. Tap **Copy**.
3. In CMD, from the repo folder (Wrangler is already logged in from step 1):
   ```bat
   npm run bootstrap:master -- --user-id usr_PASTE_YOUR_ID_HERE --remote
   ```
   It prints `SUCCESS` and **Admin tools** now appears in your Settings. Details and safety rules are in "Admin and moderation" below.

---

### 9. Post-Deploy Smoke Checklist
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
- [ ] **Replace the placeholder app icons** in `public/icons/` (see "Install as an app (PWA)").
- [ ] **Run Prelaunch Check**:
  Execute the prelaunch verification gate and verify it passes:
  ```bash
  npm run prelaunch-check
  ```
  Must print `Prelaunch Check: PASS` before students are invited.
- [ ] **Google OAuth Status**: Move Google OAuth Consent Screen publishing status from "Testing" to "In production" so any school student can sign in without needing manual inclusion on a whitelist.
- [ ] **Establish Database Backups**: Verify backup commands work as documented in `docs/operations.md` (`npm run db:backup`).

---

## Screen sizes (phone, tablet, desktop)

- **Three designs, one rule** (`src/lib/layout.ts`): phone under 640 px, tablet 640 to 1023, desktop 1024 and up. The same two numbers are in `src/index.css` and `tests/layout.test.ts` fails if they differ. Nothing else may read the window width or hard-code a column width (the same test scans `src/` for that).
- **Phone:** unchanged. Bottom tab bar, app bar, one 430 px column, slide-up sheets.
- **Tablet:** slim icon rail on the left (`SideNav`), a 640 px centered column, no app bar, comments still a slide-up sheet, Report/Delete as centered dialogs.
- **Desktop:** sidebar with labels (also Messages and Settings), 640 px column with side borders, comments as a drawer sliding in from the right, Report/Delete as centered dialogs.
- **How a component picks its design:** structure that differs (which navigation, which overlay) comes from `useLayout()` so only one version is ever in the page; styling that differs uses the `tablet:` and `desktop:` Tailwind variants. `<html data-layout="...">` shows which design is active. The column width is `max-w-content` (the `--content-w` variable).
- **Messages** is two panes on tablet and desktop (conversation list on the left, chat on the right) and one pane at a time on phones. Settings is two panes on desktop only (section list on the left, one section at a time on the right); on phones and tablets it is one scrolling page. Both use the wider column (`max-w-wide`, the `--wide-w` variable, 960 px at most, less when the window is narrower).
- **Profile** gets a larger avatar and more space in the header on tablet and desktop. **Sign-in and onboarding** are a centered card on a tinted page from tablet up; on phones they are unchanged.
- **Resizing or rotating** across a breakpoint switches the design live and keeps where you are, including an open sheet and the open conversation (the chat is not rebuilt, so unsent text stays).
- **Overlays** (attach sheet, forward picker, sticker picker, media viewer and preview, comment sheet) are centered over the column, not the whole screen: `--nav-w` is the width of the side navigation (0 on phones, 72 px on tablets, 240 px on desktops) and they shift by it.
- **Mouse and keyboard:** buttons have hover states (post actions, list rows, navigation); Up, Down, Home and End move between conversations and between Settings sections (`src/lib/arrow-keys.ts`); the focus ring and Escape-to-close are unchanged.
- **Looking at the designs:** `npm run shots` takes screenshots of the sign-in screen and the main pages at 390, 820, 1280 and 1920 px wide into `shots/<width>/` (git-ignored). Setup is in the header of `scripts/shots.mts`: seeded dev server running, Playwright installed with `npm install --no-save playwright` (it is not in `package.json`), and either `npx playwright install chromium` or `CHROMIUM_PATH=/path/to/chrome` for a browser you already have.
- **Trying a design while building:** open the dev server with `?layout=tablet` or `?layout=desktop` (ignored in a production build).

## Motion and navigation

- **Sheets:** comments, Report and Delete account open as a panel that slides up from the bottom (`src/components/BottomSheet.tsx`) and slides back down when you tap outside it, press Escape, tap Close, drag its top bar down, or use the phone/browser Back button. The sheet adds one history entry while it is open and removes it when it closes.
- **Back button:** every screen change in the app is a history entry (`src/lib/nav-history.ts`, wired in `src/App.tsx`), so Back returns to the previous screen instead of leaving the site. Settings, Edit profile and Messages use the same history for their own Back buttons. Tapping the tab you are already on scrolls to the top.
- **Transitions:** tab changes fade up, deeper pages (Settings, Edit profile, Messages) slide in from the right and slide the other way on Back. Tab icons pop and show an indicator, buttons give press feedback, and posts, comments and Settings groups rise in. Poll bars animate to their share.
- All motion is in `src/index.css` and is switched off by the system's "reduce motion" setting.
- **Settings** now opens with your profile and an Edit profile button, with the cards grouped under Privacy and safety, Appearance, Your content and Account. "Saved." notices disappear by themselves, and the app bar is hidden on Settings so there is only one header.

## Posting limits and the spam check

- **Limit:** at most 3 posts per 15 minutes per person (replaces the old 10 per hour). It is a fixed 15-minute window, so a burst across a window edge can be up to 6. Only posts that passed every check use it: a rejected poll, a bad body or a spam-looking post does not. A separate loose guard (60 attempts per 15 minutes) keeps rejected requests from hammering the database.
- **Spam check** (`worker/content/spam.ts`): a rule-based score, not a classifier. Signals: links (one is 1 point, several 2), pushy phrases like "free money" or "click here" (2), WhatsApp/Telegram/phone bait (1), 10+ repeated characters (1), long ALL CAPS (1), mostly repeated words (2), and the same post text as one of your own in the last 24 hours (3, text of 20+ characters). A post is refused at 3 points or more, so one link or one phrase alone passes. Poll options are checked with the post.
- **3-day lock:** a refused post is recorded as a strike. Three strikes in a row (no normal post in between, all within 3 days) pause posting for 3 days from the newest strike (`403`, `code: spam_locked`, `locked_until`, `Retry-After`). A normal post clears the streak, and old strikes expire by themselves.
- The check covers new posts only. Comments, messages and profile text are not checked yet, and there is no appeal screen: a wrongly refused post is fixed by editing the text, and a lock can be lifted by deleting the person's rows in `spam_strikes`.
- Counts in polls leave out votes from anyone blocked with the poll's author (either direction, even if the block came after the vote); the vote rows stay, so unblocking brings them back.

## Install as an app (PWA)

Dialtone can be added to a phone's home screen without any app store. What exists:

- **Files** (all in `public/`, copied to the site root by the build): `manifest.webmanifest` (name, colours, icons, `display: standalone`), `sw.js` (service worker), `offline.html`, `icons/` (192, 512, maskable 512, 180 px Apple icon). `index.html` links the manifest, the theme colour and the Apple home-screen tags. The icons are **placeholders** (a yellow ring on the brand blue): replace the four PNGs in `public/icons/` with the real logo, keeping the file names and sizes (`tests/pwa.test.ts` checks both). The maskable icon must keep its artwork inside the middle 80%.
- **Service worker rules** (`public/sw.js`): static files only. It keeps the offline page, the icons, the hashed build files in `/assets/` and the bundled stickers. It never touches `/api/` (so feeds, profiles, messages, media and sign-in always come from the server), never stores HTML pages, uploads or anything from a signed-in session, and ignores non-GET and range (video) requests. Page loads always use the network; if the phone is offline the offline page is shown. It registers only in production builds on HTTPS (`registerServiceWorker` in `src/lib/pwa.ts`). When you change its rules, change `CACHE` at the top of the file; old caches are deleted on the next visit.
- **Install help** (`src/lib/pwa.ts`, `InstallBanner`, `ShareApp`): Android and desktop Chrome/Edge use the browser's own prompt, captured and shown as a banner with Install and Not now. On iPhone/iPad Safari, which has no install prompt, the banner explains Share, then Add to Home Screen. In another app's built-in browser (Instagram, Facebook, TikTok, WebViews) it asks the person to open Safari or Chrome; the sign-in page shows only this notice, because Google refuses sign-in inside those browsers. Other iOS browsers (Chrome, Firefox, Edge on iPhone) are also sent to Safari rather than promising something unverified. "Not now" hides the banner for 14 days on that device, installing hides it for good, and Settings, Install and share, always shows the instructions.
- **Share and QR** (Settings, Install and share): Share link (the phone share sheet, or copy) and a QR code. The code holds only the site address (`window.location.origin` plus `/`): no query, no fragment, no account information. The QR drawing uses the small MIT library `qrcode-generator` (no dependencies).
- **Not done on purpose:** the page does not claim it can force an install dialog on iOS, there are no startup (splash) images, and no private API response is cached.

After deploying, check on the real site: Chrome DevTools, Application, Manifest shows no errors and "Installable"; Service Workers shows `sw.js` running; Network shows `/api/` requests are not served from the service worker; on an iPhone in Safari, Share, Add to Home Screen gives the right icon and name. The canonical address (and so the QR code) is whatever address people use to open the site; if you later move to your own domain, the QR code follows automatically.

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
- **Private data.** Email, the last three digits of the roll number, and a keyed hash of the full roll number live in `user_private`, not in `profiles`, so no `SELECT *` can leak them; `GET/PATCH /api/me` now build their response from named columns only. They are never returned by any endpoint and cannot be set through `PATCH /api/me`. Deleting an account removes them.
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
- **`011_spam_strikes.sql`**: `spam_strikes`, one row per post attempt that looked like spam (see "Posting limits and the spam check").
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

---

## Admin and moderation

### Three kinds of account
| | What they can do |
|---|---|
| **Master admin** (you, exactly one) | Everything an admin can, plus: act on other admins, reinstate banned accounts, appoint admins without losing the role. Nobody else can see, suspend, ban, demote or appoint the master; to every other admin the account does not exist. |
| **Appointed admin** | Look at reports and the people directory, suspend or ban ordinary accounts, reinstate suspended ones, and hand the admin role to someone else. |
| **Everyone else** | Nothing under `/api/admin`. The Admin tools entry in Settings never appears and the API answers 403. |

**Hot potato:** when an appointed admin makes someone an admin, that person becomes an admin and the appointer becomes an ordinary user in one database statement (both change or neither does). Two hand-overs at the same moment cannot both go through. The master is not affected: the master can add admins and stays the master.

Every admin action is written to the activity log (`admin_actions`): who, what, to whom, the reason you typed, and when. The master shows up there only as "master admin".

### How the master is made (and why it is safe)
The master is created only by a command you run yourself, `npm run bootstrap:master`. There is no web page, endpoint or setting that can do it, and no password or secret is involved (Wrangler uses your own Cloudflare login).

- It needs `--remote` (live database) or `--local` (test database); it never guesses.
- It **refuses** if a master already exists, if the account does not exist, or if the account is not active. It never replaces a master.
- Running it again for the same account is safe: "nothing to do".
- Even if someone edited the command, the database itself allows only one master (unique index `idx_users_one_master`).
- The role is read from the database on every request, so removing someone's admin access shuts them out at once.
- The account id is not a secret (it only identifies an account); it is shown in Settings so you can copy it.

### Recovery (lost the master account, or you want to hand it over)
Because only the person who owns the Cloudflare account can run these commands, this is the "owner can always get back in" path:
```bat
npx wrangler d1 execute classsync-db --remote --command "UPDATE users SET role = 'user' WHERE role = 'master'"
npm run bootstrap:master -- --user-id usr_THE_NEW_MASTER --remote
```
The first line removes the current master, the second makes the new one. Both are logged by Cloudflare against your account; the bootstrap also writes its own activity line.

### What admins can and cannot see
The people directory shows username, display name, role and status only. It never returns email addresses, real names or private sign-up data. A reported message is shown to admins only in the report preview, for the one message that was reported.

### Limits of this version
- The admin tools are a protected page inside the same app (Settings, Admin tools), not a separate address. A separate address would not be a security boundary by itself; the checks are on the server for every admin request.
- The master account cannot be deleted from inside the app (the request is refused); use the Recovery steps to hand it over first.
- Banning also takes the person's active posts out of circulation (they stay in the database until the normal expiry cleanup). Reinstating a banned account does not bring those posts back.
- Suspended and banned people are signed out at once and cannot sign in again; they see a clear message instead of a loop.
- Appeals, automatic content classification, and the separate "permanent artifacts" feature from the longer blueprint are not built yet.

---

## Deploying from Windows CMD, free, without your own domain

1. **Tools:** install Node.js 22 from nodejs.org, then in CMD from the repo folder: `npm install`.
2. **Address:** you do not need a domain. The deploy gives you `https://classsync.<your-name>.workers.dev` for free (the first time you deploy, Wrangler asks you to pick the `<your-name>` part). The app is a single Worker that also serves the pages, so Cloudflare Pages is not needed.
3. **Follow "Cloudflare Deployment" above, steps 1 to 9.** Every command works in CMD as written, except generating `ADMIN_SECRET` (use the `node -e` line there).
4. **Tell Google the address:** in the Google console add `https://classsync.<your-name>.workers.dev/api/auth/callback` as an authorized redirect URI, and set `APP_URL` to `https://classsync.<your-name>.workers.dev`.
5. **Backups:** `npm run db:backup` writes `backups\classsync-YYYY-MM-DD.sql` (works in CMD; the old version of this script did not).
6. **Sharing:** until the QR code feature is built, share the address itself; a QR code of that address can be made with any free QR maker. The code must contain only the address, never a login.

### Free tier: what to check before you rely on it
Cloudflare changes these numbers, so check the Workers, D1 and R2 pricing pages before launch. As far as I know at the time of writing: Workers Free allows about 100,000 requests a day (the app stops answering until the next day when it is used up), D1 Free has daily read and write limits and a total size cap, and R2 has a free monthly storage amount. **R2 asks for a payment method on the account to switch it on even for the free amount**, so if you cannot add one, photo and video upload will not work until you can (everything else does). Set a billing alert if you add a card.



## Student sign-up checks

Sign-up asks for the **full roll number** (as printed on the card) and a **scan of the card barcode**.

- **One student, one account per campus.** The roll number is normalized (case, spaces, dashes, slashes, leading zeros) and combined with the campus. Only an HMAC-SHA256 of that pair, keyed by `ROLL_KEY_SECRET`, is stored (`user_private.roll_key`), with a unique index, so two simultaneous sign-ups cannot both succeed. Class, section and session are not part of the key, so a student keeps the same identity as they move up. The last three digits are still stored for display-free internal use.
- **Card scan.** The barcode is read in the browser (`@zxing`, loaded only on that step, 1D barcodes only). The picture is never uploaded. The server compares the decoded text with the typed roll number; a mismatch is refused with a reason. A match marks the account `provisional`. This is **not proof**: a barcode can be copied, and no PGC registry is available to check against.
- **Printed text (OCR).** After the barcode matches, the same camera picture is read with Tesseract.js, on the device (engine and English data are served from `/ocr`, copied from `node_modules` by `scripts/copy-ocr-assets.mjs` before `dev` and `build`, about 22 MB, loaded only at this step). The name, campus, program and session you typed are compared with the printed text and each gets *match*, *uncertain*, *mismatch* or *unreadable* (`shared/card-match.ts`). It never changes what you typed. A clear mismatch is shown plainly and the student must tick "I checked, and what I typed is correct"; unreadable or uncertain text never blocks sign-up. The result is stored as information in `user_private.verification_detail` and never changes the verification status. The picture is dropped after reading.
- **"Already registered".** The student gets a clear message (never details of the other account), is not blocked, and a row is kept in `registration_disputes`. Admins see these under Admin, Sign-ups, with the username of the account that holds the roll number, and can mark them handled (logged in Activity). If the holder is an impostor, suspend or ban it in People and the real student can sign up again. Deleting an account frees its roll number.
- **Guessing.** Per ticket 10 tries per 15 minutes and per Google account 20 per day, so the endpoint cannot be used to map which roll numbers exist.
- **Switches.** `REQUIRE_CARD_SCAN=false` (a plain variable) lets people sign up without scanning; they stay `unverified`. The local dev server (`npm run dev`) already turns the requirement off; set `REQUIRE_CARD_SCAN=true` to try the real flow. For a deployed test site, set it as a variable. Anything else requires the scan.
- **Deploying.** Run migration 013 on the remote database first (`npx wrangler d1 migrations apply <db> --remote`), set `ROLL_KEY_SECRET`, then deploy. Accounts made before this have no roll key and stay `unverified`.

## Appeals and how long moderation records are kept

- **Appeals.** A suspended or banned student has no session, so signing in with Google gives them a one-hour *appeal ticket* cookie that can do exactly two things: send one request (1 to 500 characters, no markup, 10 tries a day) and read its status. They see the form on the sign-in screen. Admins decide under Admin, Appeals. *Reinstate* sets the account active again (a ban can only be lifted by the master, the same rule as the People tab); *Keep blocked* leaves it and shows the student the note. Every decision is logged in Activity. One open appeal per account, enforced by the database. Run migration 014 before deploying.
- **Retention** (the daily cleanup job, `POST /api/jobs/cleanup-expired`). Open reports, sign-up requests and appeals are never deleted by it. Handled ones go after: reports 90 days, sign-up requests 90 days, appeals 180 days, the admin activity log 365 days. Expired appeal tickets are removed straight away. Report evidence still expires after 30 days. The numbers are constants at the top of `worker/jobs/expiry.ts`.

## Bot check (Cloudflare Turnstile)

Optional and off by default. Turn it on to make sign-up need a passed Turnstile check:

1. In the Cloudflare dashboard create a Turnstile widget for your domain (free). Copy the site key and the secret key.
2. `npx wrangler secret put TURNSTILE_SECRET_KEY`, and add the site key as a plain variable `TURNSTILE_SITE_KEY` in `wrangler.toml` (`[vars]`). Both must be set; with only one, the check stays off.
3. The sign-up form then shows the check, and `POST /api/signup/complete` verifies the token with Cloudflare before anything is looked up or written. It fails closed: a missing token, a rejected token, or Cloudflare being unreachable all refuse the sign-up (403, `turnstile_failed`) without using up the sign-up ticket. A token works once, so the form asks for a new check after any refused attempt.
4. The widget script comes from `challenges.cloudflare.com`. There is no Content-Security-Policy in this app today; if you add one, allow that host for scripts and frames.

The widget has been tested only against a stand-in for Cloudflare's script, not on a real device.

## How the For You feed ranks

Each request ranks a pool of candidates for that viewer. The cursor remembers which posts were already delivered and every page is the best of what is left, so the feed never repeats or skips a post (even while views are being reported and the ranking shifts mid-scroll) and never dead-ends until the pool is used up.

**Candidates**: the newest 100 posts, plus up to 100 more on the viewer's strongest interests and on trending topics (however old, as long as they have not expired). Blocked users and "not interested" posts are excluded.

**Score** (weights in `worker/ranking/config.ts`, summing to 1):

| Signal | Weight | What it is |
| --- | --- | --- |
| Interest | 0.30 | The post's topics matched against the viewer's topic signals (14-day half-life) |
| Social | 0.20 | Followed author 1.0, same class 0.5 |
| Recency | 0.15 | Fades linearly over 7 days |
| Engagement | 0.15 | Distinct people who liked or commented, relative to how often it was shown |
| Class context | 0.10 | Same class as the viewer |
| Trend | 0.10 | The hottest 24h trending topic on the post |

A post the viewer was shown in the last 3 days keeps 35% of its score, so it sinks instead of repeating. Then a diversity pass applies (at most 2 posts per author and 3 per topic per page, with about 15% of slots kept for posts from outside the viewer's circle).

**What the feed learns from**: a like (+1), a comment (+3), "more like this" (+3), "show less" (-3), "not interested" (-4), and a view of 3 seconds or more (+0.1). The client reports how long each post was on screen to `POST /api/impressions`. Stored signals are decayed to the present before a new one is added, and clamped between -10 and 25.

**How posts are understood**: `#hashtags` (full weight) and a small keyword list, matched with plurals and "-ing" / "-ed" forms ("exams", "studying"). Related words also share one category topic (for example "gym" and "fitness" both add `sports-fitness`), so liking one kind of post surfaces its neighbours. There is no semantic model yet; the embedding hook in `worker/content/topics.ts` is switched off.

---

## [EXPERIMENTAL] Core Frame Feed Engine

> WARNING: Do NOT modify or edit this section unless explicitly requested.

The home feed no longer renders one endless list. It renders **frames**: discrete chunks of posts, tagged `SAFE` or `WILD`, with a **Mid-Frame** buffer slot after every two `SAFE` frames. Only a small sliding window of frames is ever in the DOM. The engine knows nothing about monetization; other managers attach to it through events.

### Where it lives

| Path | Role |
| --- | --- |
| `src/feed-engine/FeedFrameManager.ts` | The algorithm: frame generation, layout, sliding window, events |
| `src/feed-engine/pooledSource.ts` | Sorts one mixed paged feed into `SAFE` / `WILD` pools |
| `src/feed-engine/layout.ts` | Frame layout (default `SAFE, SAFE, MID, WILD`) |
| `src/feed-engine/react.ts` | React bindings: mounted frames, focus, scroll anchoring, edge sentinels |
| `src/feed-engine/scrollDirection.ts` | Which way the viewer is scrolling (the edge sentinels only act in the direction of travel) |
| `src/feed-engine/types.ts` | Types and the event map |
| `src/lib/feed-source.ts` | Connects `/api/feed` to the engine and decides `SAFE` vs `WILD` (`classifyPost`) |
| `src/components/FeedFrame.tsx`, `src/pages/FeedPage.tsx` | The only UI that uses it |
| `tests/feed-engine.test.ts`, `tests/feed-page-frames.test.tsx` | Engine and page tests |

### Concepts

- **Frame**: an immutable chunk of posts (8 by default; set `frameSize` to anything from 5 to 10). Its `index` is stable, so scrolling back up rebuilds the identical frame. Frame *data* is cached; only the *DOM* is destroyed.
- **Kinds**: `SAFE` and `WILD` frames hold only posts of that moderation state (the pooled source guarantees it). `MID` frames hold no posts: they are an empty, zero-height transition slot (no visible gap) that another manager can fill later. They only exist when a layout includes them.
- **Layout**: a pure function from position to kind. The v1 default (`DEFAULT_LAYOUT`) is one continuous run of `SAFE` frames: no Mid-Frame, nothing `WILD`. `MODERATED_LAYOUT` is the moderation-phase layout (`SAFE, SAFE, MID, WILD`, a Mid-Frame after every two `SAFE` frames); pass it as `layout` (or `frameLayout` on `FeedPage`) when you are ready. Any other pattern: `cycleLayout([...])`.
- **Volatile frame**: a frame that may never be mounted next to a `WILD` frame. `MID` frames are volatile by default (this is the "ad or non-compatible slot"); `markVolatile(frameId)` opts any other frame in.
- **Window**: at most `maxActiveFrames` (default 3: one behind, the focused frame, one ahead) are mounted.
- **Focus**: the frame crossing the middle of the viewport. `manager.focus(index)` drives everything.

### Guarantees

1. At most 3 frames are mounted at any moment.
2. A volatile frame and a `WILD` frame are **never in the mounted set together**. Before a `WILD` frame mounts, every volatile frame has been unmounted (`pre-wild`). If the focus is on a volatile frame, the `WILD` neighbour is held back instead (`conflict`).
3. Scrolling down and up share one code path. The scroll direction decides mount order and which neighbour wins a tie.
4. When the user reaches the end of the mounted frames, `advance()` moves the focus on (and `retreat()` at the top). This keeps the feed moving past a zero-height Mid-Frame and past a `WILD` frame held back behind a focused one. The page wires them to two invisible sentinels that only act in the direction the viewer is scrolling, so scrolling up through a frame can never re-mount what was just removed below it.
5. Frames that leave the window are fully removed. Blank spacers of their measured height stand in above and below the list (unmeasured frames are estimated), and the scroll position is re-anchored after every change, so the page neither jumps nor hits a wall when frames are destroyed or brought back. When a `WILD` frame arrives, an empty Mid-Frame slot is stepped over, so the content frame behind it stays mounted instead of vanishing while still on screen.
6. A kind that runs out of posts is skipped rather than ending the feed. The feed never ends on an empty Mid-Frame.
7. Overlapping `focus()` calls are safe (the latest wins), a failed load can be retried with `retry()`, and a throwing event handler can never break the core.

### Events

| Hook | Fires | Payload |
| --- | --- | --- |
| `onFrameMount` | the frame has joined the mounted set | `{ frame, direction }` |
| `onFrameUnmount` | the frame is about to leave it (tear down your own content here) | `{ frame, reason }`: `window`, `pre-wild`, `conflict` or `destroy` |
| `onMidFrameReached` | the user landed on, or scrolled past, a Mid-Frame | `{ frame, direction, landed }` |
| `on('frameFocus')` | the focused frame changed | `{ frame, previous, direction }` |
| `on('frameCreated')` | a frame was generated | `{ frame }` |
| `on('feedEnd')` | the source ran out | `{ totalFrames }` |
| `on('loadError')` | a page fetch failed | `{ error }` |

Every hook returns an unsubscribe function.

### Moderation tag

`PostItem.moderation?: 'SAFE' | 'WILD'` is read by `classifyPost` in `src/lib/feed-source.ts`. A post without the field is `SAFE`. There is no moderation tagging in v1, so the default layout shows `SAFE` frames only and the feed is one continuous list. When moderation exists, set the field on the server and switch to `MODERATED_LAYOUT`.

### Connecting another manager later (no core edits)

```ts
manager.onMidFrameReached(({ frame, landed }) => { /* fill or inspect the slot */ });
manager.onFrameUnmount(({ frame, reason }) => { /* release whatever you attached */ });
manager.markVolatile(frame.id); // opt another frame into "never beside WILD"
```

### Source

#### `src/feed-engine/types.ts`

```ts
/**
 * Core Frame Feed Engine: shared types.
 * Nothing in src/feed-engine knows about monetization. Third parties attach through events.
 */
export type ModerationState = 'SAFE' | 'WILD';
/** MID is the buffer slot inserted after every two SAFE frames. It never holds items. */
export type FrameKind = ModerationState | 'MID';
export type ScrollDirection = 'up' | 'down';
/**
 * window    left the sliding window
 * pre-wild  a volatile frame removed so a WILD frame can mount
 * conflict  a WILD frame removed because the focused frame is volatile
 * destroy   manager.destroy()
 */
export type UnmountReason = 'window' | 'pre-wild' | 'conflict' | 'destroy';

export interface Frame<T> {
  readonly id: string;
  /** Stable position in the feed. The same index always yields the same frame. */
  readonly index: number;
  readonly kind: FrameKind;
  readonly items: readonly T[];
}

export interface LoadResult<T> {
  items: T[];
  /** True when this moderation state will never produce another item. */
  done: boolean;
}

/**
 * Supplies already-classified items. The manager calls load() once per content frame, in order.
 * An empty result with done=false means "nothing right now": the slot is skipped, not the feed ended.
 */
export interface FeedSource<T> {
  load(moderation: ModerationState, limit: number): Promise<LoadResult<T>>;
}

export interface FeedStatus {
  readonly loading: boolean;
  readonly ended: boolean;
  readonly error: unknown | null;
}

export interface FeedFrameEvents<T> {
  frameCreated: { frame: Frame<T> };
  /** The frame has joined the mounted set (the UI commits it right after). */
  frameMount: { frame: Frame<T>; direction: ScrollDirection };
  /** The frame is about to leave the mounted set. Tear down anything you attached to it. */
  frameUnmount: { frame: Frame<T>; reason: UnmountReason };
  frameFocus: { frame: Frame<T>; previous: Frame<T> | null; direction: ScrollDirection };
  /** `landed` is false when the user scrolled past the Mid-Frame without stopping on it. */
  midFrameReached: { frame: Frame<T>; direction: ScrollDirection; landed: boolean };
  feedEnd: { totalFrames: number };
  loadError: { error: unknown };
}
```

#### `src/feed-engine/layout.ts`

```ts
import type { FrameKind } from './types.ts';

/** Pure mapping from a layout position to a frame kind. */
export type FrameLayout = (position: number) => FrameKind;

export function cycleLayout(pattern: readonly FrameKind[]): FrameLayout {
  if (pattern.length === 0) throw new RangeError('Layout pattern must not be empty');
  return (position) => pattern[position % pattern.length] ?? 'SAFE';
}

/** v1 default: one continuous run of SAFE frames. No Mid-Frames, nothing WILD. */
export const DEFAULT_LAYOUT: FrameLayout = cycleLayout(['SAFE']);

/**
 * The moderation-phase layout: every two SAFE frames are followed by a Mid-Frame, then one WILD frame.
 * Pass it as `layout` once posts carry a SAFE / WILD tag and something fills the Mid-Frame slot.
 */
export const MODERATED_LAYOUT: FrameLayout = cycleLayout(['SAFE', 'SAFE', 'MID', 'WILD']);
```

#### `src/feed-engine/pooledSource.ts`

```ts
import type { FeedSource, ModerationState } from './types.ts';

export interface Page<T> {
  items: readonly T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface PooledSourceOptions<T> {
  fetchPage: (cursor: string | null) => Promise<Page<T>>;
  /** The SAFE / WILD classification step. Everything downstream trusts it. */
  classify: (item: T) => ModerationState;
  /** Cap on pages fetched per load() while looking for enough items of one state. Default 3. */
  maxPagesPerLoad?: number;
}

/**
 * Turns one paged, mixed feed into two classified pools. Frames drain the pool that matches their kind.
 * Pages fetched while hunting for one state are kept for the other, so nothing is wasted.
 */
export function createPooledSource<T>(options: PooledSourceOptions<T>): FeedSource<T> {
  const { fetchPage, classify, maxPagesPerLoad = 3 } = options;
  const pools: Record<ModerationState, T[]> = { SAFE: [], WILD: [] };
  let cursor: string | null = null;
  let serverDone = false;

  async function fetchNext(): Promise<void> {
    const page = await fetchPage(cursor); // throws leave cursor and pools untouched
    for (const item of page.items) pools[classify(item)].push(item);
    cursor = page.nextCursor;
    if (!page.hasMore || page.nextCursor === null) serverDone = true;
  }

  return {
    async load(moderation, limit) {
      let pages = 0;
      while (pools[moderation].length < limit && !serverDone && pages < maxPagesPerLoad) {
        await fetchNext();
        pages++;
      }
      const items = pools[moderation].splice(0, limit);
      return { items, done: serverDone && pools[moderation].length === 0 };
    },
  };
}
```

#### `src/feed-engine/FeedFrameManager.ts`

```ts
import { DEFAULT_LAYOUT, type FrameLayout } from './layout.ts';
import type {
  FeedFrameEvents,
  FeedSource,
  FeedStatus,
  Frame,
  FrameKind,
  ModerationState,
  ScrollDirection,
  UnmountReason,
} from './types.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (payload: any) => void;

/** Upper bound on layout steps spent looking for the next frame, so a bad layout cannot spin forever. */
const MAX_LAYOUT_STEPS = 64;
/** How many empty dropped slots the window may step over when looking for the next content frame. */
const MAX_STEPPED_OVER_SLOTS = 2;

export interface FeedFrameManagerOptions<T> {
  source: FeedSource<T>;
  layout?: FrameLayout;
  /** Items per content frame. Default 8 (recommended range 5-10). */
  frameSize?: number;
  /** Frames kept mounted behind / ahead of the focused frame. Default 1 / 1. */
  windowBehind?: number;
  windowAhead?: number;
  /** Hard cap on simultaneously mounted frames. Default 3. */
  maxActiveFrames?: number;
}

/**
 * Core Frame Feed Engine.
 *
 * Slices a feed into frames (SAFE / WILD content frames plus MID buffer slots), keeps only a small
 * sliding window of them mounted, and emits events so other managers can attach without touching
 * this file. It renders nothing itself: the UI renders getMountedFrames().
 */
export class FeedFrameManager<T> {
  private readonly source: FeedSource<T>;
  private readonly layout: FrameLayout;
  private readonly frameSize: number;
  private readonly windowBehind: number;
  private readonly windowAhead: number;

  /** Data cache: every generated frame by index. Never evicted, so scrolling back rebuilds the same frame. */
  private readonly frames: Frame<T>[] = [];
  /** Frames currently in the UI, by index. */
  private readonly mounted = new Map<number, Frame<T>>();
  private readonly volatileIds = new Set<string>();
  private readonly exhausted = new Set<ModerationState>();
  private readonly handlers = new Map<keyof FeedFrameEvents<T>, Set<AnyHandler>>();
  private readonly changeListeners = new Set<() => void>();

  private mountedSnapshot: readonly Frame<T>[] = Object.freeze([]);
  private status: FeedStatus = Object.freeze({ loading: false, ended: false, error: null });
  private layoutCursor = 0;
  private focusIndex = -1;
  private lastDirection: ScrollDirection = 'down';
  private focusToken = 0;
  private generation: Promise<void> = Promise.resolve();

  constructor(options: FeedFrameManagerOptions<T>) {
    const { windowBehind = 1, windowAhead = 1, maxActiveFrames = 3 } = options;
    if (windowBehind < 0 || windowAhead < 0 || windowBehind + windowAhead + 1 > maxActiveFrames) {
      throw new RangeError(
        `Window (${windowBehind} behind + focus + ${windowAhead} ahead) exceeds maxActiveFrames (${maxActiveFrames})`,
      );
    }
    this.source = options.source;
    this.layout = options.layout ?? DEFAULT_LAYOUT;
    this.frameSize = Math.max(1, Math.floor(options.frameSize ?? 8));
    this.windowBehind = windowBehind;
    this.windowAhead = windowAhead;
  }

  // ------------------------------------------------------------------ public API

  /**
   * Move focus to a frame index. Generates missing frames, then reconciles the mounted window.
   * Rejects if the source throws (also surfaced via getStatus().error and the loadError event).
   */
  focus(index: number): Promise<void> {
    return this.moveFocus(index, false);
  }

  /** Re-run the current focus, e.g. after a load error. */
  retry(): Promise<void> {
    return this.moveFocus(Math.max(this.focusIndex, 0), true);
  }

  /**
   * Call when the user has scrolled to the end of the mounted frames. Moves the focus to the last
   * mounted frame, or one further when it is already there. This keeps the feed moving when the last
   * mounted frame is a zero-height Mid-Frame (it never crosses the viewport middle) and when a WILD
   * neighbour is held back behind a focused Mid-Frame (nothing below to scroll onto).
   */
  advance(): Promise<void> {
    if (this.focusIndex < 0 || this.mounted.size === 0) return Promise.resolve();
    return this.focus(Math.max(this.focusIndex + 1, Math.max(...this.mounted.keys())));
  }

  /** Mirror of advance(): the user has scrolled to the top of the mounted frames. */
  retreat(): Promise<void> {
    if (this.focusIndex <= 0 || this.mounted.size === 0) return Promise.resolve();
    return this.focus(Math.min(this.focusIndex - 1, Math.min(...this.mounted.keys())));
  }

  getFocusIndex(): number {
    return this.focusIndex;
  }

  /** A generated frame by index (mounted or not). */
  getFrame(index: number): Frame<T> | undefined {
    return this.frames[index];
  }

  /** How many frames have been generated so far (mounted or not). */
  getFrameCount(): number {
    return this.frames.length;
  }

  /** Mark a frame as one that must never be mounted beside a WILD frame. MID frames already are. */
  markVolatile(frameId: string, volatile = true): void {
    if (volatile) this.volatileIds.add(frameId);
    else this.volatileIds.delete(frameId);
    if (this.focusIndex >= 0) this.reconcile(this.focusIndex, this.lastDirection);
  }

  isVolatile(frame: Frame<T>): boolean {
    return frame.kind === 'MID' || this.volatileIds.has(frame.id);
  }

  /** Immutable snapshot of mounted frames sorted by index. Same reference until something changes. */
  readonly getMountedFrames = (): readonly Frame<T>[] => this.mountedSnapshot;

  readonly getStatus = (): FeedStatus => this.status;

  /** Subscribe to mounted-set / status changes (useSyncExternalStore compatible). */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  };

  on<K extends keyof FeedFrameEvents<T>>(
    event: K,
    handler: (payload: FeedFrameEvents<T>[K]) => void,
  ): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  onFrameMount(handler: (p: FeedFrameEvents<T>['frameMount']) => void): () => void {
    return this.on('frameMount', handler);
  }
  onFrameUnmount(handler: (p: FeedFrameEvents<T>['frameUnmount']) => void): () => void {
    return this.on('frameUnmount', handler);
  }
  onMidFrameReached(handler: (p: FeedFrameEvents<T>['midFrameReached']) => void): () => void {
    return this.on('midFrameReached', handler);
  }

  /** Unmounts every frame and cancels in-flight focus calls. The instance can be focused again. */
  destroy(): void {
    this.focusToken++;
    for (const frame of [...this.mounted.values()]) this.unmountFrame(frame, 'destroy');
    this.focusIndex = -1;
  }

  // ------------------------------------------------------------ frame generation

  private async moveFocus(index: number, force: boolean): Promise<void> {
    if (!Number.isInteger(index) || index < 0) throw new RangeError(`Invalid frame index: ${index}`);
    if (!force && index === this.focusIndex) return;

    const token = ++this.focusToken;
    const direction: ScrollDirection =
      index === this.focusIndex ? this.lastDirection : index > this.focusIndex ? 'down' : 'up';

    await this.ensureFrames(index + this.windowAhead);
    if (token !== this.focusToken) return; // superseded by a newer focus() or destroy()

    const last = this.frames.length - 1;
    if (last < 0) return; // empty feed
    this.reconcile(Math.min(index, last), direction);
  }

  /** Serialises generation so frames are always created in index order. */
  private ensureFrames(upTo: number): Promise<void> {
    const run = this.generation.then(async () => {
      if (this.frames.length > upTo || this.status.ended) return;
      this.setStatus({ loading: true });
      try {
        while (this.frames.length <= upTo && !this.status.ended) await this.generateNext();
        this.setStatus({ loading: false, error: null });
      } catch (error) {
        this.setStatus({ loading: false, error });
        this.emit('loadError', { error });
        throw error;
      }
    });
    this.generation = run.catch(() => undefined); // a failed load must not wedge the chain
    return run;
  }

  /**
   * Builds the next content frame (plus any Mid-Frames due before it).
   * Exhausted kinds are skipped, and Mid-Frames are only created when content follows them,
   * so the feed never ends on an empty slot.
   */
  private async generateNext(): Promise<void> {
    let pendingMids = 0;
    for (let step = 0; step < MAX_LAYOUT_STEPS; step++) {
      if (this.exhausted.has('SAFE') && this.exhausted.has('WILD')) break;
      const kind = this.layout(this.layoutCursor++);
      if (kind === 'MID') {
        pendingMids++;
        continue;
      }
      if (this.exhausted.has(kind)) continue;

      const result = await this.source.load(kind, this.frameSize);
      if (result.done) this.exhausted.add(kind);
      if (result.items.length === 0) continue; // nothing right now: skip this slot

      for (let i = 0; i < pendingMids; i++) this.pushFrame('MID', []);
      this.pushFrame(kind, result.items);
      return;
    }
    this.setStatus({ ended: true });
    this.emit('feedEnd', { totalFrames: this.frames.length });
  }

  private pushFrame(kind: FrameKind, items: readonly T[]): void {
    const index = this.frames.length;
    const frame: Frame<T> = Object.freeze({
      id: `frame-${index}`,
      index,
      kind,
      items: Object.freeze([...items]),
    });
    this.frames.push(frame);
    this.emit('frameCreated', { frame });
  }

  // --------------------------------------------------------------- reconciliation

  private reconcile(focus: number, direction: ScrollDirection): void {
    const focused = this.frames[focus];
    if (!focused) return;
    const previous = this.focusIndex >= 0 ? (this.frames[this.focusIndex] ?? null) : null;
    this.focusIndex = focus;
    this.lastDirection = direction;

    const target = this.resolveWindow(focused, direction);
    const targetIndexes = new Set(target.map((f) => f.index));
    const targetHasWild = target.some((f) => f.kind === 'WILD');

    // 1. Unmount everything outside the target, farthest first. The target never mixes a volatile
    //    frame with a WILD frame, so by the time step 2 mounts a WILD frame every volatile frame is gone.
    const evict = [...this.mounted.values()]
      .filter((f) => !targetIndexes.has(f.index))
      .sort((a, b) => Math.abs(b.index - focus) - Math.abs(a.index - focus));
    for (const frame of evict) {
      let reason: UnmountReason = 'window';
      if (this.isVolatile(frame) && targetHasWild) reason = 'pre-wild';
      else if (frame.index >= focus - this.windowBehind && frame.index <= focus + this.windowAhead) {
        reason = 'conflict';
      }
      this.unmountFrame(frame, reason);
    }

    // 2. Mount what is missing, in scroll-direction order.
    const toMount = target
      .filter((f) => !this.mounted.has(f.index))
      .sort((a, b) => (direction === 'down' ? a.index - b.index : b.index - a.index));
    for (const frame of toMount) this.mountFrame(frame, direction);

    // 3. Focus and Mid-Frame events.
    if (previous?.index !== focus) {
      this.emit('frameFocus', { frame: focused, previous, direction });
      this.emitMidFramesPassed(previous, focus, direction);
    }
  }

  /** Emits midFrameReached for every Mid-Frame between the old and new focus, in travel order. */
  private emitMidFramesPassed(previous: Frame<T> | null, focus: number, direction: ScrollDirection): void {
    const indexes: number[] = [];
    if (!previous) indexes.push(focus);
    else if (direction === 'down') for (let i = previous.index + 1; i <= focus; i++) indexes.push(i);
    else for (let i = previous.index - 1; i >= focus; i--) indexes.push(i);

    for (const i of indexes) {
      const frame = this.frames[i];
      if (frame?.kind === 'MID') this.emit('midFrameReached', { frame, direction, landed: i === focus });
    }
  }

  /**
   * Picks the frames to keep mounted: the focused frame, then up to windowAhead / windowBehind frames on
   * each side. The neighbour in the scroll direction is chosen first, so it wins any conflict. A candidate
   * that would put a volatile frame next to a WILD frame is dropped. A dropped frame with no content (a
   * Mid-Frame slot) is stepped over, so the content frame beyond it stays mounted instead of vanishing
   * while still on screen; a dropped frame that has content is never stepped over, because that would
   * leave a hole in the feed.
   */
  private resolveWindow(focused: Frame<T>, direction: ScrollDirection): Frame<T>[] {
    const picked: Frame<T>[] = [focused];

    const take = (step: 1 | -1, limit: number): void => {
      let taken = 0;
      for (let d = 1; d <= limit + MAX_STEPPED_OVER_SLOTS && taken < limit; d++) {
        const candidate = this.frames[focused.index + step * d];
        if (!candidate) return;
        if (!this.conflicts(candidate, picked)) {
          picked.push(candidate);
          taken++;
        } else if (candidate.items.length > 0) {
          return;
        }
      }
    };

    if (direction === 'down') {
      take(1, this.windowAhead);
      take(-1, this.windowBehind);
    } else {
      take(-1, this.windowBehind);
      take(1, this.windowAhead);
    }
    return picked;
  }

  private conflicts(candidate: Frame<T>, picked: readonly Frame<T>[]): boolean {
    const candidateWild = candidate.kind === 'WILD';
    const candidateVolatile = this.isVolatile(candidate);
    return picked.some(
      (p) => (candidateWild && this.isVolatile(p)) || (candidateVolatile && p.kind === 'WILD'),
    );
  }

  private mountFrame(frame: Frame<T>, direction: ScrollDirection): void {
    this.mounted.set(frame.index, frame);
    this.refreshSnapshot();
    this.emit('frameMount', { frame, direction });
  }

  private unmountFrame(frame: Frame<T>, reason: UnmountReason): void {
    if (!this.mounted.has(frame.index)) return;
    this.emit('frameUnmount', { frame, reason }); // before removal: listeners tear down first
    this.mounted.delete(frame.index);
    this.refreshSnapshot();
  }

  private refreshSnapshot(): void {
    this.mountedSnapshot = Object.freeze([...this.mounted.values()].sort((a, b) => a.index - b.index));
    this.notify();
  }

  private setStatus(patch: Partial<FeedStatus>): void {
    const next = { ...this.status, ...patch };
    if (next.loading === this.status.loading && next.ended === this.status.ended && next.error === this.status.error) {
      return;
    }
    this.status = Object.freeze(next);
    this.notify();
  }

  private notify(): void {
    this.changeListeners.forEach((listener) => listener());
  }

  private emit<K extends keyof FeedFrameEvents<T>>(event: K, payload: FeedFrameEvents<T>[K]): void {
    this.handlers.get(event)?.forEach((handler) => {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[FeedFrameManager] "${String(event)}" handler threw`, err);
      }
    });
  }
}
```

#### `src/feed-engine/react.ts`

```ts
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import type { FeedFrameManager } from './FeedFrameManager.ts';
import { markProgrammaticScroll, sentinelMayAct, type ScrollIntent } from './scrollDirection.ts';
import type { FeedStatus, Frame } from './types.ts';

/** The frames that should currently be in the React tree (3 at most by default). */
export function useMountedFrames<T>(manager: FeedFrameManager<T>): readonly Frame<T>[] {
  return useSyncExternalStore(manager.subscribe, manager.getMountedFrames, manager.getMountedFrames);
}

export function useFeedStatus<T>(manager: FeedFrameManager<T>): FeedStatus {
  return useSyncExternalStore(manager.subscribe, manager.getStatus, manager.getStatus);
}

/**
 * Put the returned ref on a frame's root element: the frame crossing the middle of the viewport
 * becomes the manager's focus. Load failures are reported through getStatus().error.
 */
export function useFrameFocus<T>(manager: FeedFrameManager<T>, index: number): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void manager.focus(index).catch(() => undefined);
      },
      { rootMargin: '-50% 0px -50% 0px', threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [manager, index]);
  return ref;
}

/**
 * Fires onEnter while the returned element is in view AND the viewer is scrolling toward it (`when`),
 * and again after `watch` changes while it still is (a plain observer only reports the first crossing).
 * Put one below the last frame (when="down", manager.advance) and one above the first (when="up",
 * manager.retreat). The direction check is what stops the two edges from undoing each other: scrolling
 * up through a frame must not re-mount what was just removed below it.
 */
export function useEdgeSentinel(onEnter: () => void, watch: unknown, when: ScrollIntent): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  const callback = useRef(onEnter);
  callback.current = onEnter;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && sentinelMayAct(when)) callback.current();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [watch, when]);
  return ref;
}

const FRAME_SELECTOR = '[data-frame-index]';

function measureTops(container: HTMLElement | null): Map<number, number> {
  const tops = new Map<number, number>();
  container?.querySelectorAll<HTMLElement>(FRAME_SELECTOR).forEach((el) => {
    tops.set(Number(el.dataset.frameIndex), el.getBoundingClientRect().top);
  });
  return tops;
}

/**
 * Keeps the page still while frames above the viewport are added or removed (scrolling either way).
 * Frame elements need a data-frame-index attribute. The position is measured when the manager
 * announces a change (before React commits) and corrected right after the commit.
 */
export function useScrollAnchor<T>(
  manager: FeedFrameManager<T>,
  containerRef: RefObject<HTMLElement | null>,
  mounted: readonly Frame<T>[],
): void {
  const tops = useRef(new Map<number, number>());

  useEffect(
    () =>
      manager.subscribe(() => {
        tops.current = measureTops(containerRef.current);
      }),
    [manager, containerRef],
  );

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const before = tops.current;
    const focus = manager.getFocusIndex();

    let anchor: { index: number; el: HTMLElement } | null = null;
    container.querySelectorAll<HTMLElement>(FRAME_SELECTOR).forEach((el) => {
      const index = Number(el.dataset.frameIndex);
      if (!before.has(index)) return; // newly mounted: nothing to compare against
      if (!anchor || Math.abs(index - focus) < Math.abs(anchor.index - focus)) anchor = { index, el };
    });

    const found = anchor as { index: number; el: HTMLElement } | null;
    const previousTop = found ? before.get(found.index) : undefined;
    if (found && previousTop !== undefined) {
      const delta = found.el.getBoundingClientRect().top - previousTop;
      if (Math.abs(delta) > 0.5) {
        markProgrammaticScroll();
        window.scrollBy({ top: delta, behavior: 'instant' });
      }
    }
    tops.current = measureTops(container);
  }, [mounted, manager, containerRef]);
}
```

#### `src/feed-engine/scrollDirection.ts`

```ts
/**
 * Which way the viewer is scrolling, read from real scroll events. Scrolls the app performs itself
 * (keeping the page still while frames change) are ignored, so they never flip the direction.
 */
export type ScrollIntent = 'up' | 'down';

let attached = false;
let lastY = 0;
let direction: ScrollIntent | null = null;
let ignoreUntil = 0;

function onScroll(): void {
  const y = window.scrollY;
  const dy = y - lastY;
  lastY = y;
  if (Math.abs(dy) >= 1 && performance.now() >= ignoreUntil) direction = dy > 0 ? 'down' : 'up';
}

function attach(): void {
  if (attached || typeof window === 'undefined') return;
  attached = true;
  lastY = window.scrollY;
  window.addEventListener('scroll', onScroll, { passive: true });
}

/** null until the viewer has scrolled at all. */
export function getScrollDirection(): ScrollIntent | null {
  attach();
  return direction;
}

/** Call right before scrolling the page programmatically so that scroll is not mistaken for the viewer's. */
export function markProgrammaticScroll(ms = 150): void {
  attach();
  ignoreUntil = performance.now() + ms;
}

/** Whether an edge sentinel may act: it must match the viewer's direction ("down" may also act before any scroll). */
export function sentinelMayAct(when: ScrollIntent): boolean {
  const current = getScrollDirection();
  return current === null ? when === 'down' : current === when;
}

/** Test helper. */
export function resetScrollDirection(): void {
  direction = null;
  ignoreUntil = 0;
  lastY = typeof window === 'undefined' ? 0 : window.scrollY;
}
```

## Academic details and moving up

Program (the seven PGC programs), session (like `2024-2026`), class/year and section are four separate fields, asked at sign-up and kept in `user_private` (class/year is `profiles.class_id`). None is part of the identity key.

- **Settings, Account, Academic details** lets a student change them as they move up, confirm "nothing has changed", or mark themselves **graduated**. Graduating sets the class to Alumni and the status to `graduated`; posts, messages and media are not touched, and graduates are not asked to renew. It cannot be undone by the student.
- **Renewal prompt.** A banner on the feed asks the student to confirm once `ACADEMIC_RENEWAL_DAYS` (default 365) have passed since they last confirmed or changed anything. Accounts made before these fields existed are asked once. Set the variable in `wrangler.toml` `[vars]` to change the period.
- API: `GET/PUT /api/me/academic`, `POST /api/me/academic/confirm`, `POST /api/me/academic/graduate` (own details only, never returned by `/api/me` or to other people). Run migration 015 before deploying.

## Checking it in a real browser

`npm run shots` (screens at phone, tablet and desktop widths) and `npm run e2e:signup` (a real sign-up with a fake camera looking at a sample card: scan, printed-text reading, account creation, mismatch confirmation and duplicate refusal) need a browser. Playwright's own download is blocked on some networks; any Chromium works: `CHROMIUM_PATH=/path/to/chrome`. The npm package `@sparticuz/chromium` ships one if you cannot download (`npx -y @sparticuz/chromium` documents it). `e2e:signup` needs `ffmpeg`, the dev server started with `REQUIRE_CARD_SCAN=true PORT=3111 npm run dev`, and `npm install --no-save playwright`.
