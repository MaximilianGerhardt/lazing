/**
 * /agents — „Mitarbeiter"-Profile-Seite (2026-06-03).
 *
 * Server-Wrapper: Auth-Gate, dann die Client-UI (Liste + Anlege-Formular).
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { currentUserIdResolved } from "@/lib/security/subject-server";
import AgentProfilesClient from "./AgentProfilesClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AgentsPage(): Promise<React.JSX.Element> {
  const h = await headers();
  const userId = currentUserIdResolved({ headers: h });
  if (!userId) {
    redirect("/login?reason=agents-needs-login");
  }
  return <AgentProfilesClient />;
}
