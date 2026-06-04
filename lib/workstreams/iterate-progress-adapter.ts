/**
 * Iterate state → StageDescriptor[] adapter (sub-plan 5 wave 2, 2026-05-01).
 *
 * Maps V1..Vmax (sniper loop) onto the 5-state stepper:
 *
 *   - one stage per version (V1, V2, ..., Vmax)
 *   - currentVersion = State.lastVersion + (phase==='lead-vN' ? 0 : 1)
 *     Simplification: we accept a pre-computed `currentVersion` from the
 *     caller — it knows the phase better than we do.
 *   - n < currentVersion → 'done'
 *   - n === currentVersion → 'running' (except when isPaused)
 *   - n > currentVersion → 'pending'
 *   - isPaused + n === currentVersion → 'pending' with subtitle
 *     "Pause vor V{n}"  (auto-advance running)
 *   - aborted → currentVersion → 'failed'
 *
 * Phase as a sub-step:
 *   - lead-vN: one sub-step "Lead schreibt"
 *   - roast: one sub-step "Roast aktiv" (several roasters combined)
 *   - pause: one sub-step "Pause" with a seconds countdown via subtitle
 *
 * Out-of-scope: roaster granularity (3-4 agents) — a detail drilldown would be
 * its own wave.
 */

import type { StageDescriptor, EtaBucket } from '@/lib/ui/pip';

export type IteratePhase = 'lead-v1' | 'roast' | 'pause' | 'idle' | 'done';

export interface IterateProgressInput {
  /** 1..maxVersion */
  currentVersion: number;
  maxVersion: number;
  phase: IteratePhase;
  /** When true → the currentVersion stage is 'pending' with a pause subtitle. */
  isPaused: boolean;
  /** When true → aborted state, currentVersion → failed. */
  isAborted?: boolean;
  /** When true → fully done, all stages → done. */
  isCompleted?: boolean;
  /**
   * Optional: seconds until the pause ends. When set + phase==='pause' →
   * subtitle "noch {N}s". For N <= 0 → "läuft an".
   */
  pauseSecondsRemaining?: number;
  /**
   * Optional: seconds since phase start (for the eta bucket of the active stage).
   */
  phaseElapsedMs?: number;
}

const NOW_60S = 60_000;
const NOW_5MIN = 5 * 60_000;
const NOW_30MIN = 30 * 60_000;

function bucketForElapsed(elapsedMs: number | undefined): EtaBucket | undefined {
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs)) return undefined;
  if (elapsedMs < NOW_60S) return 'fast';
  if (elapsedMs < NOW_5MIN) return 'normal';
  if (elapsedMs < NOW_30MIN) return 'slow';
  return 'overdue';
}

function phaseSubLabel(phase: IteratePhase, version: number): string {
  if (phase === 'lead-v1') return 'Lead schreibt';
  if (phase === 'roast') return `Roast V${version}`;
  if (phase === 'pause') return `Pause vor V${version + 1}`;
  if (phase === 'done') return 'fertig';
  return 'läuft';
}

export function iterateToStages(
  input: IterateProgressInput,
): StageDescriptor[] {
  const {
    currentVersion,
    maxVersion,
    phase,
    isPaused,
    isAborted,
    isCompleted,
    pauseSecondsRemaining,
    phaseElapsedMs,
  } = input;

  const stages: StageDescriptor[] = [];

  for (let n = 1; n <= maxVersion; n += 1) {
    let status: StageDescriptor['status'];
    let subtitle: string | undefined;
    let etaBucket: EtaBucket | undefined;
    const sub: StageDescriptor[] = [];

    if (isCompleted) {
      status = 'done';
    } else if (n < currentVersion) {
      status = 'done';
    } else if (n === currentVersion) {
      if (isAborted) {
        status = 'failed';
        subtitle = 'abgebrochen';
      } else if (isPaused || phase === 'pause') {
        status = 'pending';
        if (typeof pauseSecondsRemaining === 'number') {
          subtitle =
            pauseSecondsRemaining > 0
              ? `Pause — noch ${pauseSecondsRemaining}s`
              : 'läuft an';
        } else {
          subtitle = `Pause vor V${n + 1}`;
        }
      } else {
        status = 'running';
        etaBucket = bucketForElapsed(phaseElapsedMs);
        // Sub-step for the phase
        sub.push({
          id: `iterate::v${n}::phase::${phase}`,
          label: phaseSubLabel(phase, n),
          status: 'running',
          etaBucket,
        });
      }
    } else {
      status = 'pending';
    }

    stages.push({
      id: `iterate::v${n}`,
      label: `V${n}`,
      status,
      subtitle,
      etaBucket,
      sub: sub.length > 0 ? sub : undefined,
    });
  }

  return stages;
}
