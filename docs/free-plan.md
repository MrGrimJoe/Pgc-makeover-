# Running on the Cloudflare free plan

Limits checked against Cloudflare's docs on 2026-10-26. Check again before launch, they change.

| What | Free allowance | What spends it here |
|---|---|---|
| Worker requests | 100,000 per day, 1,000 per minute, 10 ms CPU each | every `/api/*` call (pages, scripts, stickers and icons are static assets: free and unlimited) |
| D1 queries per Worker run | 50 | every `prepare().run/first/all`; sign-in checks take 3 of them |
| D1 rows read | 5 million per day | rows a query scans, not rows it returns: a missing index is paid for in full |
| D1 rows written | 100,000 per day | every INSERT, UPDATE and DELETE row, including upserts and deletes done by cron |
| D1 size | 500 MB per database, 5 GB per account | |
| R2 | 10 GB, 1 million writes and 10 million reads per month | uploads, and every media read that misses the browser cache |
| Worker script | 3 MB compressed (this one is about 180 KB) | |

## Rules for new code
1. A route must not loop over rows and run queries inside the loop. Use `IN (...)`, multi-row `VALUES`, or one `db.batch`.
2. Never `COUNT(*)` a table that grows per view or per request. Keep a counter column instead (see migration 016).
3. A new filter needs an index that starts with the filtered column. Check with `EXPLAIN QUERY PLAN`; "SCAN" on a big table is a bug.
4. Bound parameters: at most 100 per query. Anything that takes a list from the user needs a cap. Never bind the whole block list or a whole candidate pool: use `BLOCKED_SUBQUERY` in `worker/index.ts` (it takes the viewer's id twice) and ask for post ids in chunks of 90. `tests/ranked-feed-many-blocks.test.ts` runs the feed on a database that enforces the limit.
5. Do not compress in the Worker. Cloudflare compresses responses at the edge, and Worker CPU is only 10 ms.
6. Hashed build files are cached for a year (`public/_headers`). New unhashed static files need their own rule.

## Where the budget goes (per active student per day, rough)
- Opening the app: 1 page (free) + about 5 API calls.
- Scrolling 100 posts: about 8 impression requests (one per 15 s or 20 posts) and 100 to 500 rows written.
- Posting, liking, commenting, messaging: 1 request and 1 to 4 rows each.

At about 300 rows written per student per day, 100,000 rows is roughly 300 daily-active students. Past that, the $5 Workers Paid plan (50 million rows written per month included) is the honest fix; moving "seen" and topic learning onto the phone (the feed pipeline already keeps a local history) is the free one.
