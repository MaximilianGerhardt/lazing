/**
 * POST /api/onboarding/finalize  — boot services, verify ports, complete (B5)
 *
 * Boots the agent server (if down), verifies web + agent ports, marks
 * `oss_onboarding_completed_at`, advances the wizard state to `done`, and sets
 * the `lazyos_onboarded` completion cookie so the first-run gate stops
 * redirecting. Returns the redirect target ("/").
 *
 * A degraded port verdict (agent not up) does NOT block completion — the
 * operator can boot it later via `scripts/lazyos-services.sh` / `pnpm dev:agent`.
 * Session-gated; appends `onboarding.finalize` to audit_log.
 */

import { NextResponse, type NextRequest } from "next/server";
import { eq, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { users } from "@/db/schema/users";
import { loadCurrentUser } from "@/lib/users/service";
import { writeAudit } from "@/lib/audit/write";
import {
  defaultOssState,
  parseOssState,
  type OssOnboardingState,
} from "@/lib/onboarding/oss-state";
import { finalizeServices } from "@/lib/onboarding/finalize";
import { buildOnboardedCookie } from "@/lib/onboarding/oss-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PostBody {
  /** Tests/CI may pass false to skip actually spawning the agent server. */
  bootAgent?: boolean;
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = loadCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  let body: PostBody = {};
  try {
    body = (await req.json()) as PostBody;
  } catch {
    body = {};
  }

  const finalize = await finalizeServices({ bootAgent: body.bootAgent });

  const db = getDb();
  const now = new Date();

  // Load current state, write the finalize verdict, advance to done.
  const stateRow = db
    .select({ s: sql<string | null>`oss_onboarding_state` })
    .from(users)
    .where(eq(users.id, user.id))
    .all()[0];
  const current: OssOnboardingState =
    parseOssState(stateRow?.s ?? null) ?? defaultOssState();
  current.data = {
    ...(current.data ?? {}),
    finalizeStatus: finalize.status,
  };
  if (!current.completedSteps.includes("finalize")) {
    current.completedSteps.push("finalize");
  }
  current.currentStep = "done";
  current.completedAt = now.toISOString();
  current.lastActivityAt = now.toISOString();

  db.run(sql`
    UPDATE users
       SET oss_onboarding_state = ${JSON.stringify(current)},
           oss_onboarding_completed_at = ${now.getTime()},
           updated_at = ${now.getTime()}
     WHERE id = ${user.id}
  `);

  writeAudit({
    actor: `user:${user.id}`,
    action: "onboarding.finalize",
    targetUserId: user.id,
    payload: {
      finalizeStatus: finalize.status,
      agentBooted: finalize.agentBooted,
      ports: finalize.ports,
    },
  });

  // Set the onboarded cookie so the Edge gate stops redirecting. Secure only
  // when the request arrived over https (localhost http setup still works).
  const isHttps =
    req.nextUrl.protocol === "https:" ||
    req.headers.get("x-forwarded-proto") === "https";
  const res = NextResponse.json({
    ok: true,
    finalize,
    redirect: "/",
    state: current,
  });
  res.headers.set("set-cookie", buildOnboardedCookie({ secure: isHttps }));
  return res;
}
