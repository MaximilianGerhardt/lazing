/**
 * RAG index-run → StageDescriptor[] adapter (Sub-Plan 5 wave 2, 2026-05-01).
 *
 * Stages:
 *   1. discover-sources — collect files/chats
 *   2. chunk            — split text into chunks
 *   3. embed            — compute embeddings (local, Xenova)
 *   4. persist          — INSERT chunks into rag_chunks
 *   5. cleanup          — update IndexerState, check the circuit breaker
 *
 * Input is `RagRunStatus` — provided by `/api/rag/index/[runId]/status`.
 * Since the indexer is not run-based (but stateful per
 * workspace+sourceType), we simulate "runs" as pseudo IDs:
 * `runId = ${workspaceId}::${sourceType}` or `${workspaceId}::all`.
 *
 * Mapping:
 *   - phase: discover/chunk/embed/persist/cleanup → the corresponding stage running
 *   - phase=done → all done
 *   - phase=failed → current stage failed, earlier ones done, later ones skipped
 *   - phase=circuit-open → cleanup skipped, main stage failed with subtitle
 *
 * Progress:
 *   - the embed stage gets progressPct = (embedded / totalChunks) * 100
 *     (only when totalChunks > 0)
 *   - the persist stage gets progressPct = (persisted / totalChunks) * 100
 */

import type { StageDescriptor, EtaBucket } from '@/lib/ui/pip';

export type RagPhase =
  | 'idle'
  | 'discover-sources'
  | 'chunk'
  | 'embed'
  | 'persist'
  | 'cleanup'
  | 'done'
  | 'failed'
  | 'circuit-open';

export interface RagRunStatus {
  workspaceId: string;
  /** Pseudo-run identifier for UI routing. */
  runId: string;
  phase: RagPhase;
  /** Estimated total chunk count (after discover). */
  totalChunks?: number;
  /** Embedded so far. */
  embeddedCount?: number;
  /** Persisted so far. */
  persistedCount?: number;
  /** Last activity as ms-epoch — for the eta bucket of the active stage. */
  lastUpdateMs?: number;
  /** Now-override for tests. */
  nowMs?: number;
  /** Optional: error message when phase='failed' or 'circuit-open'. */
  errorMessage?: string;
}

const STAGE_ORDER: ReadonlyArray<{ id: string; label: string; phase: RagPhase }> = [
  { id: 'rag::discover', label: 'Quellen sammeln', phase: 'discover-sources' },
  { id: 'rag::chunk', label: 'Chunken', phase: 'chunk' },
  { id: 'rag::embed', label: 'Embeddings', phase: 'embed' },
  { id: 'rag::persist', label: 'Speichern', phase: 'persist' },
  { id: 'rag::cleanup', label: 'Aufräumen', phase: 'cleanup' },
];

const NOW_60S = 60_000;
const NOW_5MIN = 5 * 60_000;
const NOW_30MIN = 30 * 60_000;

function bucketForElapsed(elapsedMs: number): EtaBucket {
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

export function ragRunToStages(status: RagRunStatus): StageDescriptor[] {
  const { phase, totalChunks, embeddedCount, persistedCount } = status;
  const now = status.nowMs ?? Date.now();
  const elapsed = status.lastUpdateMs ? Math.max(0, now - status.lastUpdateMs) : undefined;

  // Index of the active stage in STAGE_ORDER
  const activeIdx = STAGE_ORDER.findIndex((s) => s.phase === phase);
  const isDone = phase === 'done';
  const isFailed = phase === 'failed';
  const isCircuitOpen = phase === 'circuit-open';
  const isIdle = phase === 'idle';

  return STAGE_ORDER.map((stage, idx) => {
    let s: StageDescriptor['status'];
    let subtitle: string | undefined;
    let etaBucket: EtaBucket | undefined;
    let progressPct: number | undefined;

    if (isDone) {
      s = 'done';
    } else if (isIdle) {
      s = 'pending';
    } else if (isFailed && activeIdx < 0) {
      // Generic fail without a phase — last stage failed, rest skipped
      s = idx === STAGE_ORDER.length - 1 ? 'failed' : 'skipped';
      if (idx === STAGE_ORDER.length - 1) subtitle = status.errorMessage ?? 'fehlgeschlagen';
    } else if (isCircuitOpen) {
      // Circuit-open: run paused. Stages up to activeIdx done, active failed,
      // rest skipped. If activeIdx<0 → cleanup failed.
      const fallbackIdx = activeIdx < 0 ? STAGE_ORDER.length - 1 : activeIdx;
      if (idx < fallbackIdx) s = 'done';
      else if (idx === fallbackIdx) {
        s = 'failed';
        subtitle = status.errorMessage ?? 'Circuit-Breaker offen';
      } else s = 'skipped';
    } else if (activeIdx < 0) {
      // Phase unknown → everything pending
      s = 'pending';
    } else if (idx < activeIdx) {
      s = 'done';
    } else if (idx === activeIdx) {
      if (isFailed) {
        s = 'failed';
        subtitle = status.errorMessage ?? 'fehlgeschlagen';
      } else {
        s = 'running';
        if (elapsed !== undefined) etaBucket = bucketForElapsed(elapsed);
        // Per-stage progressPct
        if (stage.phase === 'embed') {
          progressPct = pct(embeddedCount, totalChunks);
          if (progressPct !== undefined && totalChunks) {
            subtitle = `${embeddedCount ?? 0}/${totalChunks} Chunks`;
          }
        } else if (stage.phase === 'persist') {
          progressPct = pct(persistedCount, totalChunks);
          if (progressPct !== undefined && totalChunks) {
            subtitle = `${persistedCount ?? 0}/${totalChunks} Chunks`;
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
