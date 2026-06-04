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
 * Root-Workspace — Cross-Workspace-Modus für Max (Handoff-Punkt 2).
 * Agent hat in diesem Modus Permission, in JEDEM Workspace zu operieren:
 * Tickets anlegen, Routinen triggern, neue Projekte starten, Meta-Ops.
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
 * Virtuelle / aggregierende Workspace-IDs, die KEINE echte, einzelne
 * Workspace-Membership besitzen:
 *   - `__root__`            Cross-Workspace-Modus (alle Projekte)
 *   - `__all__`             kombinierte Sicht
 *   - `__org_root__:<org>`  Org-Root-Aggregation (mehrere Workspaces einer Org)
 *
 * Member-/Scope-gated Per-Workspace-Endpoints (z.B.
 * `GET /api/state/projection/[workspaceId]`, `GET /api/permission/[…]/mode`)
 * antworten für diese IDs zwangsläufig mit 403 — es gibt keine
 * `hasRealWorkspaceMembership`-Zeile für eine Aggregation. Clients MÜSSEN den
 * Fetch deshalb überspringen, statt im Poll-Takt 403er zu produzieren
 * (Console-Spam, vergeudetes Netzwerk). Gleiches Muster wie
 * `AllAccessToggle` den `__root__/mode`-GET skippt.
 */
export function isVirtualWorkspaceId(id: string | null | undefined): boolean {
  if (!id) return false;
  return id === ROOT_WORKSPACE_ID || id === '__all__' || id.startsWith('__org_root__:');
}

/**
 * Static fallback — explicit empty.
 *
 * 2026-04-30: User-Inject „Beispielprojekte in der Navigation statt die echten".
 * Vorher waren 11 hardcoded Workspaces hier als Fallback bei API-Fail. Risiko:
 * wenn Auth-Cookie fehlt oder /api/workspaces leer antwortet während Hydration,
 * sah User Demo-Workspaces statt seiner echten 24 aus der DB.
 *
 * Jetzt explizit leer — bei API-Fail rendert Nav leer (deutliches Signal:
 * „Auth kaputt" statt verfälscht „falsche Workspaces sichtbar"). Echter Bug-
 * Fix wäre Auth-Race im useWorkspaces-Hook, aber leerer Fallback ist sicherer
 * als 11 falsche Einträge.
 */
export const STATIC_WORKSPACES: readonly Workspace[] = [] as const;

if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
  // dev-only Hint falls jemand auf Demo-Daten setzt
  // (Build-Time-Warning — Runtime-`useWorkspaces` zeigt eigenen Toast bei API-Fail)
}

export function findWorkspaceById(
  list: readonly Workspace[],
  id: string,
): Workspace | undefined {
  return list.find((w) => w.id === id);
}
