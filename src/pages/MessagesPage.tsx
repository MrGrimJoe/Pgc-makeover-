import React, { useState, useEffect, useRef } from 'react';
import type { ConversationItem, MessageItem, MediaItem } from '../../shared/schema.ts';
import { ArrowLeft, Image as ImageIcon, X } from 'lucide-react';
import { ExpiryChip } from '../components/ExpiryChip.tsx';

interface MessagesPageProps {
  currentUserId: string;
  initialTargetUser?: {
    username: string;
    display_name: string;
    avatar_media_id: string | null;
  } | null;
  onBack: () => void;
  onViewAuthorProfile: (username: string) => void;
}

export const MessagesPage: React.FC<MessagesPageProps> = ({
  currentUserId,
  initialTargetUser,
  onBack,
  onViewAuthorProfile,
}) => {
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [activeConversation, setActiveConversation] = useState<ConversationItem | null>(null);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [loadingConversations, setLoadingConversations] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New message composition
  const [messageBody, setMessageBody] = useState('');
  const [attachedMedia, setAttachedMedia] = useState<MediaItem[]>([]);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [sending, setSending] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const fetchConversations = async () => {
    setLoadingConversations(true);
    try {
      const res = await fetch('/api/conversations');
      if (res.ok) {
        const data = (await res.json()) as { conversations: ConversationItem[] };
        setConversations(data.conversations || []);
      }
    } catch {
      // Ignore
    } finally {
      setLoadingConversations(false);
    }
  };

  useEffect(() => {
    fetchConversations();
  }, []);

  // If opened directly with a target user (e.g. from profile "Message" button)
  useEffect(() => {
    if (initialTargetUser) {
      startOrOpenConversation(initialTargetUser.username);
    }
  }, [initialTargetUser]);

  const startOrOpenConversation = async (targetUsernameOrId: string) => {
    setError(null);
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: targetUsernameOrId }),
      });

      if (!res.ok) {
        const errData = (await res.json()) as { error?: string };
        throw new Error(errData.error || 'Failed to open conversation');
      }

      const data = (await res.json()) as { conversation: ConversationItem };
      setActiveConversation(data.conversation);
      loadMessages(data.conversation.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const loadMessages = async (convId: string) => {
    setLoadingMessages(true);
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${convId}/messages?limit=50`);
      if (res.ok) {
        const data = (await res.json()) as { messages: MessageItem[] };
        // Reverse because endpoint returns newest first
        setMessages((data.messages || []).slice().reverse());
        setTimeout(scrollToBottom, 100);
      }
    } catch {
      // Ignore
    } finally {
      setLoadingMessages(false);
    }
  };

  const handleSelectConversation = (conv: ConversationItem) => {
    setActiveConversation(conv);
    loadMessages(conv.id);
  };

  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    if (attachedMedia.length + files.length > 4) {
      setError('Maximum 4 images allowed per message.');
      return;
    }

    setUploadingImage(true);
    setError(null);

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
        if (file.size > 5 * 1024 * 1024) {
          throw new Error(`"${file.name}" exceeds 5 MB limit.`);
        }

        const formData = new FormData();
        formData.append('file', file);

        const res = await fetch('/api/media/uploads', {
          method: 'POST',
          body: formData,
        });

        if (!res.ok) {
          const errData = (await res.json()) as { error?: string };
          throw new Error(errData.error || `Upload failed for "${file.name}"`);
        }

        const item = (await res.json()) as MediaItem;
        setAttachedMedia((prev) => [...prev, item]);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploadingImage(false);
      e.target.value = '';
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeConversation || (!messageBody.trim() && attachedMedia.length === 0) || sending) {
      return;
    }

    setSending(true);
    setError(null);

    try {
      const res = await fetch(`/api/conversations/${activeConversation.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: messageBody.trim() || 'Sent an attachment',
          media_ids: attachedMedia.map((m) => m.id),
        }),
      });

      if (!res.ok) {
        const errData = (await res.json()) as { error?: string };
        throw new Error(errData.error || 'Failed to send message');
      }

      const data = (await res.json()) as { message: MessageItem };
      setMessages((prev) => [...prev, data.message]);
      setMessageBody('');
      setAttachedMedia([]);
      setTimeout(scrollToBottom, 50);

      // Refresh conversations list to update snippet
      fetchConversations();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  // If in Thread view
  if (activeConversation) {
    const otherUser = activeConversation.other_user;
    const initial = (otherUser.display_name || otherUser.username || 'U').slice(0, 2).toUpperCase();

    return (
      <div className="w-full max-w-[430px] mx-auto min-h-screen bg-[var(--bg,#fff)] flex flex-col pb-16">
        {/* Thread Header: 48px sticky */}
        <header className="sticky top-0 z-40 bg-[var(--bg,#fff)] h-[48px] border-b border-[var(--line,#E8EBF0)] flex items-center gap-2 px-3">
          <button
            type="button"
            onClick={() => {
              setActiveConversation(null);
              setError(null);
            }}
            title="Back to conversations"
            aria-label="Back to conversations"
            className="w-[44px] h-[44px] flex items-center justify-center text-[var(--text,#17233A)] hover:text-[var(--blue,#244C8A)] cursor-pointer bg-transparent border-0 -ml-2"
          >
            <ArrowLeft className="w-5 h-5 stroke-[1.7]" />
          </button>

          <button
            type="button"
            onClick={() => onViewAuthorProfile(otherUser.username)}
            className="flex items-center gap-2.5 flex-1 min-w-0 text-left bg-transparent border-0 p-0 cursor-pointer"
          >
            <div className="w-8 h-8 rounded-full bg-[var(--tint,#EAF0FA)] text-[var(--blue,#244C8A)] font-semibold text-[13px] flex items-center justify-center shrink-0">
              {initial}
            </div>
            <div className="flex-1 min-w-0">
              <span className="font-semibold text-[15px] leading-tight block truncate text-[var(--text,#17233A)]">
                {otherUser.display_name}
              </span>
              <span className="text-[12px] text-[var(--muted,#5B6577)] block leading-tight truncate">
                @{otherUser.username}
              </span>
            </div>
          </button>
        </header>

        {/* Error notification */}
        {error && (
          <div role="alert" className="m-3 p-2.5 rounded-[8px] bg-[var(--bg2,#F8F9FC)] border border-[var(--danger,#B23A40)] text-[var(--danger,#B23A40)] text-[13px]">
            {error}
          </div>
        )}

        {/* Messages List */}
        <div className="flex-1 p-4 space-y-3 overflow-y-auto">
          {loadingMessages && (
            <div className="space-y-3">
              <div className="w-48 h-10 skeleton-box rounded-[16px] mr-auto" />
              <div className="w-56 h-10 skeleton-box rounded-[16px] ml-auto" />
            </div>
          )}

          {!loadingMessages && messages.length === 0 && (
            <div className="py-16 text-center text-[13px] text-[var(--muted,#5B6577)]">
              No messages yet. Send a message to start the conversation!
            </div>
          )}

          {messages.map((msg) => {
            const isSelf = msg.sender_id === currentUserId;

            return (
              <div
                key={msg.id}
                className={`flex flex-col ${isSelf ? 'items-end' : 'items-start'}`}
              >
                {/* Message Bubble */}
                <div
                  className={`max-w-[80%] px-3.5 py-2 text-[15px] leading-relaxed break-words ${
                    isSelf
                      ? 'bg-[var(--blue,#244C8A)] text-white rounded-[16px] rounded-br-[4px]'
                      : 'bg-[var(--bg2,#F8F9FC)] border border-[var(--line,#E8EBF0)] text-[var(--text,#17233A)] rounded-[16px] rounded-bl-[4px]'
                  }`}
                >
                  {/* Media attachments */}
                  {msg.media && msg.media.length > 0 && (
                    <div className="space-y-1 mb-1.5">
                      {msg.media.map((m) => (
                        <img
                          key={m.id}
                          src={`/api/media/${m.id}`}
                          alt="Message attachment"
                          className="rounded-[8px] max-h-[220px] w-full object-cover"
                          loading="lazy"
                        />
                      ))}
                    </div>
                  )}

                  {msg.body}
                </div>

                {/* Remaining time under each message */}
                <div className="mt-1 px-1">
                  <ExpiryChip expiresAt={msg.expires_at} />
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        {/* Message Composer Bar: 44px min height */}
        <div className="sticky bottom-0 bg-[var(--bg,#fff)] border-t border-[var(--line,#E8EBF0)] p-2 px-3 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))]">
          {/* Attached preview thumbnails */}
          {attachedMedia.length > 0 && (
            <div className="flex gap-2 mb-2 overflow-x-auto pb-1">
              {attachedMedia.map((m) => (
                <div
                  key={m.id}
                  className="relative w-14 h-14 rounded-[8px] overflow-hidden bg-[var(--bg2,#F8F9FC)] border border-[var(--line,#E8EBF0)] shrink-0"
                >
                  <img src={`/api/media/${m.id}`} alt="Attachment preview" className="w-full h-full object-cover" />
                  <button
                    type="button"
                    onClick={() => setAttachedMedia((prev) => prev.filter((item) => item.id !== m.id))}
                    aria-label="Remove attachment"
                    className="absolute top-0 right-0 w-[44px] h-[44px] min-w-[44px] min-h-[44px] flex items-center justify-center text-white cursor-pointer"
                  >
                    <span className="bg-black/60 rounded-full p-0.5 flex items-center justify-center">
                      <X className="w-3 h-3" />
                    </span>
                  </button>
                </div>
              ))}
            </div>
          )}

          <form onSubmit={handleSendMessage} className="flex items-center gap-2">
            <label
              htmlFor="thread-image-upload"
              className={`w-[44px] h-[44px] flex items-center justify-center text-[var(--blue,#244C8A)] hover:opacity-80 cursor-pointer ${
                attachedMedia.length >= 4 || uploadingImage ? 'opacity-40 pointer-events-none' : ''
              }`}
              title="Attach image"
              aria-label="Attach image"
            >
              <ImageIcon className="w-6 h-6 stroke-[1.7]" />
            </label>
            <input
              id="thread-image-upload"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleImageSelect}
              aria-label="Attach image"
              className="hidden"
            />

            <input
              type="text"
              value={messageBody}
              onChange={(e) => setMessageBody(e.target.value)}
              placeholder={uploadingImage ? 'Uploading image...' : 'Message...'}
              aria-label="Message"
              maxLength={1000}
              className="flex-1 min-h-[44px] bg-[var(--bg2,#F8F9FC)] border border-[var(--line,#E8EBF0)] rounded-[12px] px-3.5 text-[15px] text-[var(--text,#17233A)] outline-none"
            />

            <button
              type="submit"
              disabled={sending || (!messageBody.trim() && attachedMedia.length === 0) || uploadingImage}
              className="min-h-[44px] px-3 font-semibold text-[15px] text-[var(--blue,#244C8A)] disabled:opacity-40 cursor-pointer bg-transparent border-0"
            >
              {sending ? 'Sending...' : 'Send'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // Conversation List View
  return (
    <div className="w-full max-w-[430px] mx-auto min-h-screen bg-[var(--bg,#fff)] flex flex-col pb-16">
      {/* Header: 48px sticky */}
      <header className="sticky top-0 z-40 bg-[var(--bg,#fff)] h-[48px] border-b border-[var(--line,#E8EBF0)] flex items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            title="Back"
            aria-label="Back"
            className="w-[44px] h-[44px] -ml-3 flex items-center justify-center text-[var(--text,#17233A)] hover:text-[var(--blue,#244C8A)] cursor-pointer bg-transparent border-0"
          >
            <ArrowLeft className="w-5 h-5 stroke-[1.7]" />
          </button>
          <span className="font-semibold text-[20px] text-[var(--text,#17233A)] tracking-[-0.3px]">
            Messages
          </span>
        </div>
      </header>

      {/* Error state */}
      {error && (
        <div role="alert" className="m-4 p-2.5 rounded-[8px] bg-[var(--bg2,#F8F9FC)] border border-[var(--danger,#B23A40)] text-[var(--danger,#B23A40)] text-[13px]">
          {error}
        </div>
      )}

      {/* Loading Skeletons */}
      {loadingConversations && (
        <div className="divide-y divide-[var(--line,#E8EBF0)]">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3 min-h-[56px]">
              <div className="w-8 h-8 rounded-full skeleton-box shrink-0" />
              <div className="flex-1 space-y-1.5">
                <div className="w-28 h-3.5 skeleton-box rounded" />
                <div className="w-44 h-3 skeleton-box rounded" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty State */}
      {!loadingConversations && conversations.length === 0 && !error && (
        <div className="py-20 text-center space-y-3 px-4">
          <p className="text-[14px] text-[var(--muted,#5B6577)]">No conversations yet.</p>
          <p className="text-[13px] text-[var(--muted,#5B6577)]">
            Visit a classmate&apos;s profile and tap &ldquo;Message&rdquo; to start a chat.
          </p>
        </div>
      )}

      {/* Conversations List (search-row pattern) */}
      {!loadingConversations && conversations.length > 0 && (
        <div className="divide-y divide-[var(--line,#E8EBF0)]">
          {conversations.map((conv) => {
            const other = conv.other_user;
            const initial = (other.display_name || other.username || 'U').slice(0, 2).toUpperCase();
            const lastMsg = conv.last_message;

            return (
              <div
                key={conv.id}
                onClick={() => handleSelectConversation(conv)}
                className="flex items-center gap-3 px-4 py-2.5 min-h-[56px] hover:bg-[var(--bg2,#F8F9FC)] cursor-pointer transition-colors"
              >
                <div className="w-8 h-8 rounded-full bg-[var(--tint,#EAF0FA)] text-[var(--blue,#244C8A)] flex items-center justify-center font-semibold text-[13px] shrink-0">
                  {initial}
                </div>

                <div className="flex-1 min-w-0">
                  <b className="font-semibold text-[15px] block text-[var(--text,#17233A)] truncate">
                    {other.display_name}
                  </b>
                  <small className="text-[var(--muted,#5B6577)] block text-[13px] truncate">
                    {lastMsg ? lastMsg.body : 'No messages yet'}
                  </small>
                </div>

                {lastMsg && (
                  <div className="shrink-0 text-right">
                    <ExpiryChip expiresAt={lastMsg.expires_at} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
