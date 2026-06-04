/**
 * POST /api/flow/compose-and-run
 *
 * Flow Studio — Chat → Flow → Run (Track-D · 2026-05-27).
 *
 * Body: { intent: string, workspaceId: string, autoRun?: boolean,
 *         styleChoices?: Record<string,string> }
 *
 * Flow (lib/flow/compose-and-run.ts::composeAndRun):
 *   1. composeFlowFromIntent → flow_template + flow_steps + missingTools.
 *   2. Stream B2 (style choice): a media step (tool:image|video|avatar) still has
 *      NO owner style choice in `styleChoices` → 200 { status:
 *      'needs-style-choice', flowId, styleChoices:[{step,styleChoiceKey,payload}…] }
 *      — the /flow front door shows a quickchoice surface per step, collects
 *      the choice(s) and RE-POSTs the same intent WITH `styleChoices`, keyed on
 *      the CANONICAL, re-compose-stable `styleChoiceKey` (`media:<kind>:<n>`,
 *      robustness fix 2026-05-29). This key survives the
 *      NON-DETERMINISTIC Opus decompose, where both the ULID stepId and
 *      the absolute idx can change on re-compose. Legacy keys
 *      (stepId, String(idx)) remain fail-soft accepted. NO dispatch.
 *   3. missingTools ≠ ∅ (and not autoRun) → 200 { status:'needs-coupling',
 *      flowId, missingTools } — the credential-coupling surface takes over.
 *   4. otherwise (or autoRun) → dispatchFlow + execution trigger (the EXISTING
 *      executePlan background run) → 200 { status:'running', flowId, runId,
 *      workstreamId }.
 *
 * Why re-POST instead of a dedicated apply-style endpoint (minimal-invasive, same auth):
 *   composeAndRun ALREADY accepts `styleChoices` as input + the re-compose path
 *   via the canonical `media:<kind>:<n>` key is built explicitly for it
 *   (lib/flow/compose-and-run.ts::computeMediaOrdinalKeys + lookupStyleChoice).
 *   A dedicated endpoint would have to reload the persisted flow +
 *   reconstruct missingTools/mediaSteps — more code, same auth. The
 *   re-POST shares auth gate + engine choice 1:1 with the first compose.
 *
 * Auth: workspace member (subject gate copied from
 *   app/api/workspaces/[id]/credentials/route.ts — 401 → 403). NO cross-scope.
 *
 * Engine: the default decompose uses the existing plan proposer
 *   (proposePlan via makeRecursivePlanDecompose). We pick the engine like
 *   lib/plan-first/plan-dispatch.ts — codex EXCLUDED (code-mode agent),
 *   claude-cli/ollama suffice for pure plan JSON.
 *
 * ADDITIVE: no existing route touched, no next build/start, :4200 stays.
 */

import { NextResponse, type NextRequest } from "next/server";

import { getDb } from "@/db/client";
import { currentUserIdResolved } from "@/lib/security/subject-server";
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from "@/lib/security/permissions";
import { detectEngines, pickEngine } from "@/lib/llm/engines/selector";
import { protectEngine } from "@/lib/privacy/protect";
import { composeAndRun } from "@/lib/flow/compose-and-run";
import { FlowComposeError } from "@/lib/flow/compose";
import { FlowDispatchError } from "@/lib/flow/execute";
import {
  logComposeAndRunStep,
  makeRequestId,
} from "@/lib/flow/persistence";
import {
  buildWhyContext,
  renderWhyContextForPrompt,
} from "@/lib/reasoning/why-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PostBody {
  intent?: unknown;
  workspaceId?: unknown;
  autoRun?: unknown;
  /**
   * Stream B2: owner-made style choices per media step. Map of
   * STEP KEY → MediaStyleOption.id. The preferred key is the
   * CANONICAL, re-compose-stable `media:<kind>:<n>` (styleChoiceKey from the
   * needs-style-choice response, robustness fix 2026-05-29). flow_steps.id and
   * String(step.idx) remain fail-soft accepted. Passed 1:1 to composeAndRun.
   */
  styleChoices?: unknown;
}

function isValidWorkspaceId(id: string): boolean {
  return /^[a-z0-9_(][a-z0-9_()-]{0,63}$/i.test(id);
}

/**
 * Validates + normalizes the optional styleChoices body param into a
 * `Record<string,string>`. Only non-empty string keys with non-empty
 * string values are kept (N6: deterministic, fail-soft — foreign/empty
 * entries are silently dropped, NOT the whole request rejected). Returns
 * undefined when there is nothing usable (= behaves like the first compose).
 */
function parseStyleChoices(
  raw: unknown,
): Readonly<Record<string, string>> | undefined {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== "string" || k.trim().length === 0) continue;
    if (typeof v !== "string" || v.trim().length === 0) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function POST(req: NextRequest): Promise<Response> {
  // Track-D (2026-05-29) — request correlation. Generated before any
  // auth/body validation, so EVERY log entry (including 401/403/400) carries
  // the reqId. Owner verification path: `tail -f /tmp/lazyos-prod-4200.log
  // | grep "compose-and-run req="`.
  const reqId = makeRequestId();
  const startedAt = Date.now();
  logComposeAndRunStep(reqId, "route start", {
    method: req.method,
    path: req.nextUrl?.pathname ?? "/api/flow/compose-and-run",
  });

  // 1. Auth gate (member-or-higher) — template credentials/route.ts.
  const userId = currentUserIdResolved(req);
  if (!userId) {
    logComposeAndRunStep(reqId, "route response", {
      status: 401,
      reason: "auth-required",
      dur_ms: Date.now() - startedAt,
    });
    return NextResponse.json(
      { error: "auth-required", reqId },
      { status: 401 },
    );
  }

  // 2. Parse body.
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    logComposeAndRunStep(reqId, "route response", {
      status: 400,
      reason: "invalid_json",
      dur_ms: Date.now() - startedAt,
    });
    return NextResponse.json(
      { error: "invalid_json", reqId },
      { status: 400 },
    );
  }

  const intent = typeof body.intent === "string" ? body.intent : "";
  const workspaceId =
    typeof body.workspaceId === "string" ? body.workspaceId : "";
  const autoRun = body.autoRun === true;
  const styleChoices = parseStyleChoices(body.styleChoices);

  if (intent.trim().length === 0) {
    logComposeAndRunStep(reqId, "route response", {
      status: 400,
      reason: "invalid_intent",
      dur_ms: Date.now() - startedAt,
    });
    return NextResponse.json(
      { error: "invalid_intent", reqId },
      { status: 400 },
    );
  }
  if (!isValidWorkspaceId(workspaceId)) {
    logComposeAndRunStep(reqId, "route response", {
      status: 400,
      reason: "invalid_workspace_id",
      dur_ms: Date.now() - startedAt,
    });
    return NextResponse.json(
      { error: "invalid_workspace_id", reqId },
      { status: 400 },
    );
  }

  // 3. Workspace permission (member-or-higher; viewer/foreign user → 403).
  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, workspaceId))) {
    logComposeAndRunStep(reqId, "route response", {
      status: 403,
      reason: "forbidden",
      workspaceId,
      dur_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ error: "forbidden", reqId }, { status: 403 });
  }

  // 4. Pick the engine for the default decompose (codex excluded — like
  //    plan-dispatch.ts). Without an engine → 503 (no plan composable).
  const selection = await detectEngines();
  // PII vault: wrap at the engine boundary — the resolved pick is claude-cli
  // (cloud) and the decompose embeds the user intent verbatim (N1).
  const engine = protectEngine(workspaceId, pickEngine(selection, ["codex-cli"]));
  if (!engine) {
    logComposeAndRunStep(reqId, "route response", {
      status: 503,
      reason: "no_engine_available",
      dur_ms: Date.now() - startedAt,
    });
    return NextResponse.json(
      { error: "no_engine_available", reqId },
      { status: 503 },
    );
  }
  // Root-cause fix (Track-D · 2026-05-29): the claude-cli engine has
  // DEFAULT_TIMEOUT_MS = 60_000 (lib/llm/engines/claude-cli.ts:28). A
  // real decompose („Ich möchte eine Website erstellen …") empirically needs
  // 38–57s PER LLM call over the MAX-plan keychain route — and the
  // recursive plan decompose (makeRecursivePlanDecompose) chains MULTIPLE
  // calls (root plan + sub-plans). Successful runs landed at 38s/57s, all
  // that needed >60s tipped into `claude-cli timeout after 60000ms` → 500 →
  // flow_runs stayed at `pending` (22/22 runs never `done`). So we give the
  // compose call explicit headroom (no default-60s). The engine still kills
  // the subprocess after this limit (no leak), just large
  // enough for the cascading plan composition. Analogous to
  // plan-dispatch.ts::PLANNER_CALL_TIMEOUT_MS, but higher: compose chains calls.
  const COMPOSE_ENGINE_TIMEOUT_MS = 180_000;
  const callEngine = async (prompt: string): Promise<string> => {
    const r = await engine.chat({
      messages: [{ role: "user", content: prompt }],
      timeoutMs: COMPOSE_ENGINE_TIMEOUT_MS,
    });
    return r.text;
  };

  // 4b. A3 (self-learning/WHY): prepend earlier rationales + active beliefs of this
  //     workspace as decompose context → consistent, reasoned
  //     composition ("we chose X because … last time"). Strictly fail-soft:
  //     an error on read-back must NEVER tip the composition (empty block ⇒
  //     bit-identical to the behaviour without WHY). Reading is workspace-scoped (N9).
  let whyContext: string | undefined;
  try {
    const rendered = renderWhyContextForPrompt(
      buildWhyContext(getDb().$raw, { workspaceId, topic: intent }),
    );
    whyContext = rendered.trim().length > 0 ? rendered : undefined;
  } catch (err) {
    console.error(
      "[compose-and-run req=" + reqId + "] WHY-Kontext-Read fehlgeschlagen (non-fatal):",
      err instanceof Error ? err.message : String(err),
    );
  }

  // 5. Compose → branch → (dispatch + trigger). The default trigger calls the
  //    existing executePlan background run (makeDefaultTrigger).
  //    Track-D: reqId is passed through, so composeAndRun carries the same
  //    correlation thread in DB + log + response.
  try {
    const result = await composeAndRun(getDb().$raw, {
      intent, // N1: verbatim
      workspaceId,
      autoRun,
      callEngine,
      reqId,
      // A3: WHY context (empty ⇒ not set ⇒ bit-identical).
      ...(whyContext ? { whyContext } : {}),
      // Stream B2: only set when usable — otherwise the first compose stays
      // bit-identical to the behaviour before this wiring.
      ...(styleChoices ? { styleChoices } : {}),
    });
    logComposeAndRunStep(reqId, "route response", {
      status: 200,
      flowStatus: result.status,
      flowRunId: result.flowRunId,
      dur_ms: Date.now() - startedAt,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof FlowComposeError) {
      logComposeAndRunStep(reqId, "route response", {
        status: 400,
        reason: "compose_failed",
        code: err.code,
        message: err.message,
        dur_ms: Date.now() - startedAt,
      });
      return NextResponse.json(
        { error: err.code, message: err.message, reqId },
        { status: 400 },
      );
    }
    if (err instanceof FlowDispatchError) {
      const status = err.code === "flow_not_found" ? 404 : 400;
      logComposeAndRunStep(reqId, "route response", {
        status,
        reason: "dispatch_failed",
        code: err.code,
        message: err.message,
        dur_ms: Date.now() - startedAt,
      });
      return NextResponse.json(
        { error: err.code, message: err.message, reqId },
        { status },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    logComposeAndRunStep(reqId, "route response", {
      status: 500,
      reason: "compose_and_run_failed",
      message,
      dur_ms: Date.now() - startedAt,
    });
    return NextResponse.json(
      {
        error: "compose_and_run_failed",
        message,
        reqId,
      },
      { status: 500 },
    );
  }
}
