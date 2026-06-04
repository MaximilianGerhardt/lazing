/**
 * GET /api/inbox/count — lean endpoint for the TopNav badge.
 *
 * Returns only the total counts without the items themselves. Polled by the
 * TopNav ~every 60s. Fast + cache-friendly.
 */

import { NextResponse, type NextRequest } from "next/server";

import { aggregateInbox } from "@/lib/inbox/aggregate";
import { listOrgsForUser } from "@/lib/orgs/repo";
import { currentUserIdResolved } from "@/lib/security/subject-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ total: 0, counts: {} });
  }
  try {
    // Phase IA.5 — org scope from cookie.
    const cookieOrgId = req.cookies.get("lazyos.org")?.value
      ?? req.cookies.get("lazyos_org")?.value
      ?? null;
    let activeOrgId: string | undefined;
    if (cookieOrgId && cookieOrgId !== "__all__") {
      activeOrgId = cookieOrgId;
    } else {
      activeOrgId = listOrgsForUser(userId)[0]?.id;
    }
    const { counts, total } = await aggregateInbox(userId, { orgId: activeOrgId });
    return NextResponse.json({ total, counts });
  } catch (err) {
    return NextResponse.json(
      {
        total: 0,
        counts: {},
        error: "aggregate-failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 200 },
    );
  }
}
