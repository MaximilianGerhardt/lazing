'use client';

/**
 * OrgBootstrap — seeds the active organization from a server-known value.
 *
 * Renders nothing. Mirror of {@link WorkspaceBootstrap}: a single
 * `useLayoutEffect` writes the org context (localStorage `lazyos.org` +
 * cookie + `org-change` event) via `setOrgIdSilent` BEFORE the tree
 * hydrates — so the OrgSwitcher normalization effect sees a valid, matching
 * org and never fires its hard-redirect to `/orgs/<org>/chat`.
 *
 * Why this exists (Nav-Fix D, 2026-06-02):
 *   `/workspaces/[id]/*` pages and the scoped main chat (`/?ws=<realId>`)
 *   live under a real customer workspace, but nothing synced the org context
 *   to that workspace's owning org. The OrgSwitcher normalization effect
 *   (OrgSwitcher.tsx) then "corrected" the org back to `orgs[0]` and
 *   `useSetOrg()` hard-redirected to the org-root chat, abandoning the page.
 *   Rendering this component on those server pages closes the gap WITHOUT a
 *   navigation — `setOrgIdSilent` never calls `location.assign`.
 *
 * Reversibility: the server pages gate the render behind
 *   `LAZYOS_WORKSPACE_ORG_BOOTSTRAP !== '0'`. Setting it to `0` restores the
 *   pre-fix behaviour exactly.
 *
 * Guard: only writes when the stored value differs (avoids a redundant
 *   `org-change` event / re-render on same-org navigation). `useLayoutEffect`
 *   (not `useEffect`) so the write lands before OrgSwitcher's normalization
 *   `useEffect` commits.
 */

import { useLayoutEffect } from 'react';
import { setOrgIdSilent } from './hooks';

// Literal mirror of the private ORG_STORAGE_KEY in hooks.ts. Kept local so
// the equality-guard read needs no extra export surface.
const ORG_STORAGE_KEY = 'lazyos.org';

interface Props {
  organizationId: string;
}

export function OrgBootstrap({ organizationId }: Props): null {
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    if (!organizationId) return;
    let current: string | null = null;
    try {
      current = window.localStorage.getItem(ORG_STORAGE_KEY);
    } catch {
      /* non-fatal — proceed with write attempt */
    }
    if (current === organizationId) return;
    // setOrgIdSilent: localStorage + cookie + `org-change` event, NO navigate.
    setOrgIdSilent(organizationId);
  }, [organizationId]);

  return null;
}
