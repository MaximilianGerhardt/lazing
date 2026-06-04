/**
 * /orgs — Phase IA.3.
 *
 * Top-level was demoted from a list page to a redirect page.
 * The default landing is always the active organization:
 *   - Cookie `lazyos.org` set → redirect /orgs/<that-id>
 *   - Otherwise → first org of the listOrgsForUser() list
 *   - If the user is in no org → /orgs/manage (to create one)
 *
 * Today's management list lives under /orgs/manage.
 */

import { redirect } from "next/navigation";
import { headers, cookies } from "next/headers";

import { listOrgsForUser } from "@/lib/orgs/repo";
import { currentUserIdResolved } from "@/lib/security/subject-server";
import { findActiveUserById } from "@/lib/users/repo";

export const dynamic = "force-dynamic";

const ORG_COOKIE_NAMES = ["lazyos.org", "lazyos_org"]; // tolerate both spellings

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
    // User is in no org — management page as fallback landing.
    redirect("/orgs/manage");
  }

  // Cookie-preferred org, otherwise first available.
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
