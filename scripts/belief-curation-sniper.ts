#!/usr/bin/env tsx
/**
 * Belief-Curation Sniper — periodic ExpeL distillation (E2, Stream A, 2026-05-27).
 *
 * Source: docs/plans/2026-05-27_self-learning-enhancements-plan.md §E2 +
 *         GOAL-lazyos-self-learning-why-engine.
 *
 * Iterates over ALL (non-archived) workspaces and calls, per workspace and
 * fail-soft, `curateWorkspaceBeliefs(raw, workspaceId, {minOutcomes, now})`. That
 * distills from the collected experience pool (P0.1 teaching beliefs +
 * decision_outcomes) generalized, reusable beliefs — one per topic, per ISO week,
 * idempotent (CURATION_MARKER). HERMES pattern "evaluate periodically".
 *
 * How it works (pattern from scripts/cleanup-reasoning-audit.ts +
 * scripts/weekly-reflection-sniper.ts):
 *   - getDb().$raw as the raw handle (curateWorkspaceBeliefs accepts it).
 *   - Fail-soft per workspace: an error in workspace A must not topple B.
 *   - Structured JSON summary on stdout (log aggregation) + a human-readable
 *     line. Default DRY-RUN — `--apply` writes the distilled beliefs.
 *   - tsx-runnable: async IIFE via main().catch(), NO top-level await.
 *   - isMain guard (like cleanup-reasoning-audit.ts): a test import triggers nothing.
 *
 * CLI:
 *   pnpm tsx scripts/belief-curation-sniper.ts            # DRY-RUN (no write)
 *   pnpm tsx scripts/belief-curation-sniper.ts --apply    # writes curation beliefs
 *   pnpm tsx scripts/belief-curation-sniper.ts --apply --min-outcomes=5
 *   pnpm tsx scripts/belief-curation-sniper.ts --workspace=WSP-123  # only one
 *
 * SCHEDULE NOTE (NOT created by this script — deliberately manual):
 *   Weekly, e.g. systemd timer `OnCalendar=Sun 23:00:00` (AFTER the
 *   weekly-reflection-sniper at 22:30, so the distillation picks up the freshest
 *   week). Example unit (not installed):
 *     [Service] Type=oneshot
 *     ExecStart=/usr/bin/pnpm tsx scripts/belief-curation-sniper.ts --apply
 *     [Timer]   OnCalendar=Sun 23:00:00
 *   Since the curation is idempotent (CURATION_MARKER per ISO week + balance),
 *   an accidental double run does no harm.
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

/** Lists the workspace IDs to curate over (non-archived), or exactly the one
 * chosen via --workspace. Raw SELECT (analogous to scripts/discover-workspaces). */
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
  // Work on an in-memory snapshot in DRY-RUN? No — we read for real but write
  // ONLY with --apply. We bypass the write by working inside a transaction in
  // DRY-RUN and rolling it back (no persistence effect, but a realistic
  // distillation preview including the idempotency check).
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
      // Fail-soft per workspace.
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
    // DRY-RUN: run everything in ONE transaction and roll it back afterwards,
    // so no belief is persisted but the preview is realistic.
    const tx = raw.transaction(() => {
      for (const id of workspaceIds) reports.push(curateOne(id));
      // Deliberate rollback via throw — better-sqlite3 rolls the TX back and
      // rethrows the marker error; we catch it below.
      throw new Error("__dry_run_rollback__");
    });
    try {
      tx();
    } catch (err) {
      if (!(err instanceof Error) || err.message !== "__dry_run_rollback__") {
        throw err;
      }
      // expected rollback — reports are already filled (computed in-TX).
    }
  }

  const beliefsWritten = apply
    ? reports.reduce((s, r) => s + r.curatedCount, 0)
    : reports.reduce((s, r) => s + r.curatedCount, 0); // in DRY-RUN: "would write"

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
    // DB boot can start background loops (setInterval). Clean exit so a
    // systemd Type=oneshot terminates (analogous to cleanup-reasoning-audit.ts).
    process.exit(summary.workspaces_failed > 0 ? 1 : 0);
  } catch (err) {
    console.error(
      "[belief-curation-sniper] fatal:",
      err instanceof Error ? err.stack : err,
    );
    process.exit(1);
  }
}

// Only run when invoked directly (not on a test import).
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("belief-curation-sniper.ts");

if (isMain) {
  void main();
}
