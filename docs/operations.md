# Operations Runbook

This guide covers operational maintenance, backups, disaster recovery, data retention, account purges, and secret rotation for the ClassSync production deployment on Cloudflare Workers, D1, and R2.

---

## 1. Backing Up D1 Database

Regular database exports protect against accidental bulk changes and allow point-in-time offline archiving.

### Automated / Scripted Backup
Run the pre-configured npm script:
```bash
npm run db:backup
```
This executes:
```bash
wrangler d1 export classsync-db --remote --output=backups/classsync-$(date +%F).sql
```
- Backups are stored in `backups/` and ignored by Git.
- The exported SQL contains full schema DDL and table data inserts.

### Manual SQL Export
To export with a custom filename or destination:
```bash
npx wrangler d1 export classsync-db --remote --output=./backups/classsync-manual-$(date +%s).sql
```

---

## 2. Restoring D1 Database & Time Travel

There are two primary methods to recover or restore D1 database state: SQL backup execution and Cloudflare D1 Time Travel.

### Option A: Restoring from SQL Backup File
To replay an exported SQL backup file directly against the remote production database:
```bash
npx wrangler d1 execute classsync-db --remote --file=backups/classsync-YYYY-MM-DD.sql
```
> **Warning**: Ensure all active connections and scheduled cron jobs are paused or monitored during a full restore to avoid conflict errors with existing primary keys.

### Option B: Cloudflare D1 Time Travel
Cloudflare D1 includes built-in Time Travel point-in-time recovery without needing external backup files.

- **Retention Window**:
  - Workers Paid plan: 30 days of continuous retention.
  - Workers Free plan: 7 days of continuous retention.

- **Inspect Database State at Point in Time**:
  Retrieve bookmark and timestamp metadata:
  ```bash
  npx wrangler d1 time-travel info classsync-db --timestamp="2026-10-18T12:00:00Z"
  ```

- **Restore Database to Point in Time**:
  Restore using an ISO-8601 timestamp:
  ```bash
  npx wrangler d1 time-travel restore classsync-db --timestamp="2026-10-18T12:00:00Z"
  ```
  Or restore using a specific bookmark hash:
  ```bash
  npx wrangler d1 time-travel restore classsync-db --bookmark="<BOOKMARK_HASH>"
  ```

---

## 3. R2 Media and D1 Synchronization

Media files in ClassSync are split into two layers:
1. **D1 `media` table**: Metadata records containing `id`, `owner_id`, `object_key`, `mime_type`, `size_bytes`, `created_at`, and `expires_at`.
2. **R2 `classsync-media` bucket**: Binary object bytes stored under `object_key`.

### What to Do If R2 and D1 Diverge

1. **Orphaned R2 Objects (Object in R2, no record in D1)**:
   - Automated Cleanup: The scheduled background worker runs periodic expiry tasks (`worker/jobs/expiry.ts`) that identify and delete orphaned objects unattached to any active post or message.
   - Manual Remediation: List keys in R2 using wrangler and delete any key not matching active D1 records:
     ```bash
     npx wrangler r2 object get classsync-media/<OBJECT_KEY>
     npx wrangler r2 object delete classsync-media/<OBJECT_KEY>
     ```

2. **Missing R2 Objects (Record in D1, object missing from R2)**:
   - When users attempt to fetch missing media via `GET /api/media/:id`, the Worker catches the missing R2 object and returns `404 Media file missing from storage` without crashing.
   - Clean up the dangling D1 database row:
     ```bash
     npx wrangler d1 execute classsync-db --remote --command="DELETE FROM media WHERE object_key = '<OBJECT_KEY>';"
     ```

---

## 4. Complete User Account Deletion

When a user requests account deletion, all personal data, database records, and binary files must be completely eradicated in compliance with data privacy regulations.

### Automated Deletion (Self-Service)
The user initiates deletion via `DELETE /api/me` (authenticated session required):
1. **R2 Deletion**: The Worker queries all `object_key` values for media owned by the user (`WHERE owner_id = ?`) as well as media attached to messages sent by the user, and immediately issues `MEDIA_BUCKET.delete(object_key)`.
2. **D1 Deletion**: The Worker runs a transactional batch deleting rows from:
   - `sessions`
   - `user_private` (email and roll number)
   - `user_settings`
   - `profiles`
   - `message_media` & `messages`
   - `media`
   - `users` (cascading to follows, blocks, post reactions, post comments, and posts)
3. **Session Termination**: Clears the session cookie with `Max-Age=0`.

### Manual Admin Account Deletion
If an administrator must manually purge a user account with ID `usr_xxx`:
1. Find all R2 keys associated with the user:
   ```bash
   npx wrangler d1 execute classsync-db --remote --command="SELECT object_key FROM media WHERE owner_id = 'usr_xxx';"
   ```
2. Delete each object from R2:
   ```bash
   npx wrangler r2 object delete classsync-media/<OBJECT_KEY>
   ```
3. Purge the database rows:
   ```bash
   npx wrangler d1 execute classsync-db --remote --command="DELETE FROM user_private WHERE user_id = 'usr_xxx'; DELETE FROM users WHERE id = 'usr_xxx';"
   ```

### Verification Checklist
Verify that the account has been completely purged:
```bash
npx wrangler d1 execute classsync-db --remote --command="SELECT COUNT(*) FROM users WHERE id = 'usr_xxx';"
npx wrangler d1 execute classsync-db --remote --command="SELECT COUNT(*) FROM profiles WHERE user_id = 'usr_xxx';"
npx wrangler d1 execute classsync-db --remote --command="SELECT COUNT(*) FROM media WHERE owner_id = 'usr_xxx';"
npx wrangler d1 execute classsync-db --remote --command="SELECT COUNT(*) FROM sessions WHERE user_id = 'usr_xxx';"
npx wrangler d1 execute classsync-db --remote --command="SELECT COUNT(*) FROM user_private WHERE user_id = 'usr_xxx';"
```
All queries must return `0`.

---

## 5. Secret Rotation Procedures

### Rotating `ADMIN_SECRET`
The `ADMIN_SECRET` protects internal endpoints such as `GET /api/admin/stats` and `GET /api/admin/reports`.

1. Generate a new high-entropy secret (at least 32 characters):
   ```bash
   openssl rand -base64 32
   ```
2. Update the secret in Cloudflare Workers:
   ```bash
   npx wrangler secret put ADMIN_SECRET
   ```
   Paste the newly generated secret when prompted.
3. Update any internal operations scripts, monitoring dashboards, or cron jobs that pass the `x-admin-secret` header.
4. Verify by calling admin stats:
   ```bash
   curl -s -H "x-admin-secret: <NEW_SECRET>" https://<YOUR_APP_URL>/api/admin/stats
   ```
   Verify it returns HTTP 200 with system count statistics.

### Rotating Google OAuth Client Secret
When rotating the Google OAuth Client Secret:

1. In the **Google Cloud Console** under **APIs & Services > Credentials**:
   - Open your existing OAuth 2.0 Web Client.
   - Under Client secrets, click **Add secret**.
   - Note down the new Client Secret value. (Do **not** delete the old secret yet to avoid service interruption).
2. Update Cloudflare Workers with the new secret:
   ```bash
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```
   Paste the new secret when prompted.
3. Test Google Sign-In on the live web app to confirm sign-in succeeds and cookies are issued.
4. Return to the Google Cloud Console and delete the deprecated old secret.

---

## 6. Campuses

Campus names ship inside the app; there is no campus table, no seeding step and no moderation.

### Changing the list
`data/campuses.csv` (header `name,city`; quote values that contain commas) is the single source. After editing it run:
```bash
npm run generate:campuses
```
This validates every row (all bad lines are reported at once) and rewrites `shared/campuses.ts`. Commit that file. `npm run build` also runs the generator (`prebuild`), and a test fails if the committed file does not match the CSV.

Ids are `cmp_` plus the first 24 hex characters of the SHA-256 of the normalized `name|city`, so renaming a row changes its id. Students who saved the old id then show as having no campus until they pick again. Removing a row has the same effect and never causes an error.

### Campuses that are not listed
A student can type a campus instead (`profiles.campus_other`, 2 to 80 characters, no markup). It is shown on their profile but is never used for the campus search scope or suggested people. It is exclusive with the listed campus.

---

## 7. Private sign-up data

`user_private` holds each person's Google email and the last three digits of their roll number. No API returns them, `PATCH /api/me` cannot set them, and deleting an account (self-service or manual) removes the row. Keep it that way:
- Never add these columns to `profiles` or to a `SELECT *` that is sent to a client.
- `npm run attack` includes checks that fail if the roll number or email appears in any response.
- The roll number is unverified. Do not use it to grant any access.
- Backups from `npm run db:backup` contain this table; handle them like the database itself.

---

## 8. Media: kinds, caps, quotas and retention

The numbers live as named constants in `shared/media-rules.ts`; change them there (the client and the Worker both read that file).

| Kind | Allowed types | Largest file | Upload limit |
|---|---|---|---|
| `photo` | JPEG, PNG, WebP | 2.5 MB | 60 per hour per person |
| `sticker` | WebP, PNG, GIF | 300 KB | 120 per hour (shared with `gif`) |
| `gif` | GIF, WebP, MP4, WebM | 3 MB | 120 per hour (shared with `sticker`) |
| `background` | WebP, JPEG, PNG | 400 KB | 10 per hour |
| `video` | MP4, WebM | 8 MB (no server transcoding) | 60 per hour (shared with `photo`) |
| thumbnail (optional extra file) | WebP, JPEG | 80 KB | counted with its upload |

- **Quota:** each person can hold 200 MB of live media (files plus thumbnails). Over that, uploads answer `413 Storage full`.
- **Checks:** the file's first bytes must match its declared type (SVG and HTML are refused), size is checked against the kind's cap (`413` with the cap in the message), and the rate limit is charged only for files that pass.
- **Metadata:** JPEGs have APP1 (EXIF, GPS, XMP), APP13 (IPTC) and comment segments removed on the server. A JPEG that cannot be parsed is refused rather than stored untouched. The client also re-encodes photos, which drops EXIF before upload.
- **Dedupe:** per owner only (`owner_id` + `sha256` + `kind`). The same bytes from the same person reuse the existing row and nothing new is stored. Different people never share a row, because a shared hash would reveal whether someone else already has a file.
- **Serving:** `GET /api/media/:id` (and `/thumb`) sends the stored type, `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=86400` and an `ETag` (`304` for a matching `If-None-Match`).
- **Who can read:** the owner; people who can see a post it is attached to (not blocked with its author); members of the conversation for message media; signed-in people not blocked with the owner for a profile picture. Library items are private to the owner unless attached somewhere visible.
- **Forwarding:** `POST /api/messages/:id/forward {conversation_id}` needs current membership of the original conversation and of the target, and respects blocks and the recipient's DM policy. It references the same media id; nothing is re-uploaded. People cannot attach media they do not own through the normal send route.

### Retention (reference-based)
A media row is deleted only when **nothing references it** (`post_media`, `message_media`, `profiles.avatar_media_id`, `sticker_library`) **and** it is older than 24 hours.
- A message's media goes when its last referencing message expires (14 days). Forwarded media therefore lives until the last copy expires.
- A post's media goes when the post expires, unless a library item or message still uses it.
- Library items and profile pictures do not expire.
- `DELETE /api/media/:id` answers `409` while the file is still used.
- An R2 delete failure keeps the row so the next run retries.

Fixed in this version: the orphan cleanup used to ignore `message_media`, so a message photo older than 24 hours was deleted from storage while the message still existed. `tests/media-retention.test.ts` covers every reference type.

### Sticker library
`GET/POST /api/stickers/library`, `DELETE /api/stickers/library/:mediaId`. Up to 200 items per person; only your own stickers and GIFs can be added.

### Client compression (`src/lib/media.ts`)
Photos are scaled to at most 1600 px on the long edge and re-encoded as WebP at about 0.8 (JPEG where WebP encoding is unsupported), with a 320 px thumbnail. Stickers are 512x512 WebP, contain-fit with transparent padding. GIFs and clips are uploaded as they are within the cap; over the cap they are refused with a "trim it" message (conversion to a looping WebM is offered only where WebCodecs `ImageDecoder` and `VideoEncoder` exist, never required). Cloudflare Image Transformations are deliberately not used: the free plan allows 5,000 unique transformations a month and each extra size counts separately. They remain a possible future option.

---

## 9. Chat, Settings and the chat background

- **Chat background** is a per-phone setting (six plain-CSS presets: Plain, Paper, Mint, Sky, Night, Dots, or the person's own picture). The picture is downscaled in the browser to at most 1280 px WebP under about 300 KB and kept in IndexedDB, keyed by user id. It is never uploaded, so it costs no storage and needs no moderation. It does not follow the person to another phone.
- **Contrast:** an imported picture always sits under a 90% scrim in the app surface color (`IMAGE_SCRIM_ALPHA` in `shared/chat-background.ts`). `tests/chat-background.test.ts` computes the contrast of body text and timestamps for every preset and for worst-case pictures (black, white, saturated colors) in light and dark, and fails below 4.5:1. The test also reads `src/index.css`, so changing a theme color without updating the model fails the build. Expiry chips and the Report button sit on an opaque pill, not on the wallpaper.
- **Dark theme `--danger`:** was missing, so red text on the dark background measured about 2.9:1. It is now `#E5767C` in both dark blocks.
- **Messages** may be media only, with up to 4 attachments (`kind` photo, sticker, gif or video). Conversation previews report the kind of the last attachment (`media_kind`) and the app shows "Photo", "Sticker", "GIF" or "Video" when there is no text.
- **Reports:** reporting a message stores media ids, kinds and SHA-256 hashes in the evidence snapshot, so a moderator can identify the exact files even after storage cleanup.
- **Settings** holds: chat background, who can message you, blocked people, interests, my stickers & GIFs, sign out, delete account. Edit profile holds identity and look only.

### Moderation honesty
There is no automatic image or video scanner. Safety rests on reporting, blocking, short retention (messages 14 days, posts 7 to 14 days), read rules (media is readable only where it is attached, or by its owner) and the upload limits above. Reporting and blocking are available wherever new content appears: the chat menu, each message, the media viewer, posts, comments and profiles.

---

## 10b. Spam strikes

`spam_strikes` is tiny (one row per refused attempt). To lift a lock for someone: `DELETE FROM spam_strikes WHERE user_id = '<id>'` on the remote database. Strikes are removed with the account. Rate-limit keys: `post:<id>` (3 per 15 minutes), `postattempt:<id>` (60 per 15 minutes), `pollvote:<id>` (60 per hour). Run migrations 005 to 011 on the remote database before deploying this version.

## 10a. Profile backgrounds and polls

- **Backgrounds** are ordinary `media` rows of kind `background` (400 KB cap, 10 uploads per hour, counted in the 200 MB quota). `profiles.wallpaper_media_id` is a retention reference, like the avatar: the cleanup job (`unreferencedSql` in `worker/media.ts`) keeps the file while it is a profile background and deletes it 24 hours after it stops being one (replaced, removed, or a preset chosen). Reads follow the avatar rule: any signed-in person who is not blocked with the owner.
- **Moderation:** reporting a user stores the current background's media id and hash in `report_evidence` (30 days), so the file can be found even after the person changes it.
- **Polls** need no storage beyond three small tables. Votes are one statement per vote (`ON CONFLICT` on `(poll_id, user_id)`), so parallel requests cannot create a second row. The limit is 60 votes per hour per person (`pollvote:<userId>` in `rate_limits`). A page of posts costs at most three extra poll queries (`worker/polls.ts`), whatever the number of polls.
- **Retention:** a poll goes with its post (foreign key cascade); votes go with the voter's account. Counts are only ever read for viewers who may see them.

## 10. Stickers, GIFs and the R2 free tier

### Adding or changing bundled stickers
See "Stickers and GIFs" in the README. In short: put images under `public/stickers/<pack>/`, run `npm run build:stickers`, commit `shared/stickers.ts` and `public/stickers/numbering.json`. Bundled stickers cost **no R2 storage and no R2 operations**: they are static assets served by the Worker with `Cache-Control: public, max-age=31536000, immutable`. The URL carries a short content hash (`?v=...`), so a replaced file is fetched fresh while unchanged ones stay cached.

### Keys
`app:<pack>/<number>` (checked against the shipped manifest) or `usr:<mediaId>` (checked against the sender's read rights; an uploaded sticker or GIF is also attached through `message_media`, `post_media` or `comment_media`, so retention and read rules are the same as for any attachment). Posts and comments that use an uploaded sticker keep it for as long as they exist; messages for 14 days.

### If you pass the R2 free tier
The free tier covers 10 GB of storage and a monthly number of reads and writes. Where the numbers come from here: every uploaded photo, sticker, GIF, clip and thumbnail is one or two R2 writes and every view is a read (browsers cache for a day). Things to do, cheapest first:
1. Check usage in the Cloudflare dashboard (R2, then the bucket, then Metrics).
2. Lower the caps or the per-person quota in `shared/media-rules.ts` (`MEDIA_SIZE_CAPS`, `MEDIA_QUOTA_BYTES`) and deploy. They apply to new uploads only.
3. Shorten retention if needed: message media goes when its last message expires (`worker/jobs/expiry.ts`), posts at 7 to 14 days.
4. Prefer bundled stickers: moving popular uploaded stickers into a bundled pack removes their R2 cost entirely.
5. Last resort: move to the paid R2 plan (pay per GB and per million operations). Nothing in the app needs to change.
`SELECT owner_id, SUM(size_bytes + thumb_size_bytes) AS bytes FROM media GROUP BY owner_id ORDER BY bytes DESC LIMIT 20;` shows who uses the most.

## 11. Admin roles and the master admin
See "Admin and moderation" in the README for the rules. Day to day:
- **Make the master:** `npm run bootstrap:master -- --user-id usr_XXXX --remote` (once; it refuses if a master exists).
- **Change the master (recovery):** `npx wrangler d1 execute classsync-db --remote --command "UPDATE users SET role = 'user' WHERE role = 'master'"`, then bootstrap the new account.
- **Who is an admin now:** `npx wrangler d1 execute classsync-db --remote --command "SELECT u.id, p.username, u.role, u.appointed_by, u.appointed_at FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.role != 'user'"`
- **Read the activity log:** `npx wrangler d1 execute classsync-db --remote --command "SELECT created_at, actor_id, action, target_id, detail FROM admin_actions ORDER BY created_at DESC LIMIT 50"`
- **Deploy order:** run `npm run db:migrate:remote` before `npm run deploy`; sign-in reads the `role` column added by migration 012.

## 11. Service worker and app icons

- `public/sw.js` keeps only static files (offline page, icons, `/assets/`, `/stickers/`) and never `/api/`. It cannot hold anyone's private data, so signing out or deleting an account needs no cache clearing.
- **A bad service worker release:** fix `public/sw.js`, bump `CACHE` (for example `dialtone-static-v2`), deploy. Browsers re-check the worker file on each visit and the new version deletes the old cache. As a last resort ship a `sw.js` that only calls `self.registration.unregister()`.
- **Changing icons or the app name:** edit `public/icons/*.png` and `public/manifest.webmanifest`. Phones that already installed the app may keep the old icon until it is removed and added again (iOS) or for a few days (Android).
- **Cloudflare free tier:** `wrangler.toml` sets `run_worker_first = ["/api/*"]`, so only API calls run the Worker; pages, scripts, icons and stickers are answered by the static-assets layer (caching and security headers for those come from `public/_headers`). As far as I know static-asset requests do not count toward the Workers request limit (about 100,000 a day on the free plan), so the daily budget is spent on API calls only. Confirm this against Cloudflare's current Static Assets pricing before inviting many students. Before this change every page and file request ran the Worker and counted.
