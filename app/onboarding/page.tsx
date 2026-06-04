/**
 * /onboarding — onboarding wizard MVP (Phase ORG SP-8).
 *
 * Server component. Reads current-user (or redirects to /login),
 * loads the onboarding state, redirects if already completed.
 *
 * Phase 1 MVP: 3 steps inline on a single page. Phase N can split this into
 * `/onboarding/[step]/page.tsx` when the steps become more complex.
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

  // Already completed → straight to /
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
