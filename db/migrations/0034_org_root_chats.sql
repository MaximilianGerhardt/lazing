-- Phase IA.4 — org-root chat per org as a virtual workspace
-- (`__org_root__:<orgId>`).
--
-- Three steps (all idempotent):
--   1. Create a root pseudo-workspace per existing org.
--   2. Today's global `__root__` workspace migrates to
--      `__org_root__:<defaultOrgId>` — we leave `__root__` as a
--      backwards-compat row so existing events do not
--      break, but mark it as archived=0 with a hint label.
--   3. Triggers are NOT used — a new org creation must create the
--      root WS itself in `lib/orgs/repo.ts.createOrg(...)`.

-- 1. Create a root WS per org, if not present.
INSERT OR IGNORE INTO workspaces (
  id, label, accent, path, sensitivity, archived, description, organization_id, created_at, updated_at
)
SELECT
  '__org_root__:' || o.id,
  o.name || ' · Root',
  COALESCE('palette-' || o.palette_index, 'a-now'),
  '',
  'normal',
  0,
  'Org-Root-Chat — alles was hier passiert ist scoped auf die Org-Rechte-Ebene.',
  o.id,
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  CAST(strftime('%s','now') AS INTEGER) * 1000
FROM organizations o
WHERE o.archived = 0;

-- 2. Mark today's __root__ workspace — we leave it as a
--    compat row but no longer show it in the switcher.
--    Only if __root__ exists.
UPDATE workspaces
SET label = 'Legacy Root (deprecated)',
    archived = 1
WHERE id = '__root__'
  AND archived = 0;
