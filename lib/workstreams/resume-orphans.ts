/**
 * Boot resume for orphaned iterate/plan/tier runs (owner fix 2026-05-30, Opus 4.8).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * EMPIRICAL PROBLEM (owner finding, experienced live):
 *   The owner started an iterate build in the „website" workspace
 *   (lead→roaster-1→roaster-2→lead-v2). MID-run the Next.js server
 *   (:4200) was restarted (deploy). Finding:
 *     - The tmux spawns are detached (server/agents/tmux-spawn.ts:396) and
 *       survive the restart as isolated sessions.
 *     - BUT the in-process orchestration loop in
 *       server/agents/tier-orchestrator.ts (runIterate / runIterateResume) — which
 *       polls the `.done` flag of the tmux spawns (tmux-spawn.ts:426) and advances the waves
 *       lead→roaster→v2 — lives in the Next.js PROCESS. On a restart
 *       the run is ORPHANED: nobody polls anymore, nobody advances the wave.
 *     - sweepStaleWorkstreams (recovery.ts, every 3 min) marks such runs only
 *       after ~20 min as `stuck` + notify. There is NO auto-resume.
 *
 *   EXTENSION (2026-05-30 PM, Opus 4.8): the plague affects NOT JUST iterate runs.
 *   The owner saw 4 "interrupted, restart?" cards after ONE deploy:
 *     - 2× connector-onboarding SOP runs (heygen) — created by
 *       lib/connectors/auto-connect.ts:250 (createWorkstream) +
 *       :313 (executePlan).
 *     - 2× website/flow runs — created by lib/flow/execute.ts:184
 *       (workstreams insert) + lib/flow/compose-and-run.ts:220 (executePlan via
 *       makeDefaultTrigger).
 *   BOTH are — unlike iterate — NOT event-sourced tier waves but
 *   ordinary `workstreams` runs (status='active') with a persisted
 *   `workstream_plan_steps` plan, processed by the in-process `executePlan`
 *   (lib/workstreams/plan-executor.ts). On a restart this
 *   in-process loop is also orphaned → nobody processes the remaining pending steps. The old
 *   boot resume, however, knew ONLY `loadIterateResumeContext` → for plan runs it always
 *   returned `ctx=null` and terminalized them (instead of continuing them).
 *   This extension adds the PLAN-RUN resume path (see below).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HOW THE INTERMEDIATE STATE IS RECONSTRUCTED (the core) — per run type:
 *
 *   (A) ITERATE RUN (event-sourced).
 *   Iterate progress is FULLY event-sourced. `loadIterateResumeContext`
 *   (tier-orchestrator.ts:1519) reconstructs the intermediate state EXCLUSIVELY from
 *   `events` on the `primary_ticket_id`:
 *     - the highest `iterate-version` (with text)  = the last written plan,
 *     - the associated `iterate-roast` outputs     = the roaster findings for it,
 *     - the original user prompt + any user corrections.
 *   done flags / tmux session names are NOT the intermediate state — they are only the
 *   currently running spawn. The real progress is in the event DB and survives
 *   every restart.
 *
 *   → An intermediate state is safely reconstructible EXACTLY WHEN
 *     `loadIterateResumeContext` returns non-null (at least one
 *     `iterate-version` event with text exists). Then this boot resume calls
 *     the EXISTING `runIterateResume` path (N4: don't reinvent) — exactly
 *     the same path as the user-triggered sniper resume
 *     (/api/workstreams/[id]/resume).
 *
 *   (B) PLAN RUN (flow website OR connector-onboarding SOP) — step-status-sourced.
 *   The progress of a plan run is NOT an event stream but the `status`
 *   of each `workstream_plan_steps` row (plan-repo.ts:226 setPlanStepStatus —
 *   pending→active→done/failed). That is exactly the reconstructible intermediate state:
 *   which steps are done and which are still open.
 *
 *   → The EXISTING `executePlan` (plan-executor.ts:472) IS by nature an
 *     idempotent resume path: it reads the persisted step `status` as the
 *     start state (plan-executor.ts:630–633 `stepStatuses[id] = step.status ??
 *     'pending'`), treats done steps in the ready queue as completed
 *     (isReady checks `deps.every(d => stepStatuses[d]==='done')`, :1074) and
 *     re-spawns ONLY the pending steps. Already-done steps are NEVER
 *     re-spawned (R3). A re-call of `executePlan` thus continues the run exactly
 *     where the restart orphaned it — N4: no reinvent, no new
 *     resume code. We read planId + coordKey losslessly from the persisted
 *     root steps (each carries plan_id + coord_key, workstream_plan_steps.ts:24/40).
 *
 *   → A plan intermediate state is reconstructible EXACTLY WHEN the workstream
 *     has at least one root plan step (depth=0). If it has NONE (neither
 *     iterate-version NOR plan steps), there is nothing safe to continue.
 *
 *   COMMON CASE — no intermediate state:
 *   When neither (A) nor (B) applies (no iterate-version event AND no
 *   plan steps — e.g. the run was created but the lead/compose has not yet
 *   written anything persistent), we terminalize the run IMMEDIATELY (not
 *   only after 20 min) cleanly to `stuck` + an honest, action-guiding notify
 *   (same mechanic as the recovery sweep). NO sham resume.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * R3 SAFETY (NEVER blindly re-spawn twice):
 *   Before a run is considered orphaned, it is checked for liveness:
 *     1. Liveness guard (as in the recovery sweep): if the master has an active
 *        sub-workstream with recent `updated_at` (< SUB_ACTIVITY_WINDOW_MS), the
 *        wave is still running → untouched.
 *     2. tmux session probe: if a tmux session of a sub-WS still exists
 *        (`sessionExists`), the spawn may still be running → untouched (conservative).
 *   Idempotency (two boots in a row must not double-spawn):
 *     - In-process guard (resumeInProgress) against a double run in the same process.
 *     - Atomic claim BEFORE the spawn: `UPDATE … SET updated_at=now WHERE id=? AND
 *       status='active' AND updated_at < cutoff`. If the claim fails
 *       (changes=0), another run already grabbed the run → skip. The
 *       fresh `updated_at` also takes the run out of the orphan window of a
 *       directly following second boot.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * RELATIONSHIP TO THE EXISTING SWEEPS (additive, replaces nothing):
 *   - sweepStaleWorkstreams (recovery.ts, 3 min) stays UNCHANGED — back-compat.
 *   - reapStaleWorkstreams (reap-stale.ts, 5 min) stays UNCHANGED.
 *   This boot resume runs ONCE at boot (no interval) and kicks in BEFORE
 *   the sweep: it attempts a real continuation instead of just a stuck marking. Runs it
 *   can't resume it terminalizes immediately — the sweep would set them to `stuck` 20 min
 *   later anyway, we do it deterministically + immediately.
 *
 * Operating constraints:
 *   N4:  Reuse of the EXISTING resume paths — runIterateResume for
 *        iterate runs, executePlan for plan runs (flow/SOP onboarding). No
 *        new resume code, no second execution engine.
 *   N6:  Deterministic time proxy (updated_at) + liveness probe, no LLM.
 *   N8:  Every resume/terminalization decision writes a
 *        workstream_decisions row (why resume vs. terminalized; per path its
 *        own rationale — iterate vs. plan vs. terminalized).
 *   N10: content_hash in the decision row (internally via writeDecision).
 *   No secret in logs/trace/notify (only name + minutes + IDs).
 */

import { getDb } from '@/db/client';
import { writeDecision } from '@/lib/workstreams/trace-repo';
import { emitOrUpdateCard } from '@/lib/events/emit-or-update-card';
import { emitAnswerRequired } from '@/lib/push/triggers';
import { SUB_ACTIVITY_WINDOW_MS } from '@/lib/workstreams/recovery';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Orphan threshold: an `active` workstream without updated_at progress since
 * this time is a resume candidate. Default 4 min — deliberately SHORTER than the
 * recovery sweep's STALE_MS (20 min): we want to continue the orphaned run at boot
 * IMMEDIATELY, not wait 20 min. 4 min sits safely above the
 * longest single phase (Opus lead ~4 min) — the liveness guard + tmux probe
 * additionally guard against falsely selecting a still-running run.
 * Overridable via ENV `LAZYOS_WS_ORPHAN_RESUME_MS`.
 */
export const ORPHAN_RESUME_MS: number = (() => {
  const raw = process.env.LAZYOS_WS_ORPHAN_RESUME_MS;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 4 * 60_000; // 4 min
})();

/** Max. number of orphaned runs handled per boot sweep. */
export const ORPHAN_MAX_PER_BOOT = 25;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type OrphanOutcome =
  | 'resumed' // the real runIterateResume path was called (intermediate state reconstructible)
  | 'terminated' // immediately cleanly terminalized to stuck (no intermediate state)
  | 'alive' // alive (liveness guard / tmux) → untouched
  | 'claim-lost' // another run grabbed the run between SELECT and claim
  | 'error'; // isolated error — the sweep continues

/** Which existing resume path kicked in (only when outcome='resumed'). */
export type ResumedKind = 'iterate' | 'plan';

export interface OrphanRunResult {
  workstreamId: string;
  workspaceId: string;
  outcome: OrphanOutcome;
  /** On 'resumed': via which existing path it was continued. */
  resumedKind?: ResumedKind;
  /** On 'resumed' (iterate): the version it was continued from. */
  resumedFromVersion?: number;
  detail?: string;
}

export interface ResumeOrphansResult {
  scanned: number;
  resumed: string[];
  terminated: string[];
  aliveSkipped: number;
  errors: number;
  results: OrphanRunResult[];
  sweptAt: number;
  /** true when another boot sweep was still running → this run was aborted. */
  skippedDueToConcurrentSweep: boolean;
}

// ---------------------------------------------------------------------------
// In-process guard
// ---------------------------------------------------------------------------

let resumeInProgress = false;

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

interface OrphanCandidateRow {
  id: string;
  workspace_id: string;
  name: string;
  updated_at: number;
}

/**
 * Finds orphaned (no longer orchestrated) `active` runs (iterate, flow,
 * SOP onboarding) and continues them cleanly — via the existing runIterateResume
 * path (iterate) or executePlan path (plan run: flow/SOP) on a reconstructible
 * intermediate state, otherwise immediate clean terminalization + notify.
 *
 * Idempotent, R3-safe, fail-soft (never throws). To be called ONCE at boot.
 *
 * @param now Time reference (default Date.now()). Testable.
 */
export async function resumeOrphanedRuns(
  now: number = Date.now(),
): Promise<ResumeOrphansResult> {
  const sweptAt = now;

  if (resumeInProgress) {
    return {
      scanned: 0,
      resumed: [],
      terminated: [],
      aliveSkipped: 0,
      errors: 0,
      results: [],
      sweptAt,
      skippedDueToConcurrentSweep: true,
    };
  }

  resumeInProgress = true;
  try {
    return await runOrphanSweep(now, sweptAt);
  } finally {
    resumeInProgress = false;
  }
}

async function runOrphanSweep(
  now: number,
  sweptAt: number,
): Promise<ResumeOrphansResult> {
  const db = getDb();
  const cutoff = now - ORPHAN_RESUME_MS;

  // Only `active` runs carry orchestration. `paused` runs deliberately wait
  // for user input (the sniper window persists via waitForSniperPause, NOT via
  // the in-process loop in a form that would need a restart). `stuck`/`done`/
  // `archived` are terminal — the recovery sweep/reaper handles those, not us.
  // Bounded via LIMIT (protection against "first boot after long downtime").
  const rows = db.$raw
    .prepare(
      `SELECT id, workspace_id, name, updated_at
         FROM workstreams
        WHERE status = 'active'
          AND updated_at < ?
        ORDER BY updated_at ASC
        LIMIT ?`,
    )
    .all(cutoff, ORPHAN_MAX_PER_BOOT) as OrphanCandidateRow[];

  const results: OrphanRunResult[] = [];
  const resumed: string[] = [];
  const terminated: string[] = [];
  let aliveSkipped = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const res = await handleOrphanRun(row, now, cutoff);
      results.push(res);
      switch (res.outcome) {
        case 'resumed':
          resumed.push(row.id);
          break;
        case 'terminated':
          terminated.push(row.id);
          break;
        case 'alive':
          aliveSkipped += 1;
          break;
        default:
          break; // claim-lost: neither resumed nor terminated, no error
      }
    } catch (err) {
      errors += 1;
      results.push({
        workstreamId: row.id,
        workspaceId: row.workspace_id,
        outcome: 'error',
        detail: err instanceof Error ? err.message : String(err),
      });
      console.warn(
        '[resume-orphans] Fehler beim Behandeln von',
        row.id,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (resumed.length > 0 || terminated.length > 0) {
    console.info(
      `[resume-orphans] Boot-Sweep: resumed=${resumed.length} terminated=${terminated.length} ` +
        `alive=${aliveSkipped} (scanned=${rows.length}, errors=${errors}, ` +
        `orphan>${Math.round(ORPHAN_RESUME_MS / 60_000)}min)`,
    );
  }

  return {
    scanned: rows.length,
    resumed,
    terminated,
    aliveSkipped,
    errors,
    results,
    sweptAt,
    skippedDueToConcurrentSweep: false,
  };
}

// ---------------------------------------------------------------------------
// Per-run handling
// ---------------------------------------------------------------------------

/**
 * Handles a single orphan candidate:
 *   0. Liveness guard (recent active sub-WS) → 'alive', untouched.
 *   1. tmux session probe (a sub-WS tmux still exists) → 'alive', untouched.
 *   2. Atomic claim → on changes=0 → 'claim-lost' (another run was faster).
 *   3. Run-type classification + the best existing resume path (in this order):
 *      a) ITERATE: loadIterateResumeContext non-null → N8 decision (resume) +
 *         runIterateResume (existing path) → 'resumed' (kind=iterate).
 *      b) PLAN (flow/SOP onboarding): root plan steps exist → N8 decision +
 *         executePlan (existing, idempotent resume path — done steps stay
 *         done, only pending re-spawned) → 'resumed' (kind=plan). Best-effort flips
 *         any flow_runs row back to 'running' (UI consistency).
 *      c) NEITHER: immediate clean terminalization to 'stuck' + N8 decision
 *         + card + push → 'terminated' (no sham resume).
 */
async function handleOrphanRun(
  row: OrphanCandidateRow,
  now: number,
  cutoff: number,
): Promise<OrphanRunResult> {
  const db = getDb();
  const staleMinutes = Math.round((now - row.updated_at) / 60_000);

  // 0. Liveness guard — identical to the recovery sweep: an active sub-WS with
  //    recent updated_at means the wave is still running (the master updated_at is
  //    only old because sub-spawns bump their own row, not the master).
  const subActivityCutoff = now - SUB_ACTIVITY_WINDOW_MS;
  const liveSub = db.$raw
    .prepare(
      `SELECT 1
         FROM workstreams
        WHERE parent_workstream_id = ?
          AND status = 'active'
          AND updated_at > ?
        LIMIT 1`,
    )
    .get(row.id, subActivityCutoff) as { 1: number } | undefined;

  if (liveSub) {
    return {
      workstreamId: row.id,
      workspaceId: row.workspace_id,
      outcome: 'alive',
      detail: 'recent-active-sub-workstream',
    };
  }

  // 1. tmux session probe (conservative, R3): if a tmux session of a sub-WS
  //    of this master still exists, a spawn may still be running → untouched.
  //    (Polling no longer runs — but we NEVER blindly re-spawn as long as
  //    anything on the run is still tmux-alive.)
  const hasLiveTmux = await anySubWorkstreamTmuxAlive(row.id);
  if (hasLiveTmux) {
    return {
      workstreamId: row.id,
      workspaceId: row.workspace_id,
      outcome: 'alive',
      detail: 'live-tmux-session',
    };
  }

  // 2. Atomic claim: takes the run out of the orphan window BEFORE we spawn.
  //    The WHERE guard on status='active' AND updated_at < cutoff ensures
  //    that a second (parallel or directly following) boot sweep does not also grab the same
  //    run — on changes=0 another run won.
  const claim = db.$raw
    .prepare(
      `UPDATE workstreams
          SET updated_at = ?
        WHERE id = ? AND status = 'active' AND updated_at < ?`,
    )
    .run(now, row.id, cutoff) as { changes?: number };

  if ((claim.changes ?? 0) === 0) {
    return {
      workstreamId: row.id,
      workspaceId: row.workspace_id,
      outcome: 'claim-lost',
      detail: 'concurrent-claim-or-status-change',
    };
  }

  // 3. Intermediate state reconstructible?
  const { loadIterateResumeContext, runIterateResume } = await import(
    '@/server/agents/tier-orchestrator'
  );
  const ctx = await loadIterateResumeContext(row.id);

  if (ctx) {
    // ── Real resume via the existing path (N4) ───────────────────────────────
    // N8: decision row BEFORE the spawn — honest rationale (why resume).
    const rationale =
      `Boot-Resume: Server-Restart hat die In-Process-Orchestrierung verwaist ` +
      `(${staleMinutes}min ohne updated_at-Fortschritt, kein lebendiger Sub-WS/tmux). ` +
      `Zwischenstand rekonstruierbar aus Event-Log (letzte iterate-version=V${ctx.lastVersion}, ` +
      `${ctx.roastTexts.length} Roast-Output(s)). Fortsetzung via bestehendem ` +
      `runIterateResume-Pfad (V${ctx.lastVersion}→V${ctx.lastVersion + 1}). N4/N6/N8.`;
    writeDecision({
      workspaceId: row.workspace_id,
      workstreamId: row.id,
      coordKey: `${row.workspace_id}/${row.id}`,
      decisionKind: 'orphan_detected',
      rationale,
      actor: 'policy',
    });

    // runIterateResume itself sets status='active', emits iterate-resumed,
    // spawns the next wave and terminalizes to 'done' on convergence/cap.
    // We do NOT await the whole wave (can take 1-3 min) — fire-and-track,
    // so the boot sweep goes through all orphans quickly. Errors in the resume are
    // non-fatal for the sweep (its own catch).
    void runIterateResume(row.id).catch((err: unknown) => {
      console.warn(
        '[resume-orphans] runIterateResume fehlgeschlagen (non-fatal):',
        row.id,
        err instanceof Error ? err.message : String(err),
      );
    });

    return {
      workstreamId: row.id,
      workspaceId: row.workspace_id,
      outcome: 'resumed',
      resumedKind: 'iterate',
      resumedFromVersion: ctx.lastVersion,
      detail: `resume V${ctx.lastVersion}→V${ctx.lastVersion + 1}`,
    };
  }

  // ── No iterate intermediate state → try the PLAN-RUN path (flow / SOP) ──────
  // Flow-website and connector-onboarding SOP runs are ordinary
  // workstreams runs with a persisted workstream_plan_steps plan. Their
  // intermediate state is the step `status`. If the run has root plan steps, we
  // continue it via the EXISTING, idempotent executePlan (N4).
  const planResume = await resumePlanRunIfPlanSteps(row, staleMinutes);
  if (planResume) {
    return planResume;
  }

  // ── No reconstructible intermediate state (neither iterate nor plan) → ──────
  // terminalize cleanly immediately. The lead/compose has not yet written anything
  // persistent (no iterate-version event, no plan steps) — there is nothing
  // safe to continue. Instead of a sham resume: deterministically + IMMEDIATELY (not
  // only after 20 min) to 'stuck' + an honest, action-guiding notify.
  await terminateUnresumableRun(row, now, staleMinutes);
  return {
    workstreamId: row.id,
    workspaceId: row.workspace_id,
    outcome: 'terminated',
    detail: 'no-reconstructible-intermediate-state',
  };
}

/**
 * PLAN-RUN resume (flow website OR connector-onboarding SOP).
 *
 * Both run types are ordinary `workstreams` runs with a persisted
 * `workstream_plan_steps` plan (depth=0), processed by the in-process
 * `executePlan` — which is orphaned on a restart. The intermediate state is the
 * step `status` (pending/active/done/failed) of each step row.
 *
 * Reconstructible ⇔ at least one root plan step exists. Then:
 *   - read planId + coordKey losslessly from the persisted root steps
 *     (each step carries both fields — workstream_plan_steps.ts:24/40). No
 *     guessed coord format: we take exactly the persisted coord_key.
 *   - reset 'active' steps (the restart caught them mid-spawn) to 'pending'
 *     so executePlan safely re-runs them. 'done' stays 'done'
 *     (NEVER re-spawned — R3), 'failed' stays 'failed' (error-isolated).
 *   - executePlan(workstreamId, workspaceId, planId, coordKey) fire-and-track —
 *     the existing, idempotent resume path (N4). done steps are recognized as
 *     completed, only pending steps re-spawned.
 *   - Best-effort: flip any flow_runs row of this workstream back to
 *     'running' (UI consistency; a SOP onboarding run has no
 *     flow_runs row → no-op via WHERE).
 *
 * Returns the resume OrphanRunResult, OR null when the run has NO plan steps
 * (then the caller falls back to terminalization).
 *
 * IMPORTANT (R3/idempotency): the atomic claim (handleOrphanRun step 2) has already
 * taken the run out of the orphan window BEFORE this function runs — a
 * second boot sweep does not grab the same run again. executePlan itself
 * re-spawns no done steps.
 */
async function resumePlanRunIfPlanSteps(
  row: OrphanCandidateRow,
  staleMinutes: number,
): Promise<OrphanRunResult | null> {
  const { listRootPlanSteps } = await import('@/lib/workstreams/plan-repo');
  const rootSteps = listRootPlanSteps(row.id);
  if (rootSteps.length === 0) {
    return null; // no plan intermediate state → caller terminalizes
  }

  // planId + coordKey from the persisted steps (lossless, no guessing).
  const planId = rootSteps[0]!.planId;
  const coordKey = rootSteps[0]!.coordKey;

  // Step-status distribution for the honest decision rationale (no secret —
  // only counters). 'active' steps were orphaned mid-spawn → reset to 'pending'
  // so executePlan deterministically re-runs them.
  let doneCount = 0;
  let failedCount = 0;
  let pendingCount = 0;
  let resetActive = 0;
  const { setPlanStepStatus } = await import('@/lib/workstreams/plan-repo');
  for (const s of rootSteps) {
    switch (s.status) {
      case 'done':
        doneCount += 1;
        break;
      case 'failed':
        failedCount += 1;
        break;
      case 'active': {
        // Orphaned in-flight step → back to pending (re-runnable). Best-effort.
        try {
          setPlanStepStatus(s.id, 'pending');
          resetActive += 1;
        } catch {
          /* non-fatal: executePlan doesn't treat active as done anyway */
        }
        pendingCount += 1;
        break;
      }
      default:
        pendingCount += 1;
        break;
    }
  }

  // N8: decision BEFORE the resume — honest rationale (why plan resume).
  const rationale =
    `Boot-Resume: Server-Restart hat den In-Process-Plan-Executor verwaist ` +
    `(${staleMinutes}min ohne updated_at-Fortschritt, kein lebendiger Sub-WS/tmux). ` +
    `Plan-Run (Flow/SOP-Onboarding) — Zwischenstand aus workstream_plan_steps: ` +
    `${rootSteps.length} root-Steps (done=${doneCount}, failed=${failedCount}, ` +
    `pending=${pendingCount}, davon ${resetActive} verwaiste 'active'→'pending' ` +
    `zurückgesetzt). Fortsetzung via bestehendem executePlan (idempotent: done ` +
    `bleibt done, nur pending re-spawnt). N4/N6/N8.`;
  writeDecision({
    workspaceId: row.workspace_id,
    workstreamId: row.id,
    coordKey,
    decisionKind: 'orphan_detected',
    rationale,
    actor: 'policy',
  });

  // Best-effort: flow_runs row (if present) back to 'running'. A
  // SOP onboarding run has none → WHERE matches nothing → no-op. Fail-soft.
  reviveFlowRunStatus(row.id);

  // Resume via the existing path. Fire-and-track (can take minutes) — errors
  // are non-fatal for the sweep (its own catch) so all orphans go through.
  const { executePlan } = await import('@/lib/workstreams/plan-executor');
  void executePlan({
    workstreamId: row.id,
    workspaceId: row.workspace_id,
    planId,
    coordKey,
  }).catch((err: unknown) => {
    console.warn(
      '[resume-orphans] executePlan (plan-resume) fehlgeschlagen (non-fatal):',
      row.id,
      err instanceof Error ? err.message : String(err),
    );
  });

  return {
    workstreamId: row.id,
    workspaceId: row.workspace_id,
    outcome: 'resumed',
    resumedKind: 'plan',
    detail: `plan-resume ${rootSteps.length} steps (done=${doneCount}, pending=${pendingCount})`,
  };
}

/**
 * Resets any flow_runs row of this workstream back to 'running'
 * (best-effort, fail-soft). A direct raw UPDATE via the already-present
 * db.$raw handle — no import of the locked flow-persistence module needed.
 * WHERE guard on workstream_id: a SOP onboarding run (no flow_runs row) →
 * changes=0 → harmless no-op. Only 'pending'/'failed'/'cancelled' are raised to
 * 'running' — an already-'done' flow run stays done (no re-open).
 */
function reviveFlowRunStatus(workstreamId: string): void {
  try {
    const db = getDb();
    db.$raw
      .prepare(
        `UPDATE flow_runs
            SET status = 'running', updated_at = ?
          WHERE workstream_id = ?
            AND status IN ('pending', 'failed', 'cancelled')`,
      )
      .run(Date.now(), workstreamId);
  } catch {
    // flow_runs table missing / DB error → non-fatal (a SOP run doesn't need it).
  }
}

/**
 * Checks whether any sub-workstream of the master still has a live tmux session.
 * Fail-soft: on any error (DB / tmux unavailable) → false (no
 * false-positive "alive" that would block a real resume).
 */
async function anySubWorkstreamTmuxAlive(masterWorkstreamId: string): Promise<boolean> {
  const db = getDb();
  let sessionNames: string[] = [];
  try {
    const rows = db.$raw
      .prepare(
        `SELECT tmux_session_id
           FROM workstreams
          WHERE parent_workstream_id = ?
            AND tmux_session_id IS NOT NULL
            AND tmux_session_id != ''`,
      )
      .all(masterWorkstreamId) as Array<{ tmux_session_id: string | null }>;
    sessionNames = rows
      .map((r) => r.tmux_session_id)
      .filter((s): s is string => typeof s === 'string' && s.length > 0);
  } catch {
    return false;
  }
  if (sessionNames.length === 0) return false;

  try {
    const { sessionExists } = await import('@/server/tmux-controller');
    for (const name of sessionNames) {
      // sessionExists is itself try/catch-wrapped + assertSafeSessionName.
      // On an unsafe/broken name, assertSafeSessionName throws → we
      // count that as "not alive" (no block), not as an error.
      try {
        if (await sessionExists(name)) return true;
      } catch {
        /* unsafe/broken session name → don't count as alive */
      }
    }
  } catch {
    // tmux-controller not importable (e.g. Edge) → fail-soft.
    return false;
  }
  return false;
}

/**
 * Terminalizes an orphaned run WITHOUT a reconstructible intermediate state
 * cleanly to `stuck` + N8 decision + status card + push, immediately. Deliberately mirrors the
 * notify mechanic of the recovery sweep (terminateOrphanedRun) so the user
 * gets the same "restart?" affordance — only immediately instead of after 20 min.
 *
 * Atomic status guard (active→stuck): no re-push on a race.
 */
async function terminateUnresumableRun(
  row: OrphanCandidateRow,
  now: number,
  staleMinutes: number,
): Promise<void> {
  const db = getDb();

  const result = db.$raw
    .prepare(
      `UPDATE workstreams
          SET status = 'stuck', updated_at = ?
        WHERE id = ? AND status = 'active'`,
    )
    .run(now, row.id) as { changes?: number };

  if ((result.changes ?? 0) === 0) {
    // Race: a real agent finish or similar already changed the status.
    return;
  }

  const rationale =
    `Boot-Resume: Server-Restart hat die In-Process-Orchestrierung verwaist ` +
    `(${staleMinutes}min ohne Fortschritt, kein lebendiger Sub-WS/tmux). ` +
    `KEIN rekonstruierbarer Zwischenstand im Event-Log (noch keine iterate-version ` +
    `geschrieben) → kein Schein-Resume. Sofort sauber auf 'stuck' terminalisiert ` +
    `(deterministisch + sofort statt 20min-Sweep). Reason: ` +
    `orphan-no-intermediate-state:${staleMinutes}min. N4/N6/N8.`;

  // N8: decision row (best-effort).
  writeDecision({
    workspaceId: row.workspace_id,
    workstreamId: row.id,
    coordKey: `${row.workspace_id}/${row.id}`,
    decisionKind: 'orphan_detected',
    rationale,
    actor: 'policy',
  });

  // Status card (deep link „Neu starten") — Apple-feed cleanliness (2026-05-30):
  // NO raw URL/IDs in the visible text. A clean sentence + resume URL only in the
  // `href` of the markdown link (label „Neu starten"). No secret in the content.
  const cardContent =
    `Ein Lauf wurde durch einen Neustart pausiert. ` +
    `[Neu starten](/?workspace=${encodeURIComponent(row.workspace_id)}&ws=${encodeURIComponent(
      row.id,
    )}&action=resume)`;
  try {
    await emitOrUpdateCard({
      coords: {
        workspaceId: row.workspace_id,
        workstreamId: row.id,
        surfaceKind: 'toast',
      },
      content: cardContent,
      actor: 'system',
    });
  } catch (cardErr) {
    console.warn(
      '[resume-orphans] emitOrUpdateCard fehlgeschlagen (non-fatal):',
      row.id,
      cardErr instanceof Error ? cardErr.message : String(cardErr),
    );
  }

  // Push (kind='run-stuck') — the visibility gate kicks in internally. No secret.
  emitAnswerRequired({
    workspaceId: row.workspace_id,
    entityId: row.id,
    kind: 'run-stuck',
    preview: `"${row.name.slice(0, 50)}" durch Neustart unterbrochen — neu starten`,
    url: `/?workspace=${encodeURIComponent(row.workspace_id)}&ws=${encodeURIComponent(row.id)}&action=resume`,
  });
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/** Resets the in-process guard. Use ONLY in tests. */
export function __resetResumeGuardForTests(): void {
  resumeInProgress = false;
}
