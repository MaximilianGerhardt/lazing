/**
 * GET  /api/onboarding/state            — current user's state
 * POST /api/onboarding/state {step, completed?, displayName?}
 *   - markiert step als completed, schreibt currentStep auf next
 *   - bei step='done' setzt onboarding_completed_at
 *   - displayName aktualisiert users.display_name
 */

import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { users } from "@/db/schema/users";
import {
  defaultState,
  isOnboardingStep,
  nextStep,
  parseState,
  type OnboardingState,
} from "@/lib/onboarding/state";
import { loadCurrentUser } from "@/lib/users/service";
import { writeAudit } from "@/lib/audit/write";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const user = loadCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }
  const state =
    parseState(user.onboardingState) ?? defaultState("new");
  return NextResponse.json({
    user: {
      id: user.id,
      displayName: user.displayName,
      email: user.email,
    },
    state,
    completedAt:
      user.onboardingCompletedAt instanceof Date
        ? user.onboardingCompletedAt.toISOString()
        : null,
  });
}

interface PostBody {
  step?: string;
  completed?: boolean;
  displayName?: string;
  /** Locale aus Step `profile`. */
  locale?: string;
  /** Patch in `state.data` (Org-/Workspace-Auswahl, Claude-Max-Status, …). */
  dataPatch?: {
    chosenOrgId?: string | null;
    workspaceId?: string | null;
    claudeMaxStatus?: "shared" | "own";
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
  if (!isOnboardingStep(stepRaw)) {
    return NextResponse.json({ error: "invalid-step" }, { status: 400 });
  }
  const step = stepRaw;

  const db = getDb();
  const now = new Date();
  const current: OnboardingState =
    parseState(user.onboardingState) ?? defaultState("new");

  if (body.completed === true) {
    if (!current.completedSteps.includes(step)) {
      current.completedSteps.push(step);
    }
    const next = nextStep(step);
    if (next) {
      current.currentStep = next;
    }
  } else {
    current.currentStep = step;
  }

  if (body.dataPatch) {
    current.data = { ...(current.data ?? {}), ...body.dataPatch };
  }

  const completing = step === "done" && body.completed === true;
  if (completing) {
    current.completedAt = now.toISOString();
  }

  const setPatch: Record<string, unknown> = {
    onboardingState: JSON.stringify(current),
    updatedAt: now,
  };
  if (completing) {
    setPatch.onboardingCompletedAt = now;
  }
  if (body.displayName && body.displayName.trim().length > 0) {
    setPatch.displayName = body.displayName.trim().slice(0, 80);
  }
  if (
    typeof body.locale === "string" &&
    /^[a-z]{2}-[A-Z]{2}$/.test(body.locale)
  ) {
    setPatch.locale = body.locale;
  }

  db.update(users).set(setPatch).where(eq(users.id, user.id)).run();

  writeAudit({
    actor: `user:${user.id}`,
    action: completing ? "user.created" : "magic.verified",
    targetUserId: user.id,
    payload: { onboarding_step: step, completed: body.completed === true },
  });

  return NextResponse.json({ ok: true, state: current });
}
