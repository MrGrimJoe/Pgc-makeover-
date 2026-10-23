import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import type { BlockItem, MeResponse, UserInterestTopic } from '../../shared/schema.ts';
import { CHAT_BACKGROUNDS, type ChatBackgroundId } from '../../shared/chat-background.ts';
import { ChatBackground } from '../components/chat/ChatBackground.tsx';
import { MediaPreview } from '../components/chat/MediaPreview.tsx';
import { LibraryImage } from '../components/chat/LibraryImage.tsx';
import type { LibraryEntry } from '../components/chat/PickerPanel.tsx';
import { loadChatBackground, resetChatBackground, saveChatBackgroundImage, saveChatBackgroundPreset, type ChatBackgroundChoice } from '../lib/chat-background.ts';
import { prepareAndUpload, type PickedItem } from '../lib/media-upload.ts';
import { BottomSheet } from '../components/BottomSheet.tsx';
import { Avatar } from '../components/Avatar.tsx';

interface SettingsPageProps {
  currentUser: MeResponse;
  onProfileUpdated: (updated: MeResponse) => void;
  onAccountDeleted: () => void;
  onLogout: () => Promise<void> | void;
  onBack: () => void;
  /** Opens Edit profile; when omitted the profile card has no Edit button */
  onEditProfile?: () => void;
}

const card = 'border border-[var(--line,#E8EBF0)] rounded-[12px] bg-[var(--bg,#fff)] p-4 space-y-3';
const h2 = 'm-0 text-[15px] font-semibold text-[var(--text,#17233A)]';
const ghost = 'min-h-[44px] px-3.5 rounded-[8px] border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[var(--text,#17233A)] text-[13px] font-semibold cursor-pointer disabled:opacity-40';

/** Sample bubbles for the live preview. Fixed text, not real messages. */
const PreviewBubbles: React.FC = () => (
  <div className="p-3 space-y-2" aria-hidden="true">
    <div className="max-w-[75%] px-3 py-1.5 text-[14px] rounded-[14px] rounded-bl-[4px] bg-[var(--bg2,#F8F9FC)] border border-[var(--line,#E8EBF0)] text-[var(--text,#17233A)]">Hello!</div>
    <div className="max-w-[75%] ml-auto px-3 py-1.5 text-[14px] rounded-[14px] rounded-br-[4px] bg-[var(--blue,#244C8A)] text-[var(--bg,#fff)]">Hi, how are you?</div>
    <p className="m-0 text-[12px] text-[var(--muted,#5B6577)]">Messages stay for 14 days</p>
  </div>
);

export const SettingsPage: React.FC<SettingsPageProps> = ({ currentUser, onProfileUpdated, onAccountDeleted, onLogout, onBack, onEditProfile }) => {
  const userId = currentUser.user.id;
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // "Saved." style notices fade away by themselves; errors stay until the next action
  useEffect(() => {
    if (message?.type !== 'success') return;
    const t = window.setTimeout(() => setMessage(null), 3000);
    return () => window.clearTimeout(t);
  }, [message]);

  // Chat background (this phone only)
  const [bg, setBg] = useState<ChatBackgroundChoice>({ kind: 'preset', id: 'plain' });
  const [bgBusy, setBgBusy] = useState(false);
  const bgFile = useRef<HTMLInputElement>(null);
  useEffect(() => { void loadChatBackground(userId).then(setBg); }, [userId]);

  const choosePreset = async (id: ChatBackgroundId) => {
    setBg({ kind: 'preset', id });
    try { await saveChatBackgroundPreset(userId, id); } catch (e) { setMessage({ type: 'error', text: (e as Error).message }); }
  };
  const importImage = async (file: File) => {
    setBgBusy(true);
    setMessage(null);
    try {
      const blob = await saveChatBackgroundImage(userId, file);
      setBg({ kind: 'image', blob });
    } catch (e) {
      setMessage({ type: 'error', text: (e as Error).message });
    } finally {
      setBgBusy(false);
    }
  };
  const resetBg = async () => {
    await resetChatBackground(userId);
    setBg({ kind: 'preset', id: 'plain' });
  };

  // Who can message you
  const [dmPolicy, setDmPolicy] = useState(currentUser.settings.dm_policy || 'everyone');
  const saveDm = async (value: string) => {
    const previous = dmPolicy;
    setDmPolicy(value);
    setMessage(null);
    try {
      const res = await fetch('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dm_policy: value }) });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || 'Could not save.');
      const me = await fetch('/api/me');
      if (me.ok) onProfileUpdated((await me.json()) as MeResponse);
      setMessage({ type: 'success', text: 'Saved.' });
    } catch (e) {
      setDmPolicy(previous);
      setMessage({ type: 'error', text: (e as Error).message });
    }
  };

  // Blocked people and interests
  const [blocked, setBlocked] = useState<BlockItem[]>([]);
  const [interests, setInterests] = useState<UserInterestTopic[]>([]);
  useEffect(() => {
    fetch('/api/blocks').then(async (r) => r.ok && setBlocked(((await r.json()) as { blocks?: BlockItem[] }).blocks || [])).catch(() => {});
    fetch('/api/me/interests').then(async (r) => r.ok && setInterests(((await r.json()) as { interests?: UserInterestTopic[] }).interests || [])).catch(() => {});
  }, []);
  const unblock = async (id: string) => {
    const res = await fetch(`/api/blocks/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.ok) setBlocked((b) => b.filter((x) => x.user_id !== id));
  };
  const removeInterest = async (topicId: string) => {
    const res = await fetch(`/api/me/interests/${topicId}`, { method: 'DELETE' });
    if (res.ok) setInterests((i) => i.filter((x) => x.topic_id !== topicId));
  };
  const resetInterests = async () => {
    const res = await fetch('/api/me/interests', { method: 'DELETE' });
    if (res.ok) { setInterests([]); setMessage({ type: 'success', text: 'Interests reset.' }); }
  };

  // My stickers & GIFs
  const [library, setLibrary] = useState<LibraryEntry[] | null>(null);
  const [addFiles, setAddFiles] = useState<File[] | null>(null);
  const libFile = useRef<HTMLInputElement>(null);
  const loadLibrary = useCallback(async () => {
    try {
      const res = await fetch('/api/stickers/library');
      setLibrary(res.ok ? ((await res.json()) as { items: LibraryEntry[] }).items ?? [] : []);
    } catch { setLibrary([]); }
  }, []);
  useEffect(() => { void loadLibrary(); }, [loadLibrary]);
  const removeFromLibrary = async (id: string) => {
    const res = await fetch(`/api/stickers/library/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.ok) setLibrary((l) => (l ?? []).filter((x) => x.media_id !== id));
  };
  const addToLibrary = async (items: PickedItem[]) => {
    for (const item of items) {
      const uploaded = await prepareAndUpload(item);
      const res = await fetch('/api/stickers/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ media_id: uploaded.id }) });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || 'Could not add it.');
    }
    setAddFiles(null);
    void loadLibrary();
  };

  // Delete account
  const [showDelete, setShowDelete] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const username = currentUser.profile.username;
  const deleteAccount = async () => {
    if (confirmText !== username) { setDeleteError(`Type "${username}" to confirm`); return; }
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch('/api/me', { method: 'DELETE' });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || 'Failed to delete account');
      onAccountDeleted();
    } catch (e) {
      setDeleteError((e as Error).message);
      setDeleting(false);
    }
  };

  const bgName = bg.kind === 'image' ? 'Your picture' : CHAT_BACKGROUNDS.find((p) => p.id === bg.id)?.name;

  return (
    <div className="w-full max-w-content mx-auto min-h-screen bg-[var(--bg2,#F8F9FC)] pb-24 tablet:pb-8">
      <header className="sticky top-0 z-40 bg-[var(--bg,#fff)] h-[48px] border-b border-[var(--line,#E8EBF0)] flex items-center px-2">
        <button type="button" onClick={onBack} aria-label="Back" title="Back" className="w-[44px] h-[44px] flex items-center justify-center text-[var(--text,#17233A)] cursor-pointer bg-transparent border-0"><ArrowLeft className="w-5 h-5 stroke-[1.7]" aria-hidden="true" /></button>
        <h1 className="m-0 text-[18px] font-semibold text-[var(--text,#17233A)]">Settings</h1>
      </header>

      <div className="p-3 space-y-3">
        {message && <div role={message.type === 'error' ? 'alert' : 'status'} className={`rise-in p-2.5 rounded-[8px] border text-[13px] ${message.type === 'error' ? 'border-[var(--danger,#B23A40)] text-[var(--danger,#B23A40)]' : 'border-[var(--line,#E8EBF0)] text-[var(--text,#17233A)]'} bg-[var(--bg,#fff)]`}>{message.text}</div>}

        <div className="rise-in border border-[var(--line,#E8EBF0)] rounded-[12px] bg-[var(--bg,#fff)] p-4 flex items-center gap-3" style={{ '--i': 0 } as React.CSSProperties}>
          <Avatar mediaId={currentUser.profile.avatar_media_id} displayName={currentUser.profile.display_name} username={username} size={56} />
          <div className="min-w-0 flex-1">
            <b className="block truncate text-[16px] text-[var(--text,#17233A)]">{currentUser.profile.display_name || username}</b>
            <span className="block truncate text-[13px] text-[var(--muted,#5B6577)]">@{username}</span>
          </div>
          {onEditProfile && <button type="button" onClick={onEditProfile} className={ghost}>Edit profile</button>}
        </div>
        <div role="group" aria-labelledby="grp-privacy" className="rise-in space-y-3" style={{ '--i': 1 } as React.CSSProperties}>
          <p id="grp-privacy" className="m-0 px-1 pt-2 text-[12px] font-semibold uppercase tracking-wide text-[var(--muted,#5B6577)]">Privacy and safety</p>
        <section aria-labelledby="set-dm" className={card}>
          <h2 id="set-dm" className={h2}>Who can message you</h2>
          <label htmlFor="dm-policy-select" className="sr-only">Who can message you</label>
          <select id="dm-policy-select" value={dmPolicy} onChange={(e) => void saveDm(e.target.value)} className="w-full min-h-[44px] bg-[var(--bg,#fff)] border border-[var(--line,#E8EBF0)] rounded-[8px] px-3 text-[15px] text-[var(--text,#17233A)] cursor-pointer">
            <option value="everyone">Everyone</option>
            <option value="following">People I follow</option>
            <option value="none">No one</option>
          </select>
        </section>
        <section aria-labelledby="set-blocked" className={card}>
          <h2 id="set-blocked" className={h2}>Blocked people</h2>
          {blocked.length === 0 ? <p className="m-0 text-[13px] text-[var(--muted,#5B6577)]">No blocked people</p> : (
            <ul className="list-none m-0 p-0 divide-y divide-[var(--line,#E8EBF0)]">
              {blocked.map((b) => (
                <li key={b.user_id} className="flex items-center justify-between py-2">
                  <span><b className="block text-[14px] text-[var(--text,#17233A)]">{b.display_name}</b><span className="block text-[12px] text-[var(--muted,#5B6577)]">@{b.username}</span></span>
                  <button type="button" onClick={() => void unblock(b.user_id)} aria-label={`Unblock @${b.username}`} className={ghost}>Unblock</button>
                </li>
              ))}
            </ul>
          )}
        </section>
        </div>
        <div role="group" aria-labelledby="grp-look" className="rise-in space-y-3" style={{ '--i': 2 } as React.CSSProperties}>
          <p id="grp-look" className="m-0 px-1 pt-2 text-[12px] font-semibold uppercase tracking-wide text-[var(--muted,#5B6577)]">Appearance</p>
        <section aria-labelledby="set-bg" className={card}>
          <h2 id="set-bg" className={h2}>Chat background</h2>
          <p className="m-0 text-[13px] text-[var(--muted,#5B6577)]">Used in all your chats. It stays on this phone and is never uploaded.</p>
          <div className="rounded-[12px] overflow-hidden border border-[var(--line,#E8EBF0)]" data-testid="bg-preview">
            <ChatBackground choice={bg}><PreviewBubbles /></ChatBackground>
          </div>
          <div role="radiogroup" aria-label="Background" className="flex flex-wrap gap-2">
            {CHAT_BACKGROUNDS.map((p) => {
              const on = bg.kind === 'preset' && bg.id === p.id;
              return (
                <button key={p.id} type="button" role="radio" aria-checked={on} onClick={() => void choosePreset(p.id)} className={`min-h-[44px] px-3.5 rounded-full border text-[13px] font-semibold cursor-pointer ${on ? 'bg-[var(--blue,#244C8A)] text-[var(--bg,#fff)] border-[var(--blue,#244C8A)]' : 'bg-[var(--bg,#fff)] text-[var(--text,#17233A)] border-[var(--line,#E8EBF0)]'}`}>{p.name}</button>
              );
            })}
            <button type="button" role="radio" aria-checked={bg.kind === 'image'} disabled={bgBusy} onClick={() => bgFile.current?.click()} className={`min-h-[44px] px-3.5 rounded-full border text-[13px] font-semibold cursor-pointer disabled:opacity-40 ${bg.kind === 'image' ? 'bg-[var(--blue,#244C8A)] text-[var(--bg,#fff)] border-[var(--blue,#244C8A)]' : 'bg-[var(--bg,#fff)] text-[var(--text,#17233A)] border-[var(--line,#E8EBF0)]'}`}>
              {bgBusy ? 'Preparing...' : 'Your picture'}
            </button>
          </div>
          <input ref={bgFile} type="file" tabIndex={-1} accept="image/jpeg,image/png,image/webp" aria-label="Choose a picture for the chat background" className="hidden" data-testid="bg-input"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importImage(f); }} />
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-[var(--muted,#5B6577)]">Current: {bgName}</span>
            <button type="button" onClick={() => void resetBg()} className={ghost}>Reset</button>
          </div>
        </section>
        </div>
        <div role="group" aria-labelledby="grp-content" className="rise-in space-y-3" style={{ '--i': 3 } as React.CSSProperties}>
          <p id="grp-content" className="m-0 px-1 pt-2 text-[12px] font-semibold uppercase tracking-wide text-[var(--muted,#5B6577)]">Your content</p>
        <section aria-labelledby="set-interests" className={card}>
          <div className="flex items-center justify-between">
            <h2 id="set-interests" className={h2}>Interests</h2>
            {interests.length > 0 && <button type="button" onClick={() => void resetInterests()} className={ghost}>Reset</button>}
          </div>
          {interests.length === 0 ? <p className="m-0 text-[13px] text-[var(--muted,#5B6577)]">Nothing here yet. Interests build up from what you like.</p> : (
            <ul className="list-none m-0 p-0 flex flex-wrap gap-2">
              {interests.map((i) => (
                <li key={i.topic_id} className="text-[13px] text-[var(--text,#17233A)] bg-[var(--bg2,#F8F9FC)] border border-[var(--line,#E8EBF0)] pl-2.5 rounded-[8px] flex items-center">
                  <span>#{i.slug}</span>
                  <button type="button" onClick={() => void removeInterest(i.topic_id)} aria-label={`Remove #${i.slug}`} className="min-h-[44px] min-w-[44px] flex items-center justify-center bg-transparent border-0 text-[var(--muted,#5B6577)] cursor-pointer"><X className="w-3.5 h-3.5" aria-hidden="true" /></button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="set-stickers" className={card}>
          <h2 id="set-stickers" className={h2}>My stickers &amp; GIFs</h2>
          {library === null ? <p className="m-0 text-[13px] text-[var(--muted,#5B6577)]" aria-busy="true">Loading...</p> : library.length === 0 ? (
            <p className="m-0 text-[13px] text-[var(--muted,#5B6577)]">No stickers yet. Add a picture or a short clip from your phone.</p>
          ) : (
            <ul className="grid grid-cols-4 gap-2 list-none m-0 p-0">
              {library.map((s) => (
                <li key={s.media_id} className="relative">
                  <div className="aspect-square border border-[var(--line,#E8EBF0)] rounded-[8px] p-1 bg-[var(--bg,#fff)]"><LibraryImage mediaId={s.media_id} kind={s.kind} /></div>
                  <button type="button" onClick={() => void removeFromLibrary(s.media_id)} aria-label={`Remove ${s.kind}`} className="w-full min-h-[44px] mt-1 rounded-[8px] border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[12px] font-semibold text-[var(--danger,#B23A40)] cursor-pointer">Remove</button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" onClick={() => libFile.current?.click()} className={ghost}>Add from phone</button>
          <input ref={libFile} type="file" tabIndex={-1} accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm" multiple aria-label="Choose pictures to add" className="hidden" data-testid="settings-library-input"
            onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; if (f.length) setAddFiles(f); }} />
        </section>
        </div>
        <div role="group" aria-labelledby="grp-account" className="rise-in space-y-3" style={{ '--i': 4 } as React.CSSProperties}>
          <p id="grp-account" className="m-0 px-1 pt-2 text-[12px] font-semibold uppercase tracking-wide text-[var(--muted,#5B6577)]">Account</p>
        <section aria-labelledby="set-account" className={card}>
          <h2 id="set-account" className={h2}>Account</h2>
          <button type="button" onClick={() => void onLogout()} className={`${ghost} w-full`}>Sign out</button>
          <button type="button" onClick={() => setShowDelete(true)} className="w-full min-h-[44px] bg-transparent border-0 text-[14px] font-semibold text-[var(--danger,#B23A40)] cursor-pointer">Delete account</button>
        </section>
        </div>
      </div>

      {addFiles && <MediaPreview files={addFiles} mode="library" onCancel={() => setAddFiles(null)} onConfirm={addToLibrary} />}

      {showDelete && (
        <BottomSheet
          label="Delete account"
          onClose={() => { setShowDelete(false); setConfirmText(''); setDeleteError(null); }}
          className="px-5 pb-5"
        >
          {({ requestClose }) => (
            <div className="space-y-3 pt-1">
              <h2 className="m-0 text-[16px] font-semibold text-[var(--danger,#B23A40)]">Delete account</h2>
              <p className="m-0 text-[13px] text-[var(--muted,#5B6577)]">This permanently deletes your account, posts, comments and media. To confirm, type your username <strong>@{username}</strong>.</p>
              {deleteError && <div role="alert" className="text-[13px] text-[var(--danger,#B23A40)]">{deleteError}</div>}
              <input type="text" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} aria-label="Confirm username to delete account" autoComplete="off" className="w-full min-h-[44px] bg-[var(--bg2,#F8F9FC)] border border-[var(--line,#E8EBF0)] rounded-[8px] px-3 text-[15px] text-[var(--text,#17233A)]" />
              <div className="flex gap-2">
                <button type="button" onClick={requestClose} disabled={deleting} className={`${ghost} flex-1`}>Cancel</button>
                <button type="button" onClick={() => void deleteAccount()} disabled={deleting || confirmText !== username} className="flex-1 min-h-[44px] rounded-[8px] bg-[var(--danger,#B23A40)] text-[var(--bg,#fff)] text-[13px] font-semibold cursor-pointer border-0 disabled:opacity-40">{deleting ? 'Deleting...' : 'Delete permanently'}</button>
              </div>
            </div>
          )}
        </BottomSheet>
      )}

    </div>
  );
};
