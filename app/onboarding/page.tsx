/**
 * /onboarding — Onboarding-Wizard MVP (Phase ORG SP-8).
 *
 * Server-Component. Liest current-user (oder redirected zu /login),
 * läd Onboarding-State, redirected wenn schon abgeschlossen.
 *
 * Phase-1-MVP: 3 Steps inline auf einer Page. Phase-N kann das auf
 * `/onboarding/[step]/page.tsx` aufteilen wenn Steps komplexer werden.
 */

import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { findActiveUserById } from "@/lib/users/repo";
import { currentUserIdResolved } from "@/lib/security/subject-server";
import { defaultState, parseState } from "@/lib/onboarding/state";
import { OnboardingClient } from "./OnboardingClient";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const h = await headers();
  const userId = currentUserIdResolved({ headers: h });
  if (!userId) {
    redirect("/login?reason=onboarding-needs-login");
  }

  const user = findActiveUserById(userId);
  if (!user) {
    redirect("/login?reason=user-not-found");
  }

  // Schon abgeschlossen → direkt zu /
  if (user.onboardingCompletedAt) {
    redirect("/");
  }

  const state = parseState(user.onboardingState) ?? defaultState("new");

  return (
    <main className="sheet" style={{ paddingBottom: 120 }}>
      <OnboardingClient
        initial={{
          user: {
            id: user.id,
            displayName: user.displayName,
            email: user.email,
          },
          state,
        }}
      />
    </main>
  );
}
