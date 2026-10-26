-- 016_impression_counter.sql: the feed no longer counts the impressions table.
--
-- The ranked feed used to run "SELECT COUNT(*) FROM impressions WHERE post_id = p.id" for every candidate post,
-- and the only index on impressions starts with viewer_id, so every candidate caused a scan of the whole table.
-- On Cloudflare D1 that is "rows read", which the free plan caps at 5 million per day. A per-post counter that
-- is bumped when an impression row is written makes the feed read nothing extra.
ALTER TABLE posts ADD COLUMN impressions_count INTEGER NOT NULL DEFAULT 0;
UPDATE posts SET impressions_count = (SELECT COUNT(*) FROM impressions i WHERE i.post_id = posts.id);
