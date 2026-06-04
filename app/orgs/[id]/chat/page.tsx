/**
 * /orgs/[id]/chat — Phase IA.4.
 *
 * Server-Component-Redirect auf die Haupt-Chat-Route mit dem Org-Root-
 * Pseudo-Workspace als aktivem Workspace. Endpoint existiert damit der
 * OrgSwitcher (Hard-Switch) sauber `/orgs/<id>/chat` als URL-Ziel hat —
 * ohne Logik im Client-Code für „Wie heißt der Root-Workspace dieser Org".
 *
 * Kontext-Erhaltung (SAR-5 fix):
 *   Statt blind `/` zu redirecten, setzen wir den Workspace-Query-Param
 *   `ws=__org_root__:<orgId>`. Die Chat-Seite (`/`) liest `ws` aus dem
 *   Query-String und setzt localStorage + Cookie bevor sie rendert — so
 *   geht der Org-Kontext nicht verloren, auch bei Direct-URL (Bookmark).
 *
 *   Format: `__org_root__:<orgId>` — identisch mit dem Pattern in
 *   lib/nav/hooks.ts und dem OrgSwitcher.
 *
 *   Kein Endlos-Redirect: die Chat-Seite (/) behandelt `ws` als Hint,
 *   nicht als weitere Redirect-Quelle.
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
