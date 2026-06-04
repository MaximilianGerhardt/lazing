/**
 * /orgs — Phase IA.3.
 *
 * Top-Level wurde von einer Listenseite zur Redirect-Page degradiert.
 * Standard-Landing ist immer die aktive Organisation:
 *   - Cookie `lazyos.org` gesetzt → redirect /orgs/<that-id>
 *   - Sonst → erste Org der listOrgsForUser()-Liste
 *   - Wenn der User in keiner Org ist → /orgs/manage (zum Anlegen)
 *
 * Die heutige Verwaltungs-Liste lebt unter /orgs/manage.
 */

import { redirect } from "next/navigation";
import { headers, cookies } from "next/headers";

import { listOrgsForUser } from "@/lib/orgs/repo";
import { currentUserIdResolved } from "@/lib/security/subject-server";
import { findActiveUserById } from "@/lib/users/repo";

export const dynamic = "force-dynamic";

const ORG_COOKIE_NAMES = ["lazyos.org", "lazyos_org"]; // tolerieren beide Schreibweisen

export default async function OrgsRedirectPage() {
  const h = await headers();
  const userId = currentUserIdResolved({ headers: h });
  if (!userId) {
    redirect("/login?reason=orgs-needs-login");
  }
  const user = findActiveUserById(userId);
  if (!user) {
    redirect("/login?reason=user-not-found");
  }

  const orgs = listOrgsForUser(userId);
  if (orgs.length === 0) {
    // User ist in keiner Org — Verwaltungs-Page als Notfall-Landing.
    redirect("/orgs/manage");
  }

  // Cookie-bevorzugte Org, sonst erste verfügbare.
  const c = await cookies();
  let preferredId: string | null = null;
  for (const name of ORG_COOKIE_NAMES) {
    const v = c.get(name)?.value;
    if (v && orgs.some((o) => o.id === v)) {
      preferredId = v;
      break;
    }
  }
  const targetId = preferredId ?? orgs[0]!.id;
  redirect(`/orgs/${encodeURIComponent(targetId)}`);
}
