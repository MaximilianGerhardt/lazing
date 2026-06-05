/**
 * POST /api/auth/password/set — set or change your own password (session-gated).
 *
 * Body: { newPassword, currentPassword? }.
 * - If you already have a password, currentPassword must match (change).
 * - If you have none yet (magic-link user opting in), no currentPassword needed
 *   — the active session is the proof of identity.
 *
 * "Forgot password" has no separate flow on purpose: log in via the magic link,
 * then set a new password here.
 */

import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { users } from "@/db/schema/users";
import { loadCurrentUser } from "@/lib/users/service";
import { hashPassword, verifyPassword, isStrongEnough, MIN_PASSWORD_LENGTH } from "@/lib/security/password";
import { writeAudit } from "@/lib/audit/write";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  newPassword?: unknown;
  currentPassword?: unknown;
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = loadCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  if (!isStrongEnough(newPassword)) {
    return NextResponse.json(
      { error: "weak_password", hint: `min ${MIN_PASSWORD_LENGTH} characters` },
      { status: 400 },
    );
  }

  const db = getDb();
  const row = db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1)
    .all()[0];

  // Changing an existing password requires the current one.
  if (row?.passwordHash) {
    const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
    if (!verifyPassword(current, row.passwordHash)) {
      return NextResponse.json({ error: "wrong_current_password" }, { status: 403 });
    }
  }

  const hash = hashPassword(newPassword);
  db.update(users)
    .set({ passwordHash: hash, updatedAt: new Date() })
    .where(eq(users.id, user.id))
    .run();

  writeAudit({
    actor: `user:${user.id}`,
    action: row?.passwordHash ? "auth.password-changed" : "auth.password-set",
    targetUserId: user.id,
  });

  return NextResponse.json({ ok: true });
}
