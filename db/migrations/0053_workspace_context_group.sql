-- Migration 0053 — Workspace-Context-Group (2026-05-03)
--
-- Context (user finding 2026-05-03):
--   "if we also have things like energy-home grouped by context,
--    2 different workspaces must also be considered behind
--    creation or segmentation within an organization"
--
-- Example: Demo PV has two workspaces — CRM (backend tooling) and
-- Web (marketing site). Today they land under two different
-- workspace_type values (client + product), which is semantically wrong:
-- both belong to the same sub-org but are functionally separate. With
-- `context_group` the user can list them together under "Demo PV" with
-- group headers "CRM" and "Web", without misusing workspace_type.
--
-- Behavior:
--   - NULL = "no context" → the workspace lands with other WS under "General"
--   - The same string (case-sensitive, freely choosable) groups multiple WS
--     of an org under a sub-header in WorkspaceSwitcher / /orgs/[id].
--   - The UI shows a sub-header only when ≥2 distinct group values exist in the
--     org — otherwise visual noise.
--
-- Idempotency: ALTER TABLE ADD COLUMN — the duplicate-column fallback in
-- db/client.ts takes effect on the second run.

ALTER TABLE workspaces ADD COLUMN context_group TEXT;

CREATE INDEX IF NOT EXISTS idx_workspaces_context_group
  ON workspaces(organization_id, context_group)
  WHERE context_group IS NOT NULL;
