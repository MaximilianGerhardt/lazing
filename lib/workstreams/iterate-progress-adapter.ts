/**
 * Iterate-State → StageDescriptor[]-Adapter (Sub-Plan 5 Welle 2, 2026-05-01).
 *
 * Mapping V1..Vmax (Sniper-Loop) auf 5-State-Stepper:
 *
 *   - Stage pro Version (V1, V2, ..., Vmax)
 *   - currentVersion = State.lastVersion + (phase==='lead-vN' ? 0 : 1)
 *     Vereinfachung: wir akzeptieren pre-computed `currentVersion` vom
 *     Caller — der weiß die Phase besser als wir.
 *   - n < currentVersion → 'done'
 *   - n === currentVersion → 'running' (außer bei isPaused)
 *   - n > currentVersion → 'pending'
 *   - isPaused + n === currentVersion → 'pending' mit Subtitle
 *     "Pause vor V{n}"  (Auto-Advance läuft)
 *   - aborted → currentVersion → 'failed'
 *
 * Phase als Sub-Step:
 *   - lead-vN: ein Sub-Step "Lead schreibt"
 *   - roast: ein Sub-Step "Roast aktiv" (mehrere Roaster zusammengefasst)
 *   - pause: ein Sub-Step "Pause" mit Sekunden-Countdown via subtitle
 *
 * Out-of-scope: Roaster-Granularität (3-4 Agents) — Detail-Drilldown wäre
 * eigene Welle.
 */

import type { StageDescriptor, EtaBucket } from '@/lib/ui/pip';

export type IteratePhase = 'lead-v1' | 'roast' | 'pause' | 'idle' | 'done';

export interface IterateProgressInput {
  /** 1..maxVersion */
  currentVersion: number;
  maxVersion: number;
  phase: IteratePhase;
  /** Wenn true → currentVersion-Stage ist 'pending' mit Pause-Subtitle. */
  isPaused: boolean;
  /** Wenn true → aborted-State, currentVersion → failed. */
  isAborted?: boolean;
  /** Wenn true → komplett done, alle Stages → done. */
  isCompleted?: boolean;
  /**
   * Optional: Sekunden bis Pause-Ende. Wenn gesetzt + phase==='pause' →
   * Subtitle "noch {N}s". Bei N <= 0 → "läuft an".
   */
  pauseSecondsRemaining?: number;
  /**
   * Optional: Sekunden seit Phase-Start (für eta-Bucket der active Stage).
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
        // Sub-Step für Phase
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
