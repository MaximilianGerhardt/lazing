/**
 * GET  /api/system/preflight        — detect-only safe-healing preflight (B1)
 * POST /api/system/preflight {healers[]} — run the requested SAFE healers
 *
 * Session-gated (not in the middleware public allowlist). The systemcheck
 * wizard step calls GET to render the traffic-light, then POSTs the
 * auto-fixable healer ids when the user clicks "Fix safe issues".
 *
 * Only the frozen SELF_HEAL_IDS set is accepted — an unknown id yields 400.
 * Every action appends an `onboarding.preflight.*` row to audit_log.
 */

import { NextResponse, type NextRequest } from "next/server";

import { loadCurrentUser } from "@/lib/users/service";
import { writeAudit } from "@/lib/audit/write";
import {
  detectPreflight,
  isSelfHealId,
  preflightVerdict,
  runHealers,
  type SelfHealId,
} from "@/lib/onboarding/self-heal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const user = loadCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }
  const checks = await detectPreflight();
  const verdict = preflightVerdict(checks);
  const fixable = checks.filter((c) => c.fixable && c.severity !== "ok").map((c) => c.id);
  return NextResponse.json({ verdict, checks, fixable });
}

interface PostBody {
  healers?: unknown;
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

  if (!Array.isArray(body.healers) || body.healers.length === 0) {
    return NextResponse.json({ error: "no-healers" }, { status: 400 });
  }

  // Validate every id against the frozen allowlist — reject the whole request
  // if any id is unknown (no partial / best-effort acceptance of bad input).
  const ids: SelfHealId[] = [];
  for (const raw of body.healers) {
    if (typeof raw !== "string" || !isSelfHealId(raw)) {
      return NextResponse.json(
        { error: "unknown-healer", healer: typeof raw === "string" ? raw : null },
        { status: 400 },
      );
    }
    if (!ids.includes(raw)) ids.push(raw);
  }

  writeAudit({
    actor: `user:${user.id}`,
    action: "onboarding.preflight.heal",
    targetUserId: user.id,
    payload: { healers: ids },
  });

  const results = await runHealers(ids);

  // Re-run detection so the client can re-render the (hopefully greener) state.
  const checks = await detectPreflight();
  const verdict = preflightVerdict(checks);
  const fixable = checks.filter((c) => c.fixable && c.severity !== "ok").map((c) => c.id);

  return NextResponse.json({ results, verdict, checks, fixable });
}
