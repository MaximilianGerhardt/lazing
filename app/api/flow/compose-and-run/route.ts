/**
 * POST /api/flow/compose-and-run
 *
 * Flow Studio — Chat → Flow → Run (Track-D · 2026-05-27).
 *
 * Body: { intent: string, workspaceId: string, autoRun?: boolean,
 *         styleChoices?: Record<string,string> }
 *
 * Ablauf (lib/flow/compose-and-run.ts::composeAndRun):
 *   1. composeFlowFromIntent → flow_template + flow_steps + missingTools.
 *   2. Stream B2 (Stil-Wahl): hat ein Medien-Schritt (tool:image|video|avatar)
 *      noch KEINE Owner-Stil-Wahl in `styleChoices` → 200 { status:
 *      'needs-style-choice', flowId, styleChoices:[{step,styleChoiceKey,payload}…] }
 *      — die /flow-Front-Door zeigt pro Schritt eine quickchoice-Surface, sammelt
 *      die Wahl(en) und RE-POSTet denselben Intent MIT `styleChoices`, keyed auf
 *      den KANONISCHEN, re-compose-stabilen `styleChoiceKey` (`media:<kind>:<n>`,
 *      Robustheits-Fix 2026-05-29). Dieser Schlüssel übersteht den
 *      NICHT-DETERMINISTISCHEN Opus-Decompose, bei dem sowohl die ULID-stepId als
 *      auch der absolute idx beim Re-Compose wechseln können. Alt-Schlüssel
 *      (stepId, String(idx)) bleiben fail-soft akzeptiert. KEIN dispatch.
 *   3. missingTools ≠ ∅ (und nicht autoRun) → 200 { status:'needs-coupling',
 *      flowId, missingTools } — die Credential-Kopplungs-Surface übernimmt.
 *   4. sonst (oder autoRun) → dispatchFlow + Execution-Trigger (der BESTEHENDE
 *      executePlan-Background-Run) → 200 { status:'running', flowId, runId,
 *      workstreamId }.
 *
 * Warum Re-POST statt eigenem apply-style-Endpunkt (minimal-invasiv, auth-gleich):
 *   composeAndRun akzeptiert `styleChoices` BEREITS als Input + der Re-Compose-Pfad
 *   über den kanonischen `media:<kind>:<n>`-Schlüssel ist explizit dafür gebaut
 *   (lib/flow/compose-and-run.ts::computeMediaOrdinalKeys + lookupStyleChoice).
 *   Ein eigener Endpunkt müsste den persistierten Flow neu laden +
 *   missingTools/mediaSteps rekonstruieren — mehr Code, dieselbe Auth. Der
 *   Re-POST teilt Auth-Gate + Engine-Wahl 1:1 mit dem Erst-Compose.
 *
 * Auth: Workspace-Member (Subject-Gate kopiert aus
 *   app/api/workspaces/[id]/credentials/route.ts — 401 → 403). KEIN cross-scope.
 *
 * Engine: der Default-Decompose nutzt den bestehenden Plan-Proposer
 *   (proposePlan via makeRecursivePlanDecompose). Wir wählen die Engine wie
 *   lib/plan-first/plan-dispatch.ts — codex AUSGESCHLOSSEN (Code-Mode-Agent),
 *   claude-cli/ollama genügen für reines Plan-JSON.
 *
 * ADDITIV: keine bestehende Route berührt, kein next build/start, :4200 bleibt.
 */

import { NextResponse, type NextRequest } from "next/server";

import { getDb } from "@/db/client";
import { currentUserIdResolved } from "@/lib/security/subject-server";
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from "@/lib/security/permissions";
import { detectEngines, pickEngine } from "@/lib/llm/engines/selector";
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
   * Stream B2: Owner-getroffene Stil-Wahlen pro Medien-Schritt. Map von
   * SCHRITT-SCHLÜSSEL → MediaStyleOption.id. Der bevorzugte Schlüssel ist der
   * KANONISCHE, re-compose-stabile `media:<kind>:<n>` (styleChoiceKey aus der
   * needs-style-choice-Antwort, Robustheits-Fix 2026-05-29). flow_steps.id und
   * String(step.idx) bleiben fail-soft akzeptiert. 1:1 an composeAndRun.
   */
  styleChoices?: unknown;
}

function isValidWorkspaceId(id: string): boolean {
  return /^[a-z0-9_(][a-z0-9_()-]{0,63}$/i.test(id);
}

/**
 * Validiert + normalisiert den optionalen styleChoices-Body-Param zu einem
 * `Record<string,string>`. Nur nicht-leere String-Schlüssel mit nicht-leeren
 * String-Werten werden übernommen (N6: deterministisch, fail-soft — fremde/leere
 * Einträge werden still verworfen, NICHT der ganze Request abgelehnt). Liefert
 * undefined, wenn nichts Brauchbares dabei ist (= verhält sich wie der Erst-Compose).
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
  // Track-D (2026-05-29) — Request-Korrelation. Generiert vor allem
  // Auth/Body-Validation, damit JEDER Log-Eintrag (auch 401/403/400) die
  // reqId trägt. Owner-Verifikations-Pfad: `tail -f /tmp/lazyos-prod-4200.log
  // | grep "compose-and-run req="`.
  const reqId = makeRequestId();
  const startedAt = Date.now();
  logComposeAndRunStep(reqId, "route start", {
    method: req.method,
    path: req.nextUrl?.pathname ?? "/api/flow/compose-and-run",
  });

  // 1. Auth-Gate (member-or-higher) — Vorlage credentials/route.ts.
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

  // 2. Body parsen.
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

  // 3. Workspace-Permission (member-or-higher; Viewer/fremde User → 403).
  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, workspaceId))) {
    logComposeAndRunStep(reqId, "route response", {
      status: 403,
      reason: "forbidden",
      workspaceId,
      dur_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ error: "forbidden", reqId }, { status: 403 });
  }

  // 4. Engine für den Default-Decompose wählen (codex ausgeschlossen — wie
  //    plan-dispatch.ts). Ohne Engine → 503 (kein Plan komponierbar).
  const selection = await detectEngines();
  const engine = pickEngine(selection, ["codex-cli"]);
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
  // Root-Cause-Fix (Track-D · 2026-05-29): die claude-cli-Engine hat
  // DEFAULT_TIMEOUT_MS = 60_000 (lib/llm/engines/claude-cli.ts:28). Ein
  // realer Decompose („Ich möchte eine Website erstellen …") braucht über die
  // MAX-Plan-Keychain-Route empirisch 38–57s PRO LLM-Call — und der
  // Recursive-Plan-Decompose (makeRecursivePlanDecompose) kettet MEHRERE
  // Calls (Root-Plan + Sub-Plans). Erfolgreiche Runs lagen bei 38s/57s, alle
  // die >60s brauchten kippten in `claude-cli timeout after 60000ms` → 500 →
  // flow_runs blieb auf `pending` (22/22 Runs nie `done`). Wir geben dem
  // Compose-Call darum explizit Headroom (kein Default-60s). Die Engine killt
  // den Subprozess weiterhin nach diesem Limit (kein Leak), nur eben groß
  // genug für die kaskadierende Plan-Komposition. Analog zu
  // plan-dispatch.ts::PLANNER_CALL_TIMEOUT_MS, aber höher: compose kettet Calls.
  const COMPOSE_ENGINE_TIMEOUT_MS = 180_000;
  const callEngine = async (prompt: string): Promise<string> => {
    const r = await engine.chat({
      messages: [{ role: "user", content: prompt }],
      timeoutMs: COMPOSE_ENGINE_TIMEOUT_MS,
    });
    return r.text;
  };

  // 4b. A3 (Self-Learning/WHY): frühere Begründungen + aktive Beliefs dieses
  //     Workspace als Decompose-Kontext voranstellen → konsistente, begründete
  //     Komposition ("wir haben X gewählt, weil … letztes Mal"). Strikt fail-soft:
  //     ein Fehler beim Read-Back darf die Komposition NIE kippen (leerer Block ⇒
  //     bit-identisch zum Verhalten ohne WHY). Lesen ist workspace-gescoped (N9).
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

  // 5. Compose → branch → (dispatch + trigger). Der Default-Trigger ruft den
  //    bestehenden executePlan-Background-Run (makeDefaultTrigger).
  //    Track-D: reqId wird durchgereicht, damit composeAndRun denselben
  //    Korrelations-Faden in DB + Log + Response trägt.
  try {
    const result = await composeAndRun(getDb().$raw, {
      intent, // N1: verbatim
      workspaceId,
      autoRun,
      callEngine,
      reqId,
      // A3: WHY-Kontext (leer ⇒ nicht gesetzt ⇒ bit-identisch).
      ...(whyContext ? { whyContext } : {}),
      // Stream B2: nur setzen, wenn brauchbar — sonst bleibt der Erst-Compose
      // bit-identisch zum Verhalten vor dieser Verdrahtung.
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
