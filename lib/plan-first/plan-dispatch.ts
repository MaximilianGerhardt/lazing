/**
 * N6 hybrid plan dispatch (Slice 2, 2026-05-23).
 *
 * Connects the deterministic entry gate (`shouldDecompose`, N6) with the
 * LLM decomposer (`proposeRecursivePlan`) and turns a complex
 * intent into a persisted plan + subplans plus a `subplan` surface.
 *
 * Flow on a gate hit:
 *   1. Pick an engine (claude-cli → codex → ollama, fallback chain).
 *   2. `proposeRecursivePlan(maxDepth:1)` — root plan + eager subplans of the
 *      complex root steps (depth-1). Deeper = follow-up slice.
 *   3. Create the workstream (`createWorkstream`) — intent verbatim in
 *      `description` (N1).
 *   4. Persist steps atomically: root (depth 0) + subplans (depth 1) in
 *      `workstream_plan_steps`, all in ONE transaction (contentHash/N10).
 *   5. `subplan` surface via `emitOrUpdateCard` (path B → broadcast →
 *      /api/events/stream → ChatShell).
 *
 * IMPORTANT — process locality: MUST run in the **Next process** (route
 * `app/api/chat/stream`), NOT in the agent-server (:4201). `broadcast` is an
 * in-process EventEmitter; only in the Next process does the emit reach the live
 * SSE listeners of `/api/events/stream`. (Cross-roast finding 2026-05-23.)
 *
 * Scope cut (cross-roast C-E): ONLY propose + persist + render
 * (`awaitingApproval:true`). Execution (`runWalker` + approve→execute) is
 * a separate follow-up slice. The tier choice stays an LLM override.
 *
 * Known minor (documented, follow-up slice): if the persist step fails
 * (extremely rare — the plan would have to pass parseProposedPlan but hit the
 * insertPlanStep hard block), an empty workstream row is left behind.
 * The steps themselves are all-or-nothing via the transaction (no partial plan).
 */
import { shouldDecompose } from './should-decompose';
import { proposeRecursivePlan } from './recursive-plan';
import { getDb } from '@/db/client';
import { insertProposedPlan } from '@/lib/workstreams/plan-repo';
import { createWorkstream, updateWorkstream } from '@/lib/workstreams/service';
import { emitOrUpdateCard } from '@/lib/events/emit-or-update-card';
import { detectEngines, pickEngine } from '@/lib/llm/engines/selector';
import { protectEngine } from '@/lib/privacy/protect';
import { resourcePool } from '@/lib/agents/resource-pool';
import type { PoolSlot } from '@/lib/agents/resource-pool';
import { waitForBudget } from '@/lib/agents/tpm-budget';
import { writeDecision } from '@/lib/workstreams/trace-repo';
import { emitAnswerRequired } from '@/lib/push/triggers';
// W1b — self-learning P0 (2026-05-28): read-back of the WHY context (earlier
// rationales + active beliefs of this workspace) before every decompose. Template:
// app/api/flow/compose-and-run/route.ts:156-167. proposeRecursivePlan passes the
// string through unchanged at EVERY recursion level (root + eager subplans).
// Empty/missing block ⇒ bit-identical to the previous path.
import {
  buildWhyContext,
  renderWhyContextForPrompt,
} from '@/lib/reasoning/why-context';
// Slice C (2026-05-29) — discovery phase BEFORE plan decompose. Owner finding
// (example-website-3, verbatim): „Ich sehe niemanden der die Website recherchiert
// oder sich ansieht, da müsste doch eine Art Browser Bash erstmal kommen usw
// oder nicht?! Analyse, Recherche…". This phase detects URLs/domains/doc
// mentions in the prompt, fetches the URLs fail-soft and places the result as a
// Markdown block BEFORE the whyContext block — order: discovery > WHY > intent.
import { runDiscovery, type DiscoveryResult } from '@/lib/discovery/discovery-phase';

export interface PlanDispatchResult {
  readonly decomposed: boolean;
  readonly reason: string;
  readonly workstreamId?: string;
  readonly planId?: string;
  readonly rootSteps?: number;
  readonly subSteps?: number;
}

/** Per-call soft cap for a single planner LLM call (ms). */
const PLANNER_CALL_TIMEOUT_MS = 30_000;
/**
 * Hard overall deadline for the whole decompose (critic fix B2, 2026-05-23).
 * proposeRecursivePlan makes up to 1+N sequential LLM calls; without a cap
 * this could block the chat for minutes with no sign of life. If the
 * deadline is exceeded, the AbortController aborts all engine calls → tryPlanDispatch
 * throws → the caller falls back to the normal claude turn.
 */
const TOTAL_DEADLINE_MS = 40_000;
/**
 * Ultrathink (2026-06-02, default-off-gated). Deeper reasoning via
 * `--effort` takes longer — so the claude-cli path raises the per-call
 * and overall deadlines. Applies EXCLUSIVELY when the chosen planner
 * engine is claude-cli; every other path (ollama) uses
 * PLANNER_CALL_TIMEOUT_MS / TOTAL_DEADLINE_MS unchanged → byte-identical to before.
 */
const PLANNER_CALL_TIMEOUT_THINKING_MS = 90_000; // vs 30_000 default
const TOTAL_DEADLINE_THINKING_MS = 120_000; // vs 40_000 default

/**
 * Gate + decompose + persist + emit. Returns `{decomposed:false}` quickly
 * when the gate does not fire (or no engine is available) — the caller
 * then continues with the normal claude turn. On abort/deadline/error
 * in the heavy part the function throws; the caller treats that as a
 * fallback-to-normal.
 */
export async function tryPlanDispatch(args: {
  workspaceId: string;
  prompt: string;
  /** Client disconnect / request abort — aborts the decompose too (M1). */
  signal?: AbortSignal;
}): Promise<PlanDispatchResult> {
  // 1. Deterministic N6 gate (cheap, no LLM, no I/O).
  const gate = shouldDecompose(args.prompt);
  if (!gate.decompose) {
    return { decomposed: false, reason: gate.reason };
  }

  // 2. Pick an engine. B1 safety fix (critic, 2026-05-23): EXCLUDE codex
  //    — the codex adapter runs in code mode (`approval_policy="never"`, writes
  //    files/shell). The planner needs only text (plan JSON); claude-cli/ollama
  //    suffice. No engine → no decompose, normal turn.
  const selection = await detectEngines();
  // PII vault: wrap at the engine boundary. pickEngine(…,['codex-cli']) still
  // resolves to claude-cli (cloud) when available, so the planner prompt — which
  // embeds the verbatim user intent (N1) — must be tokenized before egress. The
  // wrapper is a pass-through for ollama / vault-off, and preserves engine.id so
  // the slot-kind + ultrathink gates below are unchanged.
  const engine = protectEngine(args.workspaceId, pickEngine(selection, ['codex-cli']));
  if (!engine) {
    return { decomposed: false, reason: 'no-engine-available' };
  }
  // N11 per-kind booking, correct: slot kind from the chosen engine.
  const slotKind: 'claude-cli' | 'ollama-heavy' =
    engine.id === 'ollama' ? 'ollama-heavy' : 'claude-cli';

  // Bundle the overall deadline + the external abort signal into ONE controller.
  const ctl = new AbortController();
  const onExternalAbort = (): void => ctl.abort();
  if (args.signal) {
    if (args.signal.aborted) ctl.abort();
    else args.signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  // Ultrathink: only the claude-cli path gets the raised overall deadline;
  // every other engine (ollama) keeps TOTAL_DEADLINE_MS → byte-identical.
  const totalDeadlineMs =
    engine.id === 'claude-cli' ? TOTAL_DEADLINE_THINKING_MS : TOTAL_DEADLINE_MS;
  const deadline = setTimeout(() => ctl.abort(), totalDeadlineMs);

  // Budget gate: acquire a slot from the ResourcePool (N11 hard cap: max 2 claude-cli
  // slots at once). Timeout 20s so a blocked planner does not hang the chat turn
  // forever — on timeout gracefully fall back to the normal turn.
  // TPM budget check right after: under high load waitForBudget sleeps briefly
  // before the planner starts another LLM call.
  let slot: PoolSlot | undefined;
  try {
    slot = await resourcePool.acquireSlot({
      kind: slotKind,
      subagentId: 'planner:' + args.workspaceId,
      priority: 'normal',
      timeoutMs: 20_000,
      signal: ctl.signal,
    });
  } catch (budgetErr) {
    // ResourcePoolTimeout or abort — no slot available, graceful fallback.
    clearTimeout(deadline);
    if (args.signal) args.signal.removeEventListener('abort', onExternalAbort);
    const msg = budgetErr instanceof Error ? budgetErr.message : String(budgetErr);
    return { decomposed: false, reason: 'budget-timeout:' + msg };
  }

  // Wait out TPM throttling (rolling 60s window). At >100% TPM the
  // function sleeps up to 30s — the caller's abort signal stops ctl in time.
  await waitForBudget('plan-dispatch:' + args.workspaceId);

  try {
    const callEngine = async (prompt: string): Promise<string> => {
      // Ultrathink: only claude-cli supports `--effort`; gate strictly on engine.id.
      // Default-off for ollama (the other permitted planner engine) →
      // there both prompt bytes AND timeouts stay byte-identical to the previous path.
      const useThinking = engine.id === 'claude-cli';
      const r = await engine.chat({
        messages: [{ role: 'user', content: prompt }],
        timeoutMs: useThinking ? PLANNER_CALL_TIMEOUT_THINKING_MS : PLANNER_CALL_TIMEOUT_MS,
        signal: ctl.signal,
        ...(useThinking ? { thinking: true } : {}),
      });
      return r.text;
    };

    // W1b — self-learning P0: read the WHY context fail-soft (see helper below).
    const whyContext = readWhyContextForDispatchFailSoft({
      workspaceId: args.workspaceId,
      topic: args.prompt,
    });

    // Slice C (2026-05-29) — create the workstream first, so we can emit
    // discovery as a visible surface (subKey='discovery') under the CORRECT coord
    // address — BEFORE the plan decompose / tier choice.
    //
    // Trade-off: on an engine failure in the proposeRecursivePlan call an
    // empty workstream row is left behind. The caller catches the throw and the outer
    // fallback uses a normal claude turn. The empty row does not matter
    // (status is set to 'done' at cleanup-end, or stays
    // 'proposed'/'active' and is reaped by the heartbeat reaper).
    //
    // 3. Create the workstream (owner of the plan). Intent verbatim (N1).
    const ws = await createWorkstream({
      workspaceId: args.workspaceId,
      name: planName(args.prompt),
      description: args.prompt,
    });
    const workstreamId = ws.id;
    const coordKey = `${args.workspaceId}/${workstreamId}`;

    // 4. Slice C — discovery phase BEFORE plan decompose. Fail-soft: a throw
    //    must not tip over the decompose; on error ⇒ empty discovery
    //    output ⇒ plan prompt bit-identical to the pre-Slice-C path.
    //
    //    Emit pattern (one card per workstream, subKey='discovery'):
    //      a) pre-emit „running" (one line, collapsed) — visible immediately.
    //      b) runDiscovery (parallel fetch, 12s per URL).
    //      c) post-emit „done" — same coords, idempotent (emitOrUpdateCard
    //         UPDATEs the row in-place).
    const discovery = await runDiscoveryAndEmitFailSoft({
      workspaceId: args.workspaceId,
      workstreamId,
      intent: args.prompt,
      signal: ctl.signal,
    });

    // 5. Decompose: root plan + eager depth-1 subplans.
    //    Order per the owner spec: discovery > WHY > intent. proposePlan
    //    places the whyContext string 1:1 before the base prompt
    //    (orchestrate-plan.ts:319-323). We concatenate discovery + WHY in
    //    the same order and pass the whole package through as „whyContext"
    //    — no new parameter, no signature break, identically empty
    //    path when both are empty.
    const composedContext = composeDiscoveryAndWhy(discovery.builtContext, whyContext);
    const recursive = await proposeRecursivePlan(args.prompt, {
      callEngine,
      maxDepth: 1,
      ...(composedContext ? { whyContext: composedContext } : {}),
    });
    const rootPlan = recursive.root.plan;

    // 5. Persist: root (depth 0) + all eager subplans (depth 1) in ONE
    //    outer transaction → the whole plan tree all-or-nothing (B1).
    let subSteps = 0;
    const persist = getDb().$raw.transaction((): void => {
      insertProposedPlan({ workstreamId, plan: rootPlan, depth: 0, coordKey });
      for (const [parentStepId, child] of recursive.root.children) {
        insertProposedPlan({
          workstreamId,
          plan: child.plan,
          depth: 1,
          coordKey,
          parentStepId,
        });
        subSteps += child.plan.steps.length;
      }
    });
    persist();

    // N8 trace (best-effort, non-fatal): record the decision „intent recognized
    // as multi-step → plan created" in workstream_decisions.
    // decision_kind='route' (gate routing decision), actor='agent'.
    // writeDecision internally writes a sentinel evidence row (source_kind='spawn')
    // so the evidence_refs ≥1 constraint is satisfied.
    writeDecision({
      workspaceId: args.workspaceId,
      workstreamId,
      coordKey,
      decisionKind: 'route',
      rationale: `Intent als mehrstufig erkannt → Plan erzeugt: ${gate.reason}`,
      actor: 'agent',
    });

    // 6. Emit the subplan surface (path B). Payload = ProposedPlan +
    //    depth/awaitingApproval (see SurfaceRenderer.renderSubplan).
    const surfacePayload = {
      ...rootPlan,
      depth: 0,
      awaitingApproval: true,
      workstreamId,
    };
    const childCount = recursive.root.children.size;
    await emitOrUpdateCard({
      coords: { workspaceId: args.workspaceId, workstreamId, surfaceKind: 'subplan' },
      content:
        `Das sieht nach einem mehrstufigen Vorhaben aus — hier mein Plan-Vorschlag ` +
        `(${rootPlan.steps.length} Schritte` +
        `${childCount > 0 ? `, ${childCount} davon mit eigenem Subplan` : ''}). ` +
        `Review & freigeben, oder sag mir, was anzupassen ist.\n\n` +
        `<surface:subplan>${JSON.stringify(surfacePayload)}</surface:subplan>`,
      actor: 'system',
    });

    // B2 (2026-05-25): answer_required push for the awaitingApproval subplan.
    // Best-effort / non-fatal — must never block the emitOrUpdateCard result.
    // The visibility gate applies inside the emitAnswerRequired body (no push when the tab is open).
    emitAnswerRequired({
      workspaceId: args.workspaceId,
      entityId: workstreamId,
      kind: 'approval',
      preview: `Plan "${planName(args.prompt)}" (${rootPlan.steps.length} Schritte) wartet auf Freigabe`,
      url: `/?workspace=${encodeURIComponent(args.workspaceId)}`,
    });

    // 7. Make the depth-1 subplans visible: emit a dedicated subplan card
    //    per child node (subKey='sub:<parentStepId>' — wave-7 discriminator).
    //
    //    `parentStep` = the root step whose id === parentStepId, so the
    //    SubplanCard can render the context header „Subplan — <Step-Titel>" (N1).
    //    `awaitingApproval: false` — approval runs via the root card (step 6).
    //
    //    Best-effort: an error on a single child emit does NOT kill the
    //    main flow (the plan is already persisted + the root card emitted).
    for (const [parentStepId, child] of recursive.root.children) {
      // Find the root step with the matching id (required field: id + title → isPlanStep).
      const parentStep = rootPlan.steps.find((s) => s.id === parentStepId) ?? null;

      const childPayload = {
        ...child.plan,
        depth: 1,
        awaitingApproval: false,
        workstreamId,
        // parentStep is read by the SurfaceRenderer and passed as a prop to SubplanCard;
        // there it drives the header „Subplan — <parentStep.title>".
        parentStep: parentStep ?? undefined,
        // Owner fix 2026-05-28 (owner live test: „extremst viele Surfaces auf
        // einmal"): child subplans start COLLAPSED — the parent subplan
        // stays open, each child is a pill with a chevron, one tap to
        // expand. Prevents T+0s 1+N subplan cards from flooding the
        // stream at once. Renderer-side: SubplanCard.initialCollapsed (read
        // via SurfaceRenderer.renderSubplan).
        collapsed: true,
      };

      try {
        await emitOrUpdateCard({
          coords: {
            workspaceId: args.workspaceId,
            workstreamId,
            surfaceKind: 'subplan',
            // Wave-7 subKey: must be non-empty (emitOrUpdateCard throws otherwise).
            subKey: 'sub:' + parentStepId,
          },
          content: `<surface:subplan>${JSON.stringify(childPayload)}</surface:subplan>`,
          actor: 'system',
        });
      } catch (childEmitErr) {
        // Just log — the main flow is not affected.
        console.warn(
          '[plan-dispatch] Depth-1-Subplan-Emit fehlgeschlagen',
          { parentStepId, err: childEmitErr },
        );
      }
    }

    // #3 fix (2026-05-23): do NOT leave the proposal workstream as "running".
    // It only waits for approval — otherwise /api/activity/live reports it forever as
    // background activity (the "7h37m" bug: status IN (active|paused|stuck)).
    // 'done' is not in that set. On real execution executePlan sets
    // 'active' again and 'done' at the end.
    try {
      await updateWorkstream(workstreamId, { status: 'done' });
    } catch (statusErr) {
      console.warn(
        '[plan-dispatch] Workstream-Status→done fehlgeschlagen (non-fatal):',
        statusErr instanceof Error ? statusErr.message : String(statusErr),
      );
    }

    return {
      decomposed: true,
      reason: gate.reason,
      workstreamId,
      planId: rootPlan.id,
      rootSteps: rootPlan.steps.length,
      subSteps,
    };
  } finally {
    clearTimeout(deadline);
    if (args.signal) args.signal.removeEventListener('abort', onExternalAbort);
    // Release the slot — guard against the timeout path above, where slot stays undefined.
    if (slot !== undefined) {
      resourcePool.releaseSlot(slot.slotId);
    }
  }
}

/** Short workstream label from the first prompt line (label, not a ledger field). */
function planName(prompt: string): string {
  const firstLine = (prompt.trim().split('\n')[0] ?? prompt.trim()).trim();
  if (firstLine.length <= 80) return firstLine || 'Plan';
  return `${firstLine.slice(0, 79)}…`;
}

/**
 * W1b — self-learning P0 (2026-05-28). Read-back of the WHY context
 * (earlier rationales + active beliefs) as a pill-readable string. Strictly
 * fail-soft: any error ⇒ undefined ⇒ proposeRecursivePlan sees NO
 * whyContext ⇒ prompt bytes bit-identical to the previous path (E1.3).
 *
 * Exported for unit tests — the real call lives in the decomposeAndPersist
 * main body. NO getDb singleton throw breaks the composition.
 *
 * Notes:
 *  - workspaceId empty/whitespace → buildWhyContext throws (N9 scope guard) →
 *    catch → undefined (no block).
 *  - Empty/whitespace-only renderer output → undefined (no block).
 */
export function readWhyContextForDispatchFailSoft(args: {
  workspaceId: string;
  topic: string;
}): string | undefined {
  try {
    const rendered = renderWhyContextForPrompt(
      buildWhyContext(getDb().$raw, {
        workspaceId: args.workspaceId,
        topic: args.topic,
      }),
    );
    return rendered.trim().length > 0 ? rendered : undefined;
  } catch (whyErr) {
    console.warn(
      '[plan-dispatch] WHY-Read fail-soft (kein Block angehängt):',
      whyErr instanceof Error ? whyErr.message : String(whyErr),
    );
    return undefined;
  }
}

/**
 * Slice C (2026-05-29) — concatenates the discovery block + WHY block in the
 * order „Discovery > WHY > Intent". Strictly fail-soft:
 *   - Both empty/undefined ⇒ undefined ⇒ proposeRecursivePlan sees NO
 *     whyContext ⇒ plan prompt bit-identical to the pre-Slice-C path (identity
 *     path).
 *   - Only discovery present ⇒ discovery only.
 *   - Only WHY present ⇒ WHY only (pre-Slice-C behavior).
 *   - Both present ⇒ discovery + blank line + WHY.
 *
 * Exported for unit tests.
 */
export function composeDiscoveryAndWhy(
  discoveryBlock: string | undefined,
  whyBlock: string | undefined,
): string | undefined {
  const d = (discoveryBlock ?? '').trim();
  const w = (whyBlock ?? '').trim();
  if (d.length === 0 && w.length === 0) return undefined;
  if (d.length === 0) return w;
  if (w.length === 0) return d;
  return `${d}\n\n${w}`;
}

/**
 * Slice C (2026-05-29) — discovery phase + emit pattern. NEVER throws; on
 * error it returns a discovery result with empty lists + an empty
 * context block, so the plan path runs bit-identical to the pre-Slice-C
 * behavior.
 *
 * Emit sequence per workstream (subKey='discovery'):
 *   1) pre-emit „running" — visible, immediately.
 *   2) runDiscovery (parallel fetch, max 8 URLs, 12s per URL).
 *   3) post-emit „done" — same coords ⇒ UPDATE in-place.
 *
 * Idempotency: emitOrUpdateCard uses (workspaceId, workstreamId, surfaceKind,
 * subKey) as the key. Both emits match the same key — no double-card spam.
 *
 * Exported for unit tests.
 */
export async function runDiscoveryAndEmitFailSoft(args: {
  workspaceId: string;
  workstreamId: string;
  intent: string;
  signal?: AbortSignal;
}): Promise<{
  builtContext: string;
  urlCount: number;
  docMentionCount: number;
}> {
  // signal is in reserve: runDiscovery has its own per-fetch timeouts; another
  // chaining would be convenience, not a safety gate. We mark
  // the parameter explicitly as not yet used (no lint warn).
  void args.signal;
  const coords = {
    workspaceId: args.workspaceId,
    workstreamId: args.workstreamId,
    surfaceKind: 'discovery' as const,
    subKey: 'discovery',
  };
  // 1) pre-emit „running".
  try {
    await emitOrUpdateCard({
      coords,
      content:
        `<surface:discovery>${JSON.stringify({
          workspaceId: args.workspaceId,
          workstreamId: args.workstreamId,
          status: 'running',
          urls: [],
        })}</surface:discovery>`,
      actor: 'system',
    });
  } catch (preErr) {
    console.warn(
      '[plan-dispatch] Discovery pre-emit fail-soft:',
      preErr instanceof Error ? preErr.message : String(preErr),
    );
  }

  // 2) runDiscovery.
  let result;
  try {
    result = await runDiscovery({
      workspaceId: args.workspaceId,
      intent: args.intent,
    });
  } catch (runErr) {
    console.warn(
      '[plan-dispatch] runDiscovery fail-soft:',
      runErr instanceof Error ? runErr.message : String(runErr),
    );
    // Fallback: empty result ⇒ plan prompt bit-identical to pre-Slice-C.
    result = {
      urls: [] as DiscoveryResult['urls'],
      pendingDocRequests: [] as DiscoveryResult['pendingDocRequests'],
      builtContext: '',
    };
  }

  // 3) post-emit „done" — same coords, idempotent.
  const status: 'done' | 'failed' =
    result.urls.length === 0 && result.pendingDocRequests.length === 0
      ? 'done'
      : 'done';
  try {
    await emitOrUpdateCard({
      coords,
      content:
        `<surface:discovery>${JSON.stringify({
          workspaceId: args.workspaceId,
          workstreamId: args.workstreamId,
          status,
          urls: result.urls,
          pendingDocRequests: result.pendingDocRequests,
        })}</surface:discovery>`,
      actor: 'system',
    });
  } catch (postErr) {
    console.warn(
      '[plan-dispatch] Discovery post-emit fail-soft:',
      postErr instanceof Error ? postErr.message : String(postErr),
    );
  }

  return {
    builtContext: result.builtContext,
    urlCount: result.urls.length,
    docMentionCount: result.pendingDocRequests.length,
  };
}
