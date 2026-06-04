/**
 * GET /api/auth/bootstrap-status
 *
 * Phase AU.1.1 — Probe für die Login-UI: soll die Operator-Bootstrap-Sektion
 * angezeigt werden?
 *
 * Antwort:
 *   { available: boolean, reason?: string }
 *
 *   available=true wenn:
 *     - LAZYOS_ACCESS_CODE gesetzt + ≥16 Zeichen
 *     - DB hat noch keinen aktiven Founder
 *     - Mail-Provider ist konfiguriert ODER Operator-Bootstrap ist die einzige
 *       Möglichkeit reinzukommen
 *
 *   available=false sonst (Reason für Diagnose, optional in der UI).
 *
 * Public (in middleware whitelisted). Keine Sensitive-Info im Response.
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
      // 2026-04-28: Solo-Master-Login bleibt immer verfügbar wenn Code
      // gesetzt UND ein Founder existiert. UI kann dann das Master-Tab
      // anzeigen statt Bootstrap.
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
