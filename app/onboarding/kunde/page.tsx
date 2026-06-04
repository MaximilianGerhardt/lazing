/**
 * /onboarding/kunde — geführter „Neuer Kunde"-Wizard (Bundle-B · 2026-06-03).
 *
 * Server-Shell, spiegelt das bewährte Auth-Pattern von `app/onboarding/page.tsx`
 * (current-user resolven oder redirect /login). Subfolder von `app/onboarding/`,
 * KEINE Kollision mit `app/onboarding/page.tsx` (User-Onboarding-MVP).
 *
 * Die TopNav ist auf `/onboarding/*` ohnehin ausgeblendet (HIDE_TOPNAV_PATHS),
 * der Wizard bekommt damit eine chrome-freie Full-Screen-Surface — kein Nav-Edit.
 */

import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { currentUserIdResolved } from "@/lib/security/subject-server";
import { findActiveUserById } from "@/lib/users/repo";
import { NewCustomerWizard } from "@/lib/onboarding/NewCustomerWizard";

export const dynamic = "force-dynamic";

export default async function NewCustomerOnboardingPage() {
  const h = await headers();
  const userId = currentUserIdResolved({ headers: h });
  if (!userId) {
    redirect("/login?reason=kunde-onboarding-needs-login");
  }
  const user = findActiveUserById(userId);
  if (!user) {
    redirect("/login?reason=user-not-found");
  }
  return (
    <main className="sheet" style={{ paddingBottom: 120 }}>
      <NewCustomerWizard />
    </main>
  );
}
