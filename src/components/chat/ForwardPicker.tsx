import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { ConversationItem } from '../../../shared/schema.ts';
import { Avatar } from '../Avatar.tsx';
import { useFocusTrap } from '../../lib/focus-trap.ts';

interface ForwardPickerProps {
  messageId: string;
  onClose: () => void;
  onForwarded: (conversationId: string) => void;
}

/** Choose a conversation to forward a message to. The same media is referenced, nothing is uploaded again. */
export const ForwardPicker: React.FC<ForwardPickerProps> = ({ messageId, onClose, onForwarded }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [convs, setConvs] = useState<ConversationItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  useFocusTrap(ref, onClose);

  useEffect(() => {
    fetch('/api/conversations')
      .then(async (r) => {
        if (!r.ok) throw new Error('Could not load your conversations.');
        setConvs(((await r.json()) as { conversations: ConversationItem[] }).conversations ?? []);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const forward = async (conv: ConversationItem) => {
    setBusyId(conv.id);
    setError(null);
    try {
      const res = await fetch(`/api/messages/${encodeURIComponent(messageId)}/forward`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: conv.id }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || 'Could not forward.');
      onForwarded(conv.id);
    } catch (e) {
      setError((e as Error).message);
      setBusyId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50" onClick={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label="Forward to" tabIndex={-1} onClick={(e) => e.stopPropagation()} className="w-full max-w-[430px] max-h-[70vh] overflow-y-auto bg-[var(--bg,#fff)] rounded-t-[16px] p-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
        <div className="flex items-center justify-between mb-2">
          <h2 className="m-0 text-[16px] font-semibold text-[var(--text,#17233A)]">Forward to</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="w-[44px] h-[44px] flex items-center justify-center bg-transparent border-0 text-[var(--text,#17233A)] cursor-pointer"><X className="w-5 h-5" aria-hidden="true" /></button>
        </div>
        {error && <div role="alert" className="mb-2 p-2.5 rounded-[8px] border border-[var(--danger,#B23A40)] text-[var(--danger,#B23A40)] text-[13px]">{error}</div>}
        {convs === null && !error && <p className="text-[13px] text-[var(--muted,#5B6577)]">Loading...</p>}
        {convs && convs.length === 0 && <p className="text-[13px] text-[var(--muted,#5B6577)]">You have no other conversations yet.</p>}
        <ul className="list-none m-0 p-0 divide-y divide-[var(--line,#E8EBF0)]">
          {(convs ?? []).map((c) => (
            <li key={c.id}>
              <button type="button" disabled={busyId !== null} onClick={() => void forward(c)} className="w-full flex items-center gap-3 min-h-[56px] py-2 bg-transparent border-0 text-left cursor-pointer disabled:opacity-50">
                <Avatar mediaId={c.other_user.avatar_media_id} displayName={c.other_user.display_name} username={c.other_user.username} size={40} />
                <span className="flex-1 min-w-0"><b className="block text-[15px] text-[var(--text,#17233A)] truncate">{c.other_user.display_name}</b><small className="block text-[13px] text-[var(--muted,#5B6577)] truncate">@{c.other_user.username}</small></span>
                {busyId === c.id && <span className="text-[12px] text-[var(--muted,#5B6577)]">Sending...</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
