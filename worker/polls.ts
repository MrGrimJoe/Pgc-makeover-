import type { PollItem } from '../shared/schema.ts';

export interface PollPostRef {
  id: string;
  author_id: string;
  expires_at: string;
  status: string;
}

/**
 * Hydrates the polls of a whole page of posts with a fixed number of queries (no N+1):
 *  1. options of every poll on the page (also tells which posts have a poll),
 *  2. the viewer's own votes,
 *  3. vote counts, only for polls where the viewer has voted or is the author.
 * Counts are never read for anyone else, so they cannot leak from this function.
 * Returns a map keyed by post id; posts without a poll are absent.
 */
export async function hydratePolls(db: D1Database, posts: PollPostRef[], viewerId: string, nowMs = Date.now()): Promise<Map<string, PollItem>> {
  const result = new Map<string, PollItem>();
  if (posts.length === 0) return result;
  const ids = posts.map((p) => p.id);
  const ph = ids.map(() => '?').join(',');

  const optionRows = await db
    .prepare(`SELECT id, poll_id, text FROM poll_options WHERE poll_id IN (${ph}) ORDER BY poll_id, position`)
    .bind(...ids)
    .all<{ id: string; poll_id: string; text: string }>();
  const options = optionRows.results || [];
  if (options.length === 0) return result;

  const pollIds = [...new Set(options.map((o) => o.poll_id))];
  const pollPh = pollIds.map(() => '?').join(',');

  // Placeholders appear in this order in the SQL: user_id first, then the poll ids.
  const myVotes = await db
    .prepare(`SELECT poll_id, option_id FROM poll_votes WHERE user_id = ? AND poll_id IN (${pollPh})`)
    .bind(viewerId, ...pollIds)
    .all<{ poll_id: string; option_id: string }>();
  const myVoteMap = new Map((myVotes.results || []).map((v) => [v.poll_id, v.option_id]));

  const byId = new Map(posts.map((p) => [p.id, p]));
  const countable = pollIds.filter((id) => myVoteMap.has(id) || byId.get(id)?.author_id === viewerId);
  const counts = new Map<string, number>();
  if (countable.length > 0) {
    const countPh = countable.map(() => '?').join(',');
    const countRows = await db
      .prepare(`SELECT option_id, COUNT(*) AS n FROM poll_votes WHERE poll_id IN (${countPh}) GROUP BY option_id`)
      .bind(...countable)
      .all<{ option_id: string; n: number }>();
    for (const c of countRows.results || []) counts.set(c.option_id, Number(c.n));
  }

  const countableSet = new Set(countable);
  for (const pollId of pollIds) {
    const post = byId.get(pollId)!;
    const mine = options.filter((o) => o.poll_id === pollId);
    const showCounts = countableSet.has(pollId);
    const item: PollItem = {
      options: mine.map((o) => (showCounts ? { id: o.id, text: o.text, votes: counts.get(o.id) ?? 0 } : { id: o.id, text: o.text })),
      my_vote: myVoteMap.get(pollId) ?? null,
      closed: post.status !== 'active' || Date.parse(post.expires_at) <= nowMs,
    };
    if (showCounts) item.total_votes = mine.reduce((sum, o) => sum + (counts.get(o.id) ?? 0), 0);
    result.set(pollId, item);
  }
  return result;
}
