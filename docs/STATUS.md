# Status

Base commit: `ba1d936`. Patches are cumulative from that base.

## Done
- **Phase 1: campus names inside the app** (`phase-1-campuses.patch`)
  - `data/campuses.csv` -> `shared/campuses.ts` via `scripts/generate-campuses.ts` (run by `prebuild`), same id function.
  - Server validates `campus_id` against the bundled list; `campus_other` free text, exclusive with `campus_id`, never used for search scope.
  - Migration 006 (profiles rebuilt, `campuses` and `campus_requests` dropped). Campus routes and admin moderation removed.
  - Picker filters on the device with an "Other campus" field.
- `docs/app-structure.md` page map committed.

- **Phase 2: media foundation and compression** (`phase-2-media.patch`)
  - The suspected bug was real and is fixed: the orphan cleanup ignored `message_media`, deleting message photos older than 24 hours.
  - Migration 007, `shared/media-rules.ts`, `worker/media.ts`, reference-based retention, per-kind caps and limits, quota, EXIF stripping, per-owner dedupe, library and forward endpoints, `src/lib/media.ts`.

- **Phase 3: Settings, chat, preview and viewer** (`phase-3-chat.patch`, applies on top of the pushed Phase 2 head `7ca04d3`)
  - Settings page; Edit profile reduced to identity and look; gear on own profile.
  - `MessagesPage` split into `ConversationList`, `ChatScreen`, `Composer`, `MessageBubble`, `AttachSheet`, `MediaPreview`, `MediaViewer` plus picker, forward picker and `useKeyboardInset`.
  - Media-only messages, up to 4 attachments, media kind in lists, media ids in report evidence.
  - Chat background presets and image import (on the phone), numeric contrast tests.
  - Fix: dark-mode `--danger` was 2.9:1.

- **Phase 4: stickers and GIFs** (`phase-4-stickers.patch`, applies on top of the Phase 3 patch)
  - Bundled catalog: `public/stickers/<pack>/`, `scripts/build-stickers.ts`, permanent append-only `numbering.json`, generated `shared/stickers.ts`, 8 MB budget warning, **placeholder pack** (README, "Stickers and GIFs": replace before launch).
  - Keys `app:<pack>/<number>` and `usr:<mediaId>` validated on the server; migrations 008 and 009; `comment_media`; evidence snapshots for posts and comments.
  - `StickerView`, picker (Stickers/GIFs, Recent on device only, Mine, packs, Manage), stickers in chats, posts and comments, Report on comments, post composer compresses photos and takes photos or one sticker.

- **Phase 5: profile background from your own image, and polls** (`phase-5-backgrounds-polls.patch`, applies on top of the Phase 4 patch)
  - Migration 010: `profiles.wallpaper_media_id`, `polls`, `poll_options`, `poll_votes`.
  - Background: `wallpaper_id = 'custom'` plus an owned `background` upload; reads follow the avatar rule; retention is reference-based; always drawn under a 0.55 black layer with white text (worst-case contrast test, 4.7:1); user reports record the image; picker, Replace and Remove on Edit profile; compression to 1080 px WebP under 400 KB on the phone.
  - Polls: `poll` on `POST /api/posts`, `PUT /api/posts/:id/poll/vote`, batched hydration (3 queries per page), counts only for voters and the author, closes with the post, builder on New post, poll card with accessible buttons.
  - Tests: server, jsdom (axe) and client-compression tests for both; attack suite extended (281 checks).

- **Phase 5 follow-up:** posting limit is now 3 per 15 minutes and rejected attempts no longer count; rule-based spam check on new posts with a 3-day lock after 3 spam attempts in a row (migration 011); votes from people blocked with the author no longer count in poll totals.

- **Motion, navigation and Settings pass:** slide-up sheets for comments/report/delete (drag, backdrop, Escape and Back all close them), Back-button support for the whole app, page transitions, tab bar indicator, press feedback, entrance animations, regrouped Settings with a profile card. Tests in `tests/sheet-nav-ui.test.tsx`.

- **Screen sizes, first part:** layout module with one rule for phone/tablet/desktop, side navigation (rail and sidebar), 640 px column on wider screens, sheet/dialog/drawer overlay variants, guard and matrix tests (`tests/layout.test.ts`, `tests/layout-ui.test.tsx`). The phone design is unchanged (all earlier tests still pass).
- **Screen sizes, second part:** two-pane Messages on tablet and desktop, two-pane Settings on desktop, a roomier Profile header, a centered card for sign-in and onboarding, overlays centered over the column (`--nav-w`), hover states on post actions, arrow-key movement in the conversation list and Settings sections, and `npm run shots` (`scripts/shots.mts`). Tests in `tests/layout-panes.test.tsx`.
- **Admin roles and moderation** (migration 012, `worker/admin.ts`, `src/pages/AdminPage.tsx`): one master admin made only by `npm run bootstrap:master` (refuses to replace one; the database allows only one), appointed admins with the hot-potato hand-over done in a single SQL statement, suspend / ban / reinstate with reasons and an activity log, a report preview, the people directory that never shows the master, Admin tools in Settings for admins only, an Account ID line in Settings, a clear message for suspended and banned people at sign-in, and a Windows-safe `npm run db:backup`. Tests: `tests/admin-roles.test.ts`, `tests/bootstrap-master.test.ts`, `tests/admin-ui.test.tsx`. The bootstrap command was also run for real against Wrangler's local database (promote, run again, refuse a second master, refuse a missing account).

- **Phase 6: install as an app (PWA)** (branch `phase-pwa-install`, applies on top of the admin-roles commit `9419c18`; this is Phase 2 of `PGC_Phased_Project_Blueprint_Claude_Prompt.md`)
  - `public/manifest.webmanifest`, `public/sw.js` (static files only, never `/api/`), `public/offline.html`, placeholder icons in `public/icons/`, Apple and theme tags in `index.html`. No worker, database or migration changes.
  - `src/lib/pwa.ts` (environment detection, banner rules, dismissal, browser install prompt, service worker registration), `InstallBanner` on Home (and the open-in-your-browser notice on sign-in), `ShareApp` card in Settings with Share link and QR code (`QrCode`, new dependency `qrcode-generator`).
  - Tests: `tests/pwa.test.ts` (detection, banner rules, dismissal, manifest and icon files, the service worker's rules run against fake caches), `tests/pwa-ui.test.tsx` (banner, Settings card, QR, axe), `tests/pwa-serving.test.ts` (the worker passes these files to the static assets and keeps `/api/`). The `/api/` guard was mutation-checked: removing it fails the test.

- **Fix: sticky headers and the chat typing bar** (`patch-1-chat-scroll.patch`): `<main>` used `overflow-x-hidden`, which makes it a scroll container, so no sticky header or bar inside it ever stuck to the window (chat header scrolled away, the typing bar sat behind the bottom tab bar, Settings and Admin headers scrolled off). Now `overflow-x-clip`. On phones the chat header sticks under the 48px app bar and the typing bar sticks above the 56px tab bar (`dockAboveTabBar`), and the doubled bottom padding on the chat and conversation list is gone. Looked at in Chromium at 390 px (list, chat top/middle/bottom, Settings scrolled). Not looked at on a real phone. Guard test: `tests/sticky-shell.test.ts`.

## Not started
- Phase 3 leftover: the compact composer is used for comments, but the New post page still has its own text box (it also holds photos, the poll builder and the sticker choice). The post page does now take photos or one sticker/GIF, and compresses photos, but its text box is its own.
- Nothing planned is left in Phases 1 to 5.

## Not verified
Nothing involving a real phone has been tested (keyboard, share sheet, WebCodecs). Nothing in Phases 1 to 3 has been run on a real phone or browser. Not verified: on-screen keyboard tracking and the picker replacing the keyboard (`visualViewport`, `interactive-widget`), camera and gallery pickers, the phone share sheet, GIF/video autoplay and reduced motion on devices, the canvas rotate/crop/compress output, and the look of the screens. The canvas code in `src/lib/media.ts` (`browserMediaEnv`) is tested only through a mock; it has never run in a real browser. EXIF stripping is verified on a hand-built JPEG, not on real camera files.

Phase 5 specifically: image compression for backgrounds (canvas WebP at 1080 px) and the scrim over real photos have not been looked at on a real phone or browser; contrast is proved numerically for the worst case, not by eye. The poll builder and poll card have been tested in jsdom only.

- Screen sizes: the designs were looked at in a real browser (Chromium through `npm run shots`) at 390, 820, 1280 and 1920 px: sign-in, Feed, Messages, Profile and Settings pages, and the comment drawer, comment sheet and attach sheet. Not looked at: every other page and overlay at every width (New post, Search, Edit profile, onboarding steps, media viewer, preview, forward and sticker pickers), real touch devices, and a real rotation. The jsdom tests prove which design is chosen, not how it looks.
- Admin tools: looked at in a real browser as master on a phone and as an appointed admin on a desktop (reports, people, the Make admin confirmation). Not looked at: Activity tab and the Look preview in a browser (covered by tests), a real phone, and a real Cloudflare deployment. Nothing here has been deployed.

Phase 6 specifically: nothing has run on a real phone. Not verified: the Android and desktop install prompt, Safari's Add to Home Screen result (icon, name, standalone look), the in-app browser detection on real Instagram/Facebook/TikTok browsers (it is a user-agent check and will miss some), the service worker on the deployed site, and the QR code scanned by a real camera. Lighthouse's installability audit has not been run.

## Decisions for the owner
- Votes do not count as engagement toward the 14-day extension (only likes and comments do). Counting them would be a small change in `worker/jobs/expiry.ts`.
- Once a poll closes, counts stay hidden from people who never voted. Showing final results to everyone after close is a one-line change in `worker/polls.ts`.
- Poll options are plain text (no emoji picker, no images), and a poll has no separate question field: the post text is the question.
- Spam check: the word list and thresholds are first guesses and will need tuning against real posts. Comments and messages are not checked. Posting is limited by a fixed window, not a sliding one.
- Polls: votes can be changed and anyone who votes sees the counts, so a person can vote just to peek at the results. This is the intended design; hiding counts until the poll closes would be the alternative.
- Remote database: migrations 005 to 012 must all be run before deploying (`npm run db:migrate:remote`). Migration 012 must be applied BEFORE the new code goes live, because sign-in now reads the `role` column.
- Motion and navigation: tested in jsdom only. The slide timing, the drag-to-close feel and the Back button on a real phone have not been tried. After saving Edit profile the app adds a history entry for the profile page, so Back goes to the edit form once. Scroll position is not restored when going Back.

- Screen sizes, left on purpose: the right-hand column on desktop (suggestions or trending would be new features, so the width goes to Messages and Settings). Hover states are on post actions and navigation only; other buttons keep their current look.
- Admin: banning removes a person's active posts from circulation but reinstating does not restore them. A banned or suspended admin loses the admin role (the master can appoint them again). The master cannot delete their own account or change their own role through the app (deleting answers 409). The first version has no appeals and no automatic content classification.
- PWA: the icons are placeholders and the installed name is "Dialtone" (the existing page title); change `name`/`short_name` in `public/manifest.webmanifest` and `apple-mobile-web-app-title` in `index.html` together if the product is called PGC. The Home banner reappears 14 days after "Not now" (`DISMISS_DAYS` in `src/lib/pwa.ts`). Android and desktop get an automatic banner only when the browser offers an install prompt; otherwise the instructions are only in Settings, to avoid nagging. No startup images are provided. Offline use is limited to the offline page by design (student data is never kept for offline use).

## Blueprint work (PGC_Phased_Project_Blueprint)

Its phase numbers differ from the numbered phases above.

- **Infrastructure fixes** (branch `fix/phase1-and-leftovers`): only `/api/*` runs the Worker (static files and headers come from `public/_headers`); atomic rate limiter (the old one let 40 of 40 simultaneous requests through a limit of 10); Node 22.13 guard, cross-platform `clean`, CI workflow, migration `.sql` / embedded-copy parity test.
- **Student sign-up checks** (blueprint Phase 3, partly): full roll number, unique per campus, barcode scan, "already registered" requests for admins. See README, "Student sign-up checks". Not done: OCR.
- **Appeals and retention** (blueprint Phase 7, partly): appeal tickets for blocked students, admin Appeals tab, handled-record retention. See README.
- **Turnstile** (blueprint Phase 8, partly): optional, server-verified on sign-up, fails closed. Rate limits reviewed only for sign-up, appeals and the limiter itself.
- **Academic details and progression** (blueprint Phase 3, rest): program, session, class/year and section as separate fields; update, confirm, graduate; configurable renewal prompt. See README.
- **OCR** (blueprint Phase 3, rest): Tesseract.js on the device, self-hosted, compared field by field, never blocks and never edits. Tested on real card pictures.
- **Real-browser checks done** with a headless Chromium: `npm run shots` (phone, tablet, desktop) and `npm run e2e:signup` (11 checks) pass. This is a headless browser with a fake camera, not a real phone: lighting, focus, a cracked lens and a real card are still untested.
- **Found by that browser test, and fixed:** the live scanner stopped after one frame with no message (zxing's browser reader cannot rotate a frame), and a card with a dark line left of the barcode could not be read at all. Neither showed in unit tests.
- **Not done yet:** removal of `DEV-ONLY` code and real branding (kept on purpose while the app is still in development; `npm run prelaunch-check` lists what to remove), and the real-phone check with a real card.

- **Feed pipeline (server packaging, IndexedDB cache, local personalization):** `GET /api/v1/feed/bootstrap` and `/next` return batches of 30 to 50 posts tagged SAFE or WILD (`isWild`, `safetyScore`, `likesCount`, `tags`, `timestamp`, `trendingScore`), gzip when accepted, private no-store, 30 per minute (`worker/feed-pipeline/`, contract in `shared/feed-pipeline.ts`). On the phone, `src/feed-pipeline/` holds `FeedCacheManager` (IndexedDB via `idb`: bulk writes, viewed history in first-view order, history frames read with no network, background pre-fetch below 15 unseen posts, offline fallback, expiry purge, per-person isolation), `LocalPersonalization` (per-tag preferences in localStorage, trending/recency/engagement blend, deterministic re-rank) and the glue to the frame engine. Opt-in: `<FeedPage localFirst />` (default off, `/api/feed` and `src/feed-engine/` unchanged); `App` clears the person's cache and preferences on sign-out. Full description and source in the README section `[PIPELINE]`. Verified: tsc clean, tests, build, attack suite (36 new checks), and `npm run e2e:feed` in a real Chromium against the real endpoint. Not done: a "previous posts" UI above the first frame after a reload (data is available through `getHistoryFrames`), a test on a real phone, Safari or Firefox.
