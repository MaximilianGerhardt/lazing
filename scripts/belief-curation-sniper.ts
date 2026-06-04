#!/usr/bin/env tsx
/**
 * Belief-Curation Sniper — periodische ExpeL-Distillation (E2, Stream A, 2026-05-27).
 *
 * Quelle: docs/plans/2026-05-27_self-learning-enhancements-plan.md §E2 +
 *         GOAL-lazyos-self-learning-why-engine.
 *
 * Iteriert ALLE (nicht-archivierten) Workspaces und ruft je Workspace fail-soft
 * `curateWorkspaceBeliefs(raw, workspaceId, {minOutcomes, now})` auf. Das destilliert
 * aus dem gesammelten Erfahrungs-Pool (P0.1-Lehr-Beliefs + decision_outcomes)
 * generalisierte, wiederverwendbare Beliefs — eine je Topic, pro ISO-Woche,
 * idempotent (CURATION_MARKER). HERMES-Muster „evaluate periodically".
 *
 * Arbeitsweise (Muster aus scripts/cleanup-reasoning-audit.ts +
 * scripts/weekly-reflection-sniper.ts):
 *   - getDb().$raw als rohes Handle (curateWorkspaceBeliefs nimmt es entgegen).
 *   - Fail-soft je Workspace: ein Fehler bei Workspace A darf B nicht kippen.
 *   - Strukturiertes JSON-Summary auf stdout (Log-Aggregation) + menschenlesbare
 *     Zeile. Default DRY-RUN — `--apply` schreibt die destillierten Beliefs.
 *   - tsx-lauffähig: async IIFE via main().catch(), KEIN top-level await.
 *   - isMain-Guard (wie cleanup-reasoning-audit.ts): Test-Import löst nichts aus.
 *
 * CLI:
 *   pnpm tsx scripts/belief-curation-sniper.ts            # DRY-RUN (kein Write)
 *   pnpm tsx scripts/belief-curation-sniper.ts --apply    # schreibt Curation-Beliefs
 *   pnpm tsx scripts/belief-curation-sniper.ts --apply --min-outcomes=5
 *   pnpm tsx scripts/belief-curation-sniper.ts --workspace=WSP-123  # nur einer
 *
 * SCHEDULE-HINWEIS (NICHT von diesem Script angelegt — bewusst manuell):
 *   Wöchentlich, z.B. systemd-Timer `OnCalendar=Sun 23:00:00` (NACH dem
 *   weekly-reflection-sniper um 22:30, damit die Distillation die frischeste
 *   Woche mitnimmt). Beispiel-Unit (nicht installiert):
 *     [Service] Type=oneshot
 *     ExecStart=/usr/bin/pnpm tsx scripts/belief-curation-sniper.ts --apply
 *     [Timer]   OnCalendar=Sun 23:00:00
 *   Da die Curation idempotent ist (CURATION_MARKER pro ISO-Woche + Bilanz),
 *   richtet ein versehentlicher Doppel-Lauf keinen Schaden an.
 */

import { getDb } from "@/db/client";
import { curateWorkspaceBeliefs, type CurateResult } from "@/lib/reasoning/curate";

interface CliArgs {
  apply: boolean;
  minOutcomes: number | undefined;
  workspace: string | undefined;
}

interface WorkspaceReport {
  workspaceId: string;
  ok: boolean;
  skipped: boolean;
  skipReason: string | null;
  period: string | null;
  outcomeCount: number;
  topicsConsidered: number;
  curatedCount: number;
  error: string | null;
}

interface Summary {
  applied: boolean;
  workspaces_scanned: number;
  workspaces_curated: number;
  workspaces_skipped: number;
  workspaces_failed: number;
  beliefs_written: number;
  reports: WorkspaceReport[];
}

function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = {
    apply: false,
    minOutcomes: undefined,
    workspace: undefined,
  };
  for (const a of argv) {
    if (a === "--apply") {
      out.apply = true;
    } else if (a.startsWith("--min-outcomes=")) {
      const n = Number.parseInt(a.slice("--min-outcomes=".length), 10);
      if (Number.isFinite(n) && n >= 0) out.minOutcomes = n;
    } else if (a.startsWith("--workspace=")) {
      const w = a.slice("--workspace=".length).trim();
      if (w.length > 0) out.workspace = w;
    }
  }
  return out;
}

/** Listet die Workspace-IDs, über die curated wird (nicht-archiviert), bzw. genau
 * den per --workspace gewählten. Rohes SELECT (analog scripts/discover-workspaces). */
function listWorkspaceIds(
  raw: import("better-sqlite3").Database,
  only: string | undefined,
): string[] {
  if (only) {
    const row = raw
      .prepare("SELECT id FROM workspaces WHERE id = ? LIMIT 1")
      .get(only) as { id: string } | undefined;
    return row ? [row.id] : [];
  }
  const rows = raw
    .prepare(
      "SELECT id FROM workspaces WHERE archived = 0 ORDER BY created_at ASC, id ASC",
    )
    .all() as { id: string }[];
  return rows.map((r) => r.id);
}

export async function runCuration(args: CliArgs): Promise<Summary> {
  const db = getDb();
  const raw = db.$raw;
  // Im DRY-RUN auf einem in-memory-Snapshot arbeiten? Nein — wir lesen real,
  // schreiben aber NUR bei --apply. Den Write umgehen wir, indem wir im DRY-RUN
  // in einer Transaktion arbeiten und sie zurückrollen (kein Persistenz-Effekt,
  // aber realistische Distillation-Vorschau inkl. Idempotenz-Check).
  const now = new Date();
  const reports: WorkspaceReport[] = [];

  const apply = args.apply;
  const workspaceIds = listWorkspaceIds(raw, args.workspace);

  const curateOne = (workspaceId: string): WorkspaceReport => {
    try {
      const res: CurateResult = curateWorkspaceBeliefs(raw, workspaceId, {
        minOutcomes: args.minOutcomes,
        now,
      });
      return {
        workspaceId,
        ok: true,
        skipped: res.skipped,
        skipReason: res.skipReason,
        period: res.period,
        outcomeCount: res.outcomeCount,
        topicsConsidered: res.topicsConsidered,
        curatedCount: res.curated.length,
        error: null,
      };
    } catch (err) {
      // Fail-soft je Workspace.
      return {
        workspaceId,
        ok: false,
        skipped: false,
        skipReason: null,
        period: null,
        outcomeCount: 0,
        topicsConsidered: 0,
        curatedCount: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  if (apply) {
    for (const id of workspaceIds) reports.push(curateOne(id));
  } else {
    // DRY-RUN: alles in EINER Transaktion ausführen und danach zurückrollen,
    // damit kein Belief persistiert wird, die Vorschau aber realistisch ist.
    const tx = raw.transaction(() => {
      for (const id of workspaceIds) reports.push(curateOne(id));
      // Bewusster Rollback durch Wurf — better-sqlite3 rollt die TX zurück und
      // wirft den Marker-Error weiter; wir fangen ihn unten ab.
      throw new Error("__dry_run_rollback__");
    });
    try {
      tx();
    } catch (err) {
      if (!(err instanceof Error) || err.message !== "__dry_run_rollback__") {
        throw err;
      }
      // erwarteter Rollback — reports sind bereits befüllt (in-TX berechnet).
    }
  }

  const beliefsWritten = apply
    ? reports.reduce((s, r) => s + r.curatedCount, 0)
    : reports.reduce((s, r) => s + r.curatedCount, 0); // im DRY-RUN: „würde schreiben"

  return {
    applied: apply,
    workspaces_scanned: reports.length,
    workspaces_curated: reports.filter((r) => r.ok && r.curatedCount > 0).length,
    workspaces_skipped: reports.filter((r) => r.ok && r.skipped).length,
    workspaces_failed: reports.filter((r) => !r.ok).length,
    beliefs_written: beliefsWritten,
    reports,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[belief-curation-sniper] start apply=${args.apply} ` +
      `min-outcomes=${args.minOutcomes ?? "default(3)"} ` +
      `workspace=${args.workspace ?? "ALL"}`,
  );

  try {
    const summary = await runCuration(args);
    console.log(JSON.stringify(summary));
    if (args.apply) {
      console.log(
        `[belief-curation-sniper] DONE: ${summary.beliefs_written} Beliefs ` +
          `destilliert über ${summary.workspaces_curated}/${summary.workspaces_scanned} ` +
          `Workspaces (skipped=${summary.workspaces_skipped} failed=${summary.workspaces_failed})`,
      );
    } else {
      console.log(
        `[belief-curation-sniper] DRY-RUN: würde ${summary.beliefs_written} ` +
          `Beliefs destillieren über ${summary.workspaces_curated}/${summary.workspaces_scanned} ` +
          `Workspaces (skipped=${summary.workspaces_skipped} failed=${summary.workspaces_failed}). ` +
          `--apply zum Schreiben.`,
      );
    }
    // DB-Boot kann Hintergrund-Loops starten (setInterval). Sauberer Exit, damit
    // ein systemd Type=oneshot terminiert (analog cleanup-reasoning-audit.ts).
    process.exit(summary.workspaces_failed > 0 ? 1 : 0);
  } catch (err) {
    console.error(
      "[belief-curation-sniper] fatal:",
      err instanceof Error ? err.stack : err,
    );
    process.exit(1);
  }
}

// Nur ausführen wenn direkt aufgerufen (nicht beim Test-Import).
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("belief-curation-sniper.ts");

if (isMain) {
  void main();
}
