/**
 * /reasoning-audit/* — Auth-Layout (Privacy-Sprint V5, 2026-05-01).
 *
 * Critic-VETO V5: Die /reasoning-audit/[id]-Page hatte einen Kommentar der
 * behauptete "requireSession via Layout" — aber kein Layout existierte.
 * Auth hing allein an der Edge-Middleware. Wenn die Middleware aus
 * irgend einem Grund nicht durchläuft (Matcher-Edge-Case, Build-Time-Render,
 * Bypass), war /reasoning-audit/[id] ungeschützt — und das Page-Rendering
 * würde audits aller Workspaces zeigen inkl. claimText.
 *
 * Defense-in-Depth: dieses Layout läuft auf jeden Page-Render und
 * redirected unauthentisierte Requests nach /login. Keine Annahme, dass
 * die Edge bereits gefiltert hat.
 *
 * Workspace-Membership-Filter findet zusätzlich auf der detail-page selbst
 * statt — siehe app/reasoning-audit/[id]/page.tsx.
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
