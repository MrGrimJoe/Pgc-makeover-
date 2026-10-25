-- 015_academic.sql: academic details as separate fields, and what happens as a student moves up or graduates.
--
-- Kept in user_private (never returned to other people). Class/year stays in profiles.class_id.
-- academic_status   'current' or 'graduated'. A graduate keeps the account and everything they posted; nothing is deleted.
-- academic_confirmed_at  when the student last confirmed or updated these details; the renewal prompt reads it.
-- verification_detail    what the sign-up screen reported about the printed card text (client-reported, not proof).
ALTER TABLE user_private ADD COLUMN program TEXT;
ALTER TABLE user_private ADD COLUMN session TEXT;
ALTER TABLE user_private ADD COLUMN section TEXT;
ALTER TABLE user_private ADD COLUMN academic_status TEXT NOT NULL DEFAULT 'current' CHECK (academic_status IN ('current', 'graduated'));
ALTER TABLE user_private ADD COLUMN academic_confirmed_at TEXT;
ALTER TABLE user_private ADD COLUMN graduated_at TEXT;
ALTER TABLE user_private ADD COLUMN verification_detail TEXT CHECK (verification_detail IS NULL OR length(verification_detail) <= 300);
