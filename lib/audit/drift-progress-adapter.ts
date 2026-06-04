/**
 * Drift-Audit → StageDescriptor[]-Adapter (Sub-Plan 5 Welle 2, 2026-05-01).
 *
 * Stages:
 *   1. select-targets — Welche Tickets/Workstreams werden re-evaluiert
 *   2. re-run         — Alte Reasoning-Verify-Aufrufe wiederholen
 *   3. compare        — Original vs. Re-Run, Drift quantifizieren
 *   4. report         — Drift-Report persistieren / pushen
 *
 * Mapping ähnelt dem RAG-Adapter:
 *   - phase=done → alle done
 *   - phase=failed → active failed, Rest skipped
 *   - active-Stage progressPct = (processedTargets / totalTargets) * 100
 */

import type { StageDescriptor, EtaBucket } from '@/lib/ui/pip';

export type DriftPhase =
  | 'idle'
  | 'select-targets'
  | 're-run'
  | 'compare'
  | 'report'
  | 'done'
  | 'failed';

export interface DriftAuditStatus {
  runId: string;
  phase: DriftPhase;
  totalTargets?: number;
  processedTargets?: number;
  driftFound?: number;
  lastUpdateMs?: number;
  nowMs?: number;
  errorMessage?: string;
}

const STAGE_ORDER: ReadonlyArray<{ id: string; label: string; phase: DriftPhase }> = [
  { id: 'drift::select', label: 'Targets wählen', phase: 'select-targets' },
  { id: 'drift::rerun', label: 'Re-Run', phase: 're-run' },
  { id: 'drift::compare', label: 'Vergleichen', phase: 'compare' },
  { id: 'drift::report', label: 'Report', phase: 'report' },
];

const NOW_60S = 60_000;
const NOW_5MIN = 5 * 60_000;
const NOW_30MIN = 30 * 60_000;

function bucket(elapsedMs: number): EtaBucket {
  if (elapsedMs < NOW_60S) return 'fast';
  if (elapsedMs < NOW_5MIN) return 'normal';
  if (elapsedMs < NOW_30MIN) return 'slow';
  return 'overdue';
}

function pct(num: number | undefined, denom: number | undefined): number | undefined {
  if (typeof num !== 'number' || typeof denom !== 'number') return undefined;
  if (denom <= 0) return undefined;
  return Math.round((num / denom) * 100);
}

export function driftAuditToStages(status: DriftAuditStatus): StageDescriptor[] {
  const { phase, totalTargets, processedTargets, driftFound } = status;
  const now = status.nowMs ?? Date.now();
  const elapsed = status.lastUpdateMs ? Math.max(0, now - status.lastUpdateMs) : undefined;
  const activeIdx = STAGE_ORDER.findIndex((s) => s.phase === phase);

  return STAGE_ORDER.map((stage, idx) => {
    let s: StageDescriptor['status'];
    let subtitle: string | undefined;
    let etaBucket: EtaBucket | undefined;
    let progressPct: number | undefined;

    if (phase === 'done') {
      s = 'done';
      if (stage.phase === 'report' && typeof driftFound === 'number') {
        subtitle = `${driftFound} Drift-Findings`;
      }
    } else if (phase === 'idle') {
      s = 'pending';
    } else if (phase === 'failed' && activeIdx < 0) {
      s = idx === STAGE_ORDER.length - 1 ? 'failed' : 'skipped';
      if (idx === STAGE_ORDER.length - 1) subtitle = status.errorMessage ?? 'fehlgeschlagen';
    } else if (activeIdx < 0) {
      s = 'pending';
    } else if (idx < activeIdx) {
      s = 'done';
    } else if (idx === activeIdx) {
      if (phase === 'failed') {
        s = 'failed';
        subtitle = status.errorMessage ?? 'fehlgeschlagen';
      } else {
        s = 'running';
        if (elapsed !== undefined) etaBucket = bucket(elapsed);
        if (stage.phase === 're-run') {
          progressPct = pct(processedTargets, totalTargets);
          if (progressPct !== undefined && totalTargets) {
            subtitle = `${processedTargets ?? 0}/${totalTargets} Targets`;
          }
        }
      }
    } else {
      s = 'pending';
    }

    return {
      id: stage.id,
      label: stage.label,
      status: s,
      subtitle,
      etaBucket,
      progressPct,
    };
  });
}
