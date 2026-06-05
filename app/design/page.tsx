/**
 * /design — interne Component-Library / Design-Quelle (Manifest v1.0).
 *
 * SECURITY (SP-1): Diese Seite war public (middleware-Allowlist, kein Guard) und
 * ihr „Anpassen"-Feld triggert über POST /api/feedback den Fix-Agent — anonym
 * erreichbar. Sie bleibt als interne Design-/Gradient-Quelle erhalten, ist aber
 * jetzt doppelt abgesichert:
 *   1. middleware.ts: /design + /api/feedback aus PUBLIC_PATHS entfernt → Session-Pflicht.
 *   2. Hier: Server-Guard (Login) + Sichtbarkeit nur in Dev ODER für Founder ODER
 *      wenn LAZYOS_ENABLE_DESIGN_LIBRARY gesetzt ist; sonst notFound() (greift auch,
 *      falls die Middleware je regressiert).
 */

import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { currentUserIdResolved } from "@/lib/security/subject-server";
import { findUserOrgMembership } from "@/lib/orgs/repo";
import { DEFAULT_ORG_ID } from "@/lib/orgs/constants";
import DesignLibraryClient from "./DesignLibraryClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function designLibraryEnabled(isFounderUser: boolean): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  const flag = (process.env.LAZYOS_ENABLE_DESIGN_LIBRARY ?? "").trim().toLowerCase();
  if (["1", "true", "on"].includes(flag)) return true;
  return isFounderUser;
}

export default async function DesignPage(): Promise<React.JSX.Element> {
  const h = await headers();
  const userId = currentUserIdResolved({ headers: h });
  if (!userId) {
    redirect("/login?reason=design-needs-login");
  }
  let founder = false;
  try {
    founder = findUserOrgMembership(userId, DEFAULT_ORG_ID)?.role === "founder";
  } catch {
    founder = false;
  }
  if (!designLibraryEnabled(founder)) {
    notFound();
  }
  return <DesignLibraryClient />;
}
