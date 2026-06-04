/**
 * /orgs/[orgId]/workspaces/[wsId] — canonical Org-scoped Workspace-URL.
 * Phase IA.6 (2026-04-29).
 *
 * Server-Component mit Konsistenz-Check (gehört der Workspace zur Org-
 * URL?). Bei Match → Redirect auf die heutige `/workspaces/[wsId]`-Page,
 * die alle Tabs + DB-Reads kennt. Bei Org-Mismatch → Redirect auf die
 * korrekte canonical URL. Bei fehlendem Workspace → 404.
 *
 * Längerfristig könnten wir die heutige /workspaces/[id]-Page hierher
 * verschieben und dort einen Redirect aus Bookmark-Compat hinterlegen.
 * Heute pragmatisch: beide URLs funktionieren, neue Links nutzen die
 * canonical Form, alte Bookmarks gehen auf legacy.
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
