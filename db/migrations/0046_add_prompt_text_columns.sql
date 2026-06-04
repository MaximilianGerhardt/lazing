-- Migration 0046 — optional prompt-text storage for drift verification
-- (Pattern 5 wave 3, 2026-05-01)
--
-- Background:
-- 0044 stores only prompt_hash (SHA-256 of system+user). That only allows
-- determining reproduction identity — no re-spawn possible, because the
-- original prompt is not persisted.
--
-- This migration adds two OPTIONAL plaintext columns:
--   - system_prompt_text
--   - user_prompt_text
--
-- Both are NULLable. They are written only when ENV
-- LAZYOS_AUDIT_FULL_PROMPTS=1 is set (storage-saving default off).
--
-- Used by:
--   lib/audit/reasoning-verify.ts → verifyOne() re-spawns with an identical
--   system+user prompt and compares the output via cosine similarity against
--   the original claim_text.
--
-- If both NULL → verifyOne returns {status:'ok', note:'no-prompt-text-stored'}.
-- That is a deliberate skip, not an error — verifying is opt-in.

ALTER TABLE reasoning_audit ADD COLUMN system_prompt_text TEXT;
ALTER TABLE reasoning_audit ADD COLUMN user_prompt_text TEXT;
