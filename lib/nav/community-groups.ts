/**
 * Shared, PURE community-grouping algorithm.
 *
 * Extracted from `MobileDrawer.tsx`'s "Kunden" inbox useMemo so the drawer AND
 * the new `/chats` overview ("Communities") share ONE source of truth and
 * cannot drift. Per the IA-realign critic: this is the PURE part only — the
 * hook-bound data acquisition (`useWorkspaces()` / `useUserOrgs()` /
 * `/api/subchats/activity`) stays in the components; both feed their fetched
 * data into `groupCommunityNodes(...)`.
 *
 * Grouping rule (unchanged from the drawer):
 *   - filter out archived / virtual-root / foreign high-sensitive workspaces
 *   - group visible workspaces by their organization
 *   - workspaces without a known org land in a trailing "Ohne Org" bucket
 *   - sort: client orgs first (name, locale 'de'), then other orgs (name),
 *     then the orphan bucket last
 *   - aggregate per-workspace unread into the node total
 */

import type { Organization, Workspace } from './types';

/**
 * One community node = an org (or the orphan bucket) with its visible
 * workspaces and the aggregated unread count. `paletteIndex` is the org's
 * palette slot (drives the per-org colour dot via `--palette-N-mid`).
 */
export interface CommunityNode {
  orgId: string;
  name: string;
  paletteIndex: number | undefined;
  isClient: boolean;
  rows: Workspace[];
  unread: number;
}

/** The id used for the trailing "no org" bucket. */
export const ORPHAN_ORG_ID = '__orphan__';

/**
 * Workspace visibility filter — identical to the drawer's previous inline
 * filter (and WorkspaceSwitcher L.72-73). `currentId` is needed so a
 * high-sensitivity workspace stays visible while it is the active one.
 */
export function isVisibleCommunityWorkspace(
  w: Workspace,
  currentId: string,
): boolean {
  if (w.archived) return false;
  // Virtual root workspaces (Migration 0034) are not list entries.
  if (w.id === '__root__') return false;
  if (w.id.startsWith('__org_root__:')) return false;
  // High-sensitive workspaces only show when they are the active workspace.
  if (w.sensitivity === 'high' && w.id !== currentId) return false;
  return true;
}

/**
 * Pure grouping. Given the raw workspaces + orgs + the active workspace id +
 * a per-workspace unread map, returns the sorted CommunityNode[].
 *
 * Side-effect free + deterministic → directly unit-testable and safe to call
 * from any render (drawer or /chats overview).
 */
export function groupCommunityNodes(
  workspaces: readonly Workspace[],
  orgs: readonly Organization[],
  currentId: string,
  unreadByWs: Readonly<Record<string, number>>,
): CommunityNode[] {
  const visible = workspaces.filter((w) =>
    isVisibleCommunityWorkspace(w, currentId),
  );

  const orgIndex = new Map<string, Organization>();
  for (const o of orgs) orgIndex.set(o.id, o);

  const groups = new Map<string, Workspace[]>();
  const orphan: Workspace[] = [];
  for (const w of visible) {
    if (w.organizationId && orgIndex.has(w.organizationId)) {
      const list = groups.get(w.organizationId) ?? [];
      list.push(w);
      groups.set(w.organizationId, list);
    } else {
      orphan.push(w);
    }
  }

  const sumUnread = (rows: Workspace[]): number =>
    rows.reduce((s, w) => s + (unreadByWs[w.id] ?? 0), 0);

  const nodes: CommunityNode[] = [];
  for (const [oid, rows] of groups) {
    const org = orgIndex.get(oid);
    nodes.push({
      orgId: oid,
      name: org?.name ?? oid,
      paletteIndex: org?.paletteIndex,
      isClient: org?.type === 'client',
      rows,
      unread: sumUnread(rows),
    });
  }

  // Clients first (name, 'de'), then other orgs (name); orphan bucket trails.
  nodes.sort((a, b) => {
    if (a.isClient !== b.isClient) return a.isClient ? -1 : 1;
    return a.name.localeCompare(b.name, 'de');
  });

  if (orphan.length > 0) {
    nodes.push({
      orgId: ORPHAN_ORG_ID,
      name: 'Ohne Org',
      paletteIndex: undefined,
      isClient: false,
      rows: orphan,
      unread: sumUnread(orphan),
    });
  }

  return nodes;
}

/**
 * The per-org colour-dot background. Fixes the latent token bug the critic
 * flagged: the bare `var(--palette-N)` token does NOT exist (only
 * `--palette-N-from/-mid/-to` are defined in organizations-palette.css), so the
 * old drawer dot silently fell back to `--a-now` for EVERY org. We map to the
 * real `-mid` stop, with `--a-now` as the graceful fallback. Returns
 * `undefined` when the node has no palette (orphan bucket) so the caller can
 * omit the inline style.
 */
export function communityDotBackground(
  paletteIndex: number | undefined,
): string | undefined {
  if (paletteIndex === undefined) return undefined;
  return `var(--palette-${paletteIndex}-mid, var(--a-now))`;
}
