import React, { useCallback, useEffect, useState } from 'react';
import type { ConversationItem } from '../../shared/schema.ts';
import { ConversationList } from '../components/chat/ConversationList.tsx';
import { ChatScreen } from '../components/chat/ChatScreen.tsx';

interface MessagesPageProps {
  currentUserId: string;
  initialTargetUser?: { username: string; display_name: string; avatar_media_id: string | null } | null;
  onBack: () => void;
  onViewAuthorProfile: (username: string) => void;
}

/** Messages: the conversation list, and the chat for the open conversation. */
export const MessagesPage: React.FC<MessagesPageProps> = ({ currentUserId, initialTargetUser, onBack, onViewAuthorProfile }) => {
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

  if (active) {
    return (
      <ChatScreen
        conversation={active}
        currentUserId={currentUserId}
        onBack={() => { setActive(null); void fetchConversations(); }}
        onViewProfile={onViewAuthorProfile}
        onSent={() => void fetchConversations()}
      />
    );
  }
  return <ConversationList conversations={conversations} loading={loading} error={error} onSelect={setActive} onBack={onBack} />;
};
