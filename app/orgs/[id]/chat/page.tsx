/**
 * /orgs/[id]/chat — Phase IA.4.
 *
 * Server-component redirect to the main chat route with the org-root
 * pseudo-workspace as the active workspace. The endpoint exists so that the
 * OrgSwitcher (hard switch) has a clean `/orgs/<id>/chat` URL target —
 * without logic in the client code for "what is the root workspace of this org".
 *
 * Context preservation (SAR-5 fix):
 *   Instead of blindly redirecting to `/`, we set the workspace query param
 *   `ws=__org_root__:<orgId>`. The chat page (`/`) reads `ws` from the
 *   query string and sets localStorage + cookie before it renders — so
 *   the org context is not lost, even on a direct URL (bookmark).
 *
 *   Format: `__org_root__:<orgId>` — identical to the pattern in
 *   lib/nav/hooks.ts and the OrgSwitcher.
 *
 *   No infinite redirect: the chat page (/) treats `ws` as a hint,
 *   not as another redirect source.
 */

import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function OrgChatRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<never> {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  // Encode the org-root pseudo-workspace ID as a query param so the Chat
  // page can pick it up and activate the correct workspace context without
  // requiring client-side localStorage reads on the initial server render.
  const wsParam = encodeURIComponent(`__org_root__:${id}`);
  redirect(`/?ws=${wsParam}`);
}
