# App structure (page map)

This is the contract for where each feature lives. Navigation: bottom tabs Home, Search, New post, Profile; Messages is the top-right icon.

| Page | What lives there |
|---|---|
| Home | Feed (For you, Following). Post cards: avatar (picture or initial), username, class, expiry chip, text, photos, poll, a sticker/GIF if the post has one. Like, comment, report. |
| Search | Search box, My class / Campus / Everyone tabs, trending, suggested people. |
| New post | Text, plus exactly one of: photos (up to 4), a poll, or one sticker/GIF. Expiry note. |
| Messages list | Conversations; previews show "Photo", "Sticker", "GIF" for non-text messages. |
| Chat | Header (avatar, name, menu with Block and Report), background, messages, typing bar, picker panel, media viewer. |
| Profile | Wallpaper header, stats, posts grid. Own profile: Edit profile, Settings (gear), Sign out. Others: Follow, Message, menu (Block, Report). |
| Edit profile | Photo, display name, real name, bio, campus and class, profile wallpaper (presets or the person's own image), accent, text style. Identity and look only. |
| Settings (new) | Chat background (all chats), who can message you, blocked people, interests, my stickers & GIFs (manage), sign out, delete account. |

## Rules

- The sticker/GIF library is managed from the sticker picker ("Manage") and from Settings.
- The chat background lives in Settings only. A per-chat override is a later feature and is not built.
- DM policy, blocked people, interests, sign out and delete account move from Edit profile to Settings.
- Polls exist only on posts, not in chat.
- Campus names ship inside the app (`shared/campuses.ts`), not in the database.
- Out of scope for now: drawing and text editing on media, third-party GIF search.

## Status

Built so far: the bundled campus list and the Edit profile campus picker. Everything else on this page is planned; see `docs/STATUS.md`.
