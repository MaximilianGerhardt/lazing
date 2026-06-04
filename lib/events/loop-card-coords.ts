/**
 * lib/events/loop-card-coords.ts — Welle 7 (2026-05-01)
 * ------------------------------------------------------
 *
 * Deterministic coord builder for loop-phase cards. One card per
 * (workspaceId, workstreamId, surfaceKind, subKey) tuple. The subKey
 * disambiguates multiple cards of the same kind within the same workstream
 * — e.g. "auto-dispatch-stage|stage:0", "...stage:1", "...stage:2".
 *
 * Contracts (CardSubKey format):
 *   - auto-dispatch-stage           → `stage:<stageIdx>` (0,1,2)
 *   - auto-dispatch-stage-retry     → `stage:<stageIdx>:retry:<attempt>`
 *   - auto-dispatch-overview        → NO subKey (exactly 1 per workstream)
 *   - auto-dispatch-pause           → `pause:<reasonHash>` or fixed key
 *   - tier-output                   → `tier:<tier>#<agentIdx>`
 *   - iterate-version               → `v:<versionN>`
 *   - iterate-roast                 → `roaster:<roasterIdx>:v:<versionN>`
 *   - sniper-pause-start            → `pause:v:<versionN>`
 *   - iterate-resumed               → `resumed:v:<versionN>`
 *   - user-correction               → `correction:<injectedAt>` or `:v:<versionN>`
 *   - plan-open-questions           → NO subKey (1 card per workstream)
 *
 * Stable + deterministic — the same call always returns the same subKey.
 * Race-safe, because emit-or-update-card matches jointly on (segment_id,
 * surfaceKind, workstreamId, cardSubKey).
 */

export interface LoopCoordParts {
  stageIdx?: number;
  attempt?: number;
  tier?: string;
  agentIdx?: number;
  versionN?: number;
  roasterIdx?: number;
  injectedAt?: string;
}

export function autoDispatchStageSubKey(stageIdx: number): string {
  return `stage:${stageIdx}`;
}

export function autoDispatchStageRetrySubKey(
  stageIdx: number,
  attempt: number,
): string {
  return `stage:${stageIdx}:retry:${attempt}`;
}

export function tierOutputSubKey(tier: string, agentIdx: number): string {
  return `tier:${tier}#${agentIdx}`;
}

export function iterateVersionSubKey(versionN: number): string {
  return `v:${versionN}`;
}

export function iterateRoastSubKey(
  roasterIdx: number,
  versionN: number,
): string {
  return `roaster:${roasterIdx}:v:${versionN}`;
}

export function sniperPauseSubKey(versionN: number): string {
  return `pause:v:${versionN}`;
}

export function iterateResumedSubKey(versionN: number): string {
  return `resumed:v:${versionN}`;
}

export function userCorrectionSubKey(injectedAt: string): string {
  return `correction:${injectedAt}`;
}
