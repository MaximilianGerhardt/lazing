-- Migration 0043 — User-2FA / TOTP (Sprint 3, 2026-04-30)
--
-- Extends the users table with TOTP fields + a new user_2fa_recovery table.
-- The TOTP secret is encrypted-at-rest with the existing vault pattern
-- (libsodium, see lib/security/vault.ts) — we store the
-- ciphertext here, not the plaintext secret.
--
-- Recovery codes: 10 single-use codes (BIP-39 word list or hex), hashed
-- with Argon2id on insert. The user can lose the TOTP setup and re-authenticate
-- with a recovery code.
--
-- 2FA requirement model: opt-in per user. Magic-link login asks for 2FA
-- when `users.totp_enabled_at IS NOT NULL`. Master-code login is
-- FORCIBLY redirected to the 2FA step when 2FA is active for the user.
--
-- Idempotent: ALTER TABLE ADD COLUMN with the duplicate fallback in db/client.ts.

ALTER TABLE users ADD COLUMN totp_secret_ciphertext TEXT;
ALTER TABLE users ADD COLUMN totp_enabled_at INTEGER;
ALTER TABLE users ADD COLUMN totp_last_used_at INTEGER;
-- Counter against replay attacks: user inputs must increase monotonically.
ALTER TABLE users ADD COLUMN totp_last_counter INTEGER;

CREATE TABLE IF NOT EXISTS user_2fa_recovery (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- argon2id hash, no plaintext.
  code_hash     TEXT NOT NULL,
  used_at       INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_2fa_recovery_user ON user_2fa_recovery (user_id);
CREATE INDEX IF NOT EXISTS idx_user_2fa_recovery_unused ON user_2fa_recovery (user_id, used_at);

-- 2FA sessions step 2: after magic-link verify the user waits for TOTP input.
-- We issue a pre-session token with a short TTL (5 min).
CREATE TABLE IF NOT EXISTS auth_2fa_pending (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  step1_method  TEXT NOT NULL,            -- 'magic-link' | 'master-code'
  expires_at    INTEGER NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_2fa_pending_user ON auth_2fa_pending (user_id);
CREATE INDEX IF NOT EXISTS idx_auth_2fa_pending_expiry ON auth_2fa_pending (expires_at);
