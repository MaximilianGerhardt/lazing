/**
 * /orgs/[orgId]/workspaces/[wsId] — canonical org-scoped workspace URL.
 * Phase IA.6 (2026-04-29).
 *
 * Server component with a consistency check (does the workspace belong to
 * the org URL?). On a match → redirect to the current `/workspaces/[wsId]`
 * page, which knows all tabs + DB reads. On an org mismatch → redirect to
 * the correct canonical URL. On a missing workspace → 404.
 *
 * Longer term, we could move the current /workspaces/[id] page here
 * and place a redirect there for bookmark compatibility.
 * Pragmatic today: both URLs work, new links use the
 * canonical form, old bookmarks go to legacy.
 */

import { notFound, redirect } from "next/navigation";

import { findOrgForWorkspace } from "@/lib/orgs/repo";

export const dynamic = "force-dynamic";

export default async function CanonicalWorkspaceRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; wsId: string }>;
  searchParams: Promise<{ tab?: string }>;
}): Promise<never> {
  const { id: rawOrgId, wsId: rawWsId } = await params;
  const sp = await searchParams;
  const orgId = decodeURIComponent(rawOrgId);
  const wsId = decodeURIComponent(rawWsId);

  const org = findOrgForWorkspace(wsId);
  if (!org) {
    notFound();
  }
  if (org.id !== orgId) {
    redirect(
      `/orgs/${encodeURIComponent(org.id)}/workspaces/${encodeURIComponent(wsId)}` +
        (sp.tab ? `?tab=${encodeURIComponent(sp.tab)}` : ""),
    );
  }

  redirect(
    `/workspaces/${encodeURIComponent(wsId)}` +
      (sp.tab ? `?tab=${encodeURIComponent(sp.tab)}` : ""),
  );
}
