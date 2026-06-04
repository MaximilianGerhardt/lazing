/**
 * GET  /api/onboarding/full-access            — probe the current posture (B4)
 * POST /api/onboarding/full-access {action}   — run a guided action
 *
 * Guided + detected, NEVER a hard gate. Actions:
 *   - "fda-probe-helper"           : run the proxy Full-Disk-Access probe
 *   - "enable-background-service"  : install the routines-tick LaunchAgent
 *
 * On Linux / Windows the posture is "not-required" and the actions are noops.
 * Session-gated. Every action appends an `onboarding.full-access.*` audit row.
 */

import { NextResponse, type NextRequest } from "next/server";

import { loadCurrentUser } from "@/lib/users/service";
import { writeAudit } from "@/lib/audit/write";
import {
  enableBackgroundService,
  probeFullAccess,
  runFdaProbe,
} from "@/lib/onboarding/full-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const user = loadCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }
  return NextResponse.json(probeFullAccess());
}

interface PostBody {
  action?: string;
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

  let result;
  switch (body.action) {
    case "fda-probe-helper":
      result = runFdaProbe();
      break;
    case "enable-background-service":
      result = enableBackgroundService();
      break;
    default:
      return NextResponse.json({ error: "unknown-action" }, { status: 400 });
  }

  writeAudit({
    actor: `user:${user.id}`,
    action: "onboarding.full-access.action",
    targetUserId: user.id,
    payload: { action: result.action, outcome: result.outcome },
  });

  return NextResponse.json({ result, probe: probeFullAccess() });
}
