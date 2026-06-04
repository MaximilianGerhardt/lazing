/**
 * Next.js Instrumentation Hook — läuft einmalig beim Server-Start im Node-Prozess.
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * Zweck: RAG-Embedder-Pipeline vorladen damit der erste Embed-Call des Users
 * nicht die ~166ms ONNX-Init-Latenz trägt (benchmark: lib/rag/embedder.ts).
 * Non-fatal: schlägt der Warmup fehl (circuit-open / ONNX fehlt / kein Speicher),
 * fährt der Server trotzdem hoch — der Embedder fällt auf seinen eigenen
 * Circuit-Breaker-Pfad zurück.
 *
 * Edge-Runtime wird explizit ausgeschlossen: @huggingface/transformers
 * benötigt Node-APIs (fs, crypto) und läuft NICHT auf V8 Isolates.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Dynamic-Import verhindert dass das ONNX-Paket in Edge-Bundles landet.
    const { warmupEmbedder } = await import('@/lib/rag/embedder');
    void warmupEmbedder();

    // RAG-Auto-Indexer: 30s nach Boot einen Background-Pass starten damit
    // rag_chunks befüllt wird (sonst: retrieve() liefert immer leer).
    // Fire-and-forget — blockiert den Boot NICHT (kein await).
    // Loop-Guard in indexBatch (60s-Debounce + Circuit-Breaker) verhindert
    // Re-Index-Sturm bei Hot-Reload oder schnellen Server-Restarts.
    setTimeout(() => {
      void import('@/lib/rag/auto-indexer')
        .then(({ indexAllWorkspaces }) => indexAllWorkspaces())
        .catch(() => {
          // Non-fatal: RAG-Index-Fehler blockieren nie den Server.
        });
    }, 30_000);

    // Inkrementeller Folge-Pass alle 15 Minuten für neue Chat-Messages.
    // Der 60s-Loop-Guard in indexBatch sorgt dafür dass Workspaces die
    // gerade frisch indiziert wurden übersprungen werden (reasons: ['recursion-debounce-60s']).
    setInterval(() => {
      void import('@/lib/rag/auto-indexer')
        .then(({ indexAllWorkspaces }) => indexAllWorkspaces())
        .catch(() => {
          // Non-fatal.
        });
    }, 15 * 60 * 1000);

    // Cron-Routine-Scheduler: einmalig ~45 s nach Boot (nach dem RAG-Indexer-
    // Start, damit DB-Migrationen abgeschlossen sind) und dann alle 60 s.
    // MUSS im Node-Prozess laufen — resourcePool und broadcast sind
    // In-Memory-Singletons; ein externer HTTP-Timer kann diese nicht adressieren.
    // Fire-and-forget, non-fatal — identisches Muster zum RAG-Auto-Indexer.
    setTimeout(() => {
      void import('@/lib/routines/scheduler-loop')
        .then(({ sweepDueRoutines }) => sweepDueRoutines())
        .catch(() => {
          // Non-fatal: Routine-Sweep-Fehler blockieren nie den Server.
        });
    }, 45_000);

    setInterval(() => {
      void import('@/lib/routines/scheduler-loop')
        .then(({ sweepDueRoutines }) => sweepDueRoutines())
        .catch(() => {
          // Non-fatal.
        });
    }, 60_000);

    // Boot-Resume verwaister Iterate-Runs (Owner-Fix 2026-05-30, Opus 4.8):
    // einmalig ~75s nach Boot — BEWUSST VOR dem Recovery-Sweep (90s), damit ein
    // durch Server-Restart verwaister Iterate-Run (lead→roaster→v2, dessen
    // In-Process-Orchestrierungs-Schleife beim Restart starb) SOFORT sauber
    // FORTGESETZT wird (via bestehendem runIterateResume-Pfad, wenn der
    // Zwischenstand aus dem Event-Log rekonstruierbar ist) — statt 20 min später
    // vom Sweep nur als `stuck` markiert zu werden. Runs ohne rekonstruierbaren
    // Zwischenstand terminalisiert der Boot-Resume deterministisch + sofort auf
    // `stuck` + Notify (kein Schein-Resume). R3-sicher: Liveness-Guard +
    // tmux-Session-Probe + atomarer Claim verhindern blindes Doppel-Spawnen.
    // KEIN setInterval — Boot-once. Fire-and-forget, non-fatal. Ergänzt den
    // 3-min-Recovery-Sweep + 5-min-Reaper, ersetzt sie NICHT.
    setTimeout(() => {
      void import('@/lib/workstreams/resume-orphans')
        .then(({ resumeOrphanedRuns }) => resumeOrphanedRuns())
        .then((result) => {
          if (result.resumed.length > 0 || result.terminated.length > 0) {
            console.log(
              `[boot] resume-orphans: resumed=${result.resumed.length} ` +
                `terminated=${result.terminated.length} alive=${result.aliveSkipped} ` +
                `scanned=${result.scanned} errors=${result.errors}`,
            );
          }
        })
        .catch((err) => {
          // Non-fatal: Boot-Resume-Fehler blockieren nie den Server.
          console.warn(
            '[boot] resume-orphans fehlgeschlagen (non-fatal):',
            err instanceof Error ? err.message : String(err),
          );
        });
    }, 75_000);

    // Self-Healing Workstream-Recovery: einmalig ~90s nach Boot (genau der
    // „Restart hat den Loop orphan't"-Fall — beim Boot werden hängende Runs
    // erkannt + terminalisiert bevor der User sich wundert warum nichts passiert).
    // Danach alle 180 s (3 min) periodisch. Fire-and-forget, non-fatal — gleicher
    // Stil wie sweepDueRoutines. NIE blind re-spawnen, nur stuck+notify (R3-sicher).
    setTimeout(() => {
      void import('@/lib/workstreams/recovery')
        .then(({ sweepStaleWorkstreams }) => sweepStaleWorkstreams())
        .catch(() => {
          // Non-fatal: Recovery-Fehler blockieren nie den Server.
        });
    }, 90_000);

    setInterval(() => {
      void import('@/lib/workstreams/recovery')
        .then(({ sweepStaleWorkstreams }) => sweepStaleWorkstreams())
        .catch(() => {
          // Non-fatal.
        });
    }, 180_000);

    // Stuck-Reaper (Owner-Fix 2026-05-29): terminalisiert ALT-stuck-Rows.
    // Wurzel-Befund: 16 Workstreams hingen auf `stuck`, mehrere 4 Tage alt,
    // alterten NIE aus → /api/activity/live (`status IN active/paused/stuck`)
    // zaehlte sie ewig → Pill blieb dauerhaft an, „0 von 15 alive". Der
    // recovery-Sweep markiert active/paused→stuck, terminalisiert aber NIE
    // weiter. Dieser Reaper ueberfuehrt stuck>6h (und active-ohne-Heartbeat
    // >30min ohne lebendigen Sub-WS) auf den gueltigen Terminal-Status
    // `archived` — N6 (Zeit-Proxy), N8 (Decision-Row pro Reap), kein DELETE.
    //
    // EINMALIG ~150s nach Boot — bewusst NACH dem recovery-Sweep (90s), damit
    // frische Orphans erst auf `stuck` markiert werden (mit Push/Card) und der
    // Reaper nur die wirklich aus-gealterten faengt. Danach alle 5 min.
    // Fire-and-forget, non-fatal — gleicher Stil wie sweepStaleWorkstreams.
    setTimeout(() => {
      void import('@/lib/workstreams/reap-stale')
        .then(({ reapStaleWorkstreams }) => reapStaleWorkstreams())
        .catch(() => {
          // Non-fatal: Reaper-Fehler blockieren nie den Server.
        });
    }, 150_000);

    setInterval(() => {
      void import('@/lib/workstreams/reap-stale')
        .then(({ reapStaleWorkstreams }) => reapStaleWorkstreams())
        .catch(() => {
          // Non-fatal.
        });
    }, 5 * 60 * 1000);

    // W1c — Self-Learning P0 (2026-05-28): Boot-Sweep für orphan
    // lazing/run/* Worktrees + tmux-Sessions (Audit-Befund: „10 geleakte
    // Sessions 20.-25. Mai" — Restart-Korrelation). recoverOrphanedWorktreesAll
    // iteriert über alle primary FS-Roots aus workspace_fs_roots und ruft pro
    // Repo das bestehende recoverOrphanedWorktrees() fail-soft + idempotent.
    //
    // EINMALIG ~120s nach Boot — bewusst NACH den anderen Sweeps damit:
    //   1. DB-Migrationen (workspace_fs_roots) komplett gelaufen sind,
    //   2. der stale-workstream-Sweep (90s) terminale Runs zuerst markiert,
    //   3. wir nicht aktiv laufende neue Runs versehentlich orphan'n.
    //
    // KEIN Setinterval — Boot-once-Sweep, danach laufen discardRunWorktree-
    // Aufrufe pro Plan-Lauf inline (Phase 2 R1 Pattern). Fire-and-forget.
    // Dry-Run-Modus DEFAULT (apply:false) — erst Telemetrie, dann manueller
    // Umschalt-Switch auf apply:true sobald empirisch verifiziert ist, dass
    // nur echte Orphans erfasst werden (nicht-blockierender Phase-In).
    setTimeout(() => {
      void import('@/lib/agents/worktree-manager')
        .then(({ recoverOrphanedWorktreesAll }) =>
          recoverOrphanedWorktreesAll({ apply: false }),
        )
        .then((result) => {
          if (result.scanned > 0) {
            console.log(
              `[boot] worktree-sweep[dry-run]: scanned=${result.scanned} ` +
                `dryRun=${result.dryRun} errors=${result.errors.length}`,
            );
          }
        })
        .catch((err) => {
          console.warn(
            '[boot] worktree-sweep fehlgeschlagen (non-fatal):',
            err instanceof Error ? err.message : String(err),
          );
        });
    }, 120_000);
  }
}
