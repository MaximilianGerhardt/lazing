-- Phase IA consolidation re-fix (2026-04-29). Clarification:
-- "Demo PV is a client of Example Company as a CRM and a website.
--  example-app/example-workspace-a/example-tool/example-product-c/lazyos
--  are own projects with their own sub-components."
--
-- Reactivate the sub-org structure:
--   Example Company (top-level company)
--     ├── Sub-org example-app   (product)  -> example-app-ios, example-app-web
--     ├── Sub-org example-tool  (product)  -> example-tool
--     ├── Sub-org example-product-c (product) -> example-product-c-pwa
--     ├── Sub-org lazyos        (product)  -> lazyos
--     ├── Sub-org example-workspace-a (product) -> example-workspace-a(-web)
--     ├── Sub-org Demo PV       (client)   -> demo-client + demo-pv-web (NEW)
--     ├── Sub-org demo-fitness  (client)   -> demo-fitness
--     └── Sub-org example-product-b (client) -> (no workspaces yet)
--   Owner Private (top-level private) -> private, demo-private

-- 1. Un-archive sub-orgs + set parent_id
UPDATE organizations SET archived = 0, parent_id = 'example-company'
  WHERE id IN (
    'example-app-org', 'example-tool', 'demo-pv',
    'demo-fitness', 'example-product-c', 'lazyos-product',
    'example-product-b', 'example-workspace-a-org'
  );

-- 2. Workspaces back to their sub-orgs
UPDATE workspaces SET organization_id = 'example-app-org'
  WHERE id IN ('example-app-ios', 'example-app-web');
UPDATE workspaces SET organization_id = 'example-tool'
  WHERE id = 'example-tool';
UPDATE workspaces SET organization_id = 'example-product-c'
  WHERE id = 'example-product-c-pwa';
UPDATE workspaces SET organization_id = 'lazyos-product'
  WHERE id = 'lazyos';
UPDATE workspaces SET organization_id = 'example-workspace-a-org'
  WHERE id IN ('example-workspace-a', 'example-workspace-a-web');
UPDATE workspaces SET organization_id = 'demo-pv'
  WHERE id = 'demo-client';
UPDATE workspaces SET organization_id = 'demo-fitness'
  WHERE id = 'demo-fitness';

-- 3. Relabel workspace `demo-client` to "Demo PV (CRM)"
UPDATE workspaces SET label = 'Demo PV (CRM)'
  WHERE id = 'demo-client' AND label = 'Demo PV';

-- 4. NEW: Demo PV (Web) as the second workspace of this sub-org
INSERT OR IGNORE INTO workspaces (
  id, label, accent, path, sensitivity, archived,
  description, organization_id, workspace_type, created_at, updated_at
) VALUES (
  'demo-pv-web',
  'Demo PV (Web)',
  'north',
  '',
  'normal',
  0,
  'Website of the client Demo PV.',
  'demo-pv',
  'client',
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  CAST(strftime('%s','now') AS INTEGER) * 1000
);

-- 5. Un-archive the org roots of the un-archived sub-orgs too
UPDATE workspaces SET archived = 0
  WHERE id IN (
    '__org_root__:example-app-org',
    '__org_root__:example-tool',
    '__org_root__:demo-pv',
    '__org_root__:demo-fitness',
    '__org_root__:example-product-c',
    '__org_root__:lazyos-product',
    '__org_root__:example-product-b',
    '__org_root__:example-workspace-a-org'
  );
