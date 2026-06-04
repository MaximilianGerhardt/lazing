/**
 * Boot-Resume für verwaiste Iterate-/Plan-/Tier-Runs (Owner-Fix 2026-05-30, Opus 4.8).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * EMPIRISCHES PROBLEM (Owner-Befund, live erlebt):
 *   Owner startete im „website"-Workspace einen Iterate-Build
 *   (lead→roaster-1→roaster-2→lead-v2). MITTEN im Lauf wurde der Next.js-Server
 *   (:4200) neu gestartet (Deploy). Befund:
 *     - Die tmux-Spawns sind detached (server/agents/tmux-spawn.ts:396) und
 *       überleben den Restart als isolierte Sessions.
 *     - ABER die In-Process-Orchestrierungs-Schleife in
 *       server/agents/tier-orchestrator.ts (runIterate / runIterateResume) — die
 *       das `.done`-Flag der tmux-Spawns pollt (tmux-spawn.ts:426) und die Wellen
 *       lead→roaster→v2 advanced — lebt im Next.js-PROZESS. Beim Restart
 *       VERWAIST der Run: niemand pollt mehr, niemand advanced die Welle.
 *     - sweepStaleWorkstreams (recovery.ts, alle 3 min) markiert solche Runs erst
 *       nach ~20 min als `stuck` + Notify. Es gibt KEIN Auto-Resume.
 *
 *   ERWEITERUNG (2026-05-30 PM, Opus 4.8): die Plage trifft NICHT NUR Iterate-Runs.
 *   Der Owner sah nach EINEM Deploy 4 „unterbrochen, neu starten?"-Karten:
 *     - 2× Connector-Onboarding-SOP-Runs (heygen) — angelegt von
 *       lib/connectors/auto-connect.ts:250 (createWorkstream) +
 *       :313 (executePlan).
 *     - 2× Website-/Flow-Runs — angelegt von lib/flow/execute.ts:184
 *       (workstreams-Insert) + lib/flow/compose-and-run.ts:220 (executePlan via
 *       makeDefaultTrigger).
 *   BEIDE sind — anders als Iterate — KEINE event-sourced Tier-Wellen, sondern
 *   gewöhnliche `workstreams`-Runs (status='active') mit persistiertem
 *   `workstream_plan_steps`-Plan, abgearbeitet vom In-Process-`executePlan`
 *   (lib/workstreams/plan-executor.ts). Beim Restart verwaist auch dieser
 *   In-Process-Loop → niemand arbeitet die restlichen pending-Steps ab. Der alte
 *   Boot-Resume kannte aber NUR `loadIterateResumeContext` → für Plan-Runs gab er
 *   immer `ctx=null` zurück und terminalisierte sie (statt sie fortzusetzen).
 *   Diese Erweiterung fügt den PLAN-RUN-Resume-Pfad hinzu (siehe unten).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WIE DER ZWISCHENSTAND REKONSTRUIERT WIRD (der Kern) — je Run-Typ:
 *
 *   (A) ITERATE-RUN (event-sourced).
 *   Der Iterate-Fortschritt ist VOLLSTÄNDIG event-sourced. `loadIterateResumeContext`
 *   (tier-orchestrator.ts:1519) rekonstruiert den Zwischenstand AUSSCHLIESSLICH aus
 *   `events` auf dem `primary_ticket_id`:
 *     - die höchste `iterate-version` (mit Text)  = der zuletzt geschriebene Plan,
 *     - die zugehörigen `iterate-roast`-Outputs    = die Roaster-Findings dazu,
 *     - den originalen User-Prompt + ggf. User-Korrekturen.
 *   done-Flags / tmux-Session-Namen sind NICHT der Zwischenstand — sie sind nur der
 *   gerade laufende Spawn. Der echte Fortschritt steht in der Event-DB und überlebt
 *   jeden Restart.
 *
 *   → Ein Zwischenstand ist GENAU DANN sicher rekonstruierbar, wenn
 *     `loadIterateResumeContext` non-null zurückgibt (mindestens ein
 *     `iterate-version`-Event mit Text existiert). Dann ruft dieser Boot-Resume
 *     den BESTEHENDEN `runIterateResume`-Pfad auf (N4: nicht neu erfinden) — exakt
 *     denselben Pfad wie der user-getriggerte Sniper-Resume
 *     (/api/workstreams/[id]/resume).
 *
 *   (B) PLAN-RUN (Flow-Website ODER Connector-Onboarding-SOP) — step-status-sourced.
 *   Der Fortschritt eines Plan-Runs ist KEIN Event-Strom, sondern der `status`
 *   jedes `workstream_plan_steps`-Rows (plan-repo.ts:226 setPlanStepStatus —
 *   pending→active→done/failed). Genau das ist der rekonstruierbare Zwischenstand:
 *   welche Steps fertig sind und welche noch offen.
 *
 *   → Der BESTEHENDE `executePlan` (plan-executor.ts:472) IST von Natur aus ein
 *     idempotenter Resume-Pfad: er liest den persistierten Step-`status` als
 *     Start-Zustand (plan-executor.ts:630–633 `stepStatuses[id] = step.status ??
 *     'pending'`), behandelt done-Steps in der Ready-Queue als erledigt
 *     (isReady prüft `deps.every(d => stepStatuses[d]==='done')`, :1074) und
 *     spawnt NUR noch die pending-Steps neu. Already-done Steps werden NIE
 *     re-spawnt (R3). Ein Re-Aufruf von `executePlan` setzt den Lauf also exakt
 *     dort fort, wo der Restart ihn verwaiste — N4: kein Re-Invent, kein neuer
 *     Resume-Code. planId + coordKey lesen wir verlustfrei aus den persistierten
 *     root-Steps (jeder trägt plan_id + coord_key, workstream_plan_steps.ts:24/40).
 *
 *   → Ein Plan-Zwischenstand ist GENAU DANN rekonstruierbar, wenn der Workstream
 *     mindestens einen root-Plan-Step (depth=0) hat. Hat er KEINEN (weder
 *     iterate-version NOCH Plan-Steps), gibt es nichts Sicheres fortzusetzen.
 *
 *   GEMEINSAMER FALL — kein Zwischenstand:
 *   Wenn weder (A) noch (B) greift (kein iterate-version-Event UND keine
 *   Plan-Steps — z.B. der Run wurde angelegt, aber der Lead/Compose hat noch
 *   nichts Persistentes geschrieben), terminalisieren wir den Run SOFORT (nicht
 *   erst nach 20 min) sauber auf `stuck` + ehrliche, handlungsleitende Notify
 *   (gleiche Mechanik wie der Recovery-Sweep). KEIN Schein-Resume.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * R3-SICHERHEIT (NIE blind doppelt re-spawnen):
 *   Bevor ein Run als verwaist gilt, wird er auf Lebendigkeit geprüft:
 *     1. Liveness-Guard (wie im Recovery-Sweep): hat der Master einen aktiven
 *        Sub-Workstream mit recent `updated_at` (< SUB_ACTIVITY_WINDOW_MS), läuft
 *        die Welle noch → unangetastet.
 *     2. tmux-Session-Probe: existiert noch eine tmux-Session eines Sub-WS
 *        (`sessionExists`), läuft der Spawn evtl. noch → unangetastet (konservativ).
 *   Idempotenz (zwei Boots hintereinander dürfen nicht doppelt spawnen):
 *     - In-Process-Guard (resumeInProgress) gegen Doppel-Lauf im selben Prozess.
 *     - Atomarer Claim VOR dem Spawn: `UPDATE … SET updated_at=now WHERE id=? AND
 *       status='active' AND updated_at < cutoff`. Schlägt der Claim fehl
 *       (changes=0), hat ein anderer Lauf den Run schon gegriffen → skip. Der
 *       frische `updated_at` nimmt den Run zudem aus dem Orphan-Fenster eines
 *       direkt folgenden zweiten Boots.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * VERHÄLTNIS ZU DEN BESTEHENDEN SWEEPS (additiv, ersetzt nichts):
 *   - sweepStaleWorkstreams (recovery.ts, 3 min) bleibt UNVERÄNDERT — Back-Compat.
 *   - reapStaleWorkstreams (reap-stale.ts, 5 min) bleibt UNVERÄNDERT.
 *   Dieser Boot-Resume läuft EINMALIG beim Boot (kein Interval) und greift VOR
 *   dem Sweep: er versucht echtes Fortsetzen statt nur stuck-Markierung. Runs die
 *   er nicht resumen kann, terminalisiert er sofort — der Sweep würde sie 20 min
 *   später ohnehin auf `stuck` setzen, wir machen es deterministisch + sofort.
 *
 * Operating constraints:
 *   N4:  Wiederverwendung der BESTEHENDEN Resume-Pfade — runIterateResume für
 *        Iterate-Runs, executePlan für Plan-Runs (Flow/SOP-Onboarding). Kein
 *        neuer Resume-Code, keine zweite Execution-Engine.
 *   N6:  Deterministischer Zeit-Proxy (updated_at) + Liveness-Probe, kein LLM.
 *   N8:  Jede Resume-/Terminalisierungs-Entscheidung schreibt eine
 *        workstream_decisions-Row (warum resume vs. terminalisiert; je Pfad eine
 *        eigene Begründung — iterate vs. plan vs. terminalisiert).
 *   N10: content_hash in der Decision-Row (via writeDecision intern).
 *   Kein Secret in Logs/Trace/Notify (nur Name + Minuten + IDs).
 */

import { getDb } from '@/db/client';
import { writeDecision } from '@/lib/workstreams/trace-repo';
import { emitOrUpdateCard } from '@/lib/events/emit-or-update-card';
import { emitAnswerRequired } from '@/lib/push/triggers';
import { SUB_ACTIVITY_WINDOW_MS } from '@/lib/workstreams/recovery';

// ---------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------

/**
 * Orphan-Schwelle: ein `active` Workstream ohne updated_at-Fortschritt seit
 * dieser Zeit ist Resume-Kandidat. Default 4 min — bewusst KÜRZER als das
 * STALE_MS des Recovery-Sweeps (20 min): wir wollen den verwaisten Run beim Boot
 * SOFORT fortsetzen, nicht 20 min warten. 4 min liegt sicher oberhalb der
 * längsten Einzel-Phase (Opus-Lead ~4 min) — der Liveness-Guard + tmux-Probe
 * sichern zusätzlich gegen Fehl-Auswahl eines noch laufenden Runs ab.
 * Überschreibbar via ENV `LAZYOS_WS_ORPHAN_RESUME_MS`.
 */
export const ORPHAN_RESUME_MS: number = (() => {
  const raw = process.env.LAZYOS_WS_ORPHAN_RESUME_MS;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 4 * 60_000; // 4 min
})();

/** Max. Anzahl verwaister Runs die pro Boot-Sweep behandelt werden. */
export const ORPHAN_MAX_PER_BOOT = 25;

// ---------------------------------------------------------------------------
// Ergebnis-Typen
// ---------------------------------------------------------------------------

export type OrphanOutcome =
  | 'resumed' // echter runIterateResume-Pfad aufgerufen (Zwischenstand rekonstruierbar)
  | 'terminated' // sofort sauber auf stuck terminalisiert (kein Zwischenstand)
  | 'alive' // lebendig (Liveness-Guard / tmux) → unangetastet
  | 'claim-lost' // anderer Lauf hat den Run zwischen SELECT und Claim gegriffen
  | 'error'; // isolierter Fehler — Sweep läuft weiter

/** Welcher bestehende Resume-Pfad griff (nur bei outcome='resumed'). */
export type ResumedKind = 'iterate' | 'plan';

export interface OrphanRunResult {
  workstreamId: string;
  workspaceId: string;
  outcome: OrphanOutcome;
  /** Bei 'resumed': über welchen bestehenden Pfad fortgesetzt wurde. */
  resumedKind?: ResumedKind;
  /** Bei 'resumed' (iterate): die Version von der aus fortgesetzt wurde. */
  resumedFromVersion?: number;
  detail?: string;
}

export interface ResumeOrphansResult {
  scanned: number;
  resumed: string[];
  terminated: string[];
  aliveSkipped: number;
  errors: number;
  results: OrphanRunResult[];
  sweptAt: number;
  /** true wenn ein anderer Boot-Sweep noch lief → dieser Lauf wurde abgebrochen. */
  skippedDueToConcurrentSweep: boolean;
}

// ---------------------------------------------------------------------------
// In-Process-Guard
// ---------------------------------------------------------------------------

let resumeInProgress = false;

// ---------------------------------------------------------------------------
// Haupt-Funktion
// ---------------------------------------------------------------------------

interface OrphanCandidateRow {
  id: string;
  workspace_id: string;
  name: string;
  updated_at: number;
}

/**
 * Findet verwaiste (nicht mehr orchestrierte) `active` Runs (Iterate, Flow,
 * SOP-Onboarding) und setzt sie sauber fort — via bestehendem runIterateResume-
 * Pfad (Iterate) bzw. executePlan-Pfad (Plan-Run: Flow/SOP) bei rekonstruier-
 * barem Zwischenstand, sonst sofortige saubere Terminalisierung + Notify.
 *
 * Idempotent, R3-sicher, fail-soft (wirft nie). Beim Boot EINMALIG aufzurufen.
 *
 * @param now Zeitreferenz (Default Date.now()). Testbar.
 */
export async function resumeOrphanedRuns(
  now: number = Date.now(),
): Promise<ResumeOrphansResult> {
  const sweptAt = now;

  if (resumeInProgress) {
    return {
      scanned: 0,
      resumed: [],
      terminated: [],
      aliveSkipped: 0,
      errors: 0,
      results: [],
      sweptAt,
      skippedDueToConcurrentSweep: true,
    };
  }

  resumeInProgress = true;
  try {
    return await runOrphanSweep(now, sweptAt);
  } finally {
    resumeInProgress = false;
  }
}

async function runOrphanSweep(
  now: number,
  sweptAt: number,
): Promise<ResumeOrphansResult> {
  const db = getDb();
  const cutoff = now - ORPHAN_RESUME_MS;

  // Nur `active` Runs sind orchestrierungs-tragend. `paused` Runs warten bewusst
  // auf User-Input (Sniper-Window persistiert über waitForSniperPause, NICHT über
  // den In-Process-Loop in einer Form, die ein Restart bräuchte). `stuck`/`done`/
  // `archived` sind terminal — die fasst der Recovery-Sweep/Reaper an, nicht wir.
  // Bounded via LIMIT (Schutz gegen „erster Boot nach langer Downtime").
  const rows = db.$raw
    .prepare(
      `SELECT id, workspace_id, name, updated_at
         FROM workstreams
        WHERE status = 'active'
          AND updated_at < ?
        ORDER BY updated_at ASC
        LIMIT ?`,
    )
    .all(cutoff, ORPHAN_MAX_PER_BOOT) as OrphanCandidateRow[];

  const results: OrphanRunResult[] = [];
  const resumed: string[] = [];
  const terminated: string[] = [];
  let aliveSkipped = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const res = await handleOrphanRun(row, now, cutoff);
      results.push(res);
      switch (res.outcome) {
        case 'resumed':
          resumed.push(row.id);
          break;
        case 'terminated':
          terminated.push(row.id);
          break;
        case 'alive':
          aliveSkipped += 1;
          break;
        default:
          break; // claim-lost: weder resumed noch terminated, kein Fehler
      }
    } catch (err) {
      errors += 1;
      results.push({
        workstreamId: row.id,
        workspaceId: row.workspace_id,
        outcome: 'error',
        detail: err instanceof Error ? err.message : String(err),
      });
      console.warn(
        '[resume-orphans] Fehler beim Behandeln von',
        row.id,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (resumed.length > 0 || terminated.length > 0) {
    console.info(
      `[resume-orphans] Boot-Sweep: resumed=${resumed.length} terminated=${terminated.length} ` +
        `alive=${aliveSkipped} (scanned=${rows.length}, errors=${errors}, ` +
        `orphan>${Math.round(ORPHAN_RESUME_MS / 60_000)}min)`,
    );
  }

  return {
    scanned: rows.length,
    resumed,
    terminated,
    aliveSkipped,
    errors,
    results,
    sweptAt,
    skippedDueToConcurrentSweep: false,
  };
}

// ---------------------------------------------------------------------------
// Pro-Run-Behandlung
// ---------------------------------------------------------------------------

/**
 * Behandelt einen einzelnen Orphan-Kandidaten:
 *   0. Liveness-Guard (recent aktiver Sub-WS) → 'alive', unangetastet.
 *   1. tmux-Session-Probe (existiert noch ein Sub-WS-tmux) → 'alive', unangetastet.
 *   2. Atomarer Claim → bei changes=0 → 'claim-lost' (anderer Lauf war schneller).
 *   3. Run-Typ-Klassifikation + bester bestehender Resume-Pfad (in dieser Reihenfolge):
 *      a) ITERATE: loadIterateResumeContext non-null → N8-Decision (resume) +
 *         runIterateResume (bestehender Pfad) → 'resumed' (kind=iterate).
 *      b) PLAN (Flow/SOP-Onboarding): root-Plan-Steps existieren → N8-Decision +
 *         executePlan (bestehender, idempotenter Resume-Pfad — done-Steps bleiben
 *         done, nur pending re-spawnt) → 'resumed' (kind=plan). Best-effort flippt
 *         ein etwaiger flow_runs-Row zurück auf 'running' (UI-Konsistenz).
 *      c) WEDER NOCH: sofortige saubere Terminalisierung auf 'stuck' + N8-Decision
 *         + Card + Push → 'terminated' (kein Schein-Resume).
 */
async function handleOrphanRun(
  row: OrphanCandidateRow,
  now: number,
  cutoff: number,
): Promise<OrphanRunResult> {
  const db = getDb();
  const staleMinutes = Math.round((now - row.updated_at) / 60_000);

  // 0. Liveness-Guard — identisch zum Recovery-Sweep: ein aktiver Sub-WS mit
  //    recent updated_at bedeutet, die Welle läuft noch (Master-updated_at ist
  //    nur deshalb alt, weil Sub-Spawns die eigene Row bumpen, nicht die Master).
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
    return {
      workstreamId: row.id,
      workspaceId: row.workspace_id,
      outcome: 'alive',
      detail: 'recent-active-sub-workstream',
    };
  }

  // 1. tmux-Session-Probe (konservativ, R3): existiert noch eine tmux-Session
  //    eines Sub-WS dieses Masters, läuft evtl. noch ein Spawn → unangetastet.
  //    (Polling läuft zwar nicht mehr — aber wir re-spawnen NIE blind solange
  //    irgendetwas am Run noch tmux-lebendig ist.)
  const hasLiveTmux = await anySubWorkstreamTmuxAlive(row.id);
  if (hasLiveTmux) {
    return {
      workstreamId: row.id,
      workspaceId: row.workspace_id,
      outcome: 'alive',
      detail: 'live-tmux-session',
    };
  }

  // 2. Atomarer Claim: nimmt den Run aus dem Orphan-Fenster, BEVOR wir spawnen.
  //    WHERE-Guard auf status='active' AND updated_at < cutoff stellt sicher,
  //    dass ein zweiter (paralleler oder direkt folgender) Boot-Sweep denselben
  //    Run nicht ebenfalls greift — bei changes=0 hat ein anderer Lauf gewonnen.
  const claim = db.$raw
    .prepare(
      `UPDATE workstreams
          SET updated_at = ?
        WHERE id = ? AND status = 'active' AND updated_at < ?`,
    )
    .run(now, row.id, cutoff) as { changes?: number };

  if ((claim.changes ?? 0) === 0) {
    return {
      workstreamId: row.id,
      workspaceId: row.workspace_id,
      outcome: 'claim-lost',
      detail: 'concurrent-claim-or-status-change',
    };
  }

  // 3. Zwischenstand rekonstruierbar?
  const { loadIterateResumeContext, runIterateResume } = await import(
    '@/server/agents/tier-orchestrator'
  );
  const ctx = await loadIterateResumeContext(row.id);

  if (ctx) {
    // ── Echtes Resume via bestehendem Pfad (N4) ──────────────────────────────
    // N8: Decision-Row VOR dem Spawn — ehrliche Begründung (warum resume).
    const rationale =
      `Boot-Resume: Server-Restart hat die In-Process-Orchestrierung verwaist ` +
      `(${staleMinutes}min ohne updated_at-Fortschritt, kein lebendiger Sub-WS/tmux). ` +
      `Zwischenstand rekonstruierbar aus Event-Log (letzte iterate-version=V${ctx.lastVersion}, ` +
      `${ctx.roastTexts.length} Roast-Output(s)). Fortsetzung via bestehendem ` +
      `runIterateResume-Pfad (V${ctx.lastVersion}→V${ctx.lastVersion + 1}). N4/N6/N8.`;
    writeDecision({
      workspaceId: row.workspace_id,
      workstreamId: row.id,
      coordKey: `${row.workspace_id}/${row.id}`,
      decisionKind: 'orphan_detected',
      rationale,
      actor: 'policy',
    });

    // runIterateResume setzt selbst status='active', emittiert iterate-resumed,
    // spawnt die nächste Welle und terminalisiert bei Konvergenz/Cap auf 'done'.
    // Wir awaiten NICHT die ganze Welle (kann 1-3 min dauern) — fire-and-track,
    // damit der Boot-Sweep alle Orphans zügig durchgeht. Fehler im Resume sind
    // nicht-fatal für den Sweep (eigenes catch).
    void runIterateResume(row.id).catch((err: unknown) => {
      console.warn(
        '[resume-orphans] runIterateResume fehlgeschlagen (non-fatal):',
        row.id,
        err instanceof Error ? err.message : String(err),
      );
    });

    return {
      workstreamId: row.id,
      workspaceId: row.workspace_id,
      outcome: 'resumed',
      resumedKind: 'iterate',
      resumedFromVersion: ctx.lastVersion,
      detail: `resume V${ctx.lastVersion}→V${ctx.lastVersion + 1}`,
    };
  }

  // ── Kein Iterate-Zwischenstand → PLAN-RUN-Pfad probieren (Flow / SOP) ───────
  // Flow-Website- und Connector-Onboarding-SOP-Runs sind gewöhnliche
  // workstreams-Runs mit persistiertem workstream_plan_steps-Plan. Ihr
  // Zwischenstand ist der Step-`status`. Hat der Run root-Plan-Steps, setzen wir
  // ihn über den BESTEHENDEN, idempotenten executePlan fort (N4).
  const planResume = await resumePlanRunIfPlanSteps(row, staleMinutes);
  if (planResume) {
    return planResume;
  }

  // ── Kein rekonstruierbarer Zwischenstand (weder iterate noch plan) → sofort ─
  // sauber terminalisieren. Der Lead/Compose hat noch nichts Persistentes
  // geschrieben (kein iterate-version-Event, keine Plan-Steps) — es gibt nichts
  // Sicheres fortzusetzen. Statt Schein-Resume: deterministisch + SOFORT (nicht
  // erst nach 20 min) auf 'stuck' + ehrliche, handlungsleitende Notify.
  await terminateUnresumableRun(row, now, staleMinutes);
  return {
    workstreamId: row.id,
    workspaceId: row.workspace_id,
    outcome: 'terminated',
    detail: 'no-reconstructible-intermediate-state',
  };
}

/**
 * PLAN-RUN-Resume (Flow-Website ODER Connector-Onboarding-SOP).
 *
 * Beide Run-Typen sind gewöhnliche `workstreams`-Runs mit persistiertem
 * `workstream_plan_steps`-Plan (depth=0), abgearbeitet vom In-Process-
 * `executePlan` — der beim Restart verwaist. Der Zwischenstand ist der
 * Step-`status` (pending/active/done/failed) jeder Step-Row.
 *
 * Rekonstruierbar ⇔ es existiert mindestens ein root-Plan-Step. Dann:
 *   - planId + coordKey verlustfrei aus den persistierten root-Steps lesen
 *     (jeder Step trägt beide Felder — workstream_plan_steps.ts:24/40). Kein
 *     erratenes Coord-Format: wir nehmen exakt das persistierte coord_key.
 *   - 'active'-Steps (Restart erwischte sie mitten im Spawn) auf 'pending'
 *     zurücksetzen, damit executePlan sie sicher neu fährt. 'done' bleibt 'done'
 *     (wird NIE re-spawnt — R3), 'failed' bleibt 'failed' (fehler-isoliert).
 *   - executePlan(workstreamId, workspaceId, planId, coordKey) fire-and-track —
 *     der bestehende, idempotente Resume-Pfad (N4). done-Steps werden als
 *     erledigt erkannt, nur pending-Steps neu gespawnt.
 *   - Best-effort: einen etwaigen flow_runs-Row dieses Workstreams zurück auf
 *     'running' flippen (UI-Konsistenz; ein SOP-Onboarding-Run hat keinen
 *     flow_runs-Row → no-op via WHERE).
 *
 * Liefert das resume-OrphanRunResult, ODER null, wenn der Run KEINE Plan-Steps
 * hat (dann fällt der Caller auf Terminalisierung zurück).
 *
 * WICHTIG (R3/Idempotenz): der atomare Claim (handleOrphanRun Schritt 2) hat den
 * Run bereits aus dem Orphan-Fenster genommen, BEVOR diese Funktion läuft — ein
 * zweiter Boot-Sweep greift denselben Run nicht erneut. executePlan selbst
 * re-spawnt keine done-Steps.
 */
async function resumePlanRunIfPlanSteps(
  row: OrphanCandidateRow,
  staleMinutes: number,
): Promise<OrphanRunResult | null> {
  const { listRootPlanSteps } = await import('@/lib/workstreams/plan-repo');
  const rootSteps = listRootPlanSteps(row.id);
  if (rootSteps.length === 0) {
    return null; // kein Plan-Zwischenstand → Caller terminalisiert
  }

  // planId + coordKey aus den persistierten Steps (verlustfrei, kein Raten).
  const planId = rootSteps[0]!.planId;
  const coordKey = rootSteps[0]!.coordKey;

  // Step-Status-Verteilung für die ehrliche Decision-Begründung (kein Secret —
  // nur Zähler). 'active'-Steps verwaisten mitten im Spawn → auf 'pending'
  // zurücksetzen, damit executePlan sie deterministisch neu fährt.
  let doneCount = 0;
  let failedCount = 0;
  let pendingCount = 0;
  let resetActive = 0;
  const { setPlanStepStatus } = await import('@/lib/workstreams/plan-repo');
  for (const s of rootSteps) {
    switch (s.status) {
      case 'done':
        doneCount += 1;
        break;
      case 'failed':
        failedCount += 1;
        break;
      case 'active': {
        // Verwaister in-flight Step → zurück auf pending (re-fahrbar). Best-effort.
        try {
          setPlanStepStatus(s.id, 'pending');
          resetActive += 1;
        } catch {
          /* non-fatal: executePlan behandelt active ohnehin nicht als done */
        }
        pendingCount += 1;
        break;
      }
      default:
        pendingCount += 1;
        break;
    }
  }

  // N8: Decision VOR dem Resume — ehrliche Begründung (warum plan-resume).
  const rationale =
    `Boot-Resume: Server-Restart hat den In-Process-Plan-Executor verwaist ` +
    `(${staleMinutes}min ohne updated_at-Fortschritt, kein lebendiger Sub-WS/tmux). ` +
    `Plan-Run (Flow/SOP-Onboarding) — Zwischenstand aus workstream_plan_steps: ` +
    `${rootSteps.length} root-Steps (done=${doneCount}, failed=${failedCount}, ` +
    `pending=${pendingCount}, davon ${resetActive} verwaiste 'active'→'pending' ` +
    `zurückgesetzt). Fortsetzung via bestehendem executePlan (idempotent: done ` +
    `bleibt done, nur pending re-spawnt). N4/N6/N8.`;
  writeDecision({
    workspaceId: row.workspace_id,
    workstreamId: row.id,
    coordKey,
    decisionKind: 'orphan_detected',
    rationale,
    actor: 'policy',
  });

  // Best-effort: flow_runs-Row (falls vorhanden) zurück auf 'running'. Ein
  // SOP-Onboarding-Run hat keinen → WHERE matcht nichts → no-op. Fail-soft.
  reviveFlowRunStatus(row.id);

  // Resume via bestehendem Pfad. Fire-and-track (kann Minuten dauern) — Fehler
  // sind non-fatal für den Sweep (eigenes catch), damit alle Orphans durchgehen.
  const { executePlan } = await import('@/lib/workstreams/plan-executor');
  void executePlan({
    workstreamId: row.id,
    workspaceId: row.workspace_id,
    planId,
    coordKey,
  }).catch((err: unknown) => {
    console.warn(
      '[resume-orphans] executePlan (plan-resume) fehlgeschlagen (non-fatal):',
      row.id,
      err instanceof Error ? err.message : String(err),
    );
  });

  return {
    workstreamId: row.id,
    workspaceId: row.workspace_id,
    outcome: 'resumed',
    resumedKind: 'plan',
    detail: `plan-resume ${rootSteps.length} steps (done=${doneCount}, pending=${pendingCount})`,
  };
}

/**
 * Setzt einen etwaigen flow_runs-Row dieses Workstreams zurück auf 'running'
 * (best-effort, fail-soft). Direkter raw-UPDATE über das schon-vorhandene
 * db.$raw-Handle — kein Import des gesperrten Flow-Persistence-Moduls nötig.
 * WHERE-Guard auf workstream_id: ein SOP-Onboarding-Run (kein flow_runs-Row) →
 * changes=0 → harmloser no-op. Nur 'pending'/'failed'/'cancelled' werden auf
 * 'running' gehoben — ein bereits 'done' Flow-Run bleibt done (kein Re-Open).
 */
function reviveFlowRunStatus(workstreamId: string): void {
  try {
    const db = getDb();
    db.$raw
      .prepare(
        `UPDATE flow_runs
            SET status = 'running', updated_at = ?
          WHERE workstream_id = ?
            AND status IN ('pending', 'failed', 'cancelled')`,
      )
      .run(Date.now(), workstreamId);
  } catch {
    // flow_runs-Tabelle fehlt / DB-Fehler → non-fatal (SOP-Run braucht es nicht).
  }
}

/**
 * Prüft, ob irgendein Sub-Workstream des Masters noch eine lebendige tmux-Session
 * hat. Fail-soft: bei jedem Fehler (DB / tmux nicht verfügbar) → false (kein
 * False-Positive-„alive", das echtes Resume blockieren würde).
 */
async function anySubWorkstreamTmuxAlive(masterWorkstreamId: string): Promise<boolean> {
  const db = getDb();
  let sessionNames: string[] = [];
  try {
    const rows = db.$raw
      .prepare(
        `SELECT tmux_session_id
           FROM workstreams
          WHERE parent_workstream_id = ?
            AND tmux_session_id IS NOT NULL
            AND tmux_session_id != ''`,
      )
      .all(masterWorkstreamId) as Array<{ tmux_session_id: string | null }>;
    sessionNames = rows
      .map((r) => r.tmux_session_id)
      .filter((s): s is string => typeof s === 'string' && s.length > 0);
  } catch {
    return false;
  }
  if (sessionNames.length === 0) return false;

  try {
    const { sessionExists } = await import('@/server/tmux-controller');
    for (const name of sessionNames) {
      // sessionExists ist selbst try/catch-gewrappt + assertSafeSessionName.
      // Bei einem unsicheren/kaputten Namen wirft assertSafeSessionName → wir
      // werten das als „nicht lebendig" (kein Block), nicht als Fehler.
      try {
        if (await sessionExists(name)) return true;
      } catch {
        /* unsafe/kaputter Session-Name → nicht als lebendig werten */
      }
    }
  } catch {
    // tmux-controller nicht importierbar (z.B. Edge) → fail-soft.
    return false;
  }
  return false;
}

/**
 * Terminalisiert einen verwaisten Run OHNE rekonstruierbaren Zwischenstand sofort
 * sauber auf `stuck` + N8-Decision + Status-Card + Push. Spiegelt bewusst die
 * Notify-Mechanik des Recovery-Sweeps (terminateOrphanedRun), damit der User
 * dieselbe „Neu starten?"-Affordanz bekommt — nur sofort statt nach 20 min.
 *
 * Atomarer Status-Guard (active→stuck): kein Re-Push bei Race.
 */
async function terminateUnresumableRun(
  row: OrphanCandidateRow,
  now: number,
  staleMinutes: number,
): Promise<void> {
  const db = getDb();

  const result = db.$raw
    .prepare(
      `UPDATE workstreams
          SET status = 'stuck', updated_at = ?
        WHERE id = ? AND status = 'active'`,
    )
    .run(now, row.id) as { changes?: number };

  if ((result.changes ?? 0) === 0) {
    // Race: ein echter Agent-Finish o.Ä. hat den Status schon geändert.
    return;
  }

  const rationale =
    `Boot-Resume: Server-Restart hat die In-Process-Orchestrierung verwaist ` +
    `(${staleMinutes}min ohne Fortschritt, kein lebendiger Sub-WS/tmux). ` +
    `KEIN rekonstruierbarer Zwischenstand im Event-Log (noch keine iterate-version ` +
    `geschrieben) → kein Schein-Resume. Sofort sauber auf 'stuck' terminalisiert ` +
    `(deterministisch + sofort statt 20min-Sweep). Reason: ` +
    `orphan-no-intermediate-state:${staleMinutes}min. N4/N6/N8.`;

  // N8: Decision-Row (best-effort).
  writeDecision({
    workspaceId: row.workspace_id,
    workstreamId: row.id,
    coordKey: `${row.workspace_id}/${row.id}`,
    decisionKind: 'orphan_detected',
    rationale,
    actor: 'policy',
  });

  // Status-Card (Deep-Link „Neu starten") — Apple-Feed-Sauberkeit (2026-05-30):
  // KEINE rohe URL/IDs im sichtbaren Text. Sauberer Satz + Resume-URL nur im
  // `href` des Markdown-Links (Label „Neu starten"). Kein Secret im Content.
  const cardContent =
    `Ein Lauf wurde durch einen Neustart pausiert. ` +
    `[Neu starten](/?workspace=${encodeURIComponent(row.workspace_id)}&ws=${encodeURIComponent(
      row.id,
    )}&action=resume)`;
  try {
    await emitOrUpdateCard({
      coords: {
        workspaceId: row.workspace_id,
        workstreamId: row.id,
        surfaceKind: 'toast',
      },
      content: cardContent,
      actor: 'system',
    });
  } catch (cardErr) {
    console.warn(
      '[resume-orphans] emitOrUpdateCard fehlgeschlagen (non-fatal):',
      row.id,
      cardErr instanceof Error ? cardErr.message : String(cardErr),
    );
  }

  // Push (kind='run-stuck') — Visibility-Gate greift intern. Kein Secret.
  emitAnswerRequired({
    workspaceId: row.workspace_id,
    entityId: row.id,
    kind: 'run-stuck',
    preview: `"${row.name.slice(0, 50)}" durch Neustart unterbrochen — neu starten`,
    url: `/?workspace=${encodeURIComponent(row.workspace_id)}&ws=${encodeURIComponent(row.id)}&action=resume`,
  });
}

// ---------------------------------------------------------------------------
// Test-Helper
// ---------------------------------------------------------------------------

/** Setzt den In-Process-Guard zurück. NUR in Tests verwenden. */
export function __resetResumeGuardForTests(): void {
  resumeInProgress = false;
}
