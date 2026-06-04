-- 0129_agent_profiles.sql — „Mitarbeiter"-Profile (Agent-Profiles, 2026-06-03)
-- Recherche: docs/research/2026-06-03_skills-mcp-skillcreator-research.md §4.
-- Idempotent. N9: workspace_id/org_id = ManifestCoord. Soft-Delete via archived_at.

CREATE TABLE IF NOT EXISTS agent_profiles (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,            -- N1 verbatim
  description      TEXT,
  role             TEXT NOT NULL,            -- SubagentRole (validiert)
  skills_json      TEXT NOT NULL DEFAULT '[]',
  mcp_servers_json TEXT NOT NULL DEFAULT '[]',
  sops_json        TEXT NOT NULL DEFAULT '[]',
  apis_json        TEXT NOT NULL DEFAULT '[]',
  workspace_id     TEXT,                     -- ManifestCoord (NULL = personal/global)
  org_id           TEXT,
  created_by       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  archived_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_profiles_workspace ON agent_profiles (workspace_id);
CREATE INDEX IF NOT EXISTS idx_agent_profiles_org       ON agent_profiles (org_id);
CREATE INDEX IF NOT EXISTS idx_agent_profiles_active    ON agent_profiles (archived_at);
