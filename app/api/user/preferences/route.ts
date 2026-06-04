/**
 * GET /api/user/preferences — system-übergreifende User-Defaults
 * (Owner-Fix Live-Test 2026-05-28).
 *
 * Owner-Befund (verbatim):
 *   „Vollzugriff war bereits aktiviert. im neuen Workspace war es nicht
 *    aktiviert. Ggf. diese Einstellung Systemübergreifend nutzbar machen."
 *
 * Verhalten:
 *   - Liest die `user_preferences`-Row des aktuell eingeloggten Users.
 *   - Liefert `{ defaultPermissionMode }` (kann NULL sein, wenn der User noch
 *     keinen Default gesetzt hat).
 *
 * Auth:
 *   - currentUserIdResolved → 401 wenn nicht eingeloggt.
 *   - KEINE Workspace-Membership-Prüfung — die Tabelle ist user-scoped,
 *     KEINE Workspace-Permissions werden hier verteilt. Der Fallback in
 *     AllAccessToggle nutzt den Wert nur zur UI-Initialisierung; der echte
 *     Spawn liest weiterhin den Workspace-Mode (server/workspace-session.ts).
 *
 * KEIN PATCH-Endpoint:
 *   Der User-Default wird ausschließlich serverseitig vom PATCH der
 *   Permission-Mode-Route mitgeschrieben (Owner-Direktive: Default folgt der
 *   letzten expliziten Toggle-Aktion). Damit verhindern wir, dass ein
 *   Client den Default ohne die zugehörige Audit-Spur kippt.
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
    // Stabile, schlanke Antwort. NULL bleibt NULL (= „kein Default").
    return NextResponse.json(
      {
        defaultPermissionMode: prefs?.defaultPermissionMode ?? null,
        // Ehrlich kommunizieren, ob die Row existiert — die UI kann so
        // zwischen „explizit auf NULL gesetzt" und „noch nie geschrieben"
        // unterscheiden (heute beides → Default 'ask'; künftig potenziell
        // verschiedenes UI-Affordance).
        hasPreferencesRow: prefs !== null,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    // Fail-soft: ein DB-Hickup darf die UI-Initialisierung nicht blockieren.
    console.error("[user/preferences GET] read error:", err);
    return NextResponse.json(
      { defaultPermissionMode: null, hasPreferencesRow: false },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }
}
