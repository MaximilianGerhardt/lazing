-- 0132_user_password — optional email + password login
-- 2026-06-05
--
-- Adds a nullable password_hash to users so the OSS instance can offer classic
-- email+password user management ALONGSIDE the existing magic-link flow. Users
-- without a password keep logging in via magic-link; setting a password is opt-in.
-- Idempotent: the migration runner skips "duplicate column name" on re-run.

ALTER TABLE users ADD COLUMN password_hash TEXT;
