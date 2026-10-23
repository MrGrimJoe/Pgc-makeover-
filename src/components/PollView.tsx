import React, { useState } from 'react';
import type { PollItem } from '../../shared/schema.ts';

interface PollViewProps {
  postId: string;
  poll: PollItem;
}

/**
 * One poll on a post. Before the viewer votes (and unless they wrote the post) only the options show;
 * the server sends counts only when they are allowed, so nothing is hidden here by styling.
 */
export const PollView: React.FC<PollViewProps> = ({ postId, poll: initial }) => {
  const [poll, setPoll] = useState<PollItem>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const showCounts = typeof poll.total_votes === 'number';
  const total = poll.total_votes ?? 0;

  const vote = async (optionId: string) => {
    if (busy || poll.closed || poll.my_vote === optionId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/posts/${encodeURIComponent(postId)}/poll/vote`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ option_id: optionId }),
      });
      const data = (await res.json().catch(() => ({}))) as { poll?: PollItem; error?: string };
      if (!res.ok || !data.poll) throw new Error(data.error || 'Could not save your vote. Try again.');
      setPoll(data.poll);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-4 pt-2" data-testid="poll">
      <ul className="m-0 p-0 list-none flex flex-col gap-2" aria-label="Poll">
        {poll.options.map((o) => {
          const mine = poll.my_vote === o.id;
          const pct = showCounts && total > 0 ? Math.round(((o.votes ?? 0) / total) * 100) : 0;
          return (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => vote(o.id)}
                disabled={busy || poll.closed}
                aria-pressed={mine}
                className={`relative w-full min-h-[44px] overflow-hidden rounded-[8px] border text-left px-3 py-2 text-[15px] text-[var(--text,#17233A)] bg-transparent cursor-pointer disabled:cursor-default ${
                  mine ? 'border-[var(--blue,#244C8A)] font-semibold' : 'border-[var(--line,#E8EBF0)]'
                }`}
              >
                {showCounts && (
                  <span aria-hidden="true" className="absolute inset-y-0 left-0 bg-[var(--bg2,#F8F9FC)]" style={{ width: `${pct}%` }} />
                )}
                <span className="relative flex items-center justify-between gap-2">
                  <span className="break-words">{o.text}{mine ? ' (your vote)' : ''}</span>
                  {showCounts && <span className="shrink-0 text-[13px] text-[var(--muted,#5B6577)]">{pct}%</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-1 text-[12px] text-[var(--muted,#5B6577)]">
        {poll.closed ? 'Poll closed' : showCounts ? `${total} ${total === 1 ? 'vote' : 'votes'}` : 'Vote to see results'}
      </p>
      {error && (
        <p role="alert" className="mt-1 text-[12px] text-[var(--danger,#B23A40)]">{error}</p>
      )}
    </div>
  );
};
