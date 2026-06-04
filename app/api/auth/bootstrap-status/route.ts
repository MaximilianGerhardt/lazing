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

import { NextResponse } from "next/server";

import { getDb } from "@/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const accessCode = process.env.LAZYOS_ACCESS_CODE?.trim();
  if (!accessCode || accessCode.length < 16) {
    return NextResponse.json({ available: false, reason: "no-access-code" });
  }

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
      // 2026-04-28: solo master login always stays available when a code is
      // set AND a founder exists. The UI can then show the master tab
      // instead of bootstrap.
      return NextResponse.json({
        available: false,
        reason: "founder-exists",
        masterLoginAvailable: true,
      });
    }
    return NextResponse.json({ available: true, masterLoginAvailable: false });
  } catch {
    return NextResponse.json({ available: false, reason: "db-error" });
  }
}
