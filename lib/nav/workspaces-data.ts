/**
 * Static fallback list of workspaces.
 *
 * Used when `/api/workspaces` is unavailable or returns empty. The order
 * here is also the order shown in the switcher — most-used first.
 */

import type { Workspace } from './types';

export const DEFAULT_WORKSPACE_ID = 'lazyos';

export const ROOT_WORKSPACE_ID = '__root__';

/**
 * Root workspace — cross-workspace mode for Max (handoff point 2).
 * In this mode the agent has permission to operate in EVERY workspace:
 * creating tickets, triggering routines, starting new projects, meta-ops.
 */
export const ROOT_WORKSPACE: Workspace = {
  id: ROOT_WORKSPACE_ID,
  label: 'Root · Cross-Workspace',
  accent: 'own',
  sensitivity: 'low',
  meta: 'Alle Projekte — neue anlegen, cross-actions',
};

export const ALL_WORKSPACE: Workspace = {
  id: '__all__',
  label: 'Alle (Cross-Workspace)',
  accent: 'north',
  sensitivity: 'low',
  meta: 'Alle Projekte kombiniert',
};

export function isRootWorkspace(id: string | null | undefined): boolean {
  return id === ROOT_WORKSPACE_ID;
}

/**
 * Virtual / aggregating workspace IDs that have NO real, single
 * workspace membership:
 *   - `__root__`            cross-workspace mode (all projects)
 *   - `__all__`             combined view
 *   - `__org_root__:<org>`  org-root aggregation (multiple workspaces of one org)
 *
 * Member-/scope-gated per-workspace endpoints (e.g.
 * `GET /api/state/projection/[workspaceId]`, `GET /api/permission/[…]/mode`)
 * inevitably respond with 403 for these IDs — there is no
 * `hasRealWorkspaceMembership` row for an aggregation. Clients MUST therefore
 * skip the fetch instead of producing 403s on every poll tick
 * (console spam, wasted network). Same pattern as
 * `AllAccessToggle` skipping the `__root__/mode` GET.
 */
export function isVirtualWorkspaceId(id: string | null | undefined): boolean {
  if (!id) return false;
  return id === ROOT_WORKSPACE_ID || id === '__all__' || id.startsWith('__org_root__:');
}

/**
 * Static fallback — explicit empty.
 *
 * 2026-04-30: user inject „Beispielprojekte in der Navigation statt die echten".
 * Previously 11 hardcoded workspaces lived here as a fallback on API failure. Risk:
 * if the auth cookie is missing or /api/workspaces responds empty during hydration,
 * the user saw demo workspaces instead of their real 24 from the DB.
 *
 * Now explicitly empty — on API failure the nav renders empty (a clear signal:
 * "auth broken" instead of a falsified "wrong workspaces visible"). The real bug
 * fix would be the auth race in the useWorkspaces hook, but an empty fallback is safer
 * than 11 wrong entries.
 */
export const STATIC_WORKSPACES: readonly Workspace[] = [] as const;

if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
  // dev-only hint in case someone relies on demo data
  // (build-time warning — runtime `useWorkspaces` shows its own toast on API failure)
}

export function findWorkspaceById(
  list: readonly Workspace[],
  id: string,
): Workspace | undefined {
  return list.find((w) => w.id === id);
}
