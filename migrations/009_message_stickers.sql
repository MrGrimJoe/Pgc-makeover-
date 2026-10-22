-- 009_message_stickers.sql: sticker/GIF key on messages (needs the messaging tables from 004).
ALTER TABLE messages ADD COLUMN sticker_key TEXT;
