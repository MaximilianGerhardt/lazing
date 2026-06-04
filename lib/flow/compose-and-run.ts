/**
 * Flow Studio — compose-and-run spine (Track-D · 2026-05-27).
 *
 * Source: docs/plans/2026-05-27_flow-studio-architecture.md (Chat → Flow → Run).
 *
 * This file is the RUNNABLE SPINE that connects the three already-built P2 building
 * blocks (composeFlowFromIntent · dispatchFlow · the existing plan-executor) into ONE
 * end-to-end path:
 *
 *   Intent ──composeFlowFromIntent──▶ flow_template + flow_steps + missingTools
 *        │
 *        ├─ missingTools ≠ ∅ (and not autoRun) ──▶ { status:'needs-coupling', … }
 *        │       (the credential-coupling surface takes over; NO dispatch)
 *        │
 *        └─ otherwise (or autoRun) ──dispatchFlow──▶ workstreams run + flow_run + steps
 *                               └─triggerFlowExecution──▶ executePlan (EXISTING)
 *                                      └─▶ { status:'running', flowId, runId, workstreamId }
 *
 * ── Which execution trigger? ────────────────────────────────────────────────
 *   The EXISTING sequential/parallel plan-executor:
 *     lib/workstreams/plan-executor.ts → executePlan({ workstreamId, workspaceId,
 *                                                       planId, coordKey })
 *   That is exactly the same trigger that POST /api/workstreams/[id]/execute-plan
 *   uses (Slice 3 · Phase 1). NO new engine (N4 — substrate discipline).
 *
 *   dispatchFlow creates a workstreams run + the root plan steps (with
 *   depends_on from the flow DAG), but returns ONLY { runId, workstreamId } —
 *   the internally assigned planId (PLAN-<ulid>) is not in the return value. The
 *   plan-executor NEEDS a planId, but falls back (plan-executor.ts:331–338)
 *   to ALL root steps if the planId matches no steps. A freshly
 *   created workstream via dispatchFlow has EXACTLY one plan → we read the
 *   real planId directly from the persisted root steps (resolvePlanId), so that
 *   the executor runs exactly the just-dispatched plan (no fallback path).
 *
 * ── Why an extracted core function (instead of logic in the route handler)? ──
 *   The NextRequest auth + JSON parsing live in the route handler (hard to test
 *   without an HTTP harness). The business logic (compose → branch → dispatch →
 *   trigger) lives HERE as a pure, injectable function `composeAndRun`:
 *     - `db` is the raw better-sqlite3 handle (like the entire flow surface).
 *     - `decompose`/`callEngine`/`hasCredential` are passed 1:1 to
 *       composeFlowFromIntent (test stubs without LLM/vault).
 *     - `triggerExecution` is injectable (default = the real plan-executor) →
 *       the test checks "trigger CALLED / NOT called" without a background run.
 *
 * Discipline:
 *   - N1: intent passed through verbatim (no .slice — composeFlowFromIntent
 *         persists it verbatim as template.name/description).
 *   - N2 (fail-closed): missingTools blocks the run, UNLESS autoRun is
 *         explicitly set (owner override) — then it dispatches anyway, because
 *         the real live call is AGAIN gated by LAZYOS_CONNECTOR_LIVE + invoke.ts
 *         (default dry-run). No silent waving-through.
 *   - N4: NO new execution engine — we call the existing executePlan.
 *   - N6: deterministic branching; the only non-deterministic
 *         element (LLM decompose) is factored out as a parameter.
 *   - N9: workspaceId/orgId passed through as scope.
 */

import { composeFlowFromIntent, type ComposeFlowInput } from "./compose";
import { dispatchFlow } from "./execute";
import type { MediaStep, MissingTool } from "./compose";
import {
  buildMediaStyleChoicePayload,
  resolveMediaStyle,
  type MediaStyleChoicePayload,
  type ResolvedMediaStyle,
} from "./media-styles";
import {
  createPendingFlowRun,
  emitFlowPendingPersistedEvent,
  logComposeAndRunStep,
  makeRequestId,
  updateFlowRunFlowId,
  updateFlowRunStatus,
} from "./persistence";
import {
  runDiscovery as defaultRunDiscovery,
  type DiscoveryResult,
  type RunDiscoveryOpts,
} from "@/lib/discovery/discovery-phase";
import { emitOrUpdateCard } from "@/lib/events/emit-or-update-card";

type RawDb = import("better-sqlite3").Database;

// ---------------------------------------------------------------------------
// Phase 1 (2026-05-29) — discovery/pending wiring: 3 fail-soft helpers.
// Deliberately mirror the canonical patterns from plan-dispatch.ts so the
// /flow path gets the same discovery semantics as the plan path.
// ---------------------------------------------------------------------------

/**
 * Place the discovery block BEFORE the WHY block (owner spec: discovery > WHY >
 * intent). Strictly fail-soft / identity path: both empty ⇒ undefined ⇒
 * compose prompt bit-identical to the path without discovery. 1:1 mirror of
 * plan-dispatch.ts::composeDiscoveryAndWhy.
 */
function mergeDiscoveryAndWhy(
  discoveryBlock: string | undefined,
  whyBlock: string | undefined,
): string | undefined {
  const d = (discoveryBlock ?? "").trim();
  const w = (whyBlock ?? "").trim();
  if (d.length === 0 && w.length === 0) return undefined;
  if (d.length === 0) return w;
  if (w.length === 0) return d;
  return `${d}\n\n${w}`;
}

/**
 * Best-effort wrapper around emitOrUpdateCard for the <surface:discovery> card.
 * compose-and-run has NO workstream BEFORE the dispatch (unlike
 * plan-dispatch, which already called createWorkstream) → a synthetic
 * workstreamId stand-in `flow-discovery:<reqId>` that is STABLE across the
 * deterministic re-compose. Stable ⇒ idempotent UPDATE instead of card spam.
 * Never throws meaningfully (the caller additionally wraps with try/catch).
 */
async function defaultEmitDiscoverySurface(input: {
  readonly workspaceId: string;
  readonly reqId: string;
  readonly result: DiscoveryResult;
}): Promise<void> {
  const workstreamId = `flow-discovery:${input.reqId}`;
  await emitOrUpdateCard({
    coords: {
      workspaceId: input.workspaceId,
      workstreamId,
      surfaceKind: "discovery",
      subKey: "discovery",
    },
    content: `<surface:discovery>${JSON.stringify({
      workspaceId: input.workspaceId,
      workstreamId,
      status: "done",
      urls: input.result.urls.map((u) => ({
        url: u.url,
        status: u.status,
        ...(u.title ? { title: u.title } : {}),
      })),
      pendingDocRequests: input.result.pendingDocRequests,
    })}</surface:discovery>`,
    actor: "system",
  });
}

/**
 * Attaches reqId + flowRunId to a thrown error so the route handler
 * can write both into the HTTP error response (4xx/5xx) (owner spec:
 * error response contains reqId + flowRunId). Defensive: mutates only object
 * errors; primitive throws / frozen props are silently ignored.
 */
function attachFlowRunIdToError(
  err: unknown,
  reqId: string,
  flowRunId: string | null,
): void {
  if (err && typeof err === "object") {
    try {
      (err as Record<string, unknown>).reqId = reqId;
      if (flowRunId) (err as Record<string, unknown>).flowRunId = flowRunId;
    } catch {
      // defensive: some errors have frozen props — ignore.
    }
  }
}

// ---------------------------------------------------------------------------
// Execution trigger — injectable, default = the existing plan-executor.
// ---------------------------------------------------------------------------

/**
 * Signature of the execution trigger. Default calls lib/workstreams/plan-executor.ts
 * ::executePlan — exactly the trigger that /api/workstreams/[id]/execute-plan
 * uses. In tests a spy is injected (no real background run).
 *
 * Best-effort: the plan-executor is a background run (the route returns
 * immediately). We do NOT `await` it in the spine — errors are logged but
 * never kill the response (same posture as execute-plan/route.ts).
 */
export type TriggerFlowExecutionFn = (input: {
  readonly workstreamId: string;
  readonly workspaceId: string;
}) => void;

/**
 * Reads the planId of a freshly dispatched workstream from the persisted
 * root plan steps. dispatchFlow creates EXACTLY one plan; all its root steps
 * carry the same plan_id. Returns null if (unexpectedly) no root steps are
 * present — then the default trigger falls back to "all root steps" anyway.
 *
 * Direct query on the raw handle (no getDb() singleton) so the
 * resolution stays in-memory testable (same discipline as execute.ts).
 */
export function resolvePlanId(db: RawDb, workstreamId: string): string | null {
  try {
    const row = db
      .prepare(
        `SELECT plan_id FROM workstream_plan_steps
           WHERE workstream_id = ? AND depth = 0
           ORDER BY step_index ASC LIMIT 1`,
      )
      .get(workstreamId) as { plan_id?: string } | undefined;
    return row?.plan_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Default trigger: calls the EXISTING executePlan in the background (no
 * await, best-effort — like execute-plan/route.ts). Reads the real planId from
 * the root steps + derives the coordKey in the canonical N9 format
 * ("<workspaceId>/<workstreamId>", identical to execute-plan/route.ts).
 *
 * Lazy import of executePlan so the pure compose-needs-coupling branch
 * (no run) NEVER loads the executor + its heavy transitive closure.
 */
export function makeDefaultTrigger(db: RawDb): TriggerFlowExecutionFn {
  return ({ workstreamId, workspaceId }) => {
    const planId = resolvePlanId(db, workstreamId) ?? `flow:${workstreamId}`;
    const coordKey = `${workspaceId}/${workstreamId}`;
    void import("@/lib/workstreams/plan-executor")
      .then(({ executePlan }) =>
        executePlan({ workstreamId, workspaceId, planId, coordKey }),
      )
      .catch((err: unknown) => {
        console.error(
          "[flow/compose-and-run] executePlan background error:",
          err instanceof Error ? err.message : String(err),
        );
      });
  };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Owner-made style choices for media steps (Stream B2): map from
 * STEP KEY → MediaStyleOption.id (e.g. {"media:video:0": "video-higgsfield"}).
 *
 * ── Keying model (robustness fix · 2026-05-29) ──────────────────────────────
 *   Since the Opus switch, the decompose is NON-DETERMINISTIC: a
 *   re-compose of the same intent can give the media steps a different stepId (always a new
 *   ULID) AND a different idx (the position shifts when the decompose inserts/
 *   reorders steps). A styleChoices map keyed on stepId OR
 *   String(idx) then NO longer matches → the system hangs at
 *   'needs-style-choice' instead of dispatching (empirically 3–4 re-POSTs needed).
 *
 *   So the PRIMARY, re-compose-stable key is a CANONICAL
 *   media ordinal: `media:<kind>:<n>` — the n-th (0-based) media step
 *   of its type in compose order (e.g. "media:video:0" = first video,
 *   "media:image:1" = second image). This survives the re-compose because it depends
 *   on neither the ULID nor the absolute idx, only on the RELATIVE
 *   order of media steps of the same kind — exactly what the owner made
 *   the choice against. NO title hash (would break on a minimal LLM rephrasing
 *   of the title).
 *
 *   BACKWARDS-COMPATIBLE (fail-soft): lookupStyleChoice tries in this
 *   order — (1) media:<kind>:<ordinal>, (2) flow_steps.id (persisted-
 *   flow path), (3) String(idx) (old key). A hit on ANY
 *   key suffices; existing idx keys keep working.
 *
 * As long as a media step has NO entry, composeAndRun pauses with
 * status 'needs-style-choice' (instead of unilaterally assuming ONE provider).
 */
export type MediaStyleChoices = Readonly<Record<string, string>>;

export interface ComposeAndRunInput {
  /** Raw operator intent (verbatim, N1). */
  readonly intent: string;
  /** ManifestCoord scope (N9). */
  readonly workspaceId: string;
  /** Optional org scope (passed through). */
  readonly orgId?: string | null;
  /**
   * Owner style choices per media step (Stream B2). Without a (complete) choice,
   * composeAndRun returns status 'needs-style-choice' with the options, INSTEAD
   * of unilaterally choosing ONE provider (PA-Chat finding hero video).
   * Additive + backwards-compatible: if the field is missing AND no
   * media steps exist, composeAndRun behaves exactly as before.
   */
  readonly styleChoices?: MediaStyleChoices;
  /**
   * Owner override: dispatch + execute immediately despite missingTools. The real
   * live call stays gated by LAZYOS_CONNECTOR_LIVE (default dry-run) — autoRun
   * bypasses ONLY the needs-coupling pause, NOT the live gate.
   */
  readonly autoRun?: boolean;
  /** Test stub for the decomposition (no real LLM). 1:1 to compose. */
  readonly decompose?: ComposeFlowInput["decompose"];
  /** LLM adapter for the default decompose (when no decompose). 1:1 to compose. */
  readonly callEngine?: ComposeFlowInput["callEngine"];
  /** Credential existence check. 1:1 to compose (default = COUNT on api_credentials). */
  readonly hasCredential?: ComposeFlowInput["hasCredential"];
  /**
   * A3 (Self-Learning/WHY): a pre-rendered WHY context block (earlier
   * rationales + active beliefs of this workspace) that the default decompose
   * prepends to the plan prompt → consistent, justified composition. Passed 1:1
   * to compose. Missing/empty ⇒ bit-identical to behavior without WHY.
   */
  readonly whyContext?: ComposeFlowInput["whyContext"];
  /**
   * Injectable execution trigger (test spy). Default = makeDefaultTrigger(db)
   * → the existing executePlan background run.
   */
  readonly triggerExecution?: TriggerFlowExecutionFn;
  /** onCycle switch for dispatchFlow (default 'error'). */
  readonly onCycle?: Parameters<typeof dispatchFlow>[1]["onCycle"];
  /**
   * Track-D (2026-05-29) — request correlation ID. Optional. If not
   * set, composeAndRun generates one itself. Written into every log marker
   * + every flow_runs row + every flow_pending_persisted event.
   * Owner verification path: `tail /tmp/lazyos-prod-4200.log | grep
   * "compose-and-run req=<id>"` + `SELECT * FROM flow_runs WHERE req_id = ?`.
   */
  readonly reqId?: string;
  /**
   * Phase 1 — finding 2 (2026-05-29): discovery phase BEFORE composeFlowFromIntent.
   * If the operator intent contains URLs or doc mentions, compose-and-
   * run first calls `runDiscovery` (same mechanism as plan-dispatch) and prepends
   * the `builtContext` to the `whyContext` (order per owner spec:
   * discovery > WHY > intent). Fail-soft: a throw in the discovery does
   * NOT topple the compose; on empty/missing output the prompt stays
   * bit-identical to the path without discovery.
   *
   * Injectable for tests (stub instead of real net I/O). Default = the real
   * `runDiscovery` from `lib/discovery/discovery-phase.ts`.
   */
  readonly runDiscovery?: (opts: RunDiscoveryOpts) => Promise<DiscoveryResult>;
  /**
   * Optional emit hook for the `<surface:discovery>` card. Called after
   * a successful discovery if the result contains URLs OR
   * doc mentions. Fail-soft: a throw does NOT topple the compose path.
   * Default = a best-effort wrapper around `emitOrUpdateCard` (workspaceId as
   * the workstream-coord stand-in, because compose-and-run still has
   * NO workstream before the dispatch — plan-dispatch has already
   * called `createWorkstream` at that point, compose-and-run has NOT).
   *
   * Injectable for tests (spy without a real DB insert into the events table).
   */
  readonly emitDiscoverySurface?: (input: {
    readonly workspaceId: string;
    readonly reqId: string;
    readonly result: DiscoveryResult;
  }) => Promise<void> | void;
}

/**
 * A single media step + its quickchoice payload (Stream B2). The
 * payload is already in renderer format (`<surface:prompt variant=quickchoice>`)
 * — the /flow front door only writes it into the stream.
 */
export interface MediaStyleChoicePrompt {
  /** The media step (stepId/stepTitle/kind). */
  readonly step: MediaStep;
  /** The quickchoice surface payload (renderer format). */
  readonly payload: MediaStyleChoicePayload;
  /**
   * Robustness fix (2026-05-29): the CANONICAL, re-compose-stable
   * key `media:<kind>:<n>` of this step. The /flow front door SHOULD
   * re-POST the owner choice under THIS key (instead of String(idx) or
   * stepId) so the matching survives the non-deterministic re-compose.
   * Both old keys remain accepted fail-soft.
   */
  readonly styleChoiceKey: string;
}

/**
 * Track-D (2026-05-29) — persistence-trail fields that EVERY branch returns
 * (once the compose succeeded). The owner sees:
 *
 *   - reqId       — correlation UI ↔ server log ↔ DB.
 *   - flowRunId   — the persisted flow_runs.id (for polling/SSE watch).
 *
 * Before Track-D only the 'running' branch returned a runId; needs-coupling
 * + needs-style-choice left the owner in the dark (master context §10 finding 2).
 */
export interface ComposeAndRunPersistenceTrail {
  readonly reqId: string;
  /**
   * The persisted flow_runs.id. NULL only if the early pending stub
   * failed (DB migration drift) — the HTTP response still remains
   * fail-soft.
   */
  readonly flowRunId: string | null;
}

export type ComposeAndRunResult = ComposeAndRunPersistenceTrail &
  (
    | {
        /**
         * Stream B2: at least one media step still has NO owner style choice.
         * The /flow front door presents a quickchoice payload per step.
         * NO dispatch, NO unilateral provider choice.
         */
        readonly status: "needs-style-choice";
        readonly flowId: string;
        /** One quickchoice payload + the step per open media step. */
        readonly styleChoices: readonly MediaStyleChoicePrompt[];
      }
    | {
        readonly status: "needs-coupling";
        readonly flowId: string;
        readonly missingTools: readonly MissingTool[];
      }
    | {
        readonly status: "running";
        readonly flowId: string;
        readonly runId: string;
        readonly workstreamId: string;
      }
  );

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Composes a flow from the intent and — depending on missingTools/autoRun —
 * pauses for credential coupling OR dispatches + triggers execution.
 *
 * Track-D (2026-05-29) — repro persistence trail (master context §10 finding 2):
 *   IMMEDIATELY after a successful composeFlowFromIntent a flow_runs row
 *   with status='pending' is written (createPendingFlowRun). EVERY branch
 *   (needs-style-choice / needs-coupling / running / compose error) returns
 *   reqId + flowRunId — the owner verification path stays visible,
 *   even when dispatch+engine take 60s+. Status transitions: pending →
 *   running (in runDispatchedFlow → updateFlowRunStatus). On dispatch
 *   error: pending → failed + errorMessage (local try/catch here).
 *
 *   Structured server log markers: each branch emits a
 *   `[compose-and-run req=<id>] …` via logComposeAndRunStep.
 *
 * @throws FlowComposeError (from compose.ts) on invalid intent/scope/decompose.
 *         — Thrown before the flow_runs stub; the caller (route.ts) gets
 *         no flowRunId because the composition itself failed. Persisting
 *         the error is the caller's job (route.ts catches both errors).
 * @throws FlowDispatchError (from execute.ts) on an empty flow / cycle.
 *         — We catch THIS internally: set status='failed' on the
 *         pending stub, write errorMessage/code, and re-throw it,
 *         so route.ts builds the correct 4xx response.
 */
export async function composeAndRun(
  db: RawDb,
  input: ComposeAndRunInput,
): Promise<ComposeAndRunResult> {
  const reqId = input.reqId ?? makeRequestId();
  const startedAt = Date.now();

  logComposeAndRunStep(reqId, "start", {
    workspaceId: input.workspaceId,
    autoRun: input.autoRun === true,
    styleChoicesCount: input.styleChoices
      ? Object.keys(input.styleChoices).length
      : 0,
    intentHead: input.intent.slice(0, 50), // Log-only truncation — DB writes verbatim (N1).
  });

  // 0. Phase 1 / finding 1 — EARLY pending stub BEFORE composeFlowFromIntent.
  //    The REAL flow_template.id does not exist yet; we use a
  //    synthetic placeholder `pending:<reqId>` as flow_id and backfill
  //    the real flowId after a successful compose. This way — as required by the
  //    owner — a DB trail is created even when the claude-cli compose
  //    hits the 60s timeout on a long brief or throws on JSON parse (finding 1
  //    from 2026-05-29_phase1-wave2-e2e-report.md). The route handler can
  //    read `flowRunId` from the thrown error (see attachFlowRunIdToError).
  const placeholderFlowId = `pending:${reqId}`;
  const earlyPending = createPendingFlowRun(db, {
    flowId: placeholderFlowId,
    workspaceId: input.workspaceId,
    reqId,
  });
  let flowRunId: string | null = earlyPending?.id ?? null;
  logComposeAndRunStep(reqId, "persist pending (early)", {
    flowRunId,
    placeholderFlowId,
    persisted: earlyPending != null,
  });

  // 0b. Phase 1 / finding 2 — discovery BEFORE composeFlowFromIntent. Fail-soft:
  //     a throw in fetch/parse does not topple the compose; on empty output
  //     the plan prompt stays bit-identical to the path without discovery (N6).
  //     Order per owner spec: discovery > WHY > intent — we prepend
  //     the discovery block before the incoming whyContext.
  const runDiscoveryFn = input.runDiscovery ?? defaultRunDiscovery;
  const emitDiscovery =
    input.emitDiscoverySurface ?? defaultEmitDiscoverySurface;
  let discoveryResult: DiscoveryResult | null = null;
  try {
    discoveryResult = await runDiscoveryFn({
      intent: input.intent,
      workspaceId: input.workspaceId,
    });
    logComposeAndRunStep(reqId, "discovery ok", {
      urls: discoveryResult.urls.length,
      docMentions: discoveryResult.pendingDocRequests.length,
      hasContext: discoveryResult.builtContext.length > 0,
    });
  } catch (discErr) {
    const m = discErr instanceof Error ? discErr.message : String(discErr);
    logComposeAndRunStep(reqId, "discovery fail-soft", { message: m });
    // Deliberate fall-through: discoveryResult stays null, the compose runs
    // bit-identical to the path without discovery.
  }

  // 0c. Surface emit for the discovery card. Only if there is anything to
  //     show — NO empty discovery block in the UI. Fail-soft.
  if (
    discoveryResult &&
    (discoveryResult.urls.length > 0 ||
      discoveryResult.pendingDocRequests.length > 0)
  ) {
    try {
      await emitDiscovery({
        workspaceId: input.workspaceId,
        reqId,
        result: discoveryResult,
      });
    } catch (emitErr) {
      const m = emitErr instanceof Error ? emitErr.message : String(emitErr);
      logComposeAndRunStep(reqId, "discovery emit fail-soft", { message: m });
    }
  }

  // 0d. Place the discovery builtContext before the whyContext (discovery > WHY).
  const effectiveWhyContext = mergeDiscoveryAndWhy(
    discoveryResult?.builtContext,
    input.whyContext,
  );

  // 1. Composition (persists flow_template + flow_steps + reports
  //    missingTools). In try/catch — on throw we mark the early
  //    pending stub as 'failed' (with a verbatim error_message, N1) and
  //    re-throw with an attached flowRunId so the route can deliver the ID in
  //    the HTTP response.
  let composed: Awaited<ReturnType<typeof composeFlowFromIntent>>;
  try {
    composed = await composeFlowFromIntent(db, {
      intent: input.intent,
      workspaceId: input.workspaceId,
      orgId: input.orgId ?? null,
      decompose: input.decompose,
      callEngine: input.callEngine,
      hasCredential: input.hasCredential,
      whyContext: effectiveWhyContext,
    });
  } catch (composeErr) {
    const message =
      composeErr instanceof Error ? composeErr.message : String(composeErr);
    const code =
      composeErr && typeof composeErr === "object" && "code" in composeErr
        ? String((composeErr as { code: unknown }).code)
        : "compose-error";
    logComposeAndRunStep(reqId, "compose throw", { code, message });
    console.error(
      `[compose-and-run req=${reqId}] compose throw error=${message}`,
    );
    if (flowRunId) {
      updateFlowRunStatus(db, {
        runId: flowRunId,
        status: "failed",
        errorMessage: message,
        errorCode: code,
      });
    }
    // Attach reqId+flowRunId to the error so the route handler can forward it in
    // the HTTP response (owner spec: response 500/4xx contains
    // reqId+flowRunId).
    attachFlowRunIdToError(composeErr, reqId, flowRunId);
    throw composeErr;
  }

  const flowId = composed.template.id;
  const styleChoices = input.styleChoices ?? {};

  logComposeAndRunStep(reqId, "compose ok", {
    flowId,
    mediaSteps: composed.mediaSteps.length,
    missingTools: composed.missingTools.length,
    dur_ms: Date.now() - startedAt,
  });

  // 1b. Backfill: write the real flow_id into the early pending stub
  //     (placeholder `pending:<reqId>` → flowId). Fail-soft.
  if (flowRunId) {
    updateFlowRunFlowId(db, { runId: flowRunId, flowId });
    logComposeAndRunStep(reqId, "persist pending (backfill flow_id)", {
      flowRunId,
      flowId,
    });
  }

  // 2. Stream B2 — media style choice BEFORE any provider assumption. If a
  //    media step (tool:image|video|avatar) still has NO owner style choice,
  //    we pause with the options — INSTEAD of unilaterally taking ONE provider
  //    (PA-Chat finding hero video → wrong heygen type → stuck).
  //    autoRun does NOT skip this pause: the style choice is a substantive
  //    owner decision, not a mere credential gate (unlike needs-coupling).
  // Robustness fix (2026-05-29): compute canonical ordinal keys ONCE over all
  // media steps (media:<kind>:<n>) → re-compose-stable matching.
  const ordinalKeys = computeMediaOrdinalKeys(composed.mediaSteps);
  const unresolvedMedia = composed.mediaSteps.filter(
    (m) =>
      lookupStyleChoice(styleChoices, m, ordinalKeys.get(m.stepId)) == null,
  );
  if (unresolvedMedia.length > 0) {
    logComposeAndRunStep(reqId, "branch=needs-style-choice", {
      unresolvedMedia: unresolvedMedia.length,
      dur_ms: Date.now() - startedAt,
    });
    if (flowRunId) {
      emitFlowPendingPersistedEvent(db, {
        workspaceId: input.workspaceId,
        flowRunId,
        flowId,
        reqId,
        status: "needs-style-choice",
      });
    }
    return {
      reqId,
      flowRunId,
      status: "needs-style-choice",
      flowId,
      styleChoices: unresolvedMedia.map((step) => ({
        step,
        styleChoiceKey:
          ordinalKeys.get(step.stepId) ?? String(step.idx),
        payload: buildMediaStyleChoicePayload({
          flowId,
          stepId: step.stepId,
          stepTitle: step.stepTitle,
          stepKind: step.kind,
          // Robustness fix: re-compose-stable key in the payload so
          // the quickchoice click handler sends it along on the re-POST.
          styleChoiceKey: ordinalKeys.get(step.stepId) ?? String(step.idx),
        }),
      })),
    };
  }

  // 2b. All media steps are style-chosen → the choice now determines the
  //     connector need. Only 'connector' styles can trigger a coupling;
  //     'procedural'/'css'/'placeholder' need NO connector — the
  //     corresponding compose-missingTools entry is dropped (N2:
  //     deliberate owner decision, no silent waving-through of a live call).
  const effectiveMissingTools = recomputeMissingTools(
    composed.missingTools,
    composed.mediaSteps,
    styleChoices,
    ordinalKeys,
  );

  // 3. Branching (N2 fail-closed): unconnected tools block the run, unless
  //    the owner has explicitly set autoRun.
  if (effectiveMissingTools.length > 0 && !input.autoRun) {
    logComposeAndRunStep(reqId, "branch=needs-coupling", {
      missingTools: effectiveMissingTools.length,
      providers: effectiveMissingTools.map((m) => m.provider).join(","),
      dur_ms: Date.now() - startedAt,
    });
    if (flowRunId) {
      emitFlowPendingPersistedEvent(db, {
        workspaceId: input.workspaceId,
        flowRunId,
        flowId,
        reqId,
        status: "needs-coupling",
      });
    }
    return {
      reqId,
      flowRunId,
      status: "needs-coupling",
      flowId,
      missingTools: effectiveMissingTools,
    };
  }

  // 4. Dispatch (workstreams run + flow_run + plan steps) + execution trigger.
  //    We catch FlowDispatchError locally → set the pending stub to
  //    'failed' + re-throw (route.ts builds the 4xx response).
  const trigger = input.triggerExecution ?? makeDefaultTrigger(db);
  try {
    const dispatched = runDispatchedFlow(db, {
      flowId,
      workspaceId: input.workspaceId,
      trigger,
      onCycle: input.onCycle,
    });
    // dispatchFlow creates its OWN flow_runs row (createFlowRun in
    // execute.ts). The early pending stub stays as a correlation anchor with
    // reqId — we mark it 'running' and fill in the now-
    // known workstreamId. So `SELECT * FROM flow_runs WHERE
    // req_id = ?` finds BOTH: the stub (with reqId) and the dispatch run.
    if (flowRunId) {
      updateFlowRunStatus(db, {
        runId: flowRunId,
        status: "running",
        workstreamId: dispatched.workstreamId,
      });
    }
    logComposeAndRunStep(reqId, "branch=running", {
      flowRunId,
      dispatchedRunId: dispatched.runId,
      workstreamId: dispatched.workstreamId,
      dur_ms: Date.now() - startedAt,
    });
    return {
      reqId,
      flowRunId,
      ...dispatched,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "dispatch_failed";
    logComposeAndRunStep(reqId, "branch=error", {
      where: "dispatch",
      code,
      message,
      dur_ms: Date.now() - startedAt,
    });
    if (flowRunId) {
      updateFlowRunStatus(db, {
        runId: flowRunId,
        status: "failed",
        errorMessage: message,
        errorCode: code,
      });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Stream B2 — style-choice resolution
// ---------------------------------------------------------------------------

/**
 * Computes for each media step its CANONICAL, re-compose-stable
 * ordinal key `media:<kind>:<n>` — n is the 0-based rank of the step
 * AMONG the media steps of its type, in compose order. Example:
 * two videos + one image ⇒ {first video: "media:video:0", image: "media:image:0",
 * second video: "media:video:1"}.
 *
 * Order = ascending by step.idx (compose order). Stable across a
 * re-compose because only the RELATIVE order of media
 * steps of the same kind matters (not ULID, not absolute idx). Returns a map stepId →
 * canonicalKey.
 */
export function computeMediaOrdinalKeys(
  mediaSteps: readonly MediaStep[],
): ReadonlyMap<string, string> {
  const ordered = [...mediaSteps].sort((a, b) => a.idx - b.idx);
  const counters = new Map<string, number>();
  const keyByStepId = new Map<string, string>();
  for (const step of ordered) {
    const n = counters.get(step.kind) ?? 0;
    keyByStepId.set(step.stepId, `media:${step.kind}:${n}`);
    counters.set(step.kind, n + 1);
  }
  return keyByStepId;
}

/** Format of the canonical ordinal key (documented for tests/callers). */
export function mediaOrdinalKey(kind: MediaStep["kind"], ordinal: number): string {
  return `media:${kind}:${ordinal}`;
}

/**
 * Reads the style choice of a media step. Tries in this order
 * (robustness fix · 2026-05-29):
 *   1. CANONICAL ordinal key `media:<kind>:<n>` (re-compose-stable,
 *      preferred — survives a new ULID AND a shifted idx).
 *   2. flow_steps.id (persisted-flow path — when /flow reuses the flow).
 *   3. String(idx) (old key — backwards-compatible, fail-soft).
 * A hit on ANY key suffices. Returns the non-empty
 * option id or null.
 *
 * `ordinalKey` is the canonical key of this step precomputed via
 * computeMediaOrdinalKeys(step) (or undefined if not computable).
 */
function lookupStyleChoice(
  choices: Readonly<Record<string, string>>,
  step: MediaStep,
  ordinalKey?: string,
): string | null {
  if (ordinalKey) {
    const byOrdinal = choices[ordinalKey];
    if (typeof byOrdinal === "string" && byOrdinal.trim().length > 0)
      return byOrdinal;
  }
  const byId = choices[step.stepId];
  if (typeof byId === "string" && byId.trim().length > 0) return byId;
  const byIdx = choices[String(step.idx)];
  if (typeof byIdx === "string" && byIdx.trim().length > 0) return byIdx;
  return null;
}

/**
 * Resolves the style choice of ONE media step → concrete approach/provider.
 *
 * This is the per-step function from the Stream B2 task: after the choice
 * the provider/coupling need is determined. 'connector' options ⇒
 * needsConnector:true (provider/capabilities set); 'procedural'/'css'/
 * 'placeholder' ⇒ needsConnector:false (no external need).
 *
 * @throws MediaStyleError('unknown_option') when optionId does not belong to the kind.
 */
export function applyStyleChoice(
  step: MediaStep,
  optionId: string,
): ResolvedMediaStyle {
  return resolveMediaStyle(step.kind, optionId);
}

/**
 * Recomputes the effective missingTools AFTER the style choices.
 *
 *   - For each media step with a chosen 'connector' style: the compose-
 *     missingTools entry stays (coupling needed). If the chosen
 *     provider does NOT match the compose hint (e.g. a future second
 *     connector option), the entry is corrected to the chosen provider.
 *   - For each media step with a 'procedural'/'css'/'placeholder' style: the
 *     compose-missingTools entry is DROPPED (no connector needed).
 *   - Non-media steps (e.g. future tool:* skills without a style model) stay
 *     unchanged in the list (fail-closed default).
 */
function recomputeMissingTools(
  composeMissing: readonly MissingTool[],
  mediaSteps: readonly MediaStep[],
  styleChoices: Readonly<Record<string, string>>,
  ordinalKeys?: ReadonlyMap<string, string>,
): readonly MissingTool[] {
  const mediaByStepId = new Map(mediaSteps.map((m) => [m.stepId, m]));
  const keys = ordinalKeys ?? computeMediaOrdinalKeys(mediaSteps);
  const out: MissingTool[] = [];

  for (const mt of composeMissing) {
    const media = mediaByStepId.get(mt.stepId);
    if (media == null) {
      // Not a media step → take over unchanged (fail-closed).
      out.push(mt);
      continue;
    }
    const optionId = lookupStyleChoice(
      styleChoices,
      media,
      keys.get(media.stepId),
    );
    // Defensive: without a choice we wouldn't be here at all (needs-style-choice above).
    if (optionId == null) {
      out.push(mt);
      continue;
    }
    const resolved = applyStyleChoice(media, optionId);
    if (!resolved.needsConnector) {
      // procedural/css/placeholder → no connector, entry drops out.
      continue;
    }
    // connector style: entry stays; set provider/capabilities to the CHOICE
    // (may differ from the compose default hint).
    out.push({
      ...mt,
      provider: resolved.provider,
      neededCapabilities: resolved.neededCapabilities,
    });
  }

  return out;
}

/**
 * Shared dispatch+trigger path — used by composeAndRun (autoRun/connected) AND
 * by the [flowId]/run route (after successful credential coupling). Creates
 * the run and calls the execution trigger.
 *
 * @throws FlowDispatchError on an empty flow / unknown flowId / cycle.
 */
export function runDispatchedFlow(
  db: RawDb,
  args: {
    readonly flowId: string;
    readonly workspaceId: string;
    readonly parentTicketId?: string | null;
    readonly trigger?: TriggerFlowExecutionFn;
    readonly onCycle?: Parameters<typeof dispatchFlow>[1]["onCycle"];
    /** Slice 2 (2026-06-03): {{param.*}} values for runtime interpolation. */
    readonly params?: Parameters<typeof dispatchFlow>[1]["params"];
  },
): {
  readonly status: "running";
  readonly flowId: string;
  readonly runId: string;
  readonly workstreamId: string;
} {
  const dispatched = dispatchFlow(db, {
    flowId: args.flowId,
    workspaceId: args.workspaceId,
    parentTicketId: args.parentTicketId ?? null,
    ...(args.onCycle ? { onCycle: args.onCycle } : {}),
    ...(args.params ? { params: args.params } : {}),
  });

  const trigger = args.trigger ?? makeDefaultTrigger(db);
  trigger({
    workstreamId: dispatched.workstreamId,
    workspaceId: args.workspaceId,
  });

  return {
    status: "running",
    flowId: args.flowId,
    runId: dispatched.runId,
    workstreamId: dispatched.workstreamId,
  };
}
