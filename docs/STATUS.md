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

## Not started
- Phase 3 leftover: the compact composer is used for comments, but the New post page still has its own text box (it also holds photos and the future poll and sticker choice). It moves to the shared composer with the sticker work in Phase 4.
- Phase 4: bundled stickers/GIFs (keys, manifest, numbering), sticker keys on posts and comments, picker packs.
- Phase 5: profile background from the person's own image; polls on posts.

## Not verified
Nothing involving a real phone has been tested (keyboard, share sheet, WebCodecs). Nothing in Phases 1 to 3 has been run on a real phone or browser. Not verified: on-screen keyboard tracking and the picker replacing the keyboard (`visualViewport`, `interactive-widget`), camera and gallery pickers, the phone share sheet, GIF/video autoplay and reduced motion on devices, the canvas rotate/crop/compress output, and the look of the screens. The canvas code in `src/lib/media.ts` (`browserMediaEnv`) is tested only through a mock; it has never run in a real browser. EXIF stripping is verified on a hand-built JPEG, not on real camera files.
