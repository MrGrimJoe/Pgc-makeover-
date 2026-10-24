# App structure (page map)

This is the contract for where each feature lives. Navigation: bottom tabs Home, Search, New post, Profile; Messages is the top-right icon.

| Page | What lives there |
|---|---|
| Home | A dismissible install banner when installing is possible (see README, "Install as an app"). Feed (For you, Following). Post cards: avatar (picture or initial), username, class, expiry chip, text, photos, poll, a sticker/GIF if the post has one. Like, comment, report. |
| Search | Search box, My class / Campus / Everyone tabs, trending, suggested people. |
| New post | Text, plus exactly one of: photos (up to 4), a poll, or one sticker/GIF. Expiry note. |
| Messages list | Conversations; previews show "Photo", "Sticker", "GIF" for non-text messages. |
| Chat | Header (avatar, name, menu with Block and Report), background, messages, typing bar, picker panel, media viewer. |
| Profile | Wallpaper header, stats, posts grid. Own profile: Edit profile, Settings (gear), Sign out. Others: Follow, Message, menu (Block, Report). |
| Edit profile | Photo, display name, real name, bio, campus and class, profile wallpaper (presets or the person's own image), accent, text style. Identity and look only. |
| Settings (new) | Chat background (all chats), who can message you, blocked people, interests, my stickers & GIFs (manage), sign out, delete account. Account group also has Install and share (install steps for this device, Share link, QR code). |

## Rules

- The sticker/GIF library is managed from the sticker picker ("Manage") and from Settings.
- The chat background lives in Settings only. A per-chat override is a later feature and is not built.
- DM policy, blocked people, interests, sign out and delete account move from Edit profile to Settings.
- Polls exist only on posts, not in chat.
- Campus names ship inside the app (`shared/campuses.ts`), not in the database.
- Out of scope for now: drawing and text editing on media, third-party GIF search.

## Status

Built so far: the bundled campus list and picker; media foundation (kinds, caps, quotas, library, forwarding); Settings page; the chat (conversation list with profile pictures and previews, chat header with Block and Report, background, composer, attach sheet, preview, viewer).

Where the code lives:
- `src/pages/MessagesPage.tsx` (small shell), `src/components/chat/` (`ConversationList`, `ChatScreen`, `Composer`, `MessageBubble`, `AttachSheet`, `MediaPreview`, `MediaViewer`, `ForwardPicker`, `PickerPanel`, `ChatBackground`, `AnimatedMedia`), `src/lib/keyboard.ts` (`useKeyboardInset`).
- `src/pages/SettingsPage.tsx`. Settings is reached from the gear on your own profile; it is not a bottom tab (the Profile tab stays highlighted).

Out of scope for now: drawing and text editing on media (the preview offers rotate, crop to a shape, and "Send as" only), third-party GIF search, per-chat backgrounds.

Stickers and GIFs (bundled packs with permanent numbering, uploaded ones, keys in chats, posts and comments) are built; the bundled pack is a **placeholder** until the real art is added (README, "Stickers and GIFs"). The profile background from your own image and polls (Phase 5) are built. See `docs/STATUS.md`.
