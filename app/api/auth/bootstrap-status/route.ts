/**
 * GET /api/auth/bootstrap-status
 *
 * Phase AU.1.1 — probe for the login UI: should the operator bootstrap section
 * be shown?
 *
 * Response:
 *   { available: boolean, reason?: string }
 *
 *   available=true when:
 *     - LAZYOS_ACCESS_CODE set + ≥16 characters
 *     - DB has no active founder yet
 *     - a mail provider is configured OR operator bootstrap is the only
 *       way to get in
 *
 *   available=false otherwise (reason for diagnosis, optional in the UI).
 *
 * Public (whitelisted in middleware). No sensitive info in the response.
 */

import { NextResponse, type NextRequest } from "next/server";

import { getDb } from "@/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** First run from the local machine itself (loopback, not proxied/tunneled). */
function isLoopback(req: NextRequest): boolean {
  const host = (req.headers.get("host") ?? "").toLowerCase().replace(/:\d+$/, "");
  const loopback =
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  const proxied = Boolean(
    req.headers.get("x-forwarded-for") || req.headers.get("x-forwarded-host"),
  );
  return loopback && !proxied;
}

export async function GET(req: NextRequest): Promise<Response> {
  const accessCode = process.env.LAZYOS_ACCESS_CODE?.trim();
  const hasCode = Boolean(accessCode && accessCode.length >= 16);
  const localFirstRun = isLoopback(req);

  try {
    const db = getDb();
    const row = db.$raw
      .prepare(
        `SELECT COUNT(*) AS c
           FROM org_memberships m
           INNER JOIN users u ON u.id = m.user_id
          WHERE m.role = 'founder'
            AND u.status = 'active'
            AND u.deleted_at IS NULL`,
      )
      .get() as { c?: number } | undefined;
    const founders = row?.c ?? 0;
    if (founders > 0) {
      // Solo master login stays available when a code is set AND a founder
      // exists. The UI can then show the master tab instead of bootstrap.
      return NextResponse.json({
        available: false,
        reason: "founder-exists",
        masterLoginAvailable: hasCode,
      });
    }
    // No founder yet → first-run bootstrap is available. On localhost it is
    // CODELESS (the local operator is the owner — no terminal code to copy);
    // remote first-run still requires the access code.
    if (localFirstRun) {
      return NextResponse.json({
        available: true,
        codeless: true,
        masterLoginAvailable: false,
      });
    }
    if (hasCode) {
      return NextResponse.json({
        available: true,
        codeless: false,
        masterLoginAvailable: false,
      });
    }
    return NextResponse.json({ available: false, reason: "no-access-code" });
  } catch {
    return NextResponse.json({ available: false, reason: "db-error" });
  }
}
