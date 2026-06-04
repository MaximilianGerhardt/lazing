'use client';

/**
 * useWorkspaceState — Slice 2 (2026-05-30, Apple-UX Surface-Rework / ActionDeck).
 *
 * Reads the deterministic operational workspace state
 * (`projectWorkspaceState`) via the existing member-auth/scope-gated
 * route `GET /api/state/projection/[workspaceId]` (N2/N9 enforced there)
 * and delivers it as client state to the `ActionDeck` region.
 *
 * WHY a projection instead of the rendered history?
 * ────────────────────────────────────────────────────
 * Owner finding #1 (verbatim):
 *   „Plan-Synthese fertig + Entscheidung benötigt gleichzeitig → die
 *    Entscheidung geht komplett unter → komplett irreführend. Sowas muss
 *    immer unten über den Chat angepinnt sein, so wie mit den Fragen."
 *
 * The visible chat cards are ONLY history (state-projector.ts §29).
 * What blocks NOW (an open gate, an open question) lives in the
 * DB/event truth — not in the DOM. This hook fetches exactly that truth, so
 * the ActionDeck always pins the ONE most important, still-open item.
 *
 * Lifecycle:
 *   • Poll every POLL_MS (like OpenQuestionsSurface) — fresh default cadence.
 *   • Additional invalidation via `refreshSignal`: ChatShell increments the
 *     counter after the SSE frame ends (answer finished) → the deck slips
 *     immediately to the next priority instead of waiting for the next poll tick.
 *   • No state mutation, read-only — like the route itself.
 *
 * Fail-soft: every fetch error → last known state stays in place
 * (no flicker). On the first error without a prior state → null (deck renders
 * nothing; today's pill stays unaffected, see ActionDeck).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { isVirtualWorkspaceId } from '../nav/workspaces-data';
import type {
  BlockingGateState,
  OpenQuestionState,
  WorkspaceState,
} from '../projection/types';

/** Default poll cadence — mirrored from OpenQuestionsSurface (POLL_MS = 5000). */
export const POLL_MS = 5000;

// ───────────────────────────────────────────────────────────────────────────
// selectPinnedItem — pure, tested prioritization
// ───────────────────────────────────────────────────────────────────────────

/**
 * The ONE item the ActionDeck pins. Exactly one variant at a time
 * (NEVER gate + question simultaneously) — mirrors `deriveNextAllowedUserInput`:
 *
 *   1. blockingGate  (approve-gate)  — a gate blocks the run completely.
 *   2. question      (answer-question) — an open question is pending.
 *   3. info          (wait)          — run is active, no user input needed.
 *   4. null          (free-prompt)   — nothing to pin.
 */
export type PinnedItem =
  | { type: 'gate'; gate: BlockingGateState }
  | { type: 'question'; question: OpenQuestionState; openCount: number }
  | { type: 'info'; phase?: string; runId: string }
  /**
   * Bug 1 / context loss (2026-05-30, owner scenario "connector onboarding
   * heygen interrupted"): an open, NON-running workstream
   * (status 'paused' | 'stuck' | 'interrupted') that expects a user reaction
   * (resume / rephrase). MUST NOT vanish as a bland "running" — the deck pins
   * it with name + resume hint, so a short/unclear input ("?", "yes",
   * "continue") does not lose the context.
   *
   * The actual resume/auth trigger lives in the connector/server stack
   * (lib/connectors/auto-connect.ts · server) — this item keeps the context
   * visible + gives the parent (ChatShell) the `workstreamId` with which it
   * can kick off the correct resume path (instead of a generic clarify menu).
   */
  | {
      type: 'resume';
      workstreamId: string;
      name: string;
      status: string;
      /** Heuristic: does the name look like connector onboarding? */
      isOnboarding: boolean;
    }
  | null;

/**
 * Workstream statuses that expect a user reaction (resume / discard)
 * instead of running on by themselves. Source: workstreams.status (verbatim).
 */
const RESUMABLE_STATUSES = new Set(['paused', 'stuck', 'interrupted']);

/**
 * Heuristic (lexical, N7): recognizes a connector/onboarding workstream by its
 * name. Deliberately broad (onboarding, connector, auth, oauth, "verbind",
 * known provider slugs) — the deck hint is only context, not the actual
 * auth trigger, so a generous detection is safe.
 */
export function looksLikeOnboarding(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.includes('onboarding') ||
    n.includes('connector') ||
    n.includes('connect') ||
    n.includes('oauth') ||
    n.includes('auth') ||
    n.includes('verbind') ||
    n.includes('credential') ||
    n.includes('zugang')
  );
}

/**
 * Pure selection function (no React, no I/O) — fully unit-testable.
 *
 * Priority: gate > open question > info(running) > null. Deliberately congruent
 * with `deriveNextAllowedUserInput` (state-projector.ts §660), so the
 * pinned action and `nextAllowedUserInput` never diverge.
 *
 * Gate selection: the NEWEST open gate (highest createdAt). The projection
 * already delivers blockingGates sorted DESC; we still explicitly pick
 * max(createdAt) — robust against future sort changes.
 *
 * Question selection: the NEWEST still-unanswered question (highest askedAt) —
 * same logic as today's pill (newest question set wins).
 */
export function selectPinnedItem(
  state: WorkspaceState | null | undefined,
): PinnedItem {
  if (!state) return null;

  // 1. Blocking gate (highest priority — blocks the whole run).
  if (Array.isArray(state.blockingGates) && state.blockingGates.length > 0) {
    let newest = state.blockingGates[0]!;
    for (const g of state.blockingGates) {
      if (g.createdAt > newest.createdAt) newest = g;
    }
    return { type: 'gate', gate: newest };
  }

  // 2. Open (unanswered) question.
  const unanswered = Array.isArray(state.openQuestions)
    ? state.openQuestions.filter((q) => !q.answered)
    : [];
  if (unanswered.length > 0) {
    let newest = unanswered[0]!;
    for (const q of unanswered) {
      if (q.askedAt > newest.askedAt) newest = q;
    }
    return {
      type: 'question',
      question: newest,
      openCount: unanswered.length,
    };
  }

  // 2b. Interrupted/paused workstream → resume item (owner scenario
  //     "connector onboarding heygen interrupted"). HIGHER than the generic
  //     "running" info path, so an open onboarding context does not vanish
  //     and a short/unclear input stays in ITS context.
  //     An actively RUNNING FlowRun (below) has no resume need → the
  //     resume check only fires when NO run is currently streaming.
  const runActiveNow =
    state.activeFlowRun &&
    (state.activeFlowRun.status === 'running' ||
      state.activeFlowRun.status === 'pending' ||
      state.activeFlowRun.status === 'needs-coupling' ||
      state.activeFlowRun.status === 'needs-style-choice');
  if (!runActiveNow && Array.isArray(state.activeWorkstreams)) {
    const resumable = state.activeWorkstreams.filter((w) =>
      RESUMABLE_STATUSES.has(w.status),
    );
    if (resumable.length > 0) {
      // Onboarding workstreams take precedence (action-guiding); otherwise the
      // first resumable. Deterministic (first match per group).
      const onboarding = resumable.find((w) => looksLikeOnboarding(w.name));
      const chosen = onboarding ?? resumable[0]!;
      return {
        type: 'resume',
        workstreamId: chosen.workstreamId,
        name: chosen.name,
        status: chosen.status,
        isOnboarding: looksLikeOnboarding(chosen.name),
      };
    }
  }

  // 3. Info: run is active (no user input expected) — slim "running" line.
  const run = state.activeFlowRun;
  if (
    run &&
    (run.status === 'running' ||
      run.status === 'pending' ||
      run.status === 'needs-coupling' ||
      run.status === 'needs-style-choice')
  ) {
    return { type: 'info', phase: run.currentPhase, runId: run.flowRunId };
  }
  // No FlowRun, but active workstreams → also "running".
  if (
    Array.isArray(state.activeWorkstreams) &&
    state.activeWorkstreams.length > 0
  ) {
    return { type: 'info', runId: 'workstreams' };
  }

  // 4. Nothing to pin.
  return null;
}

/**
 * F18 (2026-05-30) — the signature of the currently PINNED decision/quickchoice,
 * with which the in-feed card (SurfaceRenderer · `useDecisionPinned`) quiets
 * itself once it is pinned below (no two loud copies).
 *
 * The signature is the SAME one that `state-projector.extractGateOptions` /
 * `effectiveDescription` stores as `gate.description`: for a decision the
 * verbatim headline, for a QuickChoice the option labels (join ' · ') — the
 * feed card forms exactly the same signature, so they match.
 *
 * Returns null if the pinned item is NOT a decision (or nothing is pinned).
 * ChatShell passes the return value through to `PinnedDecisionRegistryProvider`
 * (pinnedHeadline).
 */
export function pinnedDecisionSignature(item: PinnedItem): string | null {
  if (!item || item.type !== 'gate') return null;
  if (item.gate.kind !== 'decision') return null;
  const d =
    typeof item.gate.description === 'string' ? item.gate.description.trim() : '';
  return d.length > 0 ? d : null;
}

// ───────────────────────────────────────────────────────────────────────────
// Hook
// ───────────────────────────────────────────────────────────────────────────

export interface UseWorkspaceStateResult {
  /** Last known projection state (null until the first successful fetch). */
  state: WorkspaceState | null;
  /** First load still in progress (no state, no error). */
  loading: boolean;
  /** Last fetch error (informative; the state stays fail-soft in place). */
  error: string | null;
  /** Manual re-fetch (e.g. after a deck action). */
  refresh: () => void;
}

export interface UseWorkspaceStateOptions {
  /**
   * Monotonically increasing invalidation counter. ChatShell increments it
   * after the SSE frame ends (answer finished). Every change triggers an
   * immediate re-fetch — the deck is then fresh without waiting for the poll tick.
   */
  refreshSignal?: number;
  /** Poll interval in ms (default POLL_MS = 5000). 0/negative → no polling. */
  pollMs?: number;
  /**
   * Test hook: fetch implementation is injectable. Default = global fetch.
   * Keeps the hook unit-testable without a jsdom network.
   */
  fetchImpl?: typeof fetch;
}

export function useWorkspaceState(
  workspaceId: string | null | undefined,
  opts: UseWorkspaceStateOptions = {},
): UseWorkspaceStateResult {
  const { refreshSignal = 0, pollMs = POLL_MS, fetchImpl } = opts;

  const [state, setState] = useState<WorkspaceState | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(workspaceId));
  const [error, setError] = useState<string | null>(null);

  // Manual refresh tick — adds to refreshSignal.
  const [manualTick, setManualTick] = useState(0);
  const refresh = useCallback(() => setManualTick((n) => n + 1), []);

  // Race guard: only the response of the newest request may set the state.
  const reqIdRef = useRef(0);

  useEffect(() => {
    // Virtual / aggregating IDs (`__root__`, `__all__`, `__org_root__:*`)
    // have no real workspace membership — the member-gated projection
    // route inevitably answers 403. Skipping the fetch (and the 5s polling)
    // here prevents the 403 console spam and pointless network; the
    // ActionDeck renders nothing for an aggregation anyway (state stays
    // null — identical to the previous fail-soft behavior, just without noise).
    if (!workspaceId || isVirtualWorkspaceId(workspaceId)) {
      setState(null);
      setLoading(false);
      setError(null);
      return;
    }
    const doFetch = fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== 'function') {
      return;
    }
    let cancelled = false;
    const myReq = (reqIdRef.current += 1);

    const load = async (): Promise<void> => {
      try {
        const res = await doFetch(
          `/api/state/projection/${encodeURIComponent(workspaceId)}`,
          { method: 'GET', headers: { accept: 'application/json' } },
        );
        if (cancelled || myReq !== reqIdRef.current) return;
        if (!res.ok) {
          // Fail-soft: last state stays in place, only mark the error.
          setError(`HTTP ${res.status}`);
          setLoading(false);
          return;
        }
        const body = (await res.json()) as WorkspaceState;
        if (cancelled || myReq !== reqIdRef.current) return;
        setState(body);
        setError(null);
        setLoading(false);
      } catch (err) {
        if (cancelled || myReq !== reqIdRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    };

    void load();

    // Polling.
    let timer: ReturnType<typeof setInterval> | undefined;
    if (pollMs > 0) {
      timer = setInterval(() => void load(), pollMs);
    }
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
    // refreshSignal + manualTick force a fresh re-fetch.
  }, [workspaceId, refreshSignal, manualTick, pollMs, fetchImpl]);

  return { state, loading, error, refresh };
}

export default useWorkspaceState;
