-- Phase IA consolidation 2026-04-29 final: type correction for example-app + example-tool.
-- example-app + example-tool are own projects (product), not client/tool.

UPDATE organizations SET type = 'product'
  WHERE id IN ('example-app-org', 'example-tool')
  AND type IN ('client', 'tool');
