# Status

Base commit: `ba1d936`. Patches are cumulative from that base.

## Done
- **Phase 1: campus names inside the app** (`phase-1-campuses.patch`)
  - `data/campuses.csv` -> `shared/campuses.ts` via `scripts/generate-campuses.ts` (run by `prebuild`), same id function.
  - Server validates `campus_id` against the bundled list; `campus_other` free text, exclusive with `campus_id`, never used for search scope.
  - Migration 006 (profiles rebuilt, `campuses` and `campus_requests` dropped). Campus routes and admin moderation removed.
  - Picker filters on the device with an "Other campus" field.
- `docs/app-structure.md` page map committed.

## Not started
- Phase 2: media foundation and compression (migration 007, reference-based cleanup, the suspected message-attachment cleanup bug is still unchecked, EXIF stripping, quotas, `src/lib/media.ts`).
- Phase 3: Settings page, composer, attach sheet, preview, viewer, MessagesPage split.
- Phase 4: bundled and uploaded stickers/GIFs in chats, posts and comments.

## Not verified
Nothing involving a real phone has been tested (keyboard, share sheet, WebCodecs). Phase 1 touched none of those.
