/**
 * GET /api/auth/me — Current-User-Info für Frontend.
 *
 * Wird vom UI als SWR-Polling alle 60s gecallt, um Cookie-Invalidation
 * (deleted/suspended User, Token-Tampering, expired Cookie) zu erkennen
 * und den Tab zu reloaden.
 *
 * Response-Shape:
 *   200 { user: { id, email, displayName, locale, ... } }
 *   404 { error: "not-found" }     — Cookie verifiziert aber userId nicht in DB
 *   401 wird von Middleware zurückgegeben (Cookie fehlt/ungültig)
 *
 * Edge-Hinweis: Diese Route läuft auf Node-Runtime (DB-Lookup).
 */

import { NextResponse, type NextRequest } from "next/server";

import { findActiveUserById } from "@/lib/users/repo";
import { currentSubject } from "@/lib/security/subject";
import { currentUserIdResolved } from "@/lib/security/subject-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const subject = currentSubject(req);

  // Phase AU.4: Bootstrap-Cookie wird auf den ersten Founder-User remapped.
  // currentUserIdResolved liefert die ULID — falls noch kein Founder existiert,
  // ist die Antwort 404 (frische Installation, User muss durch Bootstrap-Flow).
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json(
      {
        error: "not-found",
        subjectKind: subject.kind,
        hint: "no-founder-yet",
      },
      { status: 404 },
    );
  }
  const user = findActiveUserById(userId);
  if (!user) {
    return NextResponse.json(
      { error: "not-found", subjectKind: subject.kind },
      { status: 404 },
    );
  }

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      locale: user.locale,
      status: user.status,
      emailVerifiedAt:
        user.emailVerifiedAt instanceof Date
          ? user.emailVerifiedAt.toISOString()
          : null,
      onboardingCompletedAt:
        user.onboardingCompletedAt instanceof Date
          ? user.onboardingCompletedAt.toISOString()
          : null,
    },
  });
}
