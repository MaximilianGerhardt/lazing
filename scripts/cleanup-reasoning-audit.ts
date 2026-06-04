#!/usr/bin/env tsx
/**
 * Cleanup cron for reasoning audit (Pattern 5 wave 4, 2026-05-01).
 *
 * Deletes old audit rows that are no longer forensically relevant:
 *   - older than --max-age-days (default 90)
 *   - verified_status IN ('ok', NULL)
 *   - parent_ticket_id refers to a 'closed' event (ticket finished)
 *
 * ALWAYS keep (forensics obligation):
 *   - verified_status = 'drift'      → permanent evidence trail
 *   - verified_status = 'fabricated'  → hallucination forensics
 *   - parent_ticket_id NULL OR ticket not in 'closed' events
 *
 * Tickets are event-sourced (no `tickets` table). The 'closed' status
 * derives from `events WHERE entity_type='ticket' AND event_type='closed'`.
 *
 * Invocation:
 *   pnpm tsx scripts/cleanup-reasoning-audit.ts --dry-run
 *   pnpm tsx scripts/cleanup-reasoning-audit.ts --max-age-days=180
 *   pnpm tsx scripts/cleanup-reasoning-audit.ts --keep-flagged
 *
 * Single-pass: no loop. Triggered via systemd timer weekly on Sunday 04:00 UTC.
 *
 * Output: structured JSON summary on stdout (for log aggregation).
 */

import { getDb } from "@/db/client";

interface CliArgs {
  maxAgeDays: number;
  dryRun: boolean;
  keepFlagged: boolean;
}

interface Summary {
  deleted: number;
  kept_drift: number;
  kept_fabricated: number;
  kept_recent: number;
  kept_open_ticket: number;
  kept_no_ticket: number;
  total_before: number;
  total_after: number;
  cutoff_ms: number;
  dry_run: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = {
    maxAgeDays: 90,
    dryRun: false,
    keepFlagged: false,
  };
  for (const raw of argv) {
    if (raw.startsWith("--max-age-days=")) {
      const n = Number.parseInt(raw.slice("--max-age-days=".length), 10);
      if (Number.isFinite(n) && n > 0) out.maxAgeDays = n;
    } else if (raw === "--dry-run") {
      out.dryRun = true;
    } else if (raw === "--keep-flagged") {
      // no-op: drift/fabricated are ALWAYS kept. The flag exists
      // only for explicit documentation in cron invocations.
      out.keepFlagged = true;
    }
  }
  return out;
}

export async function runCleanup(args: CliArgs): Promise<Summary> {
  const db = getDb();
  const raw = db.$raw;
  const cutoffMs = Date.now() - args.maxAgeDays * 86_400_000;

  // Total-before for telemetry.
  const totalBefore = (
    raw.prepare("SELECT COUNT(*) AS c FROM reasoning_audit").get() as {
      c: number;
    }
  ).c;

  // Subquery: which parent_ticket_ids are 'closed'?
  // Tickets are event-sourced. `events.event_type='closed' AND
  // entity_type='ticket'` marks done.
  const closedTicketSubquery = `
    SELECT entity_id FROM events
    WHERE entity_type = 'ticket' AND event_type = 'closed'
  `;

  // Diagnostic counts before DELETE — we want to know WHY rows are kept
  // (forensic audit of the cleanup logic itself).
  const driftRow = raw
    .prepare(
      `SELECT COUNT(*) AS c FROM reasoning_audit
       WHERE verified_status = 'drift'`,
    )
    .get() as { c: number };
  const fabricatedRow = raw
    .prepare(
      `SELECT COUNT(*) AS c FROM reasoning_audit
       WHERE verified_status = 'fabricated'`,
    )
    .get() as { c: number };

  // Candidates that would fall into the DELETE filter but are saved
  // because parent_ticket_id is NULL OR not in closed tickets.
  // We count them for telemetry — they are NOT deleted.
  const recentRow = raw
    .prepare(
      `SELECT COUNT(*) AS c FROM reasoning_audit
       WHERE ts >= ?
         AND (verified_status IS NULL OR verified_status = 'ok')`,
    )
    .get(cutoffMs) as { c: number };

  const noTicketRow = raw
    .prepare(
      `SELECT COUNT(*) AS c FROM reasoning_audit
       WHERE ts < ?
         AND (verified_status IS NULL OR verified_status = 'ok')
         AND parent_ticket_id IS NULL`,
    )
    .get(cutoffMs) as { c: number };

  const openTicketRow = raw
    .prepare(
      `SELECT COUNT(*) AS c FROM reasoning_audit
       WHERE ts < ?
         AND (verified_status IS NULL OR verified_status = 'ok')
         AND parent_ticket_id IS NOT NULL
         AND parent_ticket_id NOT IN (${closedTicketSubquery})`,
    )
    .get(cutoffMs) as { c: number };

  // Count delete candidates.
  const deleteCandidatesRow = raw
    .prepare(
      `SELECT COUNT(*) AS c FROM reasoning_audit
       WHERE ts < ?
         AND (verified_status IS NULL OR verified_status = 'ok')
         AND parent_ticket_id IS NOT NULL
         AND parent_ticket_id IN (${closedTicketSubquery})`,
    )
    .get(cutoffMs) as { c: number };

  let deleted = 0;
  if (!args.dryRun && deleteCandidatesRow.c > 0) {
    const deleteStmt = raw.prepare(
      `DELETE FROM reasoning_audit
       WHERE ts < ?
         AND (verified_status IS NULL OR verified_status = 'ok')
         AND parent_ticket_id IS NOT NULL
         AND parent_ticket_id IN (${closedTicketSubquery})`,
    );
    const result = deleteStmt.run(cutoffMs);
    deleted = Number(result.changes);
  } else {
    deleted = args.dryRun ? 0 : 0;
  }

  const totalAfter = (
    raw.prepare("SELECT COUNT(*) AS c FROM reasoning_audit").get() as {
      c: number;
    }
  ).c;

  return {
    deleted: args.dryRun ? deleteCandidatesRow.c : deleted,
    kept_drift: driftRow.c,
    kept_fabricated: fabricatedRow.c,
    kept_recent: recentRow.c,
    kept_open_ticket: openTicketRow.c,
    kept_no_ticket: noTicketRow.c,
    total_before: totalBefore,
    total_after: totalAfter,
    cutoff_ms: cutoffMs,
    dry_run: args.dryRun,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.keepFlagged) {
    console.log(
      "[cleanup-reasoning-audit] --keep-flagged set (drift/fabricated " +
        "werden immer behalten — Flag dokumentiert nur Intent)",
    );
  }
  console.log(
    `[cleanup-reasoning-audit] start max-age-days=${args.maxAgeDays} ` +
      `dry-run=${args.dryRun}`,
  );

  try {
    const summary = await runCleanup(args);
    console.log(JSON.stringify(summary));
    if (args.dryRun) {
      console.log(
        `[cleanup-reasoning-audit] DRY-RUN: würde ${summary.deleted} ` +
          `Rows löschen (forensisch behalten: ` +
          `drift=${summary.kept_drift} fabricated=${summary.kept_fabricated})`,
      );
    } else {
      console.log(
        `[cleanup-reasoning-audit] DONE: ${summary.deleted} Rows gelöscht ` +
          `(${summary.total_before} → ${summary.total_after})`,
      );
    }
    // DB boot starts the stuck-detector loop (setInterval). Clean exit
    // so the systemd service terminates as Type=oneshot.
    process.exit(0);
  } catch (err) {
    console.error(
      "[cleanup-reasoning-audit] fatal:",
      err instanceof Error ? err.stack : err,
    );
    process.exit(1);
  }
}

// Only run when invoked directly (not on a test import).
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("cleanup-reasoning-audit.ts");

if (isMain) {
  void main();
}
