import React from 'react';
import { ArrowLeft } from 'lucide-react';
import type { ConversationItem } from '../../../shared/schema.ts';
import { Avatar } from '../Avatar.tsx';
import { ExpiryChip } from '../ExpiryChip.tsx';
import { arrowKeyNav } from '../../lib/arrow-keys.ts';

/** Preview text for the last message: the text, or "Photo", "Sticker", "GIF", "Video" for media-only messages. */
export function previewText(last: NonNullable<ConversationItem['last_message']> | null | undefined): string {
  if (!last) return 'No messages yet';
  if (last.body) return last.body;
  switch (last.media_kind) {
    case 'sticker': return 'Sticker';
    case 'gif': return 'GIF';
    case 'video': return 'Video';
    case 'photo': return 'Photo';
    default: return 'Message';
  }
}

interface ConversationListProps {
  conversations: ConversationItem[];
  loading: boolean;
  error: string | null;
  onSelect: (conv: ConversationItem) => void;
  onBack: () => void;
  /** Two-pane layouts: the list sits beside the chat, so there is no Back button and no own column width. */
  embedded?: boolean;
  /** The conversation that is open next to the list (embedded only). */
  selectedId?: string | null;
}

export const ConversationList: React.FC<ConversationListProps> = ({ conversations, loading, error, onSelect, onBack, embedded = false, selectedId = null }) => (
  <div className={embedded ? 'w-full bg-[var(--bg,#fff)] flex flex-col' : 'w-full max-w-content mx-auto min-h-screen bg-[var(--bg,#fff)] flex flex-col'}>
    <header className={`sticky z-40 bg-[var(--bg,#fff)] border-b border-[var(--line,#E8EBF0)] flex items-center px-4 ${embedded ? 'top-0 h-[56px]' : 'top-[48px] h-[48px]'}`}>
      {!embedded && (
        <button type="button" onClick={onBack} title="Back" aria-label="Back" className="w-[44px] h-[44px] -ml-3 flex items-center justify-center text-[var(--text,#17233A)] cursor-pointer bg-transparent border-0">
          <ArrowLeft className="w-5 h-5 stroke-[1.7]" />
        </button>
      )}
      <h1 className="font-semibold text-[20px] text-[var(--text,#17233A)] tracking-[-0.3px] m-0">Messages</h1>
    </header>

    {error && (
      <div role="alert" className="m-4 p-2.5 rounded-[8px] bg-[var(--bg2,#F8F9FC)] border border-[var(--danger,#B23A40)] text-[var(--danger,#B23A40)] text-[13px]">{error}</div>
    )}

    {loading && (
      <div className="divide-y divide-[var(--line,#E8EBF0)]" aria-busy="true">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3 min-h-[56px]">
            <div className="w-10 h-10 rounded-full skeleton-box shrink-0" />
            <div className="flex-1 space-y-1.5"><div className="w-28 h-3.5 skeleton-box rounded" /><div className="w-44 h-3 skeleton-box rounded" /></div>
          </div>
        ))}
      </div>
    )}

    {!loading && conversations.length === 0 && !error && (
      <div className="py-20 text-center space-y-3 px-4">
        <p className="text-[14px] text-[var(--muted,#5B6577)]">No conversations yet.</p>
        <p className="text-[13px] text-[var(--muted,#5B6577)]">Visit a classmate&apos;s profile and tap &ldquo;Message&rdquo; to start a chat.</p>
      </div>
    )}

    {!loading && conversations.length > 0 && (
      <ul onKeyDown={arrowKeyNav} className="divide-y divide-[var(--line,#E8EBF0)] list-none m-0 p-0">
        {conversations.map((conv) => {
          const other = conv.other_user;
          const last = conv.last_message;
          return (
            <li key={conv.id}>
              <button
                type="button"
                onClick={() => onSelect(conv)}
                aria-current={embedded && selectedId === conv.id ? 'true' : undefined}
                className={`w-full flex items-center gap-3 px-4 py-2.5 min-h-[56px] border-0 text-left hover:bg-[var(--bg2,#F8F9FC)] cursor-pointer ${embedded && selectedId === conv.id ? 'bg-[var(--tint,#EEF3FB)]' : 'bg-transparent'}`}
              >
                <Avatar mediaId={other.avatar_media_id} displayName={other.display_name} username={other.username} size={40} />
                <span className="flex-1 min-w-0">
                  <b className="font-semibold text-[15px] block text-[var(--text,#17233A)] truncate">{other.display_name}</b>
                  <small className="text-[var(--muted,#5B6577)] block text-[13px] truncate">{previewText(last)}</small>
                </span>
                {last && <span className="shrink-0"><ExpiryChip expiresAt={last.expires_at} /></span>}
              </button>
            </li>
          );
        })}
      </ul>
    )}
  </div>
);
