/**
 * /oss-onboarding — Lazing-style first-run OSS wizard (Phase OSS-WIZ.1).
 *
 * Server component. Reads the current user (or redirects to /login),
 * loads the OSS wizard state from the migration-0054 column, redirects to /
 * if already completed.
 *
 * Exists in parallel to /onboarding — intentionally not replaced, because
 * /onboarding is the cloud/SaaS first journey (org/workspace/MAX plan) and
 * /oss-onboarding is OSS server commissioning (engine/repo/push).
 * In V2 the two can be merged together.
 */

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { users } from "@/db/schema/users";
import { findActiveUserById } from "@/lib/users/repo";
import { currentUserIdResolved } from "@/lib/security/subject-server";
import { defaultOssState, parseOssState } from "@/lib/onboarding/oss-state";
import { isOAuthConfigured } from "@/lib/github/oauth";
import { OssOnboardingClient } from "./OssOnboardingClient";

export const dynamic = "force-dynamic";

export default async function OssOnboardingPage() {
  const h = await headers();
  const userId = currentUserIdResolved({ headers: h });
  if (!userId) {
    redirect("/login?reason=oss-onboarding-needs-login");
  }

  const user = findActiveUserById(userId);
  if (!user) {
    redirect("/login?reason=user-not-found");
  }

  // Read OSS state directly — the Drizzle schema does not know the columns yet.
  const db = getDb();
  const row = db
    .select({
      ossState: sql<string | null>`oss_onboarding_state`,
      ossDone: sql<number | null>`oss_onboarding_completed_at`,
    })
    .from(users)
    .where(eq(users.id, userId))
    .all()[0];

  if (row?.ossDone) {
    redirect("/?from=oss-onboarding");
  }

  const state = parseOssState(row?.ossState ?? null) ?? defaultOssState();
  const githubOAuthReady = isOAuthConfigured();

  return (
    <main className="sheet" style={{ paddingBottom: 120 }}>
      <OssOnboardingClient
        initial={{
          user: {
            id: user.id,
            displayName: user.displayName,
            email: user.email,
          },
          state,
          githubOAuthReady,
        }}
      />
    </main>
  );
}
