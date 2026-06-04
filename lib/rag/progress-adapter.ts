/**
 * RAG-Index-Run → StageDescriptor[]-Adapter (Sub-Plan 5 Welle 2, 2026-05-01).
 *
 * Stages:
 *   1. discover-sources — Files/Chats sammeln
 *   2. chunk            — Text in Chunks splitten
 *   3. embed            — Embeddings rechnen (lokal, Xenova)
 *   4. persist          — Chunks in rag_chunks INSERTen
 *   5. cleanup          — IndexerState aktualisieren, Circuit-Breaker checken
 *
 * Input ist `RagRunStatus` — wird von `/api/rag/index/[runId]/status`
 * geliefert. Da der Indexer nicht run-basiert ist (sondern stateful per
 * workspace+sourceType), simulieren wir "Runs" als Pseudo-IDs:
 * `runId = ${workspaceId}::${sourceType}` oder `${workspaceId}::all`.
 *
 * Mapping:
 *   - phase: discover/chunk/embed/persist/cleanup → entsprechende Stage running
 *   - phase=done → alle done
 *   - phase=failed → aktuelle Stage failed, vorherige done, nachfolgende skipped
 *   - phase=circuit-open → cleanup skipped, Hauptstage failed mit Subtitle
 *
 * Progress:
 *   - embed-Stage bekommt progressPct = (embedded / totalChunks) * 100
 *     (nur wenn totalChunks > 0)
 *   - persist-Stage bekommt progressPct = (persisted / totalChunks) * 100
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
  /** Pseudo-Run-Identifikator für UI-Routing. */
  runId: string;
  phase: RagPhase;
  /** Geschätzte Gesamt-Chunk-Anzahl (nach discover). */
  totalChunks?: number;
  /** Bisher embedded. */
  embeddedCount?: number;
  /** Bisher persisted. */
  persistedCount?: number;
  /** Letzte Aktivität als ms-epoch — für eta-Bucket der active Stage. */
  lastUpdateMs?: number;
  /** Now-override für tests. */
  nowMs?: number;
  /** Optional: Fehler-Message wenn phase='failed' oder 'circuit-open'. */
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

  // Idx der aktiven Stage in STAGE_ORDER
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
      // Generischer Fail ohne Phase — letzte Stage failed, Rest skipped
      s = idx === STAGE_ORDER.length - 1 ? 'failed' : 'skipped';
      if (idx === STAGE_ORDER.length - 1) subtitle = status.errorMessage ?? 'fehlgeschlagen';
    } else if (isCircuitOpen) {
      // Circuit-Open: Run pausiert. Stages bis activeIdx done, active failed,
      // Rest skipped. Wenn activeIdx<0 → cleanup failed.
      const fallbackIdx = activeIdx < 0 ? STAGE_ORDER.length - 1 : activeIdx;
      if (idx < fallbackIdx) s = 'done';
      else if (idx === fallbackIdx) {
        s = 'failed';
        subtitle = status.errorMessage ?? 'Circuit-Breaker offen';
      } else s = 'skipped';
    } else if (activeIdx < 0) {
      // Phase unbekannt → alles pending
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
        // Per-Stage progressPct
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
