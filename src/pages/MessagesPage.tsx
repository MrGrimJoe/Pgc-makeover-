import React, { useCallback, useEffect, useState } from 'react';
import type { ConversationItem } from '../../shared/schema.ts';
import { ConversationList } from '../components/chat/ConversationList.tsx';
import { ChatScreen } from '../components/chat/ChatScreen.tsx';
import { useLayout } from '../lib/layout.ts';

interface MessagesPageProps {
  currentUserId: string;
  initialTargetUser?: { username: string; display_name: string; avatar_media_id: string | null } | null;
  onBack: () => void;
  onViewAuthorProfile: (username: string) => void;
}

/**
 * Messages. Phone: the conversation list, then the chat for the open conversation (one at a time).
 * Tablet and desktop: both side by side. The open conversation is the same state in both, and the chat
 * stays at the same place in the tree, so resizing across a breakpoint keeps it (and its unsent text).
 */
export const MessagesPage: React.FC<MessagesPageProps> = ({ currentUserId, initialTargetUser, onBack, onViewAuthorProfile }) => {
  const layout = useLayout();
  const twoPane = layout !== 'phone';
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [active, setActive] = useState<ConversationItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchConversations = useCallback(async () => {
    try {
      const res = await fetch('/api/conversations');
      if (res.ok) setConversations(((await res.json()) as { conversations: ConversationItem[] }).conversations || []);
    } catch {
      // keep the previous list
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void fetchConversations(); }, [fetchConversations]);

  // Opened from a profile's Message button
  useEffect(() => {
    if (!initialTargetUser) return;
    (async () => {
      setError(null);
      try {
        const res = await fetch('/api/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: initialTargetUser.username }) });
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || 'Failed to open conversation');
        setActive(((await res.json()) as { conversation: ConversationItem }).conversation);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [initialTargetUser]);

  const showList = twoPane || !active;
  const showChat = twoPane || !!active;
  return (
    <div className={twoPane ? 'flex items-start w-full' : undefined}>
      {showList && (
        <div className={twoPane ? 'sticky top-0 self-start h-screen overflow-y-auto shrink-0 border-r border-[var(--line,#E8EBF0)] w-[260px] desktop:w-[320px]' : undefined}>
          <ConversationList conversations={conversations} loading={loading} error={error} onSelect={setActive} onBack={onBack} embedded={twoPane} selectedId={active?.id ?? null} />
        </div>
      )}
      {showChat && (
        <div className={twoPane ? 'flex-1 min-w-0' : undefined}>
          {active ? (
            <ChatScreen
              key={active.id}
              conversation={active}
              currentUserId={currentUserId}
              onBack={() => { setActive(null); void fetchConversations(); }}
              onViewProfile={onViewAuthorProfile}
              onSent={() => void fetchConversations()}
              embedded={twoPane}
            />
          ) : (
            <div className="sticky top-0 h-screen flex items-center justify-center px-6 text-center text-[14px] text-[var(--muted,#5B6577)]">
              Choose a conversation to start chatting.
            </div>
          )}
        </div>
      )}
    </div>
  );
};
