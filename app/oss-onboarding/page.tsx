/**
 * /oss-onboarding — Lazing-Style First-Run OSS-Wizard (Phase OSS-WIZ.1).
 *
 * Server-Component. Liest current-user (oder redirected zu /login),
 * läd OSS-Wizard-State aus Migration-0054-Spalte, redirected zu / wenn
 * schon abgeschlossen.
 *
 * Existiert parallel zu /onboarding — bewusst nicht ersetzt, weil
 * /onboarding die Cloud/SaaS-Erst-Reise (Org/Workspace/MAX-Plan) ist und
 * /oss-onboarding die OSS-Server-Inbetriebnahme (Engine/Repo/Push) ist.
 * In der V2 können die zwei zusammengeschoben werden.
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

  // Lese OSS-State direkt — Drizzle-Schema kennt die Spalten noch nicht.
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
