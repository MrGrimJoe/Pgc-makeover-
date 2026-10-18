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
   npx wrangler d1 execute classsync-db --remote --command="DELETE FROM users WHERE id = 'usr_xxx';"
   ```

### Verification Checklist
Verify that the account has been completely purged:
```bash
npx wrangler d1 execute classsync-db --remote --command="SELECT COUNT(*) FROM users WHERE id = 'usr_xxx';"
npx wrangler d1 execute classsync-db --remote --command="SELECT COUNT(*) FROM profiles WHERE user_id = 'usr_xxx';"
npx wrangler d1 execute classsync-db --remote --command="SELECT COUNT(*) FROM media WHERE owner_id = 'usr_xxx';"
npx wrangler d1 execute classsync-db --remote --command="SELECT COUNT(*) FROM sessions WHERE user_id = 'usr_xxx';"
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
