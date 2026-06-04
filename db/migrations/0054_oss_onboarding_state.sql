-- Migration 0054 — OSS-Onboarding-State (2026-05-23)
--
-- Context (user finding 2026-05-23):
--   "it would be important here that there is an OSS onboarding, like e.g. at
--    lazing there was one... So it currently seems to me more like the mockup
--    mode"
--
-- Separation from the existing `onboarding_state` (Phase AU.3) is intentional:
--   - `onboarding_state`        — Welcome/Profile/Org/Workspace/Claude-MAX
--     (data-model explanation for a new cloud user)
--   - `oss_onboarding_state`    — engine-detect/workspace-root/GitHub/push
--     (OSS server initial setup after `git clone`)
--
-- Behavior:
--   - NULL = the user never saw the OSS wizard → on next login redirect
--     to /oss-onboarding (if the server has `LAZYOS_OSS_MODE=true`).
--   - The JSON blob contains currentStep + completedSteps + skippedSteps + data.
--   - `oss_onboarding_completed_at` is separate as a type-safe timestamp field
--     for index/query, instead of querying a JSON path.
--
-- Idempotent: ALTER TABLE … ADD COLUMN is idempotent in SQLite as long as
-- you check for existence. The Drizzle migrator runs the file a single
-- time.

ALTER TABLE users ADD COLUMN oss_onboarding_state TEXT;
ALTER TABLE users ADD COLUMN oss_onboarding_completed_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_users_oss_onboarding_completed
  ON users (oss_onboarding_completed_at);
