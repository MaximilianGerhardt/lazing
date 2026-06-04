/**
 * GET /api/setup/status — consolidates first-time-setup readiness into
 * a single JSON for the home-page SetupHero component.
 *
 * Response:
 *   {
 *     engines:               { ready: number, total: number },
 *     github:                { connected: boolean },
 *     push:                  { vapidConfigured: boolean, subscribed: boolean },
 *     onboardingCompleted:   boolean
 *   }
 *
 * Direktive 2026-05-23 ("Setup zeigt drei Schritte obwohl Push aktiv"):
 *   - `push.subscribed` IS computed server-side now. Wenn die File-Store-
 *     Datei `data/push-subscriptions.json` mindestens 1 Eintrag hat, gilt
 *     Push als aktiv. Der Client kann das uebersteuern, wenn die lokale
 *     Browser-Subscription nicht mehr existiert.
 *   - `engines.total` ist 3 (claude-cli, codex-cli, ollama) — claude-api
 *     wurde 2026-05-23 entfernt.
 *   - `onboardingCompleted` ist KEIN blocker fuer den Setup-Hero. Der Hero
 *     verschwindet sobald engines>0 + push erfuellt (GitHub optional).
 *
 * Notes:
 *   - Engine detection uses the cached snapshot — no fresh probe — so
 *     this endpoint stays sub-50ms on the home-page render path.
 *   - GitHub status falls back to "not connected" on any error rather
 *     than returning 500.
 *
 * Used by:
 *   - `/lib/home/SetupHero.tsx` (every page load + window-focus).
 */

import { NextResponse, type NextRequest } from "next/server";

import { currentUserIdResolved } from "@/lib/security/subject-server";
import { detectEngines } from "@/lib/llm/engines";
import { findCredentialForUser } from "@/lib/github/repo";
import { loadCurrentUser } from "@/lib/users/service";
import { list as listPushSubscriptions } from "@/lib/pwa/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json(
      {
        engines: { ready: 0, total: 3 },
        github: { connected: false },
        push: {
          vapidConfigured: !!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
          subscribed: false,
        },
        onboardingCompleted: false,
      },
      { status: 401 },
    );
  }

  // Engine matrix (cached probe) — 3 engines after claude-api removal.
  let enginesReady = 0;
  let enginesTotal = 3;
  try {
    const snap = await detectEngines({ forceProbe: false });
    enginesTotal = snap.available.length || 3;
    enginesReady = snap.available.filter((e) => e.available).length;
  } catch {
    /* leave 0/3 */
  }

  // GitHub credential
  let githubConnected = false;
  try {
    githubConnected = !!findCredentialForUser(userId);
  } catch {
    /* leave false */
  }

  // VAPID server-side env presence
  const vapidConfigured = !!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

  // Push subscription file-store check (Direktive 2026-05-23):
  // Mindestens eine gespeicherte Subscription = Push aktiv.
  let pushSubscribed = false;
  try {
    const subs = await listPushSubscriptions();
    pushSubscribed = Array.isArray(subs) && subs.length > 0;
  } catch {
    /* leave false */
  }

  // Onboarding completion — best-effort from user row.
  let onboardingCompleted = false;
  try {
    const user = loadCurrentUser(req);
    if (user) {
      onboardingCompleted =
        user.onboardingCompletedAt instanceof Date ||
        typeof user.onboardingCompletedAt === "string";
    }
  } catch {
    /* leave false */
  }

  return NextResponse.json({
    engines: { ready: enginesReady, total: enginesTotal },
    github: { connected: githubConnected },
    push: { vapidConfigured, subscribed: pushSubscribed },
    onboardingCompleted,
  });
}
