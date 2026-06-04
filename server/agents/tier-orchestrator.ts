/**
 * Tier-Orchestrator (Phase A) — parallel Multi-Agent-Spawn.
 *
 * Spawns N×Opus + M×Sonnet + K×Haiku against the same plan prompt with
 * different diversity roles. Each output lands as a
 * `commented` event on the workstream's master plan ticket.
 *
 * Safety mechanisms:
 *   - MAX_CONCURRENT_SPAWNS hard cap (FIFO queue for the rest)
 *   - LAZYOS_TIER_DEPTH env: spawned agents see depth=1, cannot
 *     spawn further themselves (recursion guard, memory pin)
 *   - Wallclock timeout per tier (Opus 5min, Sonnet 3min, Haiku 90s)
 *   - Rate-limit detection in stderr → exponential backoff + skip
 *
 * Auth = MAX plan: ANTHROPIC_API_KEY is stripped from the child env.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { emitEvent } from '../../lib/events/emit';
import { emitOrUpdateCard } from '../../lib/events/emit-or-update-card';
import { defaultWorkspacePath } from '../../lib/workspaces/projects-root';
import {
  iterateVersionSubKey,
  tierOutputSubKey,
} from '../../lib/events/loop-card-coords';
import type { ActorType } from '../../lib/events/types';
import { MODEL_NAMES, TIER_EFFORT, type TierModel } from '../../lib/agents/pricing';
import { pickRoleForIndex } from '../../lib/agents/diversity-roles';
import { spawnAndAudit } from './spawn-and-audit';
import { hashOutput } from '@/lib/audit/reasoning';
import { BRAND_NAME } from '@/lib/brand';
import { getDb } from '../../db/client';
import { ulid } from '../../lib/ulid';
import { formatTwinsForPrompt } from '../../lib/twins/format-for-prompt';
// P0.3b — Self-Learning / WHY engine (2026-05-27): READ-ONLY import of the
// WHY-context aggregator. Feeds prior rationales + active, weighted
// beliefs of this workspace into the tier-lead prompt — alongside the existing
// RAG/Twin enrichment. why-context.ts itself is NOT modified (N4).
import {
  buildWhyContext,
  renderWhyContextForPrompt,
} from '../../lib/reasoning/why-context';
import {
  createSubWorkstream,
  updateWorkstream,
  type SubWorkstreamRole,
} from '../../lib/workstreams/service';
import { workspaceIsSandbox } from '../../lib/workspaces/sandbox';

/**
 * V3 Wire-Punkt 1 (2026-05-01) — Sandbox-Auto-Approve.
 *
 * In sandbox workspaces we skip the user's click on "Approve":
 * after `approval_requested` we IMMEDIATELY chain an `approved` event with
 * `flags.autoApprove=true`, so the FSM sets the master to `approved`
 * and auto-dispatch (lib/tickets/auto-dispatch.ts) picks up the sub-tickets.
 *
 * Best-effort: continue on any error (original behavior,
 * user clicks manually). We NEVER want to block the pipeline.
 */
async function maybeAutoApproveInSandbox(opts: {
  workspaceId: string;
  parentTicketId: string;
  workstreamId: string;
  reason: string;
}): Promise<void> {
  try {
    const inSandbox = await workspaceIsSandbox(opts.workspaceId);
    if (!inSandbox) return;
    await emitEvent({
      segmentId: opts.workspaceId,
      entityType: 'ticket',
      entityId: opts.parentTicketId,
      eventType: 'approved',
      actor: 'agent:sandbox-auto',
      payload: {
        from: 'review',
        to: 'approved',
        transition: 'approve',
        autoApproved: true,
        autoApprovedReason: 'sandbox-mode',
        workstreamId: opts.workstreamId,
        reason: opts.reason,
      },
      sensitivity: 'low',
    });
    // Updated event with workflowState='approved' so auto-dispatch
    // does not miss the trigger from updated events (see maybeAutoDispatch).
    await emitEvent({
      segmentId: opts.workspaceId,
      entityType: 'ticket',
      entityId: opts.parentTicketId,
      eventType: 'updated',
      actor: 'agent:sandbox-auto',
      payload: {
        workflowState: 'approved',
        transition: 'sandbox_auto_approve',
        autoApproved: true,
        workstreamId: opts.workstreamId,
      },
      sensitivity: 'low',
    });
  } catch (err) {
    console.warn(
      '[sandbox-auto-approve] failed (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Sprint 2 / Strand B (2026-04-30) — RAG context injection into lead prompts.
 *
 * Local workspace context (files + chat + tickets + work products) is
 * formatted via `lib/rag/retriever` as a top-K markdown block and appended
 * to the lead system prompt. Token cap: 4000.
 *
 * Best-effort: on any failure (embedder dead, DB empty, module init)
 * the function returns ''. The lead then runs without RAG context —
 * graceful degradation without a pipeline block.
 *
 * MAX-plan compliant: 100% local (Xenova all-MiniLM-L6-v2, 384-dim).
 */
async function injectRagContext(
  workspaceId: string,
  query: string,
): Promise<string> {
  const enriched = await injectRagContextWithSources(workspaceId, query);
  return enriched.text;
}

/**
 * Pattern 5 traceability (2026-05-01): variant that additionally returns the
 * source IDs + scores so the caller writes them into reasoning_audit.
 * No behavior drift from injectRagContext — same code, more output.
 */
async function injectRagContextWithSources(
  workspaceId: string,
  query: string,
): Promise<{
  text: string;
  sources: Array<{ sourceType: string; sourceId: string; score: number }>;
}> {
  try {
    const { retrieve, formatForPrompt } = await import('../../lib/rag/retriever');
    const result = await retrieve({ workspaceId, query, topK: 8, tokenCap: 4000 });
    if (result.hits.length === 0) return { text: '', sources: [] };
    return {
      text: formatForPrompt(result),
      sources: result.hits.map((h) => ({
        sourceType: h.sourceType,
        sourceId: h.sourceId,
        score: Number(h.similarity.toFixed(4)),
      })),
    };
  } catch (err) {
    console.warn('[tier-orchestrator] rag-inject-fail:', err instanceof Error ? err.message : err);
    return { text: '', sources: [] };
  }
}

/**
 * P0.3b — Self-Learning / WHY engine (2026-05-27). Builds the WHY block for
 * a tier-lead prompt: prior rationales + active, topic-relevant beliefs
 * of this workspace (lib/reasoning/why-context.ts — READ-ONLY).
 *
 * Strictly fail-soft (same posture as injectRagContext): ANY read error
 * (missing table, DB init, empty ledger) returns '' — the lead then runs
 * without WHY context (graceful degradation, NEVER a pipeline block).
 *
 * N9: everything is hard-scoped to workspaceId (buildWhyContext filters).
 * N2 untouched: no RAG, no audit row, no cross-scope.
 */
function buildWhyBlockForLead(workspaceId: string, topic: string): string {
  try {
    const rendered = renderWhyContextForPrompt(
      buildWhyContext(getDb().$raw, { workspaceId, topic }),
    );
    return rendered.trim();
  } catch (err) {
    console.warn(
      '[tier-orchestrator] why-inject-fail:',
      err instanceof Error ? err.message : err,
    );
    return '';
  }
}

/**
 * P0.3b — pure helper: appends an (already rendered) WHY block to a
 * lead system prompt. Mirrors the existing RAG enrichment pattern
 * (`${leadSystem}\n\n---\n${ctx}`) exactly, so the ordering in the prompt
 * is deterministic + testable.
 *
 * Empty/whitespace-only whyBlock ⇒ base is returned UNCHANGED
 * (bit-identical to the behavior before P0.3b). Pure function — no I/O, no
 * read — so the prompt construction is isolated and unit-testable.
 */
export function injectWhyIntoLeadSystem(base: string, whyBlock: string): string {
  const why = typeof whyBlock === 'string' ? whyBlock.trim() : '';
  if (why.length === 0) return base;
  return `${base}\n\n---\n${why}`;
}

/**
 * Sprint C (2026-04-29) — sub-workstream spawn helper.
 * Creates a sub-WS row before the tmux spawn. On error: silent + null.
 */
async function trySubWs(
  parentId: string,
  role: SubWorkstreamRole,
  model: string,
): Promise<string | undefined> {
  try {
    const sub = await createSubWorkstream({
      parentId,
      role,
      model,
    });
    return sub.id;
  } catch {
    return undefined;
  }
}

/**
 * Sprint C — idempotent sub-workstream card in the chat. Emit only when
 * no sub-workstreams card yet exists for this master workstream.
 */
async function emitSubWorkstreamsCardIfAbsent(args: {
  workspaceId: string;
  workstreamId: string;
}): Promise<void> {
  try {
    // Sub-Plan C (2026-04-30): consolidated via `emitOrUpdateCard`. Per
    // `(workspaceId, workstreamId, 'sub-workstreams')` coord there is
    // exactly one live event row — repeated calls (e.g. after
    // re-spawn) update in-place instead of emitting a new event.
    // Surface payload additionally carries `masterWorkstreamId` for the
    // existing SubWorkstreamsCard component (backwards-compat).
    const surfaceJson = JSON.stringify({
      workstreamId: args.workstreamId,
      masterWorkstreamId: args.workstreamId,
      workspaceId: args.workspaceId,
    });
    const text = [
      'Sub-Workstreams aktiv — pro Sub-Agent ein Live-Token-Counter.',
      '',
      `<surface:sub-workstreams>${surfaceJson}</surface:sub-workstreams>`,
    ].join('\n');
    await emitOrUpdateCard({
      coords: {
        workspaceId: args.workspaceId,
        workstreamId: args.workstreamId,
        surfaceKind: 'sub-workstreams',
      },
      content: text,
      actor: 'system',
    });
  } catch {
    /* non-fatal */
  }
}

/**
 * Owner-fix run-cockpit (2026-05-28) — emit/update of the aggregated cockpit
 * card. ALONGSIDE the 3 existing emits (sub-workstreams + iterate-pipeline +
 * iterate-version) — the old cards remain for back-compat (voice/API
 * consumers); the renderer suppresses them in the UI as soon as the cockpit
 * card is active for the same coord (lib/chat/SurfaceRenderer.tsx →
 * RunCockpitRegistry).
 *
 * Idempotent via `emitOrUpdateCard` (key = (workspaceId, workstreamId,
 * 'run-cockpit', subKey='cockpit')) — on phase change the card is
 * updated in-place, no second bubble. Strictly non-fatal — an error here
 * must NEVER block the tier/iterate run.
 *
 * Uses `subKey:'cockpit'` so the coord match in the DB is explicit
 * (wave-7 subKey requirement: non-empty when set).
 */
export interface RunCockpitEmitInput {
  workspaceId: string;
  workstreamId: string;
  phase: 'decompose' | 'tier-spawn' | 'lead' | 'roaster' | 'consensus' | 'done';
  phaseIndex?: number;
  phaseTotal?: number;
  workstreamName?: string;
  /** List of the known sub-workstreams (role, status, tokensOut). */
  subWorkstreams?: Array<{
    id?: string;
    role: string;
    status?: string;
    tokensOut?: number;
    model?: string;
  }>;
  maxVersion?: number;
  tokensTotal?: number;
  costCents?: number;
  /** Optional hint override, otherwise the renderer defaults to phase. */
  nextStepHint?: string;
}

const RUN_COCKPIT_PHASE_ORDER = [
  'decompose',
  'tier-spawn',
  'lead',
  'roaster',
  'consensus',
  'done',
] as const;

export async function emitRunCockpitCard(
  input: RunCockpitEmitInput,
): Promise<void> {
  try {
    const phaseTotal = input.phaseTotal ?? RUN_COCKPIT_PHASE_ORDER.length;
    const derivedIdx = RUN_COCKPIT_PHASE_ORDER.indexOf(input.phase) + 1;
    const phaseIndex = input.phaseIndex ?? (derivedIdx > 0 ? derivedIdx : 1);

    const payload: Record<string, unknown> = {
      workspaceId: input.workspaceId,
      workstreamId: input.workstreamId,
      phase: input.phase,
      phaseIndex,
      phaseTotal,
    };
    if (input.workstreamName) payload.workstreamName = input.workstreamName;
    if (input.subWorkstreams && input.subWorkstreams.length > 0) {
      payload.subWorkstreams = input.subWorkstreams;
    }
    if (typeof input.maxVersion === 'number') payload.maxVersion = input.maxVersion;
    if (typeof input.tokensTotal === 'number') payload.tokensTotal = input.tokensTotal;
    if (typeof input.costCents === 'number') payload.costCents = input.costCents;
    if (input.nextStepHint) payload.nextStepHint = input.nextStepHint;

    const surfaceJson = JSON.stringify(payload);
    const text = [
      'Lauf-Cockpit — Phase ' +
        phaseIndex +
        ' von ' +
        phaseTotal +
        ' aktiv.',
      '',
      `<surface:run-cockpit>${surfaceJson}</surface:run-cockpit>`,
    ].join('\n');

    await emitOrUpdateCard({
      coords: {
        workspaceId: input.workspaceId,
        workstreamId: input.workstreamId,
        surfaceKind: 'run-cockpit',
        // subKey must be non-empty, otherwise emitOrUpdateCard throws. We use
        // a constant discriminator so the same coord cell is matched +
        // updated in-place on every phase update.
        subKey: 'cockpit',
      },
      content: text,
      actor: 'system',
    });
  } catch {
    /* non-fatal — cockpit emit must never block the run */
  }
}

// 2026-04-28 Phase RL: 6 -> 3. With MAX-plan TPM throttling (brief Anthropic
// throttling within the MAX plan, NOT the 5h cap) reducing parallel
// spawns helps. 3 is a compromise between speed and TPM avoidance.
const MAX_CONCURRENT_SPAWNS = 3;

/** Sniper pause: user window between Roast↔V2, V2↔V3, Synthesis↔Re-Synth. Default 25s. */
const SNIPER_PAUSE_MS = (() => {
  const raw = Number.parseInt(
    process.env.LAZYOS_SNIPER_PAUSE_MS ?? '',
    10,
  );
  return Number.isFinite(raw) && raw >= 0 ? raw : 25_000;
})();
const SNIPER_PAUSE_POLL_MS = 1500;

/**
 * Waits until SNIPER_PAUSE_MS has elapsed OR a new
 * user-correction arrives after `pauseStartedAt`. Returns the number
 * of corrections found in the pause window (0 = none, spawn without
 * multi-round; >0 = user injected, V2 or V3 should react).
 */
export const SNIPER_PAUSE_MS_PUBLIC = SNIPER_PAUSE_MS;

export async function waitForSniperPause(
  parentTicketId: string,
  pauseStartedAt: number,
  durationMs: number,
): Promise<number> {
  if (durationMs <= 0) return 0;
  const deadline = Date.now() + durationMs;
  let found = 0;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await new Promise((r) =>
      setTimeout(r, Math.min(SNIPER_PAUSE_POLL_MS, remaining)),
    );
    try {
      const { getDb } = await import('../../db/client');
      const db = getDb();
      const rows = db.$raw
        .prepare(
          `SELECT COUNT(*) as c FROM events
            WHERE entity_type = 'ticket'
              AND entity_id = ?
              AND event_type = 'commented'
              AND created_at >= ?
              AND json_extract(payload, '$.kind') = 'user-correction'`,
        )
        .get(parentTicketId, pauseStartedAt) as { c?: number } | undefined;
      const count = rows?.c ?? 0;
      if (count > found) {
        found = count;
        // As soon as some arrive: wait a bit longer (max +2s) so that
        // rapidly successive corrections are all collected,
        // then abort.
        const grace = Math.min(2000, deadline - Date.now());
        if (grace > 0) {
          await new Promise((r) => setTimeout(r, grace));
        }
        break;
      }
    } catch {
      /* poll error non-fatal */
    }
  }
  return found;
}

// Owner directive Opus-only (2026-05-29): all tiers now run Opus
// (MODEL_NAMES). A shorter 'sonnet'/'haiku' timeout would kill the slower
// Opus run prematurely (exit=-1, 0 tokens) → hence the Opus timeout
// (5 min) everywhere.
const TIER_TIMEOUT_MS: Record<TierModel, number> = {
  opus: 5 * 60_000,
  sonnet: 5 * 60_000,
  haiku: 5 * 60_000,
};

export interface SpawnTierOpts {
  workspaceId: string;
  workspacePath: string;
  parentTicketId: string;
  workstreamId: string;
  prompt: string;
  tierMix: { opus: number; sonnet: number; haiku: number };
}

export interface TierSpawnResult {
  totalSpawned: number;
  totalSucceeded: number;
  totalFailed: number;
  totalCostCents: number;
  outputs: Array<{
    tier: TierModel;
    agentIdx: number;
    role: string;
    text: string;
    tokens: { input: number; output: number; cacheRead: number };
    costCents: number;
    durationMs: number;
    rateLimited: boolean;
  }>;
}

interface SpawnPlan {
  tier: TierModel;
  agentIdx: number;
  role: string;
  focus: string;
}

/**
 * Run all tier-spawns. Emits `commented` events as they complete.
 * Returns aggregated result.
 */
export async function spawnTier(opts: SpawnTierOpts): Promise<TierSpawnResult> {
  // Owner directive (2026-05-29/30): EXCLUSIVELY Opus 4.8 for every spawn.
  // The tierMix (opus/sonnet/haiku) still only controls the NUMBER of parallel
  // agents (breadth), but EVERY slot runs as 'opus' — label, model
  // (MODEL_NAMES.opus) AND effort (xhigh) are thus independent of the pricing.ts
  // alias Opus. So a sonnet#/haiku# agent never shows up in the smoke again, and
  // even if someone ever removes the pricing alias, every tier spawn stays
  // Opus. agentIdx stays globally unique (running), so tmux session
  // names + UI labels do not collide.
  const plan: SpawnPlan[] = [];
  let globalIdx = 0;
  const totalSlots = opts.tierMix.opus + opts.tierMix.sonnet + opts.tierMix.haiku;
  for (let i = 0; i < totalSlots; i++, globalIdx++) {
    const r = pickRoleForIndex(globalIdx);
    plan.push({ tier: 'opus', agentIdx: i, role: r.name, focus: r.focus });
  }

  const outputs: TierSpawnResult['outputs'] = [];
  let succeeded = 0;
  let failed = 0;
  let costTotal = 0;

  // Sprint C (2026-04-29): sub-workstreams card in the chat (idempotent).
  void emitSubWorkstreamsCardIfAbsent({
    workspaceId: opts.workspaceId,
    workstreamId: opts.workstreamId,
  });

  // Owner-fix run-cockpit (2026-05-28): aggregated cockpit-card emit/update.
  // Phase 'tier-spawn' — the sub-agents are being dispatched. Idempotent.
  // The old cards (sub-workstreams here, iterate-pipeline/iterate-version
  // later in runIterate) remain emitted for back-compat; in the UI
  // the renderer suppresses them as soon as the cockpit card is active.
  void emitRunCockpitCard({
    workspaceId: opts.workspaceId,
    workstreamId: opts.workstreamId,
    phase: 'tier-spawn',
    subWorkstreams: plan.map((p) => ({
      role: `${p.tier}-${p.role}`,
      status: 'pending',
    })),
  });

  // FIFO queue with concurrency cap.
  const inFlight = new Set<Promise<void>>();
  for (const slot of plan) {
    while (inFlight.size >= MAX_CONCURRENT_SPAWNS) {
      await Promise.race(inFlight);
    }
    const task = (async (): Promise<void> => {
      try {
        const result = await runOne(opts, slot);
        outputs.push(result);
        if (result.rateLimited) {
          failed += 1;
        } else {
          succeeded += 1;
          costTotal += result.costCents;
        }
        // Live event as a comment on the master ticket so the UI can see it
        await emitEvent({
          segmentId: opts.workspaceId,
          entityType: 'ticket',
          entityId: opts.parentTicketId,
          eventType: 'commented',
          actor: `agent:${slot.tier}-${slot.role}` as ActorType,
          payload: {
            tier: slot.tier,
            agentIdx: slot.agentIdx,
            role: slot.role,
            focus: slot.focus,
            text: result.text,
            tokens: result.tokens,
            costCents: result.costCents,
            durationMs: result.durationMs,
            workstreamId: opts.workstreamId,
            rateLimited: result.rateLimited,
            kind: 'tier-output',
          },
          sensitivity: 'low',
        }).catch(() => undefined);

        // Wave 7 (2026-05-01): persistent LoopPhaseCard per (tier, agentIdx).
        // One card per agent in the tier-mix matrix; on repeated calls
        // (e.g. multi-round iterate) it is updated in-place.
        if (opts.workstreamId) {
          const tierObj: Record<string, unknown> = {
            kind: 'tier-output',
            workstreamId: opts.workstreamId,
            workspaceId: opts.workspaceId,
            tier: slot.tier,
            agentIdx: slot.agentIdx,
            actor: slot.role,
            text: result.text,
          };
          await emitOrUpdateCard({
            coords: {
              workspaceId: opts.workspaceId,
              workstreamId: opts.workstreamId,
              surfaceKind: 'loop-phase',
              subKey: tierOutputSubKey(slot.tier, slot.agentIdx),
            },
            content: `<surface:loop-phase>${JSON.stringify(tierObj)}</surface:loop-phase>`,
            actor: 'system',
          }).catch(() => undefined);
        }
      } catch (err) {
        failed += 1;
        await emitEvent({
          segmentId: opts.workspaceId,
          entityType: 'ticket',
          entityId: opts.parentTicketId,
          eventType: 'error_logged',
          actor: 'system',
          payload: {
            message: err instanceof Error ? err.message : String(err),
            tier: slot.tier,
            agentIdx: slot.agentIdx,
            workstreamId: opts.workstreamId,
          },
          sensitivity: 'low',
        }).catch(() => undefined);
      }
    })();
    inFlight.add(task);
    void task.finally(() => {
      inFlight.delete(task);
    });
  }

  await Promise.all(inFlight);

  return {
    totalSpawned: plan.length,
    totalSucceeded: succeeded,
    totalFailed: failed,
    totalCostCents: costTotal,
    outputs,
  };
}

async function runOne(
  opts: SpawnTierOpts,
  slot: SpawnPlan,
): Promise<TierSpawnResult['outputs'][number]> {
  const model = MODEL_NAMES[slot.tier];
  const effort = TIER_EFFORT[slot.tier];

  const systemPrompt = [
    `Du bist ein Sub-Agent eines ${BRAND_NAME}-Multi-Agent-Plans.`,
    `Workstream: ${opts.workstreamId}`,
    `Master-Ticket: ${opts.parentTicketId}`,
    `Workspace: ${opts.workspaceId}`,
    `Deine Diversity-Rolle: **${slot.role}** — fokussiere auf ${slot.focus}.`,
    `Du bist Agent ${slot.agentIdx + 1} im Tier ${slot.tier} (Effort ${effort}).`,
    '',
    'Aufgabe: Lies den Plan-Prompt unten, schreib einen kompakten Vorschlag/Plan-Beitrag aus deiner Diversity-Perspektive.',
    'Maximal 600 Woerter. Markdown ok, KEINE surface:-Tags. KEIN Tool-Use.',
    'Strukturiere: 1) Kerneinsicht (1 Satz) 2) Top-3 konkrete Schritte 3) Hauptrisiko aus deiner Perspektive.',
  ].join('\n');

  // Pattern 2 Digital-Twin (2026-05-01): compact <TWIN_USER>+<TWIN_DOMAIN>
  // JSON block instead of a markdown wall. Fail-soft (empty string on error).
  const twins = await formatTwinsForPrompt(opts.workspaceId).catch(() => '');
  const systemPromptEnriched = twins ? `${systemPrompt}\n\n${twins}` : systemPrompt;

  // tmux spawn instead of direct child_process - survives lazyos-web restart.
  // Sprint C (2026-04-29): sub-workstream row per tier spawn.
  // Pattern 5 wave 2 (2026-05-01): the spawnAndAudit wrapper persists
  // automatically into reasoning_audit (queueMicrotask, fail-soft, ~0ms latency).
  const subId = await trySubWs(opts.workstreamId, 'tier-spawn', model);
  const result = await spawnAndAudit(
    {
      workspaceId: opts.workspaceId,
      workspacePath: opts.workspacePath,
      workstreamId: opts.workstreamId,
      subWorkstreamId: subId,
      tier: slot.tier,
      agentIdx: slot.agentIdx,
      model,
      systemPrompt: systemPromptEnriched,
      userPrompt: opts.prompt,
      timeoutMs: TIER_TIMEOUT_MS[slot.tier],
    },
    {
      workspaceId: opts.workspaceId,
      workstreamId: opts.workstreamId,
      parentTicketId: opts.parentTicketId,
      phase: phaseFromSlot(slot),
      role: 'sub-spawn',
      priorOutputs: [],
    },
  );

  // Backoff on rate-limit so subsequent spawns get breathing room
  if (result.rateLimited) await sleep(2000);

  return {
    tier: slot.tier,
    agentIdx: slot.agentIdx,
    role: slot.role,
    text: result.text,
    tokens: result.tokens,
    costCents: result.costCents,
    durationMs: result.durationMs,
    rateLimited: result.rateLimited,
  };
}

function phaseFromSlot(slot: SpawnPlan): string {
  // Tier spawns are their own phase, not V1/V2/V3 (that is the sniper loop).
  return `tier-${slot.tier}-${slot.agentIdx}`;
}

/**
 * Synthesis lead (Phase D, MVP):
 * Takes all tier outputs, lets Opus-xhigh consolidate them into a
 * final plan with a user-facing section. Writes the output as a
 * `commented` event with `payload.kind='synthesis'` on the master ticket.
 */
export async function runSynthesis(opts: {
  workspaceId: string;
  workspacePath: string;
  parentTicketId: string;
  workstreamId: string;
  originalPrompt: string;
  outputs: TierSpawnResult['outputs'];
}): Promise<{ text: string; costCents: number; durationMs: number }> {
  const startedAt = Date.now();
  const succeeded = opts.outputs.filter((o) => !o.rateLimited && o.text.length > 0);
  if (succeeded.length === 0) {
    return { text: '(keine Tier-Outputs zum Synthetisieren)', costCents: 0, durationMs: 0 };
  }
  const condensed = succeeded
    .map((o, i) => `### #${i + 1} ${o.tier.toUpperCase()} · ${o.role}\n${o.text}`)
    .join('\n\n---\n\n');

  const systemPrompt = [
    `Du bist der Lead-Synthesizer eines ${BRAND_NAME}-Multi-Agent-Plans.`,
    'Du bekommst N Plan-Vorschläge von Sub-Agents (Opus/Sonnet/Haiku) mit unterschiedlichen Diversity-Rollen.',
    'Konsolidiere zu *einem* finalen Plan-Doc.',
    '',
    'Output-Struktur (Markdown):',
    '## Konsolidierter Plan',
    '<3-7 nummerierte Schritte mit Begründung>',
    '',
    '## User-Sicht',
    '1. Du klickst X. 2. System fragt Y. 3. Du antwortest. 4. System macht Z.',
    '',
    '## Offene Fragen',
    'PFLICHT-Format pro Frage (≥80% sollten OPTIONS haben — User klickt statt tippen):',
    '`- [?] <Frage> | OPTIONS: <A> | <B> | <C>` (2-5 Optionen, plausible Defaults).',
    'Beispiel: `- [?] Sidebar wo? | OPTIONS: rechts Desktop | unter Editor | Drawer-Modal`',
    'NUR ohne OPTIONS bei reinen Erklärungs-Fragen (z.B. Schema-Detail).',
    '',
    '## Cluster-Übersicht',
    '<welche Sub-Agents was vorgeschlagen haben, kurz pro Tier>',
    '',
    'Wenn ≥3 unvereinbare Cluster: am Ende `@max` als Mention.',
    '',
    'PFLICHT-Section ## Sub-Tickets (PHASE H 2026-04-26):',
    'Liste 2-6 ausführbare Sub-Tickets im STRIKT YAML-Format ohne Wrap:',
    '```yaml',
    '- title: <Imperativ-Titel max 80 Zeichen>',
    '  prio: P1',
    '  body: |',
    '    <2-4 Saetze was zu tun ist + Akzeptanzkriterium>',
    '- title: ...',
    '  prio: P2',
    '  body: |',
    '    ...',
    '```',
    'WICHTIG: title als Imperativ ("Implementiere X" / "Refactor Y" / "Teste Z"),',
    'prio aus P0/P1/P2/P3, body Markdown-frei. Genau dieses Block-Format —',
    'der Server parst es und legt automatisch Sub-Tickets mit parentTicketId an.',
    '',
    'WICHTIG — Conversation-Mix (Sub-Plan F 2026-04-30):',
    '1. Beginne mit 1-2 Sätzen knappe Conversation als Intro',
    '   (max 50 Worte, hartes Budget, KEIN Multi-Paragraph-Wall).',
    '2. DANN folgt der Plan-Markdown wie oben spezifiziert.',
    '3. AM ALLERLETZTEN ENDE: <surface:milestone>{...}</surface:milestone> Tag',
    '   als strukturierte Daten — die Completion-Card im Apple-Keynote-Style.',
    '',
    'Beispiel für den Conversation-Intro-Block:',
    '"Ich konsolidiere die Vorschläge der Sub-Agents zu einem Plan. Drei',
    ' Cluster sind klar, einer braucht @max-Entscheidung."',
    '',
    'KEIN Surface-Tag ohne vorhergehende Conversation. KEIN Spam-Feeling.',
    '',
    'Maximal 2000 Wörter (ohne Surface-Tag und ohne Intro-Block).',
    '',
    'PFLICHT-Section ## Consensus-Meta (Pattern 5 Traceability, 2026-05-01):',
    'Am ALLER-LETZTEN ENDE (nach Surface-Tag), füge einen YAML-Block ein:',
    '```yaml consensus_meta',
    'level: strong | majority | disagreement',
    'clusters: <Anzahl unvereinbarer Cluster, integer>',
    'outliers: <Anzahl Outlier-Vorschläge, integer>',
    'open_questions: <Anzahl ## Offene Fragen Bullets, integer>',
    'reasoning: <1-Satz-Begründung warum dieses Level>',
    '```',
    'Regeln (deterministisch — wende sie strikt an):',
    '  - clusters >= 3 ODER open_questions >= 3 → level = disagreement',
    '  - clusters == 2 ODER outliers >= 1 ODER open_questions >= 2 → level = majority',
    '  - sonst → level = strong',
    'Dieser Block ist nicht-optional — der Server parst ihn deterministisch',
    'für Konsens-Routing. Bei fehlendem Block fällt das System auf eine',
    'konservative Substring-Heuristik zurück (default = majority).',
  ].join('\n');

  const userPrompt = [
    `Original-Anfrage von Max: ${opts.originalPrompt}`,
    '',
    `Workstream: ${opts.workstreamId}`,
    `Master-Ticket: ${opts.parentTicketId}`,
    '',
    `Es gibt ${succeeded.length} Sub-Agent-Outputs:`,
    '',
    condensed,
  ].join('\n');

  // Synthesis via tmux spawn for resilience
  const synthSubId = await trySubWs(
    opts.workstreamId,
    'synthesis',
    MODEL_NAMES.opus,
  );
  // Sprint 2 / Strand B: RAG inject for synthesis (workspace context).
  // Pattern 5 (2026-05-01): with sources, so reasoning_audit references the
  // chunks explicitly. Drift detection depends on it.
  // Pattern 2 (2026-05-01): twin block BETWEEN systemPrompt and RAG block.
  const synthRag = await injectRagContextWithSources(opts.workspaceId, opts.originalPrompt);
  const synthTwins = await formatTwinsForPrompt(opts.workspaceId).catch(() => '');
  const synthSystemWithTwins = synthTwins
    ? `${systemPrompt}\n\n${synthTwins}`
    : systemPrompt;
  const synthSystemEnriched = synthRag.text
    ? `${synthSystemWithTwins}\n\n---\n${synthRag.text}`
    : synthSystemWithTwins;
  // Pattern 5 wave 2 (2026-05-01): spawnAndAudit with sourceChunks (RAG chunks)
  // and priorOutputs (tier hashes). Drift detection depends on it.
  const synthResult = await spawnAndAudit(
    {
      workspaceId: opts.workspaceId,
      workspacePath: opts.workspacePath,
      workstreamId: opts.workstreamId,
      subWorkstreamId: synthSubId,
      tier: 'opus',
      agentIdx: 999, // unique session-name
      model: MODEL_NAMES.opus,
      systemPrompt: synthSystemEnriched,
      userPrompt,
      timeoutMs: 6 * 60_000,
    },
    {
      workspaceId: opts.workspaceId,
      workstreamId: opts.workstreamId,
      parentTicketId: opts.parentTicketId,
      phase: 'synthesis',
      role: 'synthesis',
      sourceChunks: synthRag.sources,
      priorOutputs: succeeded.map((o, i) => ({
        phase: `tier-${o.tier}-${i}`,
        hash: hashOutput(o.text),
      })),
    },
  );
  const text = synthResult.text || '(Synthesis fehlgeschlagen)';
  const tokens = synthResult.tokens;
  const costCents = synthResult.costCents;
  const durationMs = synthResult.durationMs;

  // Phase AC.1 + Pattern 5 hardening (2026-05-01):
  // Consensus level PREFERABLY from the `consensus_meta` YAML block that the
  // synthesizer is required to emit. Server-side re-compute overrides
  // when the LLM claims `level: strong` but the counts contradict it.
  // Substring heuristic only as fallback (goes conservatively to 'majority').
  const consensusMeta = detectConsensusMeta(text);
  const consensusLevel = consensusMeta.level;

  // P13 Devil's Advocate (2026-05-01, E4 extended 2026-05-27):
  // Falsification pass AFTER the synthesis. Gated to exactly the two cases
  // where confirmation bias is a risk:
  //   1. consensus_level='strong' — echo-chamber danger (false-strong).
  //   2. WHY block fed in — the read-back of prior beliefs (P0.3b)
  //      can let the AI confirm its own old convictions.
  //      The DA challenges these beliefs (N5 support, NOT the user).
  // Fail-soft: on DA failure the synthesis continues normally — the counter
  // is an extra safeguard, not a quality gate. Additive alongside enrichment.
  //
  // whyInjected is determined here purely for the gating (same source as
  // in the lead path: buildWhyBlockForLead). Fail-soft → empty block = no
  // WHY = false; the gating then falls back to 'strong'.
  const whyForGate = buildWhyBlockForLead(opts.workspaceId, opts.originalPrompt);
  const whyInjected = whyForGate.trim().length > 0;
  let devilsAdvocate: import('./devils-advocate').DevilsAdvocateResult | null =
    null;
  let devilsAdvocateGated = false;
  {
    const { shouldRunDevilsAdvocate } = await import('./devils-advocate');
    devilsAdvocateGated = shouldRunDevilsAdvocate({
      consensusLevel,
      whyInjected,
    });
  }
  if (devilsAdvocateGated) {
    try {
      const { runDevilsAdvocate } = await import('./devils-advocate');
      devilsAdvocate = await runDevilsAdvocate({
        workspaceId: opts.workspaceId,
        workspacePath: opts.workspacePath,
        workstreamId: opts.workstreamId,
        parentTicketId: opts.parentTicketId,
        synthesisText: text,
        originalPrompt: opts.originalPrompt,
      });
    } catch (err) {
      console.warn('[devils-advocate] failed:', err);
    }
  }

  await emitEvent({
    segmentId: opts.workspaceId,
    entityType: 'ticket',
    entityId: opts.parentTicketId,
    eventType: 'commented',
    actor: 'agent:lead-synthesizer',
    payload: {
      kind: 'synthesis',
      text,
      tokens,
      costCents,
      durationMs,
      workstreamId: opts.workstreamId,
      n_inputs: succeeded.length,
      consensus_level: consensusLevel,
      consensus_meta: {
        clusters: consensusMeta.clusters,
        outliers: consensusMeta.outliers,
        openQuestions: consensusMeta.openQuestions,
        reasoning: consensusMeta.reasoning,
        source: consensusMeta.source,
      },
      devils_advocate: devilsAdvocate
        ? {
            counterEvidenceCount: devilsAdvocate.counterEvidenceCount,
            unfalsifiable: devilsAdvocate.unfalsifiable,
            verdict: devilsAdvocate.verdict,
            costCents: devilsAdvocate.costCents,
          }
        : null,
    },
    sensitivity: 'low',
  }).catch(() => undefined);

  // P13: counter-evidence card as its OWN event — NOT mixed into the
  // synthesis. A separate "Counter-Evidence (Devil's
  // Advocate)" card appears in the chat. Only emit if the DA found at least 1 counter.
  if (devilsAdvocate && devilsAdvocate.counterEvidenceCount > 0) {
    await emitEvent({
      segmentId: opts.workspaceId,
      entityType: 'ticket',
      entityId: opts.parentTicketId,
      eventType: 'counter_evidence_card',
      actor: 'agent:devils-advocate',
      payload: {
        kind: 'counter-evidence',
        text: devilsAdvocate.text,
        verdict: devilsAdvocate.verdict,
        counterEvidenceCount: devilsAdvocate.counterEvidenceCount,
        unfalsifiable: devilsAdvocate.unfalsifiable,
        costCents: devilsAdvocate.costCents,
        durationMs: devilsAdvocate.durationMs,
        workstreamId: opts.workstreamId,
        synthesisHash: hashOutput(text),
      },
      sensitivity: 'low',
    }).catch(() => undefined);
  }

  // P13: separate push-trigger event when the synthesis is non-falsifiable.
  // Surface-card warning + p1 push, so Max actively reviews it instead
  // of overlooking it in the chat stream.
  if (devilsAdvocate && devilsAdvocate.unfalsifiable) {
    await emitEvent({
      segmentId: opts.workspaceId,
      entityType: 'ticket',
      entityId: opts.parentTicketId,
      eventType: 'synthesis_unfalsifiable',
      actor: 'agent:devils-advocate',
      payload: {
        kind: 'synthesis-unfalsifiable',
        text: devilsAdvocate.text,
        workstreamId: opts.workstreamId,
        synthesisHash: hashOutput(text),
      },
      sensitivity: 'low',
    }).catch(() => undefined);
  }

  // PHASE H (2026-04-26): parse sub-tickets from the synthesis markdown +
  // auto-create them with parentTicketId. This turns 1 synthesis immediately
  // into N executable tickets; the user does not have to decompose it himself.
  let createdCount = 0;
  try {
    const subTickets = parseSubTicketsBlock(text);
    for (const st of subTickets) {
      await createSubTicketEvent({
        workspaceId: opts.workspaceId,
        parentTicketId: opts.parentTicketId,
        workstreamId: opts.workstreamId,
        title: st.title,
        prio: st.prio,
        body: st.body,
      });
      createdCount++;
    }
  } catch (err) {
    console.warn('[synthesis] sub-ticket-parse failed:', err);
  }

  // Workflow auto-advance of the master ticket (user bug 2026-04-26: pipeline
  // stayed on "draft" despite a finished synthesis). After synthesis the master
  // is de-facto in the review stage — the user should approve/reject.
  await emitEvent({
    segmentId: opts.workspaceId,
    entityType: 'ticket',
    entityId: opts.parentTicketId,
    eventType: 'approval_requested',
    actor: 'agent:lead-synthesizer',
    payload: {
      reason: 'Synthesis fertig',
      subTicketsCreated: createdCount,
      workstreamId: opts.workstreamId,
    },
    sensitivity: 'low',
  }).catch(() => undefined);

  // V3 wire point 4 (2026-05-01): in sandbox workspaces auto-approve
  // after synthesis. Sub-dispatch then takes effect directly (wire point 3).
  await maybeAutoApproveInSandbox({
    workspaceId: opts.workspaceId,
    parentTicketId: opts.parentTicketId,
    workstreamId: opts.workstreamId,
    reason: 'sandbox-synthesis-complete',
  });

  return { text, costCents, durationMs };
}

/**
 * Phase AC.1 (2026-04-26): derive the consensus level from the synthesis markdown.
 *
 *  - 'strong' = clear consensus, sub-pipelines can auto-dispatch
 *  - 'majority' = consensus with outliers, user should click Quick-Start
 *  - 'disagreement' = user decision required (@max mention, multiple clusters)
 *
 * Defensive: when unclear, always one step more cautious than necessary.
 */
export type ConsensusLevel = 'strong' | 'majority' | 'disagreement';

export interface ConsensusMeta {
  level: ConsensusLevel;
  clusters: number | null;
  outliers: number | null;
  openQuestions: number | null;
  reasoning: string | null;
  /**
   * How the level was derived:
   *   - 'meta-block' = parsed from the deterministic YAML block
   *   - 'substring-fallback' = LLM delivered no block, heuristic
   *   - 'meta-overridden' = block level inconsistent with block counts → server recomputes
   */
  source: 'meta-block' | 'substring-fallback' | 'meta-overridden';
}

/**
 * Phase AC.1 + Pattern 5 hardening (2026-05-01):
 * Reads PREFERABLY the `consensus_meta` YAML block that the synthesizer
 * must emit deterministically. Substring heuristic only as a fallback.
 *
 * Defensive: more conservative than the LLM claims — if the block
 * says `level: strong` but `clusters >= 3`, we override to
 * `disagreement`. Prevents auto-dispatch due to an LLM misjudgment.
 */
export function detectConsensusLevel(synthesisText: string): ConsensusLevel {
  return detectConsensusMeta(synthesisText).level;
}

export function detectConsensusMeta(synthesisText: string): ConsensusMeta {
  const blockMatch = synthesisText.match(
    /```yaml\s+consensus_meta\s*\n([\s\S]+?)```/i,
  );
  if (blockMatch) {
    const body = blockMatch[1];
    const level = parseYamlField(body, 'level');
    const clusters = parseYamlInt(body, 'clusters');
    const outliers = parseYamlInt(body, 'outliers');
    const openQuestions = parseYamlInt(body, 'open_questions');
    const reasoning = parseYamlField(body, 'reasoning');
    const claimed = normaliseLevel(level);
    if (claimed) {
      // Server-side re-compute: if the LLM lies, we override.
      const recomputed = recomputeLevel(clusters, outliers, openQuestions);
      if (recomputed && recomputed !== claimed && stricter(recomputed, claimed)) {
        return {
          level: recomputed,
          clusters,
          outliers,
          openQuestions,
          reasoning,
          source: 'meta-overridden',
        };
      }
      return {
        level: claimed,
        clusters,
        outliers,
        openQuestions,
        reasoning,
        source: 'meta-block',
      };
    }
  }
  // Fallback heuristic (old substring path, defensive → 'majority').
  const t = synthesisText.toLowerCase();
  let fallback: ConsensusLevel = 'strong';
  if (/(^|\s)@max(\b|\s)/.test(synthesisText)) fallback = 'disagreement';
  else if (t.includes('disagreement') || t.includes('unvereinbar')) fallback = 'disagreement';
  else {
    const clusterSection = synthesisText.match(
      /##\s+Cluster-(?:Übersicht|Uebersicht|Overview)([\s\S]*?)(?:\n##\s|$)/i,
    );
    if (clusterSection) {
      const bullets = clusterSection[1].match(/^[\s]*[-*]\s+/gm) ?? [];
      if (bullets.length >= 3) fallback = 'disagreement';
      else if (bullets.length >= 2) fallback = 'majority';
    }
    if (fallback === 'strong') {
      if (t.includes('outlier') || t.includes('ausreißer') || t.includes('ausreisser')) {
        fallback = 'majority';
      }
      const openQ = synthesisText.match(/\[\?\]/g) ?? [];
      if (openQ.length >= 2 && fallback === 'strong') fallback = 'majority';
    }
  }
  // If the synthesizer delivered NO meta block, we conservatively go
  // at least to 'majority' so the user never gets a surprise auto-dispatch.
  if (fallback === 'strong') fallback = 'majority';
  return {
    level: fallback,
    clusters: null,
    outliers: null,
    openQuestions: null,
    reasoning: null,
    source: 'substring-fallback',
  };
}

function parseYamlField(body: string, key: string): string | null {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'mi');
  const m = body.match(re);
  if (!m) return null;
  return m[1].replace(/^["']|["']$/g, '').trim();
}

function parseYamlInt(body: string, key: string): number | null {
  const v = parseYamlField(body, key);
  if (v === null) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function normaliseLevel(v: string | null): ConsensusLevel | null {
  if (!v) return null;
  const norm = v.toLowerCase().trim();
  if (norm === 'strong' || norm === 'majority' || norm === 'disagreement') {
    return norm;
  }
  return null;
}

function recomputeLevel(
  clusters: number | null,
  outliers: number | null,
  openQuestions: number | null,
): ConsensusLevel | null {
  if (clusters === null && outliers === null && openQuestions === null) return null;
  if ((clusters ?? 0) >= 3 || (openQuestions ?? 0) >= 3) return 'disagreement';
  if ((clusters ?? 0) === 2 || (outliers ?? 0) >= 1 || (openQuestions ?? 0) >= 2) {
    return 'majority';
  }
  return 'strong';
}

function stricter(a: ConsensusLevel, b: ConsensusLevel): boolean {
  const order = { strong: 0, majority: 1, disagreement: 2 } as const;
  return order[a] > order[b];
}

interface ParsedSubTicket {
  title: string;
  prio: 'P0' | 'P1' | 'P2' | 'P3';
  body: string;
}

/**
 * Parses the ## Sub-Tickets section from the synthesis markdown.
 * Expects a YAML-like format between ```yaml and ```.
 * Very defensive — on schema drift we return an empty array instead of throwing.
 */
export function parseSubTicketsBlock(synthesis: string): ParsedSubTicket[] {
  // Find the section — search for "## Sub-Tickets", then the YAML code block
  const section = synthesis.split(/^##\s+Sub-Tickets\s*$/m)[1];
  if (!section) return [];
  const codeMatch = section.match(/```(?:yaml|yml)?\n([\s\S]+?)```/);
  if (!codeMatch) return [];
  let yaml = codeMatch[1];

  // 2026-04-26: LLMs often use a `sub_tickets:` wrapper. Remove the wrapper.
  yaml = yaml.replace(/^sub_tickets:\s*\n/m, '');

  const tickets: ParsedSubTicket[] = [];
  // Items start with `- title:`. Whitespace-tolerant for indented wrappers.
  const items = yaml.split(/^\s*-\s+title:\s*/m).filter((s) => s.trim().length > 0);
  for (const raw of items) {
    const titleMatch = raw.match(/^(.+?)$/m);
    if (!titleMatch) continue;
    const title = titleMatch[1].replace(/^["']|["']$/g, '').trim().slice(0, 200);
    if (title.length < 4) continue;

    const prioMatch = raw.match(/^\s*prio:\s*(P[0-3])/m);
    const prio = (prioMatch?.[1] ?? 'P2') as ParsedSubTicket['prio'];

    let body = '';
    const bodyMatch = raw.match(/^\s*body:\s*\|?\s*\n([\s\S]+?)(?=\n\s*[-]\s+title|$)/m);
    if (bodyMatch) {
      body = bodyMatch[1]
        .split('\n')
        .map((l) => l.replace(/^\s{2,4}/, ''))
        .join('\n')
        .trim()
        .slice(0, 2000);
    }
    tickets.push({ title, prio, body });
    if (tickets.length >= 8) break;
  }
  return tickets;
}

export async function createSubTicketEvent(opts: {
  workspaceId: string;
  parentTicketId: string;
  workstreamId: string;
  title: string;
  prio: string;
  body: string;
}): Promise<void> {
  // 2026-04-28 fix: real ULID instead of custom base36 (was 17 chars instead of
  // 26 → /tickets/[id] page threw 404 because the regex expected 26 chars).
  const { ulid } = await import('@/lib/ulid');
  const ticketId = `TCK-${ulid()}`;
  await emitEvent({
    segmentId: opts.workspaceId as string,
    entityType: 'ticket',
    entityId: ticketId,
    eventType: 'created',
    actor: 'agent:lead-synthesizer',
    payload: {
      title: opts.title,
      body: opts.body,
      prio: opts.prio,
      workstreamId: opts.workstreamId,
      parentTicketId: opts.parentTicketId,
      tags: ['auto-generated', 'sub-ticket'],
    },
    sensitivity: 'low',
  }).catch((err) => {
    console.warn('[synthesis] createSubTicketEvent failed:', err);
  });
}

// ===========================================================================
// Phase IT (2026-04-27) — iterative roast loop
// ===========================================================================
//
// Alternative to spawn+synthesis: 1 lead writes V1, 2 roasters
// (user advocate + pragmatist) attack V1, the lead writes V2 with diff
// annotations. Total: 4 spawns instead of 20+ in swarm mode.
//
// Output: same structure as runSynthesis (commented kind=synthesis on the
// master ticket), so Phase AC + auto-dispatch take effect unchanged.

// Roaster roles — pool. `runIterate` takes `slice(0, roasterCount)` from
// `IterateConfig`. The order is fixed: user advocate + pragmatist (standard,
// 2 roasters) → hacker + performance (deep, 4 roasters). Fast (0 roasters)
// skips this phase entirely.
// P15 Constraint-as-Enabler (2026-05-01, Anne quote "compliance as enabler"):
// Each roaster MUST deliver, at the end of its findings, a consequence line
// for EVERY lever point: "If fixed: this enables <X>". This makes the
// findings not be perceived as a wall, but as a lever/gate.
const CONSEQUENCE_REQUIREMENT =
  ' PFLICHT: Jeder Finding-Punkt endet mit einer Konsequenz-Zeile im Format ' +
  '"Wenn fix: dies ermöglicht <konkretes Outcome>" — Trust-Zone, ' +
  'Reichweite, Compliance-Gain, Performance-Headroom o.ä. Kein Finding ohne ' +
  'positive Konsequenz-Linie.';

const ROAST_ROLES = [
  {
    id: 'roast-user-advocate',
    label: 'User-Anwalt',
    focus:
      'Du bist der Anwalt des Users. Roast den Plan brutal aus User-Perspektive: Wo ist Developer-Speak statt User-Sicht? Wo fehlt eine konkrete Userflow? Wo wuerde der User abbrechen? Maximal 600 Woerter, nur Kritik + Verbesserungs-Vorschlaege als Bullets. KEIN neuer Plan-Entwurf — nur Findings.' +
      CONSEQUENCE_REQUIREMENT,
  },
  {
    id: 'roast-pragmatist',
    label: 'Pragmatist',
    focus:
      'Du bist der Pragmatist. Roast den Plan auf Over-Engineering, Scope-Creep, fehlendes 80/20. Was kann WEG ohne den Kern zu schwaechen? Welche Features sind YAGNI? Maximal 600 Woerter, nur Kritik + Cuts als Bullets. KEIN neuer Plan — nur Findings.' +
      CONSEQUENCE_REQUIREMENT,
  },
  {
    id: 'roast-hacker',
    label: 'Hacker',
    focus:
      'Du bist der Red-Team-Hacker. Roast den Plan auf Security-Loecher, Auth-Bypass-Pfade, Input-Injection, Race-Conditions, missbrauchbare APIs. Welche Annahmen sind angreifbar? Wo fehlt RLS / Validation / Rate-Limit? Maximal 600 Woerter, nur Findings + Exploit-Skizzen als Bullets. KEIN neuer Plan — nur Schwachstellen.' +
      CONSEQUENCE_REQUIREMENT,
  },
  {
    id: 'roast-performance',
    label: 'Performance-Skeptiker',
    focus:
      'Du bist der Performance-Skeptiker. Roast den Plan auf N+1 Queries, fehlende Indizes, blocking IO, unnoetige Re-Renders, fehlendes Caching, ungebremste Loops, Memory-Bloat. Was bricht unter Last? Maximal 600 Woerter, nur Kritik + Mess-Vorschlaege als Bullets. KEIN neuer Plan — nur Findings.' +
      CONSEQUENCE_REQUIREMENT,
  },
] as const;

interface IterateDiffScore {
  openQuestionsBefore: number;
  openQuestionsAfter: number;
  userFlowSectionAdded: boolean;
  lengthChange: number;
  improvementPct: number;
}

interface IterateResult {
  finalText: string;
  iterations: number;
  diffScore: IterateDiffScore;
  totalCostCents: number;
  totalDurationMs: number;
}

/**
 * Sub-Plan 04 wave 2 (2026-04-29) — live iterate card in the chat.
 * Idempotent: emit one `<surface:iterate-pipeline>` chat_message_completed
 * per workstream, ONCE at the start of the iterate pipeline. The card then
 * polls pause status itself and transforms. On resume,
 * no second card is emitted (LIKE query on the existing card).
 */
async function emitIteratePipelineCardIfAbsent(args: {
  workspaceId: string;
  workstreamId: string;
  workstreamName?: string;
  maxVersion?: number;
}): Promise<void> {
  try {
    // Sub-Plan C (2026-04-30): one card per (workstream, kind).
    // On re-spawn (resume after stale check, V4→V5 transition) the
    // existing card is updated in-place. The frontend still renders the card
    // at its original stream position.
    const surfaceJson = JSON.stringify({
      workstreamId: args.workstreamId,
      workspaceId: args.workspaceId,
      workstreamName: args.workstreamName,
      maxVersion: args.maxVersion ?? 5,
    });
    const text = [
      'Plan-Pipeline gestartet — die Wellen V1...V5 laufen automatisch.',
      'Du kannst während jeder 25 s Sniper-Pause eine Korrektur in die',
      'Karte schreiben — sie landet in der nächsten Welle.',
      '',
      `<surface:iterate-pipeline>${surfaceJson}</surface:iterate-pipeline>`,
    ].join('\n');
    await emitOrUpdateCard({
      coords: {
        workspaceId: args.workspaceId,
        workstreamId: args.workstreamId,
        surfaceKind: 'iterate-pipeline',
      },
      content: text,
      actor: 'system',
    });
  } catch {
    /* non-fatal */
  }
}

/**
 * Sub-Plan 02 (2026-04-29) — open-questions push trigger.
 * Sub-Plan D (2026-04-30) — additionally emit a `<surface:open-questions>` card
 * idempotently into the chat, with QuickChoice options if the
 * lead included `OPTIONS:` in the plan.
 *
 * Idempotency: LIKE query on existing chat_message_completed events of the
 * last 24h that contain this workstreamId surface tag — analogous to
 * emitIteratePipelineCardIfAbsent.
 */
/**
 * Sub-Plan 03 — Pattern 1 symbolic guard (2026-04-30).
 *
 * Quota check after each Vn output:
 *   ≥80% coverage OPTIONS + ≥2 distinct per list.
 * On violation:
 *   1. `commented` event `kind=symbolic-guard-warning` to the master ticket
 *      (workstream-scoped state in the DB, no closure risk).
 *   2. Status card in the chat (assistant bubble with rationale + expected
 *      behavior in the next iteration).
 *
 * Auto-reprompt loop (Vn → Vn-quickfix-reprompt) is Sprint 1.1 — this
 * wave delivers the detection + visibility. The reprompt itself is
 * invasive (originalPrompt fence, race-safe lock, telemetry) and belongs
 * in its own PR.
 */
async function logSymbolicGuardIfViolated(args: {
  workspaceId: string;
  parentTicketId: string;
  workstreamId: string;
  version: number;
  planText: string;
}): Promise<void> {
  try {
    const { parsePlanQuestions, checkOptionsQuota } = await import(
      '../../lib/workstreams/parse-plan-questions'
    );
    const qs = parsePlanQuestions(args.planText);
    const verdict = checkOptionsQuota(qs);
    if (verdict.ok || verdict.total < 2) return;

    await emitEvent({
      segmentId: args.workspaceId,
      entityType: 'ticket',
      entityId: args.parentTicketId,
      eventType: 'commented',
      actor: 'system',
      payload: {
        kind: 'symbolic-guard-warning',
        workstreamId: args.workstreamId,
        version: args.version,
        coverage: verdict.coverage,
        total: verdict.total,
        withOptions: verdict.withOptions,
        reasons: verdict.reasons,
      },
      sensitivity: 'low',
    }).catch(() => undefined);
  } catch {
    /* non-fatal — the guard never blocks the pipeline */
  }
}

async function emitOpenQuestionsIfAny(args: {
  workspaceId: string;
  parentTicketId: string;
  workstreamId: string;
  version: number;
  planText: string;
}): Promise<void> {
  try {
    const { parsePlanQuestions } = await import(
      '../../lib/workstreams/parse-plan-questions'
    );
    const questions = parsePlanQuestions(args.planText);
    if (questions.length === 0) return;

    // 1. DB event (push-rule trigger, the old path is preserved).
    await emitEvent({
      segmentId: args.workspaceId,
      entityType: 'ticket',
      entityId: args.parentTicketId,
      eventType: 'commented',
      actor: 'system',
      payload: {
        kind: 'plan-open-questions',
        workstreamId: args.workstreamId,
        version: args.version,
        questionCount: questions.length,
      },
      sensitivity: 'low',
    }).catch(() => undefined);

    // 2. Sub-Plan D — emit the chat surface idempotently.
    // Sub-Plan C (2026-04-30): one card per (workstream, kind). On
    // Vn transitions the questions block is updated in-place (new
    // version number, new/updated questions).
    try {
      const surfacePayload = {
        workstreamId: args.workstreamId,
        version: args.version,
        questions: questions.map((q) => ({
          id: q.id,
          q: q.text,
          ...(q.options && q.options.length > 0
            ? { options: q.options }
            : {}),
        })),
      };
      const surfaceJson = JSON.stringify(surfacePayload);
      const text = [
        `Plan V${args.version} hat ${questions.length} offene ${
          questions.length === 1 ? 'Frage' : 'Fragen'
        } — beantworte sie direkt hier, sie fließen in V${args.version + 1} ein.`,
        '',
        `<surface:open-questions>${surfaceJson}</surface:open-questions>`,
      ].join('\n');

      await emitOrUpdateCard({
        coords: {
          workspaceId: args.workspaceId,
          workstreamId: args.workstreamId,
          surfaceKind: 'open-questions',
        },
        content: text,
        actor: 'system',
      });
    } catch {
      /* non-fatal — the push event stays functional */
    }
  } catch {
    /* non-fatal */
  }
}

/**
 * Resume helper (Sub-Plan 01c) — collects data from the DB for a
 * `resumeFromVersion` call of runIterate. Reads the last iterate-version
 * event + roast outputs.
 */
export async function loadIterateResumeContext(
  workstreamId: string,
): Promise<{
  workspaceId: string;
  workspacePath: string;
  parentTicketId: string;
  originalPrompt: string;
  lastVersion: number;
  lastVersionText: string;
  roastTexts: Array<{ roleId: string; roleLabel: string; text: string }>;
} | null> {
  const { getDb } = await import('../../db/client');
  const db = getDb();
  const wsRow = db.$raw
    .prepare(
      'SELECT workspace_id, primary_ticket_id, status FROM workstreams WHERE id = ?',
    )
    .get(workstreamId) as
    | { workspace_id: string; primary_ticket_id: string | null; status: string }
    | undefined;
  if (!wsRow || !wsRow.primary_ticket_id) return null;

  const workspaceRow = db.$raw
    .prepare('SELECT path FROM workspaces WHERE id = ?')
    .get(wsRow.workspace_id) as { path: string | null } | undefined;
  const workspacePath =
    workspaceRow?.path?.trim() || defaultWorkspacePath(wsRow.workspace_id);

  // Find the original request (user prompt) from the oldest user-message event
  const promptRow = db.$raw
    .prepare(
      `SELECT json_extract(payload, '$.text') as text FROM events
        WHERE entity_type = 'ticket' AND entity_id = ?
          AND event_type = 'commented'
          AND json_extract(payload, '$.kind') IN ('user-message', 'master-prompt')
        ORDER BY created_at ASC LIMIT 1`,
    )
    .get(wsRow.primary_ticket_id) as { text: string | null } | undefined;
  const originalPrompt = promptRow?.text ?? '(Original-Prompt nicht gefunden)';

  // Highest iterate-version
  const lastVersionRow = db.$raw
    .prepare(
      `SELECT json_extract(payload, '$.version') as version,
              json_extract(payload, '$.text') as text
         FROM events
        WHERE entity_type = 'ticket' AND entity_id = ?
          AND event_type = 'commented'
          AND json_extract(payload, '$.kind') = 'iterate-version'
        ORDER BY CAST(json_extract(payload, '$.version') AS INTEGER) DESC,
                 created_at DESC
        LIMIT 1`,
    )
    .get(wsRow.primary_ticket_id) as { version: number | null; text: string | null } | undefined;
  if (!lastVersionRow || !lastVersionRow.text) return null;
  const lastVersion = lastVersionRow.version ?? 1;

  // Roast outputs for the last wave
  const roastRows = db.$raw
    .prepare(
      `SELECT json_extract(payload, '$.roasterRole') as role_id,
              json_extract(payload, '$.roasterLabel') as role_label,
              json_extract(payload, '$.text') as text
         FROM events
        WHERE entity_type = 'ticket' AND entity_id = ?
          AND event_type = 'commented'
          AND json_extract(payload, '$.kind') = 'iterate-roast'
          AND CAST(json_extract(payload, '$.version') AS INTEGER) = ?`,
    )
    .all(wsRow.primary_ticket_id, lastVersion) as Array<{
    role_id: string | null;
    role_label: string | null;
    text: string | null;
  }>;
  const roastTexts = roastRows
    .filter((r) => r.text)
    .map((r) => ({
      roleId: r.role_id ?? 'unknown',
      roleLabel: r.role_label ?? r.role_id ?? 'Roaster',
      text: r.text!,
    }));

  return {
    workspaceId: wsRow.workspace_id,
    workspacePath,
    parentTicketId: wsRow.primary_ticket_id,
    originalPrompt,
    lastVersion,
    lastVersionText: lastVersionRow.text,
    roastTexts,
  };
}

/**
 * Wave 7 (2026-05-01) — persistently emit one IterateVersionCard per V_n.
 *
 * One card per (workspaceId, workstreamId, surfaceKind=iterate-version,
 * subKey='v:N'). On re-synthesis of the same V_n (e.g. after a user inject)
 * it is updated in-place, no new row.
 *
 * Called by runIterate() for V1 + V_next.
 */
async function emitVersionCard(
  opts: { workspaceId: string; workstreamId: string },
  versionN: number,
  text: string,
  costCents: number,
): Promise<void> {
  const surfaceObj: Record<string, unknown> = {
    workstreamId: opts.workstreamId,
    workspaceId: opts.workspaceId,
    versionN,
    text,
    costCents,
  };
  await emitOrUpdateCard({
    coords: {
      workspaceId: opts.workspaceId,
      workstreamId: opts.workstreamId,
      surfaceKind: 'iterate-version',
      subKey: iterateVersionSubKey(versionN),
    },
    content: `<surface:iterate-version>${JSON.stringify(surfaceObj)}</surface:iterate-version>`,
    actor: 'system',
  }).catch(() => undefined);

  // Owner-fix run-cockpit (2026-05-28): for V_n>=2 the roaster phase is
  // active (V1 = lead, V2+ = roaster consolidation). Idempotent in-place
  // update of the cockpit card. costCents is updated in the same step.
  if (versionN >= 2) {
    void emitRunCockpitCard({
      workspaceId: opts.workspaceId,
      workstreamId: opts.workstreamId,
      phase: 'roaster',
      costCents,
    });
  }
}

/**
 * W1a — Reconcile + Handoff fail-soft helper (Self-Learning P0, 2026-05-28).
 *
 * Mirrors the hook from lib/workstreams/plan-executor.ts:786-845, encapsulated
 * for tier-iterate paths (runIterate + runIterateResume) that carry no own
 * plan steps. Both write calls (reconcileWorkstream,
 * persistWorkspaceHandoff) are separate try/catch — an error must NEVER
 * topple the iterate-run completion.
 *
 * stepStatuses = synthetic map (lead-v1/roasters/lead-final = 'done'),
 * since the tier-iterate has no real plan-step rows. determineOutcome
 * maps 'all done' → 'success' as intended; error paths do not reach the
 * helper at all (the run would have thrown earlier).
 *
 * N9: coordKey verbatim `${workspaceId}/${workstreamId}` as in plan-executor.ts:305.
 */
export async function runReconcileAndHandoffFailSoft(
  workspaceId: string,
  workstreamId: string,
  stepStatuses: Record<string, string>,
): Promise<void> {
  try {
    const coordKey = `${workspaceId}/${workstreamId}`;
    const { reconcileWorkstream } = await import('../../lib/reasoning/reconcile');
    const reconcileResult = reconcileWorkstream(getDb().$raw, {
      workspaceId,
      workstreamId,
      coordKey,
      stepStatuses,
    });
    console.info(
      `[tier-orchestrator][reconcile] ws=${workstreamId} ` +
        `outcome=${reconcileResult.outcome} ` +
        `already=${reconcileResult.alreadyReconciled} ` +
        `beliefUpdates=${reconcileResult.beliefUpdates} ` +
        `drifts=${reconcileResult.drifts.length}`,
    );
  } catch (err) {
    console.warn(
      '[tier-orchestrator] Reconcile fehlgeschlagen (non-fatal):',
      err,
    );
  }
  try {
    const { buildWorkspaceHandoff, persistWorkspaceHandoff } = await import(
      '../../lib/reasoning/auto-handoff'
    );
    const raw = getDb().$raw;
    const handoff = buildWorkspaceHandoff(raw, workspaceId);
    const handoffResult = persistWorkspaceHandoff(raw, workspaceId, handoff);
    console.info(
      `[tier-orchestrator][handoff] ws=${workstreamId} ` +
        `written=${handoffResult.written} ` +
        `skipped=${handoffResult.skippedReason ?? 'none'}`,
    );
  } catch (err) {
    console.warn(
      '[tier-orchestrator] Handoff-Persist fehlgeschlagen (non-fatal):',
      err,
    );
  }
}

/**
 * W1c — recordFailedExperiment fail-soft helper (Self-Learning P0, 2026-05-28).
 *
 * Called from tier-iterate error paths when an iterate run has failed
 * in substance (lead spawn = 0 tokens, all roasters = failed, timeout cap).
 * Writes an entry to failed_experiments with the original user request
 * verbatim (N1 — no .slice; lib/unlearning/experiment-tracker.ts truncates itself
 * via truncateHypothesis at 500 chars with a `[truncated]` marker).
 *
 * Conservative threshold: only write on an unambiguous total failure — rather
 * too little than a false positive. The caller wraps the trigger:
 *   if (looksLikeTotalFailure) recordIterateFailureFailSoft({...});
 */
export function recordIterateFailureFailSoft(args: {
  workspaceId: string;
  workstreamId: string;
  hypothesis: string;
  reason: string;
  modelUsed?: string;
}): void {
  try {
    // dynamic import: experiment-tracker pulls in ulid + drizzle — we do not
    // want to burden the happy path and only load it when something really failed.
    void import('../../lib/unlearning/experiment-tracker').then(
      ({ recordFailedExperiment }) => {
        recordFailedExperiment({
          workspaceId: args.workspaceId,
          workstreamId: args.workstreamId,
          hypothesis: args.hypothesis,
          failureReason: args.reason,
          modelUsed: args.modelUsed,
        });
      },
    );
  } catch (err) {
    console.warn(
      '[tier-orchestrator] recordIterateFailure fehlgeschlagen (non-fatal):',
      err,
    );
  }
}

export async function runIterate(
  opts: {
    workspaceId: string;
    workspacePath: string;
    parentTicketId: string;
    workstreamId: string;
    originalPrompt: string;
  },
  // Sub-Plan A (2026-04-30): respect the tier choice. Default = TIER_PRESETS.standard
  // (backwards-compat with pre-0041 workstreams without `iterate_config_json`).
  iterateConfig?: import('../../lib/workstreams/tier-presets').IterateConfig,
): Promise<IterateResult> {
  const { TIER_PRESETS: TIER_PRESETS_LOCAL } = await import(
    '../../lib/workstreams/tier-presets'
  );
  const config = iterateConfig ?? TIER_PRESETS_LOCAL.standard;
  const startedAt = Date.now();

  // Pattern 4 wave 2.4 (2026-05-01): workflow-FSM detection.
  // If an active workflow_run is attached to this workstream AND the
  // definition is not a stub, advance the run by one tick — the free
  // iterate loop keeps running anyway (wave 3 merges both paths).
  // Best-effort: an error during advance does NOT make the workstream stuck.
  try {
    const {
      shouldUseWorkflowFsm,
      advanceWorkflowFromOrchestrator,
      emitWorkflowTickAudit,
    } = await import('../../lib/workflows/orchestrator-bridge');
    const detection = await shouldUseWorkflowFsm(opts.workstreamId);
    if (detection.useFsm) {
      const result = await advanceWorkflowFromOrchestrator({
        runId: detection.runId,
        workspaceId: opts.workspaceId,
        workstreamId: opts.workstreamId,
      });
      // Audit: log the FSM tick as an observability event. The real
      // logic (switch into the fsm-driven loop) comes in wave 3.
      void emitWorkflowTickAudit({
        workspaceId: opts.workspaceId,
        workstreamId: opts.workstreamId,
        runId: detection.runId,
        workflowId: detection.workflowId,
        result,
      });
    }
  } catch {
    // A bridge error must not block the iterate loop.
  }

  // Sub-Plan A (2026-04-30): fast-path marker — determines whether V1 must
  // already contain the final sub-tickets section.
  const willSkipV2 = config.roasterCount === 0;

  // --- Iteration 1: lead writes V1 ---------------------------------------
  const leadSystem = [
    `Du bist der Lead-Planer eines ${BRAND_NAME}-Workstreams.`,
    'Schreibe einen ersten ausfuehrbaren Plan zur Anfrage des Users.',
    '',
    'WICHTIG — Conversation-Mix (Sub-Plan F 2026-04-30):',
    '1. Beginne mit 1-2 Sätzen knappe Conversation als Intro',
    '   (max 50 Worte, hartes Budget). Beispiel:',
    '   "Ich starte einen Plan-Entwurf V1. Drei Punkte sind kritisch."',
    '2. DANN folgen die PFLICHT-Sections als strukturierte Daten.',
    '3. KEIN Multi-Paragraph-Intro, KEIN Spam-Feeling — nur ein kurzer',
    '   Conversation-Satz, dann direkt die Sections.',
    '',
    'PFLICHT-Sections:',
    '## Konsolidierter Plan',
    '<3-7 nummerierte Schritte mit Begruendung>',
    '',
    '## User-Sicht',
    '1. Du klickst X. 2. System fragt Y. 3. Du antwortest. 4. System macht Z.',
    '',
    '## Risiken',
    '- <was kann schiefgehen>',
    '',
    '## Offene Fragen',
    'PFLICHT-Format pro Frage (sonst muss User tippen statt klicken):',
    '`- [?] <konkrete Frage> | OPTIONS: <A> | <B> | <C>` (2-5 Optionen).',
    'Beispiel: `- [?] Sidebar wo? | OPTIONS: rechts Desktop | unter Editor | Drawer-Modal`',
    'Auch bei „klingt offen" — IMMER 2-5 plausible Default-Optionen anbieten.',
    'NUR wenn die Frage wirklich freie Erklärung braucht (z.B. Schema-Detail):',
    '`- [?] <Frage>` ohne OPTIONS. Zielquote: ≥80% mit OPTIONS.',
    '',
    // In fast mode (no V2), V1 must already contain the sub-tickets.
    ...(willSkipV2
      ? [
          'PFLICHT ## Sub-Tickets im YAML-Block (Schnell-Modus, kein V2):',
          '```yaml',
          '- title: <Imperativ>',
          '  prio: P1',
          '  body: |',
          '    <2-4 Saetze>',
          '```',
          'AM ENDE: <surface:milestone>{...}</surface:milestone>',
          '',
        ]
      : []),
    willSkipV2
      ? 'Maximal 1800 Woerter (inkl. Sub-Tickets-YAML).'
      : 'Maximal 1500 Woerter. Keine Sub-Tickets-Section in V1.',
  ].join('\n');

  // Sprint C (2026-04-29): sub-workstream card in the chat (idempotent).
  void emitSubWorkstreamsCardIfAbsent({
    workspaceId: opts.workspaceId,
    workstreamId: opts.workstreamId,
  });

  const v1SubId = await trySubWs(
    opts.workstreamId,
    'iterate-lead',
    MODEL_NAMES.opus,
  );

  // Sprint 2 / Strand B: RAG inject (local workspace context, MAX-plan compliant).
  // Best-effort — on any failure injectRagContext returns '' and
  // the lead runs without context (graceful degradation).
  const ragContext = await injectRagContext(opts.workspaceId, opts.originalPrompt);
  const ragEnrichedSystem = ragContext
    ? `${leadSystem}\n\n---\n${ragContext}`
    : leadSystem;

  // P0.3b — Self-Learning / WHY engine (2026-05-27): append prior rationales +
  // active, weighted beliefs of this workspace to the lead prompt, ALONGSIDE
  // the RAG/Twin enrichment. This way the swarm lead decides with consistent
  // rationale ("we chose X because … last time") instead of starting amnesiac.
  // Strictly fail-soft + workspace-scoped (N9): empty block ⇒ bit-identical.
  const whyBlock = buildWhyBlockForLead(opts.workspaceId, opts.originalPrompt);
  const enrichedSystem = injectWhyIntoLeadSystem(ragEnrichedSystem, whyBlock);

  const v1 = await spawnAndAudit(
    {
      workspaceId: opts.workspaceId,
      workspacePath: opts.workspacePath,
      workstreamId: opts.workstreamId,
      subWorkstreamId: v1SubId,
      tier: 'opus',
      agentIdx: 1,
      model: MODEL_NAMES.opus,
      systemPrompt: enrichedSystem,
      userPrompt: 'Anfrage von Max: ' + opts.originalPrompt,
      timeoutMs: 4 * 60_000,
      // maxTurns uses the default 30 (see tmux-spawn.ts) — on the MAX plan
      // not a cost guard but a pure runaway-loop guard.
    },
    {
      workspaceId: opts.workspaceId,
      workstreamId: opts.workstreamId,
      parentTicketId: opts.parentTicketId,
      phase: 'v1',
      role: 'iterate-lead',
      priorOutputs: [],
    },
  );

  // Phase IT 2026-04-27: hard-fail if the lead produced nothing.
  // Otherwise the roasters run on an empty plan and V2 has no basis.
  if (!v1.text || v1.text.trim().length === 0) {
    await emitEvent({
      segmentId: opts.workspaceId,
      entityType: 'ticket',
      entityId: opts.parentTicketId,
      eventType: 'commented',
      actor: 'agent:iterate-lead',
      payload: {
        kind: 'iterate-error',
        stage: 'v1-lead',
        error: 'Lead-V1 hat keinen Output produziert (max-turns oder rate-limit)',
        workstreamId: opts.workstreamId,
      },
      sensitivity: 'low',
    }).catch(() => undefined);
    // W1c — Self-Learning P0: record the total failure (lead-V1 empty = 0 tokens)
    // as an unresolved experiment so weekly-retry-sniper finds it.
    // N1: hypothesis = originalPrompt verbatim (the tracker truncates at 500 itself).
    recordIterateFailureFailSoft({
      workspaceId: opts.workspaceId,
      workstreamId: opts.workstreamId,
      hypothesis: opts.originalPrompt,
      reason: 'iterate-v1-empty: Lead-Spawn lieferte 0 Tokens (max-turns/rate-limit)',
      modelUsed: MODEL_NAMES.opus,
    });
    throw new Error('iterate-v1-empty');
  }

  await emitEvent({
    segmentId: opts.workspaceId,
    entityType: 'ticket',
    entityId: opts.parentTicketId,
    eventType: 'commented',
    actor: 'agent:iterate-lead',
    payload: {
      kind: 'iterate-version',
      version: 1,
      role: 'lead',
      text: v1.text,
      tokens: v1.tokens,
      costCents: v1.costCents,
      durationMs: v1.durationMs,
      workstreamId: opts.workstreamId,
    },
    sensitivity: 'low',
  }).catch(() => undefined);

  // Wave 7 (2026-05-01): persistent IterateVersionCard per V_n (V1 here).
  await emitVersionCard(opts, 1, v1.text, v1.costCents);

  // Sub-Plan 04 wave 2 (2026-04-29) — live iterate card in the chat (idempotent).
  void emitIteratePipelineCardIfAbsent({
    workspaceId: opts.workspaceId,
    workstreamId: opts.workstreamId,
  });

  // Owner-fix run-cockpit (2026-05-28): phase change to 'lead' (V1
  // written). Idempotent — emit/update of the same cockpit card.
  void emitRunCockpitCard({
    workspaceId: opts.workspaceId,
    workstreamId: opts.workstreamId,
    phase: 'lead',
    tokensTotal: (v1.tokens.input ?? 0) + (v1.tokens.output ?? 0),
    costCents: v1.costCents,
  });

  // Sub-Plan 02 — push if V1 has open questions
  void emitOpenQuestionsIfAny({
    workspaceId: opts.workspaceId,
    parentTicketId: opts.parentTicketId,
    workstreamId: opts.workstreamId,
    version: 1,
    planText: v1.text,
  });

  // Sub-Plan 03 — Pattern 1 symbolic guard
  void logSymbolicGuardIfViolated({
    workspaceId: opts.workspaceId,
    parentTicketId: opts.parentTicketId,
    workstreamId: opts.workstreamId,
    version: 1,
    planText: v1.text,
  });

  // --- Iteration 2: N roasters attack V1 in parallel ----------------------
  // Owner directive (2026-05-29/30, binding): EXCLUSIVELY Opus 4.8 for
  // EVERY agent spawn — including the roasters. MAX plan ⇒ cost irrelevant, only
  // output quality counts. The earlier "Sonnet-medium for roasters" optimization
  // (token savings) is thereby overruled. tier:'opus' also sets the
  // display label to opus#… (no misleading sonnet#100 in the smoke anymore) AND
  // makes the spawn independent of the pricing.ts alias (even if someone ever
  // removes the alias, the roaster stays Opus). Effort/timeout stay xhigh/
  // per-call as before.
  //
  // Sub-Plan A (2026-04-30): roaster count from IterateConfig. Fast=0,
  // Standard=2, Deep=4. With 0 roasters we skip the V2 synthesis
  // entirely (lead-V1 IS the final plan).
  const activeRoastRoles = ROAST_ROLES.slice(0, config.roasterCount);
  const roastResults = await Promise.all(
    activeRoastRoles.map(async (role, idx) => {
      // Role naming: 1+2 are the historical constants, 3+4 (deep
      // mode) get `iterate-roaster-N` as a string literal — the
      // SubWorkstreamRole type accepts a `(string & {})` fallback.
      const roasterRoleName: import('../../lib/workstreams/service').SubWorkstreamRole =
        idx === 0
          ? 'iterate-roaster-1'
          : idx === 1
            ? 'iterate-roaster-2'
            : (`iterate-roaster-${idx + 1}` as import('../../lib/workstreams/service').SubWorkstreamRole);
      const subId = await trySubWs(
        opts.workstreamId,
        roasterRoleName,
        MODEL_NAMES.opus,
      );
      const r = await spawnAndAudit(
        {
          workspaceId: opts.workspaceId,
          workspacePath: opts.workspacePath,
          workstreamId: opts.workstreamId,
          subWorkstreamId: subId,
          tier: 'opus', // Opus-only (owner directive) — was 'sonnet'
          agentIdx: 100 + idx,
          model: MODEL_NAMES.opus,
          systemPrompt: role.focus,
          userPrompt:
            'Anfrage Max: ' + opts.originalPrompt + '\n\nPlan V1 zum Roasten:\n\n' + v1.text,
          timeoutMs: 3 * 60_000,
        },
        {
          workspaceId: opts.workspaceId,
          workstreamId: opts.workstreamId,
          parentTicketId: opts.parentTicketId,
          phase: 'v1-roast',
          role: `iterate-roaster-${idx + 1}`,
          priorOutputs: [{ phase: 'v1', hash: hashOutput(v1.text) }],
        },
      );
      return { role, output: r };
    }),
  );

  for (const r of roastResults) {
    await emitEvent({
      segmentId: opts.workspaceId,
      entityType: 'ticket',
      entityId: opts.parentTicketId,
      eventType: 'commented',
      actor: 'agent:iterate-roaster',
      payload: {
        kind: 'iterate-roast',
        version: 1,
        roasterRole: r.role.id,
        roasterLabel: r.role.label,
        text: r.output.text,
        tokens: r.output.tokens,
        costCents: r.output.costCents,
        durationMs: r.output.durationMs,
        workstreamId: opts.workstreamId,
      },
      sensitivity: 'low',
    }).catch(() => undefined);
  }

  // --- Sniper pause: user window for mid-course correction --------------
  // Default 15s, override via env. During the pause we check every
  // 1.5s for new `user-correction` events. If any arrive,
  // we abort the pause immediately and go to V2 — the lead-V2 reads
  // the thread anyway and integrates them.
  //
  // Sub-Plan A (2026-04-30): in fast mode (roasterCount=0) there is
  // no V2 — the pause would then be useless because no synthesis stage
  // can consume the correction. We skip it.
  if (!willSkipV2) {
    await emitEvent({
      segmentId: opts.workspaceId,
      entityType: 'ticket',
      entityId: opts.parentTicketId,
      eventType: 'commented',
      actor: 'agent:iterate-lead',
      payload: {
        kind: 'sniper-pause-start',
        workstreamId: opts.workstreamId,
        durationMs: SNIPER_PAUSE_MS,
        message: `Mid-Course-Window — ${Math.round(
          SNIPER_PAUSE_MS / 1000,
        )}s. Korrektur jetzt einwerfen.`,
      },
      sensitivity: 'low',
    }).catch(() => undefined);
    await waitForSniperPause(opts.parentTicketId, startedAt, SNIPER_PAUSE_MS);
  }

  // --- Iteration 3: lead absorbs the roasts, writes V2 ---------------------
  const reviseSystem = [
    'Du bist der Lead-Planer im Iterate-Modus.',
    `V1 wurde von ${activeRoastRoles.length} Roastern attackiert. Ueberarbeite zu V2.`,
    '',
    'WICHTIG — Conversation-Mix (Sub-Plan F 2026-04-30):',
    '1. Beginne mit 1-2 Sätzen knappe Conversation als Intro (max 50 Worte).',
    '   Beispiel: "Ich integriere die Roaster-Findings in V2. User-Anwalt',
    '   und Hacker hatten die schärfsten Punkte."',
    '2. DANN folgen die Sections als strukturierte Daten.',
    '3. KEIN Surface-Tag ohne vorhergehende Conversation.',
    'Gehe auf JEDEN Roast-Punkt explizit ein:',
    '  -> "Uebernommen: <kurze Begruendung>"',
    '  -> "Abgelehnt: <kurze Begruendung>"',
    'In einer ## Roast-Antworten-Section.',
    '',
    'SNIPER-HOOK: Wenn der User waehrend des Flugs eine Korrektur',
    'reingeworfen hat (Comment am Master-Ticket mit',
    '`payload.kind="user-correction"`), liest du ihre Message und',
    'integrierst sie in V2. Schreibe eine zusaetzliche Section:',
    '',
    '## User-Korrekturen (Sniper-Hook)',
    '- "Uebernommen: <wie integriert>"',
    '- "Abgelehnt mit Begruendung: <warum>"',
    '',
    'User-Korrektur ist hoeher gewichtet als Roaster-Punkte.',
    '',
    'Output-Struktur (Markdown):',
    '## Konsolidierter Plan',
    '<3-7 nummerierte Schritte, ueberarbeitet>',
    '',
    '## User-Sicht',
    '<aus User-Sicht, nummeriert>',
    '',
    '## Risiken',
    '- <verbleibend>',
    '',
    '## Offene Fragen',
    'PFLICHT-Format pro Frage (≥80% sollten OPTIONS haben — sonst muss User tippen):',
    '`- [?] <Frage> | OPTIONS: <A> | <B> | <C>` (2-5 plausible Optionen).',
    'Beispiel: `- [?] Tier wählen? | OPTIONS: Schnell · 1 Agent | Standard · 4 | Tief · 7`',
    'NUR ohne OPTIONS bei reinen Erklärungs-Fragen.',
    '',
    '## Roast-Antworten',
    '- Uebernommen/Abgelehnt <Roast-Punkt>: <Begruendung>',
    '',
    'PFLICHT ## Sub-Tickets im YAML-Block:',
    '```yaml',
    '- title: <Imperativ>',
    '  prio: P1',
    '  body: |',
    '    <2-4 Saetze>',
    '```',
    'AM ENDE: <surface:milestone>{...}</surface:milestone>',
    'Maximal 2000 Woerter.',
  ].join('\n');

  const reviseUserParts = [
    'Anfrage Max: ' + opts.originalPrompt,
    '',
    '## V1 (deine erste Version):',
    v1.text,
  ];
  for (const r of roastResults) {
    reviseUserParts.push('');
    reviseUserParts.push('## Roast von ' + r.role.label + ':');
    reviseUserParts.push(r.output.text);
  }

  // Sniper hook 2026-04-28: read user corrections from the master-ticket
  // thread (commented events with kind='user-correction', after V1 start).
  try {
    const { getDb } = await import('../../db/client');
    const db = getDb();
    const corrections = db.$raw
      .prepare(
        `SELECT created_at, payload FROM events
          WHERE entity_type = 'ticket'
            AND entity_id = ?
            AND event_type = 'commented'
            AND created_at >= ?
          ORDER BY created_at ASC`,
      )
      .all(opts.parentTicketId, startedAt) as Array<{
      created_at: number;
      payload: string;
    }>;
    const userCorrections = corrections
      .map((c) => {
        try {
          return JSON.parse(c.payload) as {
            kind?: string;
            message?: string;
            injectedAt?: string;
          };
        } catch {
          return null;
        }
      })
      .filter(
        (p): p is { kind: string; message: string; injectedAt?: string } =>
          !!p && p.kind === 'user-correction' && typeof p.message === 'string',
      );
    if (userCorrections.length > 0) {
      reviseUserParts.push('');
      reviseUserParts.push('## SNIPER-HOOK · User-Korrekturen waehrend des Flugs');
      for (const c of userCorrections) {
        reviseUserParts.push(`- ${c.message}`);
      }
      reviseUserParts.push('');
      reviseUserParts.push(
        'Diese Korrekturen sind hoeher gewichtet als Roaster-Punkte.',
      );
    }
  } catch {
    /* non-fatal — V2 runs even without corrections */
  }

  const reviseUser = reviseUserParts.join('\n\n');

  // Sub-Plan A (2026-04-30): fast path. Without roasters there is no V2
  // synthesis step — V1 IS the final plan. We set `v2` synthetically
  // to `v1` and skip the multi-round loop (sniperLoop=false in
  // fast mode). The sub-tickets section must be parsed from V1 — the
  // leadSystem prompt does not contain it in fast mode, but the lead
  // generates it on-the-fly in fast mode because we extend the prompt
  // below.
  const skipV2 = config.roasterCount === 0;
  const v2 = skipV2
    ? {
        text: v1.text,
        tokens: 0,
        costCents: 0,
        durationMs: 0,
        timedOut: false,
        rateLimited: false,
        exitCode: 0,
      }
    : await (async () => {
        const v2SubId = await trySubWs(
          opts.workstreamId,
          'iterate-lead-v2',
          MODEL_NAMES.opus,
        );
        return spawnAndAudit(
          {
            workspaceId: opts.workspaceId,
            workspacePath: opts.workspacePath,
            workstreamId: opts.workstreamId,
            subWorkstreamId: v2SubId,
            tier: 'opus',
            agentIdx: 2,
            model: MODEL_NAMES.opus,
            systemPrompt: reviseSystem,
            userPrompt: reviseUser,
            timeoutMs: 6 * 60_000,
          },
          {
            workspaceId: opts.workspaceId,
            workstreamId: opts.workstreamId,
            parentTicketId: opts.parentTicketId,
            phase: 'v2',
            role: 'iterate-lead',
            priorOutputs: [
              { phase: 'v1', hash: hashOutput(v1.text) },
              ...roastResults.map((rr, i) => ({
                phase: `v1-roast-${i + 1}`,
                hash: hashOutput(rr.output.text),
              })),
            ],
          },
        );
      })();

  // --- Multi-round loop: a pause after each Vn, on a correction Vn+1 -----
  // Hard cap MAX_ITERATIONS=5 → V1+Roast+V2+V3+V4+V5 possible.
  // Sub-Plan A (2026-04-30): only active when sniperLoop=true (deep mode).
  // Standard + fast stop after V2 resp. V1.
  const MAX_ITERATIONS = config.sniperLoop ? 5 : skipV2 ? 1 : 2;
  let finalText = v2.text;
  let iterations = skipV2 ? 1 : 2;
  let extraVersionsCostCents = 0;
  let prevText = v2.text;
  let prevEmittedAt = Date.now();

  while (iterations < MAX_ITERATIONS) {
    const nextVersion = iterations + 1;
    const afterTag = `v${iterations}`;
    await emitEvent({
      segmentId: opts.workspaceId,
      entityType: 'ticket',
      entityId: opts.parentTicketId,
      eventType: 'commented',
      actor: 'agent:iterate-lead',
      payload: {
        kind: 'sniper-pause-start',
        after: afterTag,
        workstreamId: opts.workstreamId,
        durationMs: SNIPER_PAUSE_MS,
        message: `V${iterations} fertig — ${Math.round(
          SNIPER_PAUSE_MS / 1000,
        )}s Window. Korrektur jetzt löst V${nextVersion} aus, sonst final.`,
      },
      sensitivity: 'low',
    }).catch(() => undefined);
    const correctionsAfter = await waitForSniperPause(
      opts.parentTicketId,
      prevEmittedAt,
      SNIPER_PAUSE_MS,
    );
    if (correctionsAfter === 0) break;

    // Vn+1 with prevText as input + fresh corrections.
    const vNextParts = [
      'Anfrage Max: ' + opts.originalPrompt,
      '',
      `## V${iterations} (deine Vorgaengerversion):`,
      prevText,
      '',
      `## SNIPER-HOOK · NEUE User-Korrekturen nach V${iterations}`,
    ];
    try {
      const { getDb } = await import('../../db/client');
      const db = getDb();
      const rows = db.$raw
        .prepare(
          `SELECT payload FROM events
            WHERE entity_type = 'ticket' AND entity_id = ?
              AND event_type = 'commented'
              AND created_at >= ?
              AND json_extract(payload, '$.kind') = 'user-correction'
            ORDER BY created_at ASC`,
        )
        .all(opts.parentTicketId, prevEmittedAt) as Array<{ payload: string }>;
      for (const r of rows) {
        try {
          const p = JSON.parse(r.payload) as { message?: string };
          if (p.message) vNextParts.push(`- ${p.message}`);
        } catch {
          /* skip */
        }
      }
    } catch {
      /* non-fatal */
    }
    vNextParts.push('');
    vNextParts.push(
      `Schreibe V${nextVersion} — diese Korrekturen sind hoechste Prioritaet, sie ueberschreiben jeden Konflikt mit V${iterations}.`,
    );

    const vNextRole: SubWorkstreamRole =
      nextVersion === 3
        ? 'iterate-lead-v3'
        : nextVersion === 4
          ? 'iterate-lead-v4'
          : 'iterate-lead-v5';
    const vNextSubId = await trySubWs(
      opts.workstreamId,
      vNextRole,
      MODEL_NAMES.opus,
    );
    const vNext = await spawnAndAudit(
      {
        workspaceId: opts.workspaceId,
        workspacePath: opts.workspacePath,
        workstreamId: opts.workstreamId,
        subWorkstreamId: vNextSubId,
        tier: 'opus',
        agentIdx: nextVersion,
        model: MODEL_NAMES.opus,
        systemPrompt: reviseSystem,
        userPrompt: vNextParts.join('\n\n'),
        timeoutMs: 6 * 60_000,
      },
      {
        workspaceId: opts.workspaceId,
        workstreamId: opts.workstreamId,
        parentTicketId: opts.parentTicketId,
        phase: `v${nextVersion}`,
        role: 'iterate-lead',
        priorOutputs: [{ phase: `v${iterations}`, hash: hashOutput(prevText) }],
      },
    );
    finalText = vNext.text || prevText;
    iterations = nextVersion;
    extraVersionsCostCents += vNext.costCents;
    prevText = vNext.text;
    prevEmittedAt = Date.now();

    await emitEvent({
      segmentId: opts.workspaceId,
      entityType: 'ticket',
      entityId: opts.parentTicketId,
      eventType: 'commented',
      actor: 'agent:iterate-lead',
      payload: {
        kind: 'iterate-version',
        version: nextVersion,
        role: 'lead',
        text: vNext.text,
        tokens: vNext.tokens,
        costCents: vNext.costCents,
        durationMs: vNext.durationMs,
        workstreamId: opts.workstreamId,
      },
      sensitivity: 'low',
    }).catch(() => undefined);

    // Wave 7 (2026-05-01): persistent IterateVersionCard for V_next.
    await emitVersionCard(opts, nextVersion, vNext.text, vNext.costCents);

    // Sub-Plan 02 — push if V_next has open questions
    void emitOpenQuestionsIfAny({
      workspaceId: opts.workspaceId,
      parentTicketId: opts.parentTicketId,
      workstreamId: opts.workstreamId,
      version: nextVersion,
      planText: vNext.text,
    });

    // Sub-Plan 03 — Pattern 1 Symbolic Guard
    void logSymbolicGuardIfViolated({
      workspaceId: opts.workspaceId,
      parentTicketId: opts.parentTicketId,
      workstreamId: opts.workstreamId,
      version: nextVersion,
      planText: vNext.text,
    });
  }

  // --- Diff-Score V1 vs Final --------------------------------------------
  const diffScore = computeDiffScore(v1.text, finalText);

  // --- Final as a synthesis event (compatible with the existing AC flow) -------
  const totalCostCents =
    v1.costCents +
    roastResults.reduce((acc, r) => acc + r.output.costCents, 0) +
    v2.costCents +
    extraVersionsCostCents;
  const totalDurationMs = Date.now() - startedAt;

  const consensusLevel = detectConsensusLevel(finalText);

  await emitEvent({
    segmentId: opts.workspaceId,
    entityType: 'ticket',
    entityId: opts.parentTicketId,
    eventType: 'commented',
    actor: 'agent:iterate-lead',
    payload: {
      kind: 'synthesis',
      mode: 'iterate',
      text: finalText,
      iterations,
      diffScore,
      totalCostCents,
      durationMs: totalDurationMs,
      workstreamId: opts.workstreamId,
      n_inputs: 1 + roastResults.length,
      consensus_level: consensusLevel,
    },
    sensitivity: 'low',
  }).catch(() => undefined);

  // Parse + create sub-tickets from the final text
  let createdCount = 0;
  try {
    const subTickets = parseSubTicketsBlock(finalText);
    for (const st of subTickets) {
      await createSubTicketEvent({
        workspaceId: opts.workspaceId,
        parentTicketId: opts.parentTicketId,
        workstreamId: opts.workstreamId,
        title: st.title,
        prio: st.prio,
        body: st.body,
      });
      createdCount++;
    }
  } catch (err) {
    console.warn('[iterate] sub-ticket-parse failed:', err);
  }

  // approval_requested so the master goes into the FSM review state
  await emitEvent({
    segmentId: opts.workspaceId,
    entityType: 'ticket',
    entityId: opts.parentTicketId,
    eventType: 'approval_requested',
    actor: 'agent:iterate-lead',
    payload: {
      reason: 'iterate-fertig',
      subTicketsCreated: createdCount,
      workstreamId: opts.workstreamId,
      mode: 'iterate',
      diffScore,
    },
    sensitivity: 'low',
  }).catch(() => undefined);

  // V3 wire point 1 (2026-05-01): after iterate-final auto-approve in the
  // sandbox. The master goes straight into auto-dispatch without a user click.
  await maybeAutoApproveInSandbox({
    workspaceId: opts.workspaceId,
    parentTicketId: opts.parentTicketId,
    workstreamId: opts.workstreamId,
    reason: 'sandbox-iterate-complete',
  });

  // Fix 2026-04-30: AUTO-FINALIZE after iterate. Sub-Plan C (2026-04-30):
  // ConsensusActionCard via emitOrUpdateCard — on a repeated
  // auto-finalize (e.g. resume + re-synthesis) the existing
  // card is updated in-place. The review state transition runs ONLY
  // on the first insert (otherwise the master ticket is set to review
  // again on every refresh, which makes the UI flicker).
  try {
    const db = getDb();
    // Sub-tickets for the inline section
    const subRows = db.$raw
      .prepare(
        `SELECT json_extract(payload,'$.title') as title,
                json_extract(payload,'$.prio') as prio
           FROM events
          WHERE event_type='created'
            AND json_extract(payload,'$.parentTicketId')=?
          ORDER BY created_at ASC LIMIT 12`,
      )
      .all(opts.parentTicketId) as Array<{
      title: string | null;
      prio: string | null;
    }>;
    const subTicketsLite = subRows
      .filter((s) => s.title)
      .map((s) => ({ title: s.title!, prio: s.prio ?? 'P2' }));
    const consensusJson = JSON.stringify({
      workstreamId: opts.workstreamId,
      consensusLevel: consensusLevel === 'strong' ? 'strong'
        : consensusLevel === 'disagreement' ? 'disagreement'
        : 'majority',
      masterTicketId: opts.parentTicketId,
      outliers: [],
      subTickets: subTicketsLite,
      planText: finalText.slice(0, 6000),
    });
    const cardText = [
      `**Master-Plan fertig (${iterations} Wellen)**`,
      '',
      'Der iterate-Loop ist abgeschlossen. Sub-Tickets sind extrahiert.',
      '„Los" startet die autonome Umsetzung mit 25 s Sniper-Pause.',
      '',
      `<surface:consensus-action>${consensusJson}</surface:consensus-action>`,
    ].join('\n');
    const result = await emitOrUpdateCard({
      coords: {
        workspaceId: opts.workspaceId,
        workstreamId: opts.workstreamId,
        surfaceKind: 'consensus-action',
      },
      content: cardText,
      actor: 'system',
    });
    if (result.mode === 'inserted') {
      // Set the master to review — only on the first emit, otherwise the
      // workflow state transition twitches on every auto-finalize replay.
      await emitEvent({
        segmentId: opts.workspaceId,
        entityType: 'ticket',
        entityId: opts.parentTicketId,
        eventType: 'updated',
        actor: 'system',
        payload: {
          workflowState: 'review',
          transition: 'iterate-final',
          workstreamId: opts.workstreamId,
        },
        sensitivity: 'low',
      }).catch(() => undefined);
    }
  } catch (err) {
    console.warn('[iterate] auto-finalize failed:', err);
  }

  // ── W1a — Self-Learning P0: reconcile + handoff on the iterate-done path ─────
  //
  // P0 wiring audit (docs/audits/2026-05-28_self-learning-healing-audit.md):
  // workspace_beliefs/decision_outcomes stayed empty although done workstreams
  // exist — because the tier-iterate path does NOT call reconcile/handoff (only
  // the explicit plan-executor path in plan-executor.ts:786-845 did).
  //
  // Synthetic stepStatuses → determineOutcome → 'success'. On the failure path
  // (e.g. iterate-v1-empty) the run would have thrown earlier — the helper then
  // does not run. Fail-soft: a reconcile error NEVER topples the run completion.
  await runReconcileAndHandoffFailSoft(opts.workspaceId, opts.workstreamId, {
    'iterate-lead-v1': 'done',
    'iterate-roasters': 'done',
    'iterate-lead-final': 'done',
  });

  return {
    finalText,
    iterations,
    diffScore,
    totalCostCents,
    totalDurationMs,
  };
}

/**
 * Heuristic diff-score computation V1 -> V2.
 * Proxy metrics that estimate "improvement" — not a real benchmark,
 * but it gives the user a signal whether V2 got better.
 */
function computeDiffScore(v1: string, v2: string): IterateDiffScore {
  const oqBefore = (v1.match(/\[\?\]/g) ?? []).length;
  const oqAfter = (v2.match(/\[\?\]/g) ?? []).length;
  const userFlowAfter = /##\s+User-Sicht/i.test(v2);
  const userFlowBefore = /##\s+User-Sicht/i.test(v1);
  const roastSection = /##\s+Roast-Antworten/i.test(v2);
  const lengthChange = v2.length - v1.length;

  let score = 0;
  if (oqBefore > oqAfter) score += (oqBefore - oqAfter) * 8;
  if (!userFlowBefore && userFlowAfter) score += 15;
  if (roastSection) score += 12;
  const ratio = v1.length === 0 ? 1 : v2.length / v1.length;
  if (ratio > 0.7 && ratio < 1.4) score += 5;

  return {
    openQuestionsBefore: oqBefore,
    openQuestionsAfter: oqAfter,
    userFlowSectionAdded: !userFlowBefore && userFlowAfter,
    lengthChange,
    improvementPct: Math.min(score, 100),
  };
}

/* ==========================================================================
 * Phase RA — cross-roast sub-plans → master mapping (2026-04-29).
 *
 * Vision (user clarification 2026-04-28):
 *   "A separate plan for each feature, then roasted against each other and
 *    mapped onto the main plan, for the best result."
 *
 * Pipeline:
 *   1. Master generates sub-tickets (existing — Phase IT runIterate).
 *   2. NEW runSubPlanSniper per sub-ticket: V1→V3 with a 20s pause + inject.
 *   3. NEW runCrossRoast: lead-synth + roaster check all V_final sub-
 *      plans against each other + the master. Convergence back into the master.
 *
 * Activation: opt-in via trigger endpoint
 *   POST /api/workstreams/[id]/cross-roast { subTicketIds: string[] }
 * Auto-dispatch does NOT call it today — the Phase IN-Implement after the OSS
 * launch wires in the auto-trigger. Manual testing is already possible today.
 * ========================================================================== */

const SUBPLAN_SNIPER_PAUSE_MS = 20_000;
const CROSS_ROAST_PAUSE_MS = 25_000;

export interface SubPlanSniperOpts {
  workspaceId: string;
  workspacePath: string;
  workstreamId: string;
  /** Sub-ticket ID — pause-inject events bind to this. */
  subTicketId: string;
  /** Master plan context as a constraint for the sub-lead. */
  masterPlanText: string;
  /** Sub-ticket body (= "what is this sub-plan actually meant to achieve"). */
  subTicketBrief: string;
}

export interface SubPlanSniperResult {
  finalText: string;
  iterations: number;
  totalCostCents: number;
  totalDurationMs: number;
}

/**
 * Sub-plan sniper loop: V1 → 1 roaster → 20s pause → V2 → roaster → pause → V3.
 * Hard cap V3. Inject events on the `subTicketId` are integrated verbatim
 * as a "user correction" in the next iteration.
 */
export async function runSubPlanSniper(
  opts: SubPlanSniperOpts,
): Promise<SubPlanSniperResult> {
  const startedAt = Date.now();
  let costTotal = 0;
  let currentVersion = '';

  const HARD_CAP = 3;
  for (let iter = 1; iter <= HARD_CAP; iter += 1) {
    const isFirst = iter === 1;
    const leadSystem = [
      `Du bist der Sub-Plan-Lead eines ${BRAND_NAME}-Workstream-Sub-Tickets.`,
      'Schreibe einen konkreten, ausführbaren Plan für dieses Sub-Ticket,',
      'der den Master-Plan-Kontext respektiert (du sollst KONKRETISIEREN,',
      'nicht widersprechen).',
      '',
      isFirst
        ? '## Konsolidierter Sub-Plan\n<3-5 Schritte>\n\n## User-Sicht\n1...\n\n## Risiken\n- ...'
        : 'Integriere die Roaster-Findings + jegliche User-Korrekturen aus' +
            ' der letzten Pause WÖRTLICH. Behalte die ursprüngliche Struktur.',
      '',
      '## Master-Plan-Kontext (Constraint, NICHT widersprechen):',
      opts.masterPlanText.slice(0, 4000),
      '',
      'Maximal 800 Wörter.',
    ].join('\n');

    const userPromptParts = [
      `Sub-Ticket-Brief: ${opts.subTicketBrief}`,
    ];
    if (!isFirst && currentVersion) {
      userPromptParts.push(
        '',
        `## Vorherige Sub-Plan-Version V${iter - 1}:`,
        currentVersion,
      );
    }

    const subSniperLeadId = await trySubWs(
      opts.workstreamId,
      'sub-plan-sniper',
      MODEL_NAMES.opus,
    );
    const v = await spawnAndAudit(
      {
        workspaceId: opts.workspaceId,
        workspacePath: opts.workspacePath,
        workstreamId: `${opts.workstreamId}-sub-${opts.subTicketId}`,
        subWorkstreamId: subSniperLeadId,
        tier: 'opus',
        agentIdx: 100 + iter,
        model: MODEL_NAMES.opus,
        systemPrompt: leadSystem,
        userPrompt: userPromptParts.join('\n'),
        timeoutMs: 3 * 60_000,
      },
      {
        workspaceId: opts.workspaceId,
        workstreamId: opts.workstreamId,
        parentTicketId: opts.subTicketId,
        phase: `sub-spawn-v${iter}`,
        role: 'sub-spawn',
        priorOutputs:
          iter > 1
            ? [{ phase: `sub-spawn-v${iter - 1}`, hash: hashOutput(currentVersion) }]
            : [],
      },
    );
    costTotal += v.costCents;
    if (!v.text || v.text.trim().length === 0) {
      throw new Error(`subplan-sniper-empty: V${iter}`);
    }
    currentVersion = v.text;

    await emitEvent({
      segmentId: opts.workspaceId,
      entityType: 'ticket',
      entityId: opts.subTicketId,
      eventType: 'commented',
      actor: `agent:subplan-lead`,
      payload: {
        kind: 'sub-plan-version',
        version: iter,
        role: 'lead',
        text: v.text,
        tokens: v.tokens,
        costCents: v.costCents,
        durationMs: v.durationMs,
        workstreamId: opts.workstreamId,
        masterTicketId: undefined,
      },
      sensitivity: 'low',
    }).catch(() => undefined);

    if (iter >= HARD_CAP) break;

    // 1 roaster (compact, not a swarm like for the master).
    const roastSystem = [
      `Du bist Roaster für einen Sub-Plan in ${BRAND_NAME}.`,
      'Du hast den Sub-Plan-Draft + den Master-Plan. Frag dich:',
      '  1. Was übersieht der Sub-Plan, das im Master-Plan steht?',
      '  2. Was ist im Sub-Plan über-spezifiziert (Sub-Plan macht mehr als sein Sub-Brief)?',
      '  3. Wo widerspricht der Sub-Plan dem Master?',
      '',
      'Output: 3-5 konkrete Findings als Bullet-List.',
      'Maximal 400 Wörter.',
    ].join('\n');

    const subSniperRoasterId = await trySubWs(
      opts.workstreamId,
      'sub-plan-sniper',
      MODEL_NAMES.opus,
    );
    const r = await spawnAndAudit(
      {
        workspaceId: opts.workspaceId,
        workspacePath: opts.workspacePath,
        workstreamId: `${opts.workstreamId}-sub-${opts.subTicketId}`,
        subWorkstreamId: subSniperRoasterId,
        tier: 'opus', // Opus-only (Owner-Direktive) — war 'sonnet'
        agentIdx: 200 + iter,
        model: MODEL_NAMES.opus,
        systemPrompt: roastSystem,
        userPrompt: [
          '## Master-Plan-Kontext:',
          opts.masterPlanText.slice(0, 3000),
          '',
          '## Sub-Plan-Draft V' + iter + ':',
          v.text,
        ].join('\n'),
        timeoutMs: 2 * 60_000,
      },
      {
        workspaceId: opts.workspaceId,
        workstreamId: opts.workstreamId,
        parentTicketId: opts.subTicketId,
        phase: `sub-roast-v${iter}`,
        role: 'iterate-roaster-1',
        priorOutputs: [{ phase: `sub-spawn-v${iter}`, hash: hashOutput(v.text) }],
      },
    );
    costTotal += r.costCents;
    await emitEvent({
      segmentId: opts.workspaceId,
      entityType: 'ticket',
      entityId: opts.subTicketId,
      eventType: 'commented',
      actor: 'agent:subplan-roaster',
      payload: {
        kind: 'sub-plan-roast',
        afterVersion: iter,
        text: r.text,
        tokens: r.tokens,
        costCents: r.costCents,
        durationMs: r.durationMs,
        workstreamId: opts.workstreamId,
      },
      sensitivity: 'low',
    }).catch(() => undefined);

    // Pause window for the user inject.
    const pauseStartedAt = Date.now();
    await emitEvent({
      segmentId: opts.workspaceId,
      entityType: 'ticket',
      entityId: opts.subTicketId,
      eventType: 'commented',
      actor: 'agent:subplan-lead',
      payload: {
        kind: 'sniper-pause-start',
        after: 'sub-plan-roast',
        version: iter,
        durationMs: SUBPLAN_SNIPER_PAUSE_MS,
        workstreamId: opts.workstreamId,
      },
      sensitivity: 'low',
    }).catch(() => undefined);
    await waitForSniperPause(opts.subTicketId, pauseStartedAt, SUBPLAN_SNIPER_PAUSE_MS);
  }

  // Emit V_final as a marked output
  await emitEvent({
    segmentId: opts.workspaceId,
    entityType: 'ticket',
    entityId: opts.subTicketId,
    eventType: 'commented',
    actor: 'agent:subplan-lead',
    payload: {
      kind: 'sub-plan-v_final',
      text: currentVersion,
      iterations: HARD_CAP,
      workstreamId: opts.workstreamId,
    },
    sensitivity: 'low',
  }).catch(() => undefined);

  return {
    finalText: currentVersion,
    iterations: HARD_CAP,
    totalCostCents: costTotal,
    totalDurationMs: Date.now() - startedAt,
  };
}

export interface CrossRoastOpts {
  workspaceId: string;
  workspacePath: string;
  workstreamId: string;
  /** Master ticket ID — the final convergence is emitted here. */
  masterTicketId: string;
  masterPlanText: string;
  /** All V_final sub-plans with their sub-ticket IDs. */
  subPlans: Array<{ subTicketId: string; subBrief: string; finalText: string }>;
}

export interface CrossRoastResult {
  finalText: string;
  iterations: number;
  totalCostCents: number;
  totalDurationMs: number;
}

/**
 * Cross-roast: all V_final sub-plans + the master are consolidated in a
 * lead synthesis phase. Roaster V1→V3 (hard cap V3) pick out
 * conflicts and propose resolutions. Pause-inject between waves.
 */
export async function runCrossRoast(opts: CrossRoastOpts): Promise<CrossRoastResult> {
  const startedAt = Date.now();
  let costTotal = 0;

  const allSubsBlock = opts.subPlans
    .map(
      (s, i) =>
        `### Sub-Plan #${i + 1} (Ticket ${s.subTicketId})\n` +
        `Brief: ${s.subBrief}\n\n` +
        `Final-Text:\n${s.finalText}`,
    )
    .join('\n\n---\n\n');

  // Lead-synth: convergence analysis
  const leadSystem = [
    `Du bist der Cross-Roast-Lead für einen ${BRAND_NAME}-Workstream.`,
    'Du bekommst:',
    '  1. den Master-Plan,',
    '  2. die V_final-Sub-Pläne aller Sub-Tickets.',
    '',
    'Deine Aufgabe — schreibe eine Konvergenz-Analyse:',
    '## Konflikte zwischen Sub-Plänen',
    '<wo widersprechen sich Sub-Pläne, oder wo überlappen sie sich>',
    '',
    '## Lücken',
    '<was fehlt — Master fordert es, kein Sub-Plan adressiert es>',
    '',
    '## Über-Spec',
    '<Sub-Pläne machen mehr als ihr Sub-Brief erlaubt>',
    '',
    '## Resolutions',
    '<konkrete Vorschläge: was muss im Master angepasst werden, was muss',
    ' ein Sub-Plan abgeben oder reinholen>',
    '',
    'Maximal 1500 Wörter.',
  ].join('\n');

  const crossRoastLeadId = await trySubWs(
    opts.workstreamId,
    'cross-roast',
    MODEL_NAMES.opus,
  );
  const v1 = await spawnAndAudit(
    {
      workspaceId: opts.workspaceId,
      workspacePath: opts.workspacePath,
      workstreamId: `${opts.workstreamId}-cross`,
      subWorkstreamId: crossRoastLeadId,
      tier: 'opus',
      agentIdx: 1,
      model: MODEL_NAMES.opus,
      systemPrompt: leadSystem,
      userPrompt: [
        '## Master-Plan',
        opts.masterPlanText,
        '',
        '## Alle Sub-Pläne (V_final)',
        allSubsBlock,
      ].join('\n'),
      timeoutMs: 5 * 60_000,
    },
    {
      workspaceId: opts.workspaceId,
      workstreamId: opts.workstreamId,
      parentTicketId: opts.masterTicketId,
      phase: 'cross-roast',
      role: 'cross-roast',
      priorOutputs: opts.subPlans.map((s) => ({
        phase: `sub-final-${s.subTicketId}`,
        hash: hashOutput(s.finalText),
      })),
    },
  );
  costTotal += v1.costCents;
  if (!v1.text || v1.text.trim().length === 0) {
    throw new Error('cross-roast-v1-empty');
  }

  await emitEvent({
    segmentId: opts.workspaceId,
    entityType: 'ticket',
    entityId: opts.masterTicketId,
    eventType: 'commented',
    actor: 'agent:cross-roast-lead',
    payload: {
      kind: 'cross-roast-version',
      version: 1,
      role: 'lead',
      text: v1.text,
      tokens: v1.tokens,
      costCents: v1.costCents,
      durationMs: v1.durationMs,
      workstreamId: opts.workstreamId,
      subTicketIds: opts.subPlans.map((s) => s.subTicketId),
    },
    sensitivity: 'low',
  }).catch(() => undefined);

  let currentVersion = v1.text;

  // Roaster V2/V3 with pause-inject between the waves
  const HARD_CAP = 3;
  for (let iter = 2; iter <= HARD_CAP; iter += 1) {
    // Pause before each roaster run
    const pauseStartedAt = Date.now();
    await emitEvent({
      segmentId: opts.workspaceId,
      entityType: 'ticket',
      entityId: opts.masterTicketId,
      eventType: 'commented',
      actor: 'agent:cross-roast-lead',
      payload: {
        kind: 'sniper-pause-start',
        after: `cross-roast-v${iter - 1}`,
        version: iter - 1,
        durationMs: CROSS_ROAST_PAUSE_MS,
        workstreamId: opts.workstreamId,
      },
      sensitivity: 'low',
    }).catch(() => undefined);
    await waitForSniperPause(opts.masterTicketId, pauseStartedAt, CROSS_ROAST_PAUSE_MS);

    const roastSystem = [
      `Du bist Cross-Roast-Roaster (Welle ${iter}).`,
      'Du hast die letzte Konvergenz-Analyse + Master + Sub-Plans.',
      'Pick einen konkreten Konflikt aus der letzten Welle und schlage',
      'eine Resolution vor — wer gibt was ab, wer holt was rein, was',
      'muss am Master angepasst werden.',
      '',
      'Output: 1 Konflikt-Pick + 1 Resolution-Vorschlag. Knackig, max 400 Wörter.',
    ].join('\n');

    const crossRoasterId = await trySubWs(
      opts.workstreamId,
      'cross-roast',
      MODEL_NAMES.opus,
    );
    const r = await spawnAndAudit(
      {
        workspaceId: opts.workspaceId,
        workspacePath: opts.workspacePath,
        workstreamId: `${opts.workstreamId}-cross`,
        subWorkstreamId: crossRoasterId,
        tier: 'opus', // Opus-only (Owner-Direktive) — war 'sonnet'
        agentIdx: 100 + iter,
        model: MODEL_NAMES.opus,
        systemPrompt: roastSystem,
        userPrompt: [
          '## Letzte Konvergenz-Version V' + (iter - 1),
          currentVersion,
          '',
          '## Master',
          opts.masterPlanText.slice(0, 3000),
        ].join('\n'),
        timeoutMs: 3 * 60_000,
      },
      {
        workspaceId: opts.workspaceId,
        workstreamId: opts.workstreamId,
        parentTicketId: opts.masterTicketId,
        phase: `cross-roast-v${iter}`,
        role: 'iterate-roaster-1',
        priorOutputs: [
          { phase: `cross-roast-v${iter - 1}`, hash: hashOutput(currentVersion) },
        ],
      },
    );
    costTotal += r.costCents;

    currentVersion = `${currentVersion}\n\n## Cross-Roast V${iter} Resolution\n${r.text}`;

    await emitEvent({
      segmentId: opts.workspaceId,
      entityType: 'ticket',
      entityId: opts.masterTicketId,
      eventType: 'commented',
      actor: 'agent:cross-roast-roaster',
      payload: {
        kind: 'cross-roast-version',
        version: iter,
        role: 'roaster',
        text: r.text,
        tokens: r.tokens,
        costCents: r.costCents,
        durationMs: r.durationMs,
        workstreamId: opts.workstreamId,
      },
      sensitivity: 'low',
    }).catch(() => undefined);
  }

  // V_final → master-plan-v_after_cross-roast
  await emitEvent({
    segmentId: opts.workspaceId,
    entityType: 'ticket',
    entityId: opts.masterTicketId,
    eventType: 'commented',
    actor: 'agent:cross-roast-lead',
    payload: {
      kind: 'master-plan-v_after_cross-roast',
      text: currentVersion,
      iterations: HARD_CAP,
      subTicketIds: opts.subPlans.map((s) => s.subTicketId),
      workstreamId: opts.workstreamId,
    },
    sensitivity: 'low',
  }).catch(() => undefined);

  return {
    finalText: currentVersion,
    iterations: HARD_CAP,
    totalCostCents: costTotal,
    totalDurationMs: Date.now() - startedAt,
  };
}

/* ==========================================================================
 * Sub-Plan 01c · resume helper for stuck workstreams (2026-04-29).
 * ========================================================================== */

const ITERATE_MAX_VERSIONS = 5;

export interface ResumeIterateResult {
  workstreamId: string;
  resumedFromVersion: number;
  producedVersion: number;
  isFinal: boolean;
  totalCostCents: number;
  totalDurationMs: number;
}

export async function runIterateResume(
  workstreamId: string,
): Promise<ResumeIterateResult> {
  const startedAt = Date.now();
  const ctx = await loadIterateResumeContext(workstreamId);
  if (!ctx) {
    throw new Error(
      'resume-no-context — workstream/master-ticket not found or no iterate-version events',
    );
  }
  const {
    workspaceId,
    workspacePath,
    parentTicketId,
    originalPrompt,
    lastVersion,
    lastVersionText,
    roastTexts,
  } = ctx;

  const { getDb } = await import('../../db/client');
  const db = getDb();

  const nextVersion = lastVersion + 1;
  if (nextVersion > ITERATE_MAX_VERSIONS) {
    db.$raw
      .prepare("UPDATE workstreams SET status='done', updated_at=? WHERE id=?")
      .run(Date.now(), workstreamId);
    // W1a: reconcile + handoff on the resume-done path (max-versions cap).
    await runReconcileAndHandoffFailSoft(workspaceId, workstreamId, {
      'iterate-resume-cap': 'done',
    });
    return {
      workstreamId,
      resumedFromVersion: lastVersion,
      producedVersion: lastVersion,
      isFinal: true,
      totalCostCents: 0,
      totalDurationMs: Date.now() - startedAt,
    };
  }

  db.$raw
    .prepare("UPDATE workstreams SET status='active', updated_at=? WHERE id=?")
    .run(Date.now(), workstreamId);

  await emitEvent({
    segmentId: workspaceId,
    entityType: 'ticket',
    entityId: parentTicketId,
    eventType: 'commented',
    actor: 'agent:iterate-lead',
    payload: {
      kind: 'iterate-resumed',
      fromVersion: lastVersion,
      toVersion: nextVersion,
      workstreamId,
    },
    sensitivity: 'low',
  }).catch(() => undefined);

  const reviseSystem = [
    'Du bist Lead-Planer im Iterate-Modus (Resume-Pfad).',
    'V' + lastVersion + ' wurde von Roastern attackiert. Schreibe V' + nextVersion + '.',
    '',
    'WICHTIG — Conversation-Mix (Sub-Plan F 2026-04-30):',
    '1. Beginne mit 1-2 Sätzen knappe Conversation als Intro (max 50 Worte).',
    '   Beispiel: "V' + nextVersion + ' nimmt die Roaster-Findings + User-Korrekturen',
    '   aus dem Pause-Window auf."',
    '2. DANN folgen die Sections als strukturierte Daten.',
    '3. KEIN Surface-Tag ohne vorhergehende Conversation.',
    'Gehe auf JEDEN Roast-Punkt explizit ein:',
    '  -> "Übernommen: <Begründung>"',
    '  -> "Abgelehnt: <Begründung>"',
    'In ## Roast-Antworten.',
    '',
    'SNIPER-HOOK: User-Korrekturen aus dem Pause-Window VORZIEHEN.',
    'Section ## User-Korrekturen mit Übernommen/Abgelehnt-Begründung.',
    '',
    'Output Markdown: ## Konsolidierter Plan, ## User-Sicht, ## Risiken,',
    '## Offene Fragen, ## Roast-Antworten.',
    '',
    'PFLICHT ## Sub-Tickets im YAML-Block (für Auto-Dispatch der',
    'autonomen Umsetzung):',
    '```yaml',
    '- title: <Imperativ-Titel max 80 Zeichen>',
    '  prio: P1',
    '  body: |',
    '    <2-4 Sätze was zu tun ist + Akzeptanzkriterium>',
    '```',
    '2-6 Sub-Tickets, prio aus P0/P1/P2/P3, body Markdown-frei.',
    '',
    'Falls Konvergenz erreicht: am Ende <surface:milestone>{...}.',
    'Maximal 1800 Wörter.',
  ].join('\n');

  const reviseUserParts = [
    'Anfrage Max: ' + originalPrompt,
    '',
    '## V' + lastVersion + ':',
    lastVersionText,
  ];
  for (const r of roastTexts) {
    reviseUserParts.push('', '## Roast von ' + r.roleLabel + ':', r.text);
  }
  try {
    const lvRow = db.$raw
      .prepare(
        "SELECT created_at FROM events WHERE entity_type='ticket' AND entity_id=? AND event_type='commented' AND json_extract(payload,'$.kind')='iterate-version' AND CAST(json_extract(payload,'$.version') AS INTEGER) = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(parentTicketId, lastVersion) as { created_at: number } | undefined;
    const since = lvRow?.created_at ?? 0;
    const corrections = db.$raw
      .prepare(
        "SELECT json_extract(payload,'$.message') as msg FROM events WHERE entity_type='ticket' AND entity_id=? AND event_type='commented' AND json_extract(payload,'$.kind')='user-correction' AND created_at > ? ORDER BY created_at ASC",
      )
      .all(parentTicketId, since) as Array<{ msg: string | null }>;
    if (corrections.length > 0) {
      reviseUserParts.push('', '## User-Korrekturen seit V' + lastVersion + ':');
      for (const c of corrections) {
        if (c.msg) reviseUserParts.push('- ' + c.msg);
      }
    }
  } catch {
    /* non-fatal */
  }

  // Sprint C: sub-WS for the resume-lead spawn.
  void emitSubWorkstreamsCardIfAbsent({ workspaceId, workstreamId });
  const resumeLeadSubId = await trySubWs(
    workstreamId,
    'iterate-resume-lead',
    MODEL_NAMES.opus,
  );
  // Sprint 2 / Strand B: RAG inject for the resume-lead.
  const resumeRag = await injectRagContext(workspaceId, originalPrompt);
  const reviseSystemEnriched = resumeRag ? `${reviseSystem}\n\n---\n${resumeRag}` : reviseSystem;
  const vNew = await spawnAndAudit(
    {
      workspaceId,
      workspacePath,
      workstreamId,
      subWorkstreamId: resumeLeadSubId,
      tier: 'opus',
      agentIdx: 1,
      model: MODEL_NAMES.opus,
      systemPrompt: reviseSystemEnriched,
      userPrompt: reviseUserParts.join('\n'),
      timeoutMs: 5 * 60_000,
    },
    {
      workspaceId,
      workstreamId,
      parentTicketId,
      phase: `v${nextVersion}`,
      role: 'sniper-resume',
      priorOutputs: [
        { phase: `v${lastVersion}`, hash: hashOutput(lastVersionText) },
        ...roastTexts.map((rt, i) => ({
          phase: `v${lastVersion}-roast-${i + 1}`,
          hash: hashOutput(rt.text),
        })),
      ],
    },
  );
  let costTotal = vNew.costCents;
  if (!vNew.text || vNew.text.trim().length === 0) {
    // P1-7: set status 'stuck' via the service layer instead of raw SQL.
    // This way the typed WorkstreamStatus path takes effect and the audit trail
    // stays consistent.
    await updateWorkstream(workstreamId, { status: 'stuck' }).catch(
      () => undefined,
    );
    // W1c — Self-Learning P0: resume-lead delivered 0 tokens. N1: originalPrompt
    // verbatim — the tracker truncates to MAX itself if needed.
    recordIterateFailureFailSoft({
      workspaceId,
      workstreamId,
      hypothesis: originalPrompt,
      reason: `resume-v${nextVersion}-empty: Lead-Spawn lieferte 0 Tokens`,
      modelUsed: MODEL_NAMES.opus,
    });
    throw new Error('resume-v' + nextVersion + '-empty');
  }

  await emitEvent({
    segmentId: workspaceId,
    entityType: 'ticket',
    entityId: parentTicketId,
    eventType: 'commented',
    actor: 'agent:iterate-lead',
    payload: {
      kind: 'iterate-version',
      version: nextVersion,
      role: 'lead',
      text: vNew.text,
      tokens: vNew.tokens,
      costCents: vNew.costCents,
      durationMs: vNew.durationMs,
      workstreamId,
      resumed: true,
    },
    sensitivity: 'low',
  }).catch(() => undefined);

  // Wave 7 (2026-05-01): persistent IterateVersionCard for the resumed V_n.
  await emitOrUpdateCard({
    coords: {
      workspaceId,
      workstreamId,
      surfaceKind: 'iterate-version',
      subKey: iterateVersionSubKey(nextVersion),
    },
    content: `<surface:iterate-version>${JSON.stringify({
      workstreamId,
      workspaceId,
      versionN: nextVersion,
      text: vNew.text,
      costCents: vNew.costCents,
    })}</surface:iterate-version>`,
    actor: 'system',
  }).catch(() => undefined);

  // Sub-Plan 02 — push if the resume wave has open questions
  void emitOpenQuestionsIfAny({
    workspaceId,
    parentTicketId,
    workstreamId,
    version: nextVersion,
    planText: vNew.text,
  });

  // Sub-Plan 03 — Pattern 1 symbolic guard
  void logSymbolicGuardIfViolated({
    workspaceId,
    parentTicketId,
    workstreamId,
    version: nextVersion,
    planText: vNew.text,
  });

  const hasMilestoneTag = /<surface:milestone>/i.test(vNew.text);
  const isFinal = nextVersion >= ITERATE_MAX_VERSIONS || hasMilestoneTag;
  if (isFinal) {
    db.$raw
      .prepare("UPDATE workstreams SET status='done', updated_at=? WHERE id=?")
      .run(Date.now(), workstreamId);
    // W1a: reconcile + handoff on the resume-done path (convergence/milestone).
    await runReconcileAndHandoffFailSoft(workspaceId, workstreamId, {
      [`iterate-resume-v${nextVersion}`]: 'done',
    });
    return {
      workstreamId,
      resumedFromVersion: lastVersion,
      producedVersion: nextVersion,
      isFinal: true,
      totalCostCents: costTotal,
      totalDurationMs: Date.now() - startedAt,
    };
  }

  const newRoastResults = await Promise.all(
    ROAST_ROLES.map(async (role, idx) => {
      const subId = await trySubWs(
        workstreamId,
        'iterate-resume-roaster',
        MODEL_NAMES.opus,
      );
      const r = await spawnAndAudit(
        {
          workspaceId,
          workspacePath,
          workstreamId,
          subWorkstreamId: subId,
          tier: 'opus', // Opus-only (owner directive) — was 'sonnet'
          agentIdx: 100 + idx,
          model: MODEL_NAMES.opus,
          systemPrompt: role.focus,
          userPrompt:
            'Anfrage Max: ' +
            originalPrompt +
            '\n\nPlan V' +
            nextVersion +
            ' zum Roasten:\n\n' +
            vNew.text,
          timeoutMs: 3 * 60_000,
        },
        {
          workspaceId,
          workstreamId,
          parentTicketId,
          phase: `v${nextVersion}-roast`,
          role: `iterate-roaster-${idx + 1}`,
          priorOutputs: [{ phase: `v${nextVersion}`, hash: hashOutput(vNew.text) }],
        },
      );
      return { role, output: r };
    }),
  );
  for (const r of newRoastResults) {
    costTotal += r.output.costCents;
    await emitEvent({
      segmentId: workspaceId,
      entityType: 'ticket',
      entityId: parentTicketId,
      eventType: 'commented',
      actor: 'agent:iterate-roaster',
      payload: {
        kind: 'iterate-roast',
        version: nextVersion,
        roasterRole: r.role.id,
        roasterLabel: r.role.label,
        text: r.output.text,
        tokens: r.output.tokens,
        costCents: r.output.costCents,
        durationMs: r.output.durationMs,
        workstreamId,
      },
      sensitivity: 'low',
    }).catch(() => undefined);
  }

  const pauseStartedAt = Date.now();
  await emitEvent({
    segmentId: workspaceId,
    entityType: 'ticket',
    entityId: parentTicketId,
    eventType: 'commented',
    actor: 'agent:iterate-lead',
    payload: {
      kind: 'sniper-pause-start',
      after: 'v' + nextVersion,
      workstreamId,
      durationMs: SNIPER_PAUSE_MS,
      message:
        'V' +
        nextVersion +
        ' fertig — ' +
        Math.round(SNIPER_PAUSE_MS / 1000) +
        's Window. Korrektur einwerfen oder V' +
        (nextVersion + 1) +
        ' kommt automatisch.',
    },
    sensitivity: 'low',
  }).catch(() => undefined);
  await waitForSniperPause(parentTicketId, pauseStartedAt, SNIPER_PAUSE_MS);

  return {
    workstreamId,
    resumedFromVersion: lastVersion,
    producedVersion: nextVersion,
    isFinal: false,
    totalCostCents: costTotal,
    totalDurationMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Intent-aware strategy selection (2026-05-01)
//
// Makes the user's perception "idea vs implementation vs bug-fix" visible in
// the spawn behavior too:
//   - bug-fix         → BugFixSwarm + critic-first (reproduce → fix → test)
//   - implementation  → standard senior-dev → reviewer → critic
//   - idea            → 2 roasters + synthesis without auto-dispatch
//   - question        → lightweight Q&A
//   - discussion      → standard discussion
//
// Pure resolve function. The call is deliberately NOT made autonomously in
// runIterate/spawnTier — the existing code paths first read the user's
// choice in the TierChoice picker (see Sub-Plan A 2026-04-30, hard
// tier-choice obligation). The strategy hint overrides the user's choice
// only when the user has made NO explicit one.
//
// Consumers: the auto-dispatcher and runIterate can pull this helper
// to pre-populate IteratePresets accordingly.
// ---------------------------------------------------------------------------
import { getWorkstream as _getWorkstreamForStrategy } from '../../lib/workstreams/service';
import {
  getIntentStrategy as _getIntentStrategy,
  type IntentStrategyHint,
  type WorkstreamIntent,
} from '../../lib/workstreams/intent-classifier';

/**
 * Resolved strategy hint for a workstream. Reads workstream.intent from
 * the DB. Fail-open: on a missing workstream it returns the 'discussion'
 * default (no throw — the spawn path NEVER blocks).
 */
export async function resolveIntentStrategy(
  workstreamId: string,
): Promise<{ intent: WorkstreamIntent; strategy: IntentStrategyHint }> {
  try {
    const ws = await _getWorkstreamForStrategy(workstreamId);
    const intent: WorkstreamIntent = ws?.intent ?? 'discussion';
    return { intent, strategy: _getIntentStrategy(intent) };
  } catch {
    return {
      intent: 'discussion',
      strategy: _getIntentStrategy('discussion'),
    };
  }
}

/**
 * Synchronous strategy resolver directly from a known intent. For
 * code paths that have already loaded the workstream row (e.g. inside
 * runIterate, which already knows the workstream via the ULID lookup).
 */
export function strategyForIntent(
  intent: WorkstreamIntent,
): IntentStrategyHint {
  return _getIntentStrategy(intent);
}

