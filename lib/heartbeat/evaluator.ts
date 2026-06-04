/**
 * Heartbeat-Evaluator — reine Logik, keine I/O.
 *
 * Uebersetzt einen `ProbeResult` in eine `StallDecision`. Die Regeln
 * sind absichtlich simpel und ohne DB-Zugriff, damit sie 1:1 getestet
 * und schnell iteriert werden koennen.
 *
 * Rules (Sprint 2 · 7D, Spec-Update 2026-04-24):
 *
 *   1. probe.error present                            -> status='error'
 *   2. lastCommitTs fehlt oder > 7 Tage alt           -> status='dormant'
 *   3. lastCommitTs zwischen 24h-7 Tage alt           -> status='stale'
 *   4. lastCommitTs < 24h alt UND uncommitted <= 20   -> status='alive'
 *      (`alive`-Gate: zu viel uncommitted downgradet auf `stale`)
 *   5. Extra reasons:
 *      - many_uncommitted (>20)
 *      - many_unpushed    (>10)
 *      - outdated_deps    (>0)
 *      - no_git_history
 *
 * Reasons dienen dem UI als Tooltip/Badge. Sie sind menschenlesbar und
 * werden ins `probes`-JSON mitgeschrieben (Audit-Trail).
 */

import type { ProbeResult } from "./probes";

export type HeartbeatStatus = "alive" | "stale" | "dormant" | "error";

export interface StallDecision {
  workspaceId: string;
  status: HeartbeatStatus;
  /** Lag (seconds) since the last commit. 0 when unknown. */
  lagSec: number;
  /** Human-readable reasons — may be empty for healthy workspaces. */
  reasons: string[];
}

const H24_MS = 24 * 60 * 60 * 1000;
const D7_MS = 7 * H24_MS;
const MANY_UNCOMMITTED = 20;
const MANY_UNPUSHED = 10;

export function evaluateProbe(
  workspaceId: string,
  probe: ProbeResult,
  now: number = Date.now(),
): StallDecision {
  const reasons: string[] = [];

  // Rule 1 — explicit probe error wins.
  if (probe.error) {
    return {
      workspaceId,
      status: "error",
      lagSec: computeLagSec(probe.lastCommitTs, now),
      reasons: [`probe_error:${probe.error}`],
    };
  }

  const lagSec = computeLagSec(probe.lastCommitTs, now);
  const uncommitted = probe.uncommittedChanges ?? 0;
  const unpushed = probe.unpushedCommits ?? 0;
  const outdated = probe.outdatedDeps ?? 0;

  // Rule 2 / 3 / 4 — age bucket.
  let status: HeartbeatStatus;
  if (probe.lastCommitTs === undefined) {
    status = "dormant";
    reasons.push("no_git_history");
  } else {
    const ageMs = now - probe.lastCommitTs;
    if (ageMs > D7_MS) {
      status = "dormant";
      reasons.push(`no_commits_${Math.round(ageMs / 3600_000)}h`);
    } else if (ageMs > H24_MS) {
      status = "stale";
      reasons.push(`no_commits_${Math.round(ageMs / 3600_000)}h`);
    } else if (uncommitted > MANY_UNCOMMITTED) {
      // Too much uncommitted — downgrade alive → stale even if commits are fresh.
      status = "stale";
    } else {
      status = "alive";
    }
  }

  // Extra diagnostic reasons (do not change status unless above rule fired).
  if (uncommitted > MANY_UNCOMMITTED) {
    reasons.push(`many_uncommitted:${uncommitted}`);
  }
  if (unpushed > MANY_UNPUSHED) {
    reasons.push(`many_unpushed:${unpushed}`);
  }
  if (outdated > 0) {
    reasons.push(`outdated_deps:${outdated}`);
  }

  return {
    workspaceId,
    status,
    lagSec,
    reasons,
  };
}

function computeLagSec(lastCommitTs: number | undefined, now: number): number {
  if (!lastCommitTs) return 0;
  const diff = Math.max(0, Math.floor((now - lastCommitTs) / 1000));
  return diff;
}
