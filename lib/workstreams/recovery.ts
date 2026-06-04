/**
 * Self-Healing Workstream Recovery Sweep (2026-05-25).
 *
 * Problem: Nach einem Service-Restart (oder einem Agent-Crash) bleiben
 * Workstreams ewig in `active` oder `paused` hängen — der In-Memory-
 * inFlight-Zustand des Agent-Servers ist weg, die DB-Row sagt trotzdem
 * „läuft". Der User sieht 2.5 Stunden lang nichts passieren.
 *
 * Fix: `sweepStaleWorkstreams` läuft periodisch (alle 3 min) und
 * terminalisiert orphaned Runs konservativ zu `stuck`:
 *
 *   1. SELECT active/paused WHERE updated_at < now - STALE_MS.
 *   2. Pro Run (isoliert, try/catch): → status='stuck', Decision-Row
 *      (N8, decisionKind='orphan_detected'), Status-Card, Push-Notification
 *      (kind='run-stuck' via answer_required-Mechanik).
 *   3. Idempotent: schon-stuck Rows werden nicht erneut angefasst.
 *   4. Bounded: max MAX_PER_TICK Runs pro Sweep-Durchlauf.
 *   5. In-Process-Guard gegen Doppel-Sweep.
 *
 * NIE blind re-spawnen (kein Auto-Exec). Ehrlich stuck + notify ist die
 * Lösung. Der User bekommt eine Notification + Deep-Link um per
 * /api/workstreams/[id]/resume selbst neu zu starten.
 *
 * Prozess-Lokalität: läuft im Next.js-Prozess via instrumentation.ts —
 * DB + broadcast + emitOrUpdateCard sind hier verfügbar.
 *
 * Operating constraints (N6/N8/N10):
 *   N6:  Deterministischer Zeit-Proxy (updated_at) statt LLM-Reasoning.
 *   N8:  Jede Terminalisierung schreibt eine workstream_decisions-Row.
 *   N10: content_hash in der Decision-Row (via writeDecision intern).
 */

import { getDb } from '@/db/client';
import { writeDecision } from '@/lib/workstreams/trace-repo';
import { emitOrUpdateCard } from '@/lib/events/emit-or-update-card';
import { emitAnswerRequired } from '@/lib/push/triggers';

/**
 * Baut den same-origin Resume-Deep-Link. Die URL gehört AUSSCHLIESSLICH in den
 * `href` eines Markdown-Links — nie in den sichtbaren Karten-Text (Apple-Feed-
 * Sauberkeit, 2026-05-30). Kein Secret (nur Workspace- + Workstream-ID).
 */
function resumeHref(workspaceId: string, workstreamId: string): string {
  return `/?workspace=${encodeURIComponent(workspaceId)}&ws=${encodeURIComponent(
    workstreamId,
  )}&action=resume`;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Threshold-Millisekunden: active/paused ohne updated_at-Progress = orphaned.
 * Default 20 min. Überschreibbar via ENV `LAZYOS_WS_STALE_MS`.
 *
 * Wahl (Critic-Fix #1a, 2026-05-25): 12 min war ZU ENG. Eine normale Iterate-
 * Welle (Opus-Lead 4-5min + Roaster 3min + Sniper-Pause + V2-Lead 4min ≈ 11min)
 * bumpt die MASTER-`updated_at` NICHT während der Sub-Spawns — nur die Sub-WS-
 * Rows werden gebumpt. Ein lebendiger Master sah also nach 12 min „stale" aus.
 *
 * 20 min liegt sicher oberhalb einer vollen Welle. Zusätzlich greift der
 * Liveness-Guard (Sub-WS-Activity) in terminateOrphanedRun — der ist die
 * eigentliche Sicherung gegen Fehl-Terminalisierung, der Threshold nur die
 * grobe Vorauswahl.
 */
export const STALE_MS: number = (() => {
  const raw = process.env.LAZYOS_WS_STALE_MS;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 20 * 60_000; // 20 min
})();

/**
 * Liveness-Fenster (Critic-Fix #1b): ein Master gilt als LEBENDIG wenn er
 * mindestens einen aktiven Sub-Workstream hat dessen `updated_at` jünger als
 * dieses Fenster ist. Sub-Spawns (Lead/Roaster/Synthesis) bumpen ihre eigene
 * Row via updateTokenUsage/setSubWorkstreamStatus — solange einer davon recent
 * ist, läuft die Welle noch. 3 min deckt die längste Einzel-Phase (Opus-Lead)
 * mit Reserve ab.
 */
export const SUB_ACTIVITY_WINDOW_MS = 3 * 60_000;

/**
 * Maximale Anzahl Runs die pro Sweep-Tick terminalisiert werden.
 * Schutz gegen "erster Boot nach langer Downtime = 200 stuck Rows gleichzeitig".
 */
export const MAX_PER_TICK = 25;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface RecoverySweepResult {
  /** Anzahl Runs die der Query als potenziell stale zurückgegeben hat. */
  scanned: number;
  /** IDs der Runs die erfolgreich auf stuck gesetzt wurden. */
  terminated: string[];
  /** Runs die beim Terminalisieren einen Fehler geworfen haben (Sweep geht weiter). */
  errors: number;
  /** Timestamp (ms) des Sweep-Starts. */
  sweptAt: number;
  /** true wenn ein anderer Sweep noch lief (→ dieser Durchlauf wurde abgebrochen). */
  skippedDueToConcurrentSweep: boolean;
}

// ---------------------------------------------------------------------------
// In-process concurrency guard
// ---------------------------------------------------------------------------

let sweepInProgress = false;

// ---------------------------------------------------------------------------
// Main sweep function
// ---------------------------------------------------------------------------

/**
 * Scannt active/paused Workstreams die länger als STALE_MS kein updated_at-
 * Update hatten und markiert sie als `stuck` (orphan_detected-Decision +
 * Status-Card + Push-Notification).
 *
 * @param now  Aktueller Timestamp-Proxy. Default: Date.now(). Testbar damit.
 */
export async function sweepStaleWorkstreams(
  now: number = Date.now(),
): Promise<RecoverySweepResult> {
  const sweptAt = now;

  // In-process guard: verhindert doppelten Sweep bei schnellem Interval +
  // langer DB-Latenz. Gibt skipped-Result zurück statt zu blocken.
  if (sweepInProgress) {
    return {
      scanned: 0,
      terminated: [],
      errors: 0,
      sweptAt,
      skippedDueToConcurrentSweep: true,
    };
  }

  sweepInProgress = true;
  try {
    return await runSweep(now, sweptAt);
  } finally {
    sweepInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

interface StaleWorkstreamRow {
  id: string;
  workspace_id: string;
  name: string;
  status: string;
  updated_at: number;
}

async function runSweep(now: number, sweptAt: number): Promise<RecoverySweepResult> {
  const db = getDb();
  const cutoff = now - STALE_MS;

  // SELECT: active oder paused, kein recent updated_at.
  // Bounded: LIMIT MAX_PER_TICK verhindert Sturm beim ersten Boot nach
  // langer Downtime (viele hängende Rows).
  // Schon-stuck Rows explizit ausgeschlossen — Idempotenz.
  const rows = db.$raw
    .prepare(
      `SELECT id, workspace_id, name, status, updated_at
         FROM workstreams
        WHERE status IN ('active', 'paused')
          AND updated_at < ?
        ORDER BY updated_at ASC
        LIMIT ?`,
    )
    .all(cutoff, MAX_PER_TICK) as StaleWorkstreamRow[];

  const scanned = rows.length;
  const terminated: string[] = [];
  let errors = 0;

  for (const row of rows) {
    try {
      const didTerminate = await terminateOrphanedRun(row, now);
      if (didTerminate) terminated.push(row.id);
    } catch (err) {
      // Isolierter Fehler: ein kaputte Row bricht den Sweep NICHT ab.
      errors += 1;
      console.warn(
        '[recovery] sweepStaleWorkstreams: Fehler beim Terminalisieren von',
        row.id,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (terminated.length > 0) {
    console.info(
      `[recovery] Sweep: ${terminated.length} orphaned Workstream(s) auf stuck gesetzt`,
      `(scanned=${scanned}, errors=${errors}, stale>${Math.round(STALE_MS / 60_000)}min)`,
    );
  }

  // Reliability-Sweep 2026-05-30: piggyback der orphaned-flow_runs-Reaper auf
  // den schon-verdrahteten Recovery-Interval (3 min, instrumentation.ts:111).
  // flow_runs sammelt pending/running-Rows die nie terminalisieren wenn der
  // zugehoerige Workstream fehlt oder bereits terminal ist (DB-Befund: 39
  // haengende Rows). Der Reaper ist fail-soft + idempotent + status-geguardet
  // (faengt NIE einen Flow-Run dessen Workstream noch active/paused ist), also
  // sicher hier mitzulaufen ohne eigene Verdrahtung. Non-fatal: ein Fehler im
  // flow_run-Reap darf den Workstream-Sweep-Report nicht kippen.
  try {
    const { reapOrphanedFlowRuns } = await import('@/lib/workstreams/reap-stale');
    reapOrphanedFlowRuns({ now });
  } catch (err) {
    console.warn(
      '[recovery] reapOrphanedFlowRuns (piggyback) fehlgeschlagen (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
  }

  return { scanned, terminated, errors, sweptAt, skippedDueToConcurrentSweep: false };
}

/**
 * Terminalisiert einen einzelnen orphaned Run.
 *
 * Gibt `true` zurück wenn der Run tatsächlich terminalisiert wurde,
 * `false` wenn er lebendig ist ODER ein Concurrent-Update die Race verhindert
 * hat (beides kein Fehler).
 *
 *   0. Liveness-Guard (Critic-Fix #1b): hat der Master einen aktiven Sub-WS
 *      mit recent updated_at → Welle läuft noch → return false (kein stuck).
 *   1. Atomar: UPDATE status='stuck' NUR wenn status noch active/paused ist
 *      (verhindert Race mit Concurrent-Sweep oder echtem Agent-Finish).
 *   2. N8: writeDecision (orphan_detected) — best-effort, non-fatal.
 *   3. Status-Card via emitOrUpdateCard — zeigt „Neu starten?"-Prompt.
 *   4. Push-Notification via emitAnswerRequired (kind='run-stuck').
 *
 * Push feuert NUR beim Übergang active/paused→stuck (changes>0). Ein bereits
 * statisch-stuck Run wird vom SELECT gar nicht erfasst (status IN active/paused)
 * → kein Re-Push (Critic-Verifikation #2).
 */
async function terminateOrphanedRun(
  row: StaleWorkstreamRow,
  now: number,
): Promise<boolean> {
  const db = getDb();
  const staleMinutes = Math.round((now - row.updated_at) / 60_000);
  const prevStatus = row.status;

  // 0. Liveness-Guard: prüfe ob der Master aktive Sub-Workstreams mit recent
  //    Activity hat. Eine Iterate-Welle bumpt während der Sub-Spawns nur die
  //    Sub-WS-Rows (Lead/Roaster/Synthesis) — die Master-Row bleibt statisch.
  //    Treffer → Run ist lebendig → NICHT terminalisieren (kein stuck/Push/Decision).
  const subActivityCutoff = now - SUB_ACTIVITY_WINDOW_MS;
  const liveSub = db.$raw
    .prepare(
      `SELECT 1
         FROM workstreams
        WHERE parent_workstream_id = ?
          AND status = 'active'
          AND updated_at > ?
        LIMIT 1`,
    )
    .get(row.id, subActivityCutoff) as { 1: number } | undefined;

  if (liveSub) {
    // Lebendige Welle — Master-updated_at ist nur deshalb alt weil die
    // Sub-Spawns die eigene Row bumpen, nicht die Master-Row.
    return false;
  }

  // 1. Atomar auf stuck setzen — WHERE-Guard gegen Race.
  //    Wenn kein Row geupdated wird (Result.changes === 0): ein Concurrent-
  //    Sweep oder ein echter Agent hat den Zustand schon geändert → skip.
  const result = db.$raw
    .prepare(
      `UPDATE workstreams
          SET status = 'stuck', updated_at = ?
        WHERE id = ? AND status IN ('active', 'paused')`,
    )
    .run(now, row.id);

  if ((result as { changes?: number }).changes === 0) {
    // Race-Condition: Row wurde zwischen SELECT und UPDATE geändert.
    // Kein Fehler, kein weiterer Schritt nötig.
    return false;
  }

  const rationale =
    `Recovery-Sweep: ${staleMinutes}min ohne updated_at-Fortschritt, ` +
    `Status war '${prevStatus}'. Reason: orphaned-no-progress:${staleMinutes}min. ` +
    `Agent-Server-inFlight ist in-memory — Zeit-Proxy (updated_at) korrekt.`;

  // 2. N8: Decision-Row schreiben (best-effort).
  writeDecision({
    workspaceId: row.workspace_id,
    workstreamId: row.id,
    coordKey: `${row.workspace_id}/${row.id}`,
    decisionKind: 'orphan_detected',
    rationale,
    actor: 'policy',
  });

  // 3. Status-Card: sichtbar im Chat + Workstream-Detail.
  //    Apple-Feed-Sauberkeit (2026-05-30): KEINE rohe URL/IDs im sichtbaren Text.
  //    Der saubere Satz trägt nur den Lauf-Namen; die Resume-URL lebt
  //    ausschliesslich im `href` des Markdown-Links (Label „Neu starten") — der
  //    markdown-mini-Renderer rendert same-origin-Links als saubere Pille und
  //    zeigt NUR das Label, nie die Query. Kein Secret im Content (N8/Privacy).
  const cardContent =
    `Ein Lauf wurde durch einen Neustart pausiert. ` +
    `[Neu starten](${resumeHref(row.workspace_id, row.id)})`;

  try {
    await emitOrUpdateCard({
      coords: {
        workspaceId: row.workspace_id,
        workstreamId: row.id,
        // 'toast' = System-Notification-Card. 'status' ist kein registrierter
        // SurfaceKind — wir nutzen 'toast' für die Recovery-Meldung.
        surfaceKind: 'toast',
      },
      content: cardContent,
      actor: 'system',
    });
  } catch (cardErr) {
    // Non-fatal: wenn die Card nicht emittiert werden kann, ist der stuck-
    // Status trotzdem gesetzt. Push folgt unabhängig.
    console.warn(
      '[recovery] emitOrUpdateCard fehlgeschlagen (non-fatal):',
      row.id,
      cardErr instanceof Error ? cardErr.message : String(cardErr),
    );
  }

  // 4. Push-Notification via answer_required / emitAnswerRequired.
  //    Visibility-Gate greift intern (kein Push wenn Tab sichtbar).
  //    kind='run-stuck' wird von der neuen PUSH_RULES-Rule gefangen.
  emitAnswerRequired({
    workspaceId: row.workspace_id,
    entityId: row.id,
    kind: 'run-stuck',
    preview: `"${row.name.slice(0, 60)}" seit ${staleMinutes}min ohne Fortschritt — gestoppt`,
    url: `/?workspace=${encodeURIComponent(row.workspace_id)}&ws=${encodeURIComponent(row.id)}&action=resume`,
  });

  return true;
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/**
 * Setzt den In-Process-Sweep-Guard zurück. NUR in Tests verwenden.
 */
export function __resetSweepGuardForTests(): void {
  sweepInProgress = false;
}
