/**
 * GET /api/user/preferences — system-wide user defaults
 * (Owner fix live test 2026-05-28).
 *
 * Owner finding (verbatim):
 *   „Vollzugriff war bereits aktiviert. im neuen Workspace war es nicht
 *    aktiviert. Ggf. diese Einstellung Systemübergreifend nutzbar machen."
 *   (Full access was already enabled. In the new workspace it was not
 *    enabled. Possibly make this setting usable system-wide.)
 *
 * Behavior:
 *   - Reads the `user_preferences` row of the currently logged-in user.
 *   - Returns `{ defaultPermissionMode }` (may be NULL if the user has not yet
 *     set a default).
 *
 * Auth:
 *   - currentUserIdResolved → 401 if not logged in.
 *   - NO workspace membership check — the table is user-scoped,
 *     NO workspace permissions are handed out here. The fallback in
 *     AllAccessToggle uses the value only for UI initialization; the real
 *     spawn still reads the workspace mode (server/workspace-session.ts).
 *
 * NO PATCH endpoint:
 *   The user default is written exclusively server-side by the PATCH of the
 *   permission-mode route (owner directive: the default follows the
 *   last explicit toggle action). This prevents a
 *   client from flipping the default without the associated audit trail.
 */

import { NextResponse, type NextRequest } from "next/server";

import { currentUserIdResolved } from "@/lib/security/subject-server";
import { getUserPreferences } from "@/lib/users/preferences-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  try {
    const prefs = getUserPreferences(userId);
    // Stable, lean response. NULL stays NULL (= "no default").
    return NextResponse.json(
      {
        defaultPermissionMode: prefs?.defaultPermissionMode ?? null,
        // Honestly communicate whether the row exists — this lets the UI
        // distinguish between "explicitly set to NULL" and "never written"
        // (today both → default 'ask'; potentially different UI affordance
        // in the future).
        hasPreferencesRow: prefs !== null,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    // Fail-soft: a DB hiccup must not block the UI initialization.
    console.error("[user/preferences GET] read error:", err);
    return NextResponse.json(
      { defaultPermissionMode: null, hasPreferencesRow: false },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }
}
