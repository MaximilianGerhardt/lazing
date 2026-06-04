/**
 * /reasoning-audit/* — auth layout (Privacy-Sprint V5, 2026-05-01).
 *
 * Critic-VETO V5: the /reasoning-audit/[id] page had a comment that
 * claimed "requireSession via Layout" — but no layout existed.
 * Auth hung solely on the Edge middleware. If the middleware for
 * some reason does not run (matcher edge case, build-time render,
 * bypass), /reasoning-audit/[id] was unprotected — and page rendering
 * would show audits of all workspaces including claimText.
 *
 * Defense-in-depth: this layout runs on every page render and
 * redirects unauthenticated requests to /login. No assumption that
 * the Edge has already filtered.
 *
 * The workspace membership filter additionally happens on the detail page
 * itself — see app/reasoning-audit/[id]/page.tsx.
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { currentUserIdResolved } from "@/lib/security/subject-server";

export const dynamic = "force-dynamic";

export default async function ReasoningAuditLayout({
  children,
}: {
  children: ReactNode;
}): Promise<React.JSX.Element> {
  const h = await headers();
  const userId = currentUserIdResolved({ headers: h });
  if (!userId) {
    redirect("/login?from=%2Freasoning-audit");
  }
  return <>{children}</>;
}
