/**
 * POST /api/auth/bootstrap
 *
 * Phase AU.1.3 — Operator-Bootstrap-Endpoint für die allererste Installation.
 *
 * Body: { email: string, displayName: string, accessCode: string }
 *
 * Bedingungen:
 *   1. Same-Origin (CSRF-Schutz, analog /api/auth/login).
 *   2. DB hat noch KEINEN aktiven `founder` — sonst 410 Gone. Diese Route
 *      ist explizit single-use für die fresh-installation.
 *   3. accessCode wird timing-safe gegen LAZYOS_ACCESS_CODE geprüft.
 *
 * Bei Erfolg:
 *   - User mit ULID anlegen (Email lower-cased).
 *   - Default-Org sicherstellen (legt sie an, falls fehlt).
 *   - Founder-Membership in Default-Org.
 *   - Session-Cookie issuen.
 *   - Response: `{ ok: true, redirectTo: "/onboarding" }`.
 *
 * Sicherheit:
 *   - Failure-Delay 500-1000ms identisch zu /api/auth/login.
 *   - Race-Schutz: nach erstem Founder erscheint sofort 410 für weitere
 *     parallele Calls (DB-COUNT-Check direkt vor Insert + erneut nach Insert,
 *     bei Race wird der spätere Insert rückgängig gemacht).
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "@/db/client";
import { organizations } from "@/db/schema/organizations";
import { orgMemberships } from "@/db/schema/memberships";
import { users } from "@/db/schema/users";
import { writeAudit } from "@/lib/audit/write";
import {
  DEFAULT_ORG_ID,
  DEFAULT_ORG_NAME,
} from "@/lib/orgs/constants";
import { timingSafeEqual } from "@/lib/security/crypto";
import { logAuthAttempt } from "@/lib/security/log";
import {
  issueSessionCookieValue,
  readSessionConfig,
  sessionSetCookieHeader,
} from "@/lib/security/session";
import { ulid } from "@/lib/ulid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BootstrapSchema = z.object({
  email: z.string().min(3).max(254).email(),
  displayName: z.string().min(1).max(120),
  accessCode: z.string().min(1).max(256),
});

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function delayRandom(minMs: number, maxMs: number): Promise<void> {
  const span = Math.max(0, maxMs - minMs);
  const ms = minMs + Math.floor(Math.random() * span);
  return new Promise((r) => setTimeout(r, ms));
}

function ipOf(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

function countActiveFounders(): number {
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
  return row?.c ?? 0;
}

export async function POST(req: Request): Promise<Response> {
  const ip = ipOf(req);
  const userAgent = req.headers.get("user-agent") ?? undefined;

  if (!sameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Bedingung 2: schon ein Founder vorhanden → 410 Gone.
  if (countActiveFounders() > 0) {
    return NextResponse.json(
      {
        error: "bootstrap-closed",
        hint: "Operator-Bootstrap ist für diese Instanz bereits abgeschlossen. Nutze Email-Login.",
      },
      { status: 410 },
    );
  }

  const config = readSessionConfig();
  if (!config) {
    return NextResponse.json(
      { error: "server_not_configured" },
      { status: 500 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    await delayRandom(500, 1000);
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = BootstrapSchema.safeParse(body);
  if (!parsed.success) {
    await delayRandom(500, 1000);
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const accessCode = process.env.LAZYOS_ACCESS_CODE?.trim();
  if (!accessCode || accessCode.length < 16) {
    return NextResponse.json(
      {
        error: "server_not_configured",
        hint: "LAZYOS_ACCESS_CODE muss mindestens 16 Zeichen lang sein.",
      },
      { status: 500 },
    );
  }

  if (!timingSafeEqual(parsed.data.accessCode, accessCode)) {
    await delayRandom(500, 1000);
    await logAuthAttempt({
      outcome: "fail",
      ip,
      userAgent,
      path: "/api/auth/bootstrap",
      reason: "bad_access_code",
    });
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const email = parsed.data.email.trim().toLowerCase();
  const displayName = parsed.data.displayName.trim();

  const db = getDb();
  const now = new Date();
  const nowMs = now.getTime();

  // Default-Org sicherstellen.
  const orgRow = db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, DEFAULT_ORG_ID))
    .limit(1)
    .all();
  if (orgRow.length === 0) {
    db.insert(organizations)
      .values({
        id: DEFAULT_ORG_ID,
        name: DEFAULT_ORG_NAME,
        type: "company",
        parentId: null,
        paletteIndex: 0,
        description:
          "Default-Organisation der lazyOS-Instanz. Sie hält den oder die ersten Workspaces.",
        archived: false,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  // User anlegen — mit Race-Schutz: wenn Email schon vergeben, nehmen wir
  // den existierenden User (sollte aber nicht passieren weil wir oben schon
  // counted haben).
  let userId: string;
  const existingUser = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
    .all();
  if (existingUser.length > 0) {
    userId = existingUser[0].id;
  } else {
    userId = `usr_${ulid()}`;
    db.insert(users)
      .values({
        id: userId,
        email,
        displayName,
        locale: "de-DE",
        status: "active",
        emailVerifiedAt: now,
        onboardingState: null,
        onboardingCompletedAt: null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
        claudeMaxStatus: "shared",
      })
      .run();
  }

  // Race-Re-Check: in der Zwischenzeit könnte ein anderer Request einen
  // Founder eingetragen haben. Wenn ja → diesen User WIEDER löschen
  // (Memberships gibt es noch nicht), 410.
  if (countActiveFounders() > 0) {
    if (existingUser.length === 0) {
      db.$raw.prepare("DELETE FROM users WHERE id = ?").run(userId);
    }
    return NextResponse.json(
      {
        error: "bootstrap-closed",
        hint: "Bootstrap wurde gerade von einem anderen Request abgeschlossen.",
      },
      { status: 410 },
    );
  }

  // Founder-Membership in Default-Org.
  db.insert(orgMemberships)
    .values({
      id: `om_${ulid()}`,
      userId,
      orgId: DEFAULT_ORG_ID,
      role: "founder",
      invitedByUserId: null,
      joinedAt: now,
      updatedAt: now,
    })
    .run();
  db.$raw
    .prepare(
      "UPDATE organizations SET responsible_user_id = ?, updated_at = ? WHERE id = ?",
    )
    .run(userId, nowMs, DEFAULT_ORG_ID);

  // Session-Cookie issuen.
  const cookieValue = await issueSessionCookieValue(config, { userId });

  await logAuthAttempt({
    outcome: "ok",
    ip,
    userAgent,
    path: "/api/auth/bootstrap",
  });
  writeAudit({
    actor: `user:${userId}`,
    action: "auth.bootstrap",
    targetUserId: userId,
    payload: { email, displayName },
    ip,
    userAgent,
  });

  const res = NextResponse.json({
    ok: true,
    userId,
    redirectTo: "/onboarding",
  });
  res.headers.set("Set-Cookie", sessionSetCookieHeader(cookieValue));
  return res;
}
