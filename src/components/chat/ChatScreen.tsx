import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, MoreVertical } from 'lucide-react';
import type { ConversationItem, MediaItem, MessageItem } from '../../../shared/schema.ts';
import { Avatar } from '../Avatar.tsx';
import { ReportModal } from '../ReportModal.tsx';
import { Composer } from './Composer.tsx';
import { MessageBubble } from './MessageBubble.tsx';
import { AttachSheet } from './AttachSheet.tsx';
import { MediaPreview } from './MediaPreview.tsx';
import { MediaViewer } from './MediaViewer.tsx';
import { PickerPanel } from './PickerPanel.tsx';
import { ChatBackground } from './ChatBackground.tsx';
import { loadChatBackground, type ChatBackgroundChoice } from '../../lib/chat-background.ts';
import { prepareAndUpload, type PickedItem } from '../../lib/media-upload.ts';

interface ChatScreenProps {
  conversation: ConversationItem;
  currentUserId: string;
  onBack: () => void;
  onViewProfile: (username: string) => void;
  /** Called after something was sent so the conversation list can refresh its preview. */
  onSent: () => void;
}

export const ChatScreen: React.FC<ChatScreenProps> = ({ conversation, currentUserId, onBack, onViewProfile, onSent }) => {
  const other = conversation.other_user;
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [background, setBackground] = useState<ChatBackgroundChoice>({ kind: 'preset', id: 'plain' });

  const [attachOpen, setAttachOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTab, setPickerTab] = useState<'stickers' | 'gifs'>('stickers');
  const [previewFiles, setPreviewFiles] = useState<File[] | null>(null);
  const [previewMode, setPreviewMode] = useState<'send' | 'library'>('send');
  const [libraryKey, setLibraryKey] = useState(0);
  const [viewer, setViewer] = useState<{ msg: MessageItem; index: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reporting, setReporting] = useState<{ type: 'user' | 'message'; id: string } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { void loadChatBackground(currentUserId).then(setBackground); }, [currentUserId]);

  const scrollToBottom = () => setTimeout(() => endRef.current?.scrollIntoView?.({ behavior: 'smooth' }), 50);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${conversation.id}/messages?limit=50`);
      if (!res.ok) throw new Error('Could not load messages.');
      const data = (await res.json()) as { messages: MessageItem[] };
      setMessages((data.messages || []).slice().reverse());
      scrollToBottom();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [conversation.id]);
  useEffect(() => { void load(); }, [load]);

  const post = async (body: string, mediaIds: string[], stickerKey?: string) => {
    const res = await fetch(`/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, media_ids: mediaIds, ...(stickerKey ? { sticker_key: stickerKey } : {}) }),
    });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || 'Failed to send message');
    const data = (await res.json()) as { message: MessageItem };
    setMessages((prev) => [...prev, data.message]);
    scrollToBottom();
    onSent();
  };

  const sendText = async (text: string) => {
    setSending(true);
    setError(null);
    try {
      await post(text, []);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setSending(false);
    }
  };

  // Nothing is uploaded until the person presses Send in the preview; compression runs here.
  const confirmPreview = async (items: PickedItem[], caption: string) => {
    if (previewMode === 'library') {
      for (const item of items) {
        const uploaded = await prepareAndUpload(item);
        const res = await fetch('/api/stickers/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ media_id: uploaded.id }) });
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || 'Could not add it.');
      }
      setPreviewFiles(null);
      setLibraryKey((k) => k + 1);
      setNotice('Added to your stickers.');
      return;
    }
    const uploaded: MediaItem[] = [];
    for (const item of items) uploaded.push(await prepareAndUpload(item));
    await post(caption, uploaded.map((u) => u.id));
    setPreviewFiles(null);
  };

  // Stickers and GIFs go by key only: app:<pack>/<number> or usr:<mediaId>
  const pickSticker = async (key: string) => {
    setSending(true);
    setError(null);
    try {
      await post('', [], key);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const blockUser = async () => {
    setMenuOpen(false);
    const res = await fetch('/api/blocks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: other.id }) });
    if (res.ok) onBack();
    else setError('Could not block this person.');
  };

  const openPicker = (tab: 'stickers' | 'gifs') => {
    setPickerTab(tab);
    setAttachOpen(false);
    setPickerOpen(true);
  };

  return (
    <div className="w-full max-w-[430px] mx-auto min-h-screen bg-[var(--bg,#fff)] flex flex-col pb-16">
      <header className="sticky top-0 z-40 bg-[var(--bg,#fff)] h-[56px] border-b border-[var(--line,#E8EBF0)] flex items-center gap-1 px-2">
        <button type="button" onClick={onBack} aria-label="Back to conversations" title="Back to conversations" className="w-[44px] h-[44px] flex items-center justify-center text-[var(--text,#17233A)] cursor-pointer bg-transparent border-0">
          <ArrowLeft className="w-5 h-5 stroke-[1.7]" />
        </button>
        <button type="button" onClick={() => onViewProfile(other.username)} className="flex items-center gap-2.5 flex-1 min-w-0 text-left bg-transparent border-0 p-0 cursor-pointer min-h-[44px]">
          <Avatar mediaId={other.avatar_media_id} displayName={other.display_name} username={other.username} size={36} />
          <span className="flex-1 min-w-0">
            <span className="font-semibold text-[15px] leading-tight block truncate text-[var(--text,#17233A)]">{other.display_name}</span>
            <span className="text-[12px] text-[var(--muted,#5B6577)] block leading-tight truncate">@{other.username}</span>
          </span>
        </button>
        <div className="relative">
          <button type="button" onClick={() => setMenuOpen((o) => !o)} aria-label="Chat menu" aria-haspopup="menu" aria-expanded={menuOpen} className="w-[44px] h-[44px] flex items-center justify-center text-[var(--text,#17233A)] cursor-pointer bg-transparent border-0">
            <MoreVertical className="w-5 h-5" aria-hidden="true" />
          </button>
          {menuOpen && (
            <div role="menu" className="absolute right-0 top-[48px] z-50 w-[180px] rounded-[10px] border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] shadow-lg overflow-hidden">
              <button type="button" role="menuitem" onClick={() => void blockUser()} className="w-full min-h-[44px] px-3 text-left text-[14px] text-[var(--text,#17233A)] bg-transparent border-0 cursor-pointer">Block @{other.username}</button>
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setReporting({ type: 'user', id: other.id }); }} className="w-full min-h-[44px] px-3 text-left text-[14px] text-[var(--danger,#B23A40)] bg-transparent border-0 cursor-pointer">Report @{other.username}</button>
            </div>
          )}
        </div>
      </header>

      {error && <div role="alert" className="m-3 p-2.5 rounded-[8px] bg-[var(--bg2,#F8F9FC)] border border-[var(--danger,#B23A40)] text-[var(--danger,#B23A40)] text-[13px]">{error}</div>}
      {notice && <div role="status" className="m-3 p-2.5 rounded-[8px] bg-[var(--bg2,#F8F9FC)] border border-[var(--line,#E8EBF0)] text-[var(--text,#17233A)] text-[13px]">{notice}</div>}

      <ChatBackground choice={background} className="flex-1">
        <div className="p-4 space-y-3" aria-live="polite" aria-label="Messages">
          {loading && (
            <div className="space-y-3" aria-busy="true">
              <div className="w-48 h-10 skeleton-box rounded-[16px] mr-auto" />
              <div className="w-56 h-10 skeleton-box rounded-[16px] ml-auto" />
            </div>
          )}
          {!loading && messages.length === 0 && (
            <p className="py-16 text-center text-[13px] text-[var(--text,#17233A)] m-0">No messages yet. Send a message to start the conversation!</p>
          )}
          {messages.map((msg) => (
            <MessageBubble key={msg.id} msg={msg} isSelf={msg.sender_id === currentUserId} onOpenMedia={(m, i) => setViewer({ msg: m, index: i })} onReport={(m) => setReporting({ type: 'message', id: m.id })} />
          ))}
          <div ref={endRef} />
        </div>
      </ChatBackground>

      <Composer
        onSend={sendText}
        busy={sending}
        onAttach={() => setAttachOpen(true)}
        pickerOpen={pickerOpen}
        onTogglePicker={() => (pickerOpen ? setPickerOpen(false) : openPicker('stickers'))}
        picker={
          <PickerPanel
            key={pickerTab}
            initialTab={pickerTab}
            reloadKey={libraryKey}
            userId={currentUserId}
            onPick={(key) => void pickSticker(key)}
            onAddFiles={(files) => { setPreviewMode('library'); setPreviewFiles(files); }}
          />
        }
      />

      {attachOpen && (
        <AttachSheet
          onClose={() => setAttachOpen(false)}
          onFiles={(files) => { setAttachOpen(false); setPreviewMode('send'); setPreviewFiles(files); }}
          onSticker={() => openPicker('stickers')}
          onGif={() => openPicker('gifs')}
        />
      )}
      {previewFiles && <MediaPreview files={previewFiles} mode={previewMode} onCancel={() => setPreviewFiles(null)} onConfirm={confirmPreview} />}
      {viewer && <MediaViewer message={viewer.msg} startIndex={viewer.index} isSelf={viewer.msg.sender_id === currentUserId} onClose={() => setViewer(null)} onNotice={setNotice} />}
      {reporting && (
        <ReportModal
          targetType={reporting.type}
          targetId={reporting.id}
          onClose={() => setReporting(null)}
          onReportSubmitted={() => { setReporting(null); setNotice('Report sent. Thank you.'); }}
        />
      )}
    </div>
  );
};
