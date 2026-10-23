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

## Not started
- Phase 3 leftover: the compact composer is used for comments, but the New post page still has its own text box (it also holds photos, the poll builder and the sticker choice). The post page does now take photos or one sticker/GIF, and compresses photos, but its text box is its own.
- Nothing planned is left in Phases 1 to 5.

## Not verified
Nothing involving a real phone has been tested (keyboard, share sheet, WebCodecs). Nothing in Phases 1 to 3 has been run on a real phone or browser. Not verified: on-screen keyboard tracking and the picker replacing the keyboard (`visualViewport`, `interactive-widget`), camera and gallery pickers, the phone share sheet, GIF/video autoplay and reduced motion on devices, the canvas rotate/crop/compress output, and the look of the screens. The canvas code in `src/lib/media.ts` (`browserMediaEnv`) is tested only through a mock; it has never run in a real browser. EXIF stripping is verified on a hand-built JPEG, not on real camera files.

Phase 5 specifically: image compression for backgrounds (canvas WebP at 1080 px) and the scrim over real photos have not been looked at on a real phone or browser; contrast is proved numerically for the worst case, not by eye. The poll builder and poll card have been tested in jsdom only.

## Decisions for the owner
- Votes do not count as engagement toward the 14-day extension (only likes and comments do). Counting them would be a small change in `worker/jobs/expiry.ts`.
- Once a poll closes, counts stay hidden from people who never voted. Showing final results to everyone after close is a one-line change in `worker/polls.ts`.
- Poll options are plain text (no emoji picker, no images), and a poll has no separate question field: the post text is the question.
- Spam check: the word list and thresholds are first guesses and will need tuning against real posts. Comments and messages are not checked. Posting is limited by a fixed window, not a sliding one.
- Polls: votes can be changed and anyone who votes sees the counts, so a person can vote just to peek at the results. This is the intended design; hiding counts until the poll closes would be the alternative.
- Remote database: migrations 005 to 011 must all be run before deploying.
- Motion and navigation: tested in jsdom only. The slide timing, the drag-to-close feel and the Back button on a real phone have not been tried. After saving Edit profile the app adds a history entry for the profile page, so Back goes to the edit form once. Scroll position is not restored when going Back.

- Screen sizes: nobody has seen the tablet and desktop designs in a real browser. The tests prove which design is chosen and that the built CSS contains the right rules, not how it looks. There was no browser available in the build environment, so there are no screenshots. Open the app at 820 px and 1280 px wide (or use `?layout=tablet` / `?layout=desktop`) and check by eye.
- Screen sizes, still to do: two-pane Messages and Settings on desktop, wider Profile header and grid, a centered card for sign-in and onboarding, and hover and keyboard polish. Until then those pages use the same 640 px column as the feed. Full-screen overlays (media viewer, preview, forward picker, sticker picker) are centered on the screen, not on the column.
