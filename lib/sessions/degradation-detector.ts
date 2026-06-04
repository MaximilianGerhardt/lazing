/**
 * degradation-detector — PURE decision whether a Claude session should be
 * rotated (degrade→handoff→rotate). No I/O, no DB, no Date.now() in the core →
 * exhaustively unit-testable (the test gate demands perfection here).
 *
 * Background (audit 2026-06-03): lazyOS continues ONE session per workspace forever
 * via --resume; output degrades with length; the only auto-reset
 * fired on last_result='error' — the WRONG signal. This detector provides
 * the right signals:
 *   - turn budget exceeded               → context too long
 *   - token budget (cumulative) exceeded → context too heavy
 *   - age budget exceeded                → the session probably spans many tasks
 *   - last_result='too_many_turns'       → the CLI itself hit its turn cap
 *   - explicit task boundary (plan done) → a clean fresh session per task
 *
 * Deliberately NOT: last_result='error' triggers NO rotation here — that is handled
 * by the existing self-heal path in workspace-session.ts (fresh UUID on a corrupt
 * transcript). Double handling would step on each other's toes.
 */

export interface SessionVitals {
  /** Successful turns on this session. */
  turnCount: number;
  /** Cumulative token proxy (prompt+output chars/4) across all turns. */
  tokenEstimate: number;
  /** Age of the session in ms (now - createdAt). */
  ageMs: number;
  /** Last result label ('success'|'error'|'aborted'|'too_many_turns'|null). */
  lastResult: string | null;
}

export interface RotationPolicy {
  /** Rotation as soon as turnCount >= maxTurns. */
  maxTurns: number;
  /** Rotation as soon as tokenEstimate >= maxTokens. */
  maxTokens: number;
  /** Rotation as soon as ageMs >= maxAgeMs. */
  maxAgeMs: number;
  /** Minimum turnCount for a task boundary to rotate at all (an already
   *  fresh 0-turn session needs no rotation). */
  minTurnsForTaskBoundary: number;
}

export type RotationReason =
  | 'turn-budget'
  | 'token-budget'
  | 'age-budget'
  | 'too-many-turns'
  | 'task-boundary'
  | 'none';

export interface RotationDecision {
  rotate: boolean;
  reason: RotationReason;
  /** Human-readable detail for the audit/log. */
  detail: string;
}

/**
 * Defaults — deliberately conservative (better to rotate a little too early than to deliver
 * degraded output). All overridable via ENV; reversible.
 */
export const DEFAULT_ROTATION_POLICY: RotationPolicy = {
  // PRIMARY signals for degradation = accumulated context (turns + token proxy).
  maxTurns: 40,
  maxTokens: 250_000,
  // Age is only the WEAK secondary signal (a very old session probably spans
  // unrelated tasks + has a huge transcript). Deliberately
  // conservative (7 days) so as NOT to interrupt a legitimate multi-day active
  // conversation — turn/token budget catches the real degradation.
  maxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  minTurnsForTaskBoundary: 1,
};

/** Read policy from ENV (fail-soft to defaults). Do not call in the PURE core. */
export function rotationPolicyFromEnv(
  env: Record<string, string | undefined> = process.env,
): RotationPolicy {
  const num = (v: string | undefined, d: number): number => {
    if (!v) return d;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    maxTurns: num(env.LAZYOS_SESSION_MAX_TURNS, DEFAULT_ROTATION_POLICY.maxTurns),
    maxTokens: num(env.LAZYOS_SESSION_MAX_TOKENS, DEFAULT_ROTATION_POLICY.maxTokens),
    maxAgeMs: num(env.LAZYOS_SESSION_MAX_AGE_MS, DEFAULT_ROTATION_POLICY.maxAgeMs),
    minTurnsForTaskBoundary: DEFAULT_ROTATION_POLICY.minTurnsForTaskBoundary,
  };
}

/** Whether auto-rotation is active at all (ENV kill switch, default on). */
export function rotationEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.LAZYOS_SESSION_ROTATION !== '0';
}

/**
 * The core: PURE. `taskBoundary=true` means "a plan/task has just been cleanly
 * completed" → a fresh session for the next task (only if the session
 * has already worked). Otherwise the degradation budgets decide.
 *
 * The order of reasons is deterministic (task boundary first, then the most
 * clearly exceeded budget) — important for stable tests + audit.
 */
export function assessRotation(
  v: SessionVitals,
  taskBoundary: boolean,
  policy: RotationPolicy = DEFAULT_ROTATION_POLICY,
): RotationDecision {
  // An explicit task boundary wins — but only if the session already had turns.
  if (taskBoundary && v.turnCount >= policy.minTurnsForTaskBoundary) {
    return {
      rotate: true,
      reason: 'task-boundary',
      detail: `Task abgeschlossen nach ${v.turnCount} Turns → frische Session`,
    };
  }

  // The CLI hit its own turn cap → a clear degradation signal.
  if (v.lastResult === 'too_many_turns') {
    return {
      rotate: true,
      reason: 'too-many-turns',
      detail: 'last_result=too_many_turns → CLI-Turn-Cap erreicht',
    };
  }

  if (v.tokenEstimate >= policy.maxTokens) {
    return {
      rotate: true,
      reason: 'token-budget',
      detail: `tokenEstimate ${v.tokenEstimate} >= ${policy.maxTokens}`,
    };
  }
  if (v.turnCount >= policy.maxTurns) {
    return {
      rotate: true,
      reason: 'turn-budget',
      detail: `turnCount ${v.turnCount} >= ${policy.maxTurns}`,
    };
  }
  if (v.ageMs >= policy.maxAgeMs) {
    return {
      rotate: true,
      reason: 'age-budget',
      detail: `ageMs ${v.ageMs} >= ${policy.maxAgeMs}`,
    };
  }

  return { rotate: false, reason: 'none', detail: 'within budgets' };
}

/** Token estimate from character lengths (≈ chars/4), defensively clamped. */
export function estimateTokens(promptChars: number, outputBytes: number): number {
  const c = Math.max(0, promptChars) + Math.max(0, outputBytes);
  return Math.ceil(c / 4);
}

/**
 * Age baseline for the age budget: since the LAST rotation (`rotatedAt`),
 * otherwise since creation (`createdAt`).
 *
 * CRITICAL (review CRIT-1, 2026-06-03): the rotation resets turn_count/
 * token_estimate, but `created_at` stays immutable. If the
 * age budget kept computing against `created_at`, a session older than maxAge
 * would rotate again EVERY turn (age stays > maxAge) → a self-perpetuating
 * rotation loop that rewrites the handoff each time + discards the just-
 * resumed transcript. Computing against `rotatedAt` resets the age with
 * each rotation (fresh session ⇒ fresh age), while `created_at` is preserved
 * as the real provenance.
 */
export function effectiveAgeMs(
  createdAt: number,
  rotatedAt: number | null | undefined,
  now: number,
): number {
  return Math.max(0, now - (rotatedAt ?? createdAt));
}
