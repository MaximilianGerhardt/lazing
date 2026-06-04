/**
 * GET /api/auth/me — current-user info for the frontend.
 *
 * Called by the UI as SWR polling every 60s, to detect cookie invalidation
 * (deleted/suspended user, token tampering, expired cookie)
 * and reload the tab.
 *
 * Response shape:
 *   200 { user: { id, email, displayName, locale, ... } }
 *   404 { error: "not-found" }     — cookie verified but userId not in DB
 *   401 is returned by the middleware (cookie missing/invalid)
 *
 * Edge note: this route runs on the Node runtime (DB lookup).
 */

import { NextResponse, type NextRequest } from "next/server";

import { findActiveUserById } from "@/lib/users/repo";
import { currentSubject } from "@/lib/security/subject";
import { currentUserIdResolved } from "@/lib/security/subject-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const subject = currentSubject(req);

  // Phase AU.4: the bootstrap cookie is remapped to the first founder user.
  // currentUserIdResolved returns the ULID — if no founder exists yet,
  // the answer is 404 (fresh installation, the user must go through the bootstrap flow).
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
