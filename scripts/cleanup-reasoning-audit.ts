#!/usr/bin/env tsx
/**
 * Cleanup-Cron für Reasoning-Audit (Pattern 5 Welle 4, 2026-05-01).
 *
 * Löscht alte Audit-Rows die nicht mehr forensik-relevant sind:
 *   - älter als --max-age-days (default 90)
 *   - verified_status IN ('ok', NULL)
 *   - parent_ticket_id verweist auf ein 'closed'-Event (Ticket abgeschlossen)
 *
 * IMMER behalten (Forensik-Pflicht):
 *   - verified_status = 'drift'      → permanente Beweis-Spur
 *   - verified_status = 'fabricated'  → Halluzinations-Forensik
 *   - parent_ticket_id NULL ODER Ticket nicht in 'closed'-Events
 *
 * Tickets sind event-sourced (keine `tickets`-Tabelle). 'closed'-Status
 * ergibt sich aus `events WHERE entity_type='ticket' AND event_type='closed'`.
 *
 * Aufruf:
 *   pnpm tsx scripts/cleanup-reasoning-audit.ts --dry-run
 *   pnpm tsx scripts/cleanup-reasoning-audit.ts --max-age-days=180
 *   pnpm tsx scripts/cleanup-reasoning-audit.ts --keep-flagged
 *
 * Single-Pass: kein Loop. Wird per systemd-timer wöchentlich Sonntag 04:00 UTC
 * getriggert.
 *
 * Output: structured JSON-Summary auf stdout (für Log-Aggregation).
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
      // no-op: drift/fabricated werden IMMER behalten. Flag existiert
      // nur zur expliziten Dokumentation in Cron-Aufrufen.
      out.keepFlagged = true;
    }
  }
  return out;
}

export async function runCleanup(args: CliArgs): Promise<Summary> {
  const db = getDb();
  const raw = db.$raw;
  const cutoffMs = Date.now() - args.maxAgeDays * 86_400_000;

  // Total-before für Telemetrie.
  const totalBefore = (
    raw.prepare("SELECT COUNT(*) AS c FROM reasoning_audit").get() as {
      c: number;
    }
  ).c;

  // Subquery: Welche parent_ticket_ids sind 'closed'?
  // Tickets sind event-sourced. `events.event_type='closed' AND
  // entity_type='ticket'` markiert Done.
  const closedTicketSubquery = `
    SELECT entity_id FROM events
    WHERE entity_type = 'ticket' AND event_type = 'closed'
  `;

  // Diagnostic-Counts vor DELETE — wir wollen wissen WARUM Rows behalten
  // werden (Forensik-Audit der Cleanup-Logik selbst).
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

  // Kandidaten die in den DELETE-Filter fallen würden, aber gerettet werden
  // weil parent_ticket_id NULL ODER nicht in closed-Tickets.
  // Wir zählen sie für Telemetrie — sie werden NICHT gelöscht.
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

  // Delete-Kandidaten zählen.
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
    // DB-Boot startet stuck-detector-Loop (setInterval). Sauberer Exit
    // damit systemd-Service als Type=oneshot terminiert.
    process.exit(0);
  } catch (err) {
    console.error(
      "[cleanup-reasoning-audit] fatal:",
      err instanceof Error ? err.stack : err,
    );
    process.exit(1);
  }
}

// Nur ausführen wenn direkt aufgerufen (nicht beim Test-Import).
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("cleanup-reasoning-audit.ts");

if (isMain) {
  void main();
}
