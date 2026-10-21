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

## Not started
- Phase 3: Settings page, composer, attach sheet, preview, viewer, MessagesPage split.
- Phase 4: bundled and uploaded stickers/GIFs in chats, posts and comments.

## Not verified
Nothing involving a real phone has been tested (keyboard, share sheet, WebCodecs). Phases 1 and 2 touched none of those. The canvas code in `src/lib/media.ts` (`browserMediaEnv`) is tested only through a mock; it has never run in a real browser. EXIF stripping is verified on a hand-built JPEG, not on real camera files.
