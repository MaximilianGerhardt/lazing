/**
 * Server helper for Nav-Fix D (2026-06-02) — resolve a real workspace's
 * owning organization id so a server page can render <OrgBootstrap> and sync
 * the client org context BEFORE the OrgSwitcher normalization runs.
 *
 * Server-only (imports getDb). Never throws — a null result means "render no
 * OrgBootstrap", which degrades to the pre-fix behaviour.
 */

import { getDb } from '@/db/client';

/** ENV kill-switch. Default ON; `LAZYOS_WORKSPACE_ORG_BOOTSTRAP=0` reverts the org-sync. */
export function orgBootstrapEnabled(): boolean {
  return process.env.LAZYOS_WORKSPACE_ORG_BOOTSTRAP !== '0';
}

/**
 * Fail-soft owning-org lookup for a REAL workspace id. Returns null for:
 *   - virtual ids (`__root__`, `__all__`, `__org_root__:*` — any `__`-prefix),
 *   - malformed ids,
 *   - unknown workspaces,
 *   - any DB error.
 * Virtual ids carry no single org row (the org-switch path already set the
 * context), so skipping them is correct.
 */
export function resolveWorkspaceOrgId(workspaceId: string): string | null {
  if (!workspaceId || workspaceId.startsWith('__')) return null;
  if (!/^[a-z0-9_(][a-z0-9_()-]{0,63}$/i.test(workspaceId)) return null;
  try {
    const row = getDb()
      .$raw.prepare('SELECT organization_id FROM workspaces WHERE id = ?')
      .get(workspaceId) as { organization_id: string | null } | undefined;
    return row?.organization_id ?? null;
  } catch {
    return null;
  }
}
