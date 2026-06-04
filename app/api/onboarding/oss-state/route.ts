/**
 * GET  /api/onboarding/oss-state       — current user's OSS wizard state
 * POST /api/onboarding/oss-state {step, completed?, skipped?, dataPatch?}
 *
 * Track B. Persisted separately from `onboarding_state` (see migration 0054).
 * Marks a step as completed/skipped and advances `currentStep` to next().
 * When `step='done' && completed=true`, `oss_onboarding_completed_at` is set.
 *
 * Skippable: any step can be marked with `skipped: true` — it then lands in
 * `skippedSteps[]` (for audit + later re-prompt logic).
 *
 * Audit: every mutation appends an `onboarding.*` row to `audit_log` via
 * writeAudit — never the closed `events` enum.
 */

import { NextResponse, type NextRequest } from "next/server";
import { eq, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { users } from "@/db/schema/users";
import {
  defaultOssState,
  isOssOnboardingStep,
  nextOssStep,
  parseOssState,
  type ConnectState,
  type DetectedEngine,
  type OssOnboardingState,
  type UsagePurpose,
} from "@/lib/onboarding/oss-state";
import { loadCurrentUser } from "@/lib/users/service";
import { writeAudit } from "@/lib/audit/write";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const user = loadCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }
  const raw = readOssStateColumn(user.id);
  const state = parseOssState(raw) ?? defaultOssState();
  return NextResponse.json({
    user: { id: user.id, displayName: user.displayName, email: user.email },
    state,
    completedAt: readOssCompletedAt(user.id),
  });
}

interface PostBody {
  step?: string;
  completed?: boolean;
  skipped?: boolean;
  dataPatch?: {
    engine?: DetectedEngine | null;
    systemcheckStatus?: "passed" | "degraded" | "failed" | "skipped" | null;
    fullAccessStatus?: "granted" | "partial" | "skipped" | "not-required" | null;
    installSummary?: string | null;
    connect?: ConnectState;
    usagePurpose?: UsagePurpose | null;
    workspaceRoot?: string | null;
    workspaceLabel?: string | null;
    workspaceSensitivity?: "low" | "normal" | "high";
    githubStatus?: "connected" | "skipped" | null;
    githubAccount?: string | null;
    finalizeStatus?: "ready" | "degraded" | "skipped" | null;
    pushStatus?: "granted" | "denied" | "skipped" | null;
    notificationsEnabled?: boolean;
    preferredEngine?: string;
  };
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = loadCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const stepRaw = body.step ?? "";
  if (!isOssOnboardingStep(stepRaw)) {
    return NextResponse.json({ error: "invalid-step" }, { status: 400 });
  }
  const step = stepRaw;

  const db = getDb();
  const now = new Date();
  const current: OssOnboardingState =
    parseOssState(readOssStateColumn(user.id)) ?? defaultOssState();

  if (body.completed === true || body.skipped === true) {
    if (!current.completedSteps.includes(step)) {
      current.completedSteps.push(step);
    }
    if (body.skipped === true && !current.skippedSteps.includes(step)) {
      current.skippedSteps.push(step);
    }
    const next = nextOssStep(step);
    if (next) current.currentStep = next;
  } else {
    current.currentStep = step;
  }

  if (body.dataPatch) {
    // Shallow-merge `connect` so a single engine update never wipes siblings.
    const mergedConnect: ConnectState = {
      ...(current.data?.connect ?? {}),
      ...(body.dataPatch.connect ?? {}),
    };
    current.data = {
      ...(current.data ?? {}),
      ...body.dataPatch,
      ...(body.dataPatch.connect ? { connect: mergedConnect } : {}),
    };
  }
  current.lastActivityAt = now.toISOString();

  const completing = step === "done" && body.completed === true;
  if (completing) {
    current.completedAt = now.toISOString();
  }

  // Direct SQL — the new columns exist via migration 0054, but the stable
  // Drizzle schema may not type them yet.
  const stateJson = JSON.stringify(current);
  db.run(sql`
    UPDATE users
       SET oss_onboarding_state = ${stateJson},
           updated_at = ${now.getTime()}
     WHERE id = ${user.id}
  `);

  if (completing) {
    db.run(sql`
      UPDATE users SET oss_onboarding_completed_at = ${now.getTime()}
       WHERE id = ${user.id}
    `);
  }

  writeAudit({
    actor: `user:${user.id}`,
    action: completing ? "onboarding.completed" : "onboarding.step",
    targetUserId: user.id,
    payload: {
      oss_onboarding_step: step,
      completed: body.completed === true,
      skipped: body.skipped === true,
    },
  });

  return NextResponse.json({ ok: true, state: current });
}

function readOssStateColumn(userId: string): string | null {
  const db = getDb();
  const rows = db
    .select({ s: sql<string | null>`oss_onboarding_state` })
    .from(users)
    .where(eq(users.id, userId))
    .all();
  return rows[0]?.s ?? null;
}

function readOssCompletedAt(userId: string): string | null {
  const db = getDb();
  const rows = db
    .select({ ts: sql<number | null>`oss_onboarding_completed_at` })
    .from(users)
    .where(eq(users.id, userId))
    .all();
  const ts = rows[0]?.ts ?? null;
  return ts ? new Date(ts).toISOString() : null;
}
