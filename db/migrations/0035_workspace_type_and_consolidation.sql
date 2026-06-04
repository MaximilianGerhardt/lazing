-- Phase IA consolidation (2026-04-29). Clarification:
-- "demo-fitness, example-product-b, Demo PV are client projects of
-- Example Company". Previously each client project + each own project
-- was its own top-level org. Target: EVERYTHING belongs under
-- Example Company (or Owner Private) as a workspace with a type
-- annotation (company / product / client / tool / private).
--
-- Steps (idempotent):
--   1. Add the workspaces.workspace_type column.
--   2. Move all own + client workspaces to example-company + set the type.
--   3. Private stays with Owner Private. All other top-level orgs are
--      archived (example-app, example-tool, example-workspace-a,
--      example-product-c, lazyos-product, Demo PV, demo-fitness,
--      example-product-b).
--   4. Archive the __org_root__:<id> of the archived orgs as well.

-- 1. workspace_type column
ALTER TABLE workspaces ADD COLUMN workspace_type TEXT NOT NULL DEFAULT 'default';

-- 2a. Own projects -> Example Company, type = product (or company for the holding)
UPDATE workspaces SET organization_id = 'example-company', workspace_type = 'company'
  WHERE id = 'example-company';
UPDATE workspaces SET organization_id = 'example-company', workspace_type = 'product'
  WHERE id IN (
    'lazyos', 'example-tool', 'example-product-c-pwa',
    'example-workspace-a', 'example-workspace-a-web',
    'example-app-ios', 'example-app-web'
  );

-- 2b. Client projects -> Example Company, type = client
UPDATE workspaces SET organization_id = 'example-company', workspace_type = 'client'
  WHERE id IN ('demo-client', 'demo-fitness');

-- 2c. Private stays with Owner Private, type = private
UPDATE workspaces SET organization_id = 'owner-private', workspace_type = 'private'
  WHERE id IN ('private', 'demo-private');

-- 3. Archive all top-level orgs except Example Company + Owner Private
--    (example-app, example-tool, example-workspace-a, example-product-c,
--    lazyos-product, Demo PV, demo-fitness, example-product-b). Memberships
--    stay intact — do not destroy the audit trail.
UPDATE organizations SET archived = 1
  WHERE id IN (
    'example-app-org', 'example-tool', 'demo-pv',
    'demo-fitness', 'example-product-c', 'lazyos-product',
    'example-product-b', 'example-workspace-a-org'
  )
  AND archived = 0;

-- 4. Archive the org roots of the archived orgs too — the scoped
--    chat is pointless once the org is gone.
UPDATE workspaces SET archived = 1
  WHERE id IN (
    '__org_root__:example-app-org',
    '__org_root__:example-tool',
    '__org_root__:demo-pv',
    '__org_root__:demo-fitness',
    '__org_root__:example-product-c',
    '__org_root__:lazyos-product',
    '__org_root__:example-product-b',
    '__org_root__:example-workspace-a-org'
  )
  AND archived = 0;

-- Note: user/workspace memberships are NOT touched. Whoever was a member
-- of an archived org stays formally a member — they just cannot "use" it
-- anymore (the org filter ignores archived orgs).
-- Workspace memberships survive the org switch transparently.
