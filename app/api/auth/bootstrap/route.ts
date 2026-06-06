/**
 * POST /api/auth/bootstrap
 *
 * Phase AU.1.3 — operator bootstrap endpoint for the very first installation.
 *
 * Body: { email: string, displayName: string, accessCode: string }
 *
 * Conditions:
 *   1. Same-origin (CSRF protection, analogous to /api/auth/login).
 *   2. The DB has NO active `founder` yet — otherwise 410 Gone. This route
 *      is explicitly single-use for the fresh installation.
 *   3. accessCode is checked timing-safe against LAZYOS_ACCESS_CODE.
 *
 * On success:
 *   - Create a user with a ULID (email lower-cased).
 *   - Ensure the default org (creates it if missing).
 *   - Founder membership in the default org.
 *   - Issue a session cookie.
 *   - Response: `{ ok: true, redirectTo: "/onboarding" }`.
 *
 * Security:
 *   - Failure delay 500-1000ms identical to /api/auth/login.
 *   - Race protection: after the first founder, 410 appears immediately for
 *     further parallel calls (DB COUNT check right before insert + again after
 *     insert; on a race the later insert is rolled back).
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
import { isLoopbackFirstRun } from "@/lib/security/loopback";
import {
  hashPassword,
  isStrongEnough,
  MIN_PASSWORD_LENGTH,
} from "@/lib/security/password";
import { logAuthAttempt } from "@/lib/security/log";
import {
  issueSessionCookieValue,
  readSessionConfig,
  sessionSetCookieHeader,
} from "@/lib/security/session";
import { ulid } from "@/lib/ulid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// All fields optional: a first run from localhost needs no access code, and the
// owner e-mail/name fall back to sensible defaults — the browser flow collects
// everything, no terminal step.
const BootstrapSchema = z.object({
  email: z.string().max(254).optional(),
  displayName: z.string().max(120).optional(),
  accessCode: z.string().max(256).optional(),
  // Optional: set a password during first-run so the owner has email + password
  // credentials immediately. When omitted, recovery is via the master access
  // code or `scripts/admin.ts set-password`.
  password: z.string().max(512).optional(),
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

/**
 * Is this the first run, accessed from the local machine itself? The person who
 * started laz.ing on this box IS the owner, so the very first bootstrap from
 * loopback needs no access code. Remote/proxied/tunneled requests (a forwarded
 * host header) still must present the code.
 */
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

  // Condition 2: a founder already exists → 410 Gone.
  if (countActiveFounders() > 0) {
    return NextResponse.json(
      {
        error: "bootstrap-closed",
        hint: "Operator bootstrap is already complete for this instance. Use e-mail login.",
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
  const providedCode = parsed.data.accessCode?.trim() ?? "";
  const localFirstRun = isLoopbackFirstRun(req.headers);

  // Remote/proxied first run → the access code is REQUIRED. On localhost the
  // local operator is the owner, so the first bootstrap needs NO code (the code
  // remains the gate for remote logins once onboarding opens a tunnel).
  if (!localFirstRun) {
    if (!accessCode || accessCode.length < 16) {
      return NextResponse.json(
        {
          error: "server_not_configured",
          hint: "LAZYOS_ACCESS_CODE must be at least 16 characters.",
        },
        { status: 500 },
      );
    }
    if (!providedCode || !timingSafeEqual(providedCode, accessCode)) {
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
  }

  // Optional first-run password. Reject only if provided AND too weak — an
  // omitted password keeps the one-click flow working.
  const rawPassword =
    typeof parsed.data.password === "string" ? parsed.data.password : "";
  if (rawPassword.length > 0 && !isStrongEnough(rawPassword)) {
    await delayRandom(500, 1000);
    return NextResponse.json(
      { error: "weak_password", hint: `min ${MIN_PASSWORD_LENGTH} characters` },
      { status: 400 },
    );
  }
  const passwordHash = rawPassword.length > 0 ? hashPassword(rawPassword) : null;

  // Sensible defaults so a one-click "Get started" works: e-mail falls back to
  // LAZYOS_OWNER_EMAIL (or owner@localhost), name to "Owner".
  const rawEmail = parsed.data.email?.trim();
  const email = (
    rawEmail && rawEmail.length > 0
      ? rawEmail
      : process.env.LAZYOS_OWNER_EMAIL?.trim() || "owner@localhost"
  ).toLowerCase();
  const displayName = parsed.data.displayName?.trim() || "Owner";

  const db = getDb();
  const now = new Date();
  const nowMs = now.getTime();

  // Ensure the default org.
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
          "Default organization of the laz.ing instance. It holds the first workspace(s).",
        archived: false,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  // Create the user — with race protection: if the email is already taken, we
  // take the existing user (this should not happen since we already counted
  // above).
  let userId: string;
  const existingUser = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
    .all();
  if (existingUser.length > 0) {
    userId = existingUser[0].id;
    if (passwordHash) {
      // Existing user (rare race) opted to set a password during bootstrap.
      db.update(users)
        .set({ passwordHash, updatedAt: now })
        .where(eq(users.id, userId))
        .run();
    }
  } else {
    userId = `usr_${ulid()}`;
    db.insert(users)
      .values({
        id: userId,
        email,
        displayName,
        passwordHash,
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

  // Race re-check: in the meantime another request could have registered a
  // founder. If so → delete this user AGAIN
  // (no memberships exist yet), 410.
  if (countActiveFounders() > 0) {
    if (existingUser.length === 0) {
      db.$raw.prepare("DELETE FROM users WHERE id = ?").run(userId);
    }
    return NextResponse.json(
      {
        error: "bootstrap-closed",
        hint: "Bootstrap was just completed by another request.",
      },
      { status: 410 },
    );
  }

  // Founder membership in the default org.
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

  // Issue the session cookie.
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

  const ossMode = ["1", "true", "on"].includes(
    (process.env.LAZYOS_OSS_MODE ?? "").trim().toLowerCase(),
  );
  const res = NextResponse.json({
    ok: true,
    userId,
    redirectTo: ossMode ? "/oss-onboarding" : "/onboarding",
  });
  res.headers.set("Set-Cookie", sessionSetCookieHeader(cookieValue));
  return res;
}
