/**
 * /onboarding/kunde — guided "new customer" wizard (Bundle-B · 2026-06-03).
 *
 * Server shell, mirrors the proven auth pattern of `app/onboarding/page.tsx`
 * (resolve current-user or redirect /login). Subfolder of `app/onboarding/`,
 * NO collision with `app/onboarding/page.tsx` (user-onboarding MVP).
 *
 * The TopNav is hidden on `/onboarding/*` anyway (HIDE_TOPNAV_PATHS),
 * so the wizard gets a chrome-free full-screen surface — no nav edit.
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
