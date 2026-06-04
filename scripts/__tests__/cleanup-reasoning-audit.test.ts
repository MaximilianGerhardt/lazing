/**
 * Tests für scripts/cleanup-reasoning-audit.ts (Pattern 5 Welle 4, 2026-05-01).
 *
 * Run: `pnpm exec tsx --test scripts/__tests__/cleanup-reasoning-audit.test.ts`
 *
 * Test-Setup folgt reasoning-verify.test.ts: frische temp-DB, FK-Checks off.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, beforeEach, describe, it } from "node:test";

if (!process.env.LAZYOS_DB_PATH) {
  process.env.LAZYOS_DB_PATH = join(
    mkdtempSync(join(tmpdir(), "lazyos-audit-cleanup-")),
    "audit-cleanup-test.db",
  );
}
process.env.LAZYOS_TEST_DISABLE_FK = "1";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const dbMod = require("@/db/client") as typeof import("@/db/client");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cleanupMod = require("../cleanup-reasoning-audit") as typeof import("../cleanup-reasoning-audit");

const { runCleanup } = cleanupMod;

const DAY_MS = 86_400_000;

interface SeedRow {
  id: string;
  ageDays: number;
  verifiedStatus: string | null;
  parentTicketId: string | null;
}

function seedRow(opts: SeedRow): void {
  const db = dbMod.getDb();
  const ts = Date.now() - opts.ageDays * DAY_MS;
  db.$raw
    .prepare(
      `INSERT OR REPLACE INTO reasoning_audit
       (id, ts, workspace_id, workstream_id, parent_ticket_id, phase, role,
        llm_provider, llm_model, prompt_hash, claim_text, cost_cents,
        duration_ms, output_tokens, verified_status, verified_at, verified_note)
       VALUES (?, ?, NULL, NULL, ?, 'synthesis', 'synthesis',
               'tmux-claude', 'claude-opus-4-7', 'hash:test', 'claim-text',
               0, 0, NULL, ?, NULL, NULL)`,
    )
    .run(opts.id, ts, opts.parentTicketId, opts.verifiedStatus);
}

function seedClosedTicket(ticketId: string): void {
  const db = dbMod.getDb();
  // events-Tabelle: entity_type='ticket' AND event_type='closed' = "done"
  const id = `evt-${ticketId}`;
  db.$raw
    .prepare(
      `INSERT OR REPLACE INTO events
       (id, created_at, segment_id, entity_type, entity_id, event_type,
        actor, payload, sensitivity)
       VALUES (?, ?, 'lazyos', 'ticket', ?, 'closed', 'system', '{}', 'low')`,
    )
    .run(id, Date.now(), ticketId);
}

function clearTables(): void {
  const db = dbMod.getDb();
  db.$raw.exec(`DELETE FROM reasoning_audit;`);
  db.$raw.exec(`DELETE FROM events WHERE entity_type = 'ticket';`);
}

before(() => {
  // Trigger Migrations.
  dbMod.getDb();
});

describe("cleanup-reasoning-audit", () => {
  beforeEach(() => {
    clearTables();
  });

  it("Dry-Run zählt nur, löscht nichts", async () => {
    seedClosedTicket("TCK-CLOSED-1");
    seedRow({
      id: "AUD-A",
      ageDays: 120,
      verifiedStatus: "ok",
      parentTicketId: "TCK-CLOSED-1",
    });
    seedRow({
      id: "AUD-B",
      ageDays: 120,
      verifiedStatus: null,
      parentTicketId: "TCK-CLOSED-1",
    });

    const summary = await runCleanup({
      maxAgeDays: 90,
      dryRun: true,
      keepFlagged: false,
    });

    assert.equal(summary.deleted, 2, "dry-run must count 2 candidates");
    assert.equal(summary.dry_run, true);
    assert.equal(summary.total_before, 2);
    assert.equal(summary.total_after, 2, "dry-run must NOT delete");
  });

  it("Apply löscht ok+null wenn Ticket closed und Row alt", async () => {
    seedClosedTicket("TCK-CLOSED-2");
    seedRow({
      id: "AUD-OLD-OK",
      ageDays: 120,
      verifiedStatus: "ok",
      parentTicketId: "TCK-CLOSED-2",
    });
    seedRow({
      id: "AUD-OLD-NULL",
      ageDays: 120,
      verifiedStatus: null,
      parentTicketId: "TCK-CLOSED-2",
    });

    const summary = await runCleanup({
      maxAgeDays: 90,
      dryRun: false,
      keepFlagged: false,
    });

    assert.equal(summary.deleted, 2);
    assert.equal(summary.total_after, 0);
  });

  it("drift IMMER behalten — auch alt + closed-Ticket", async () => {
    seedClosedTicket("TCK-CLOSED-3");
    seedRow({
      id: "AUD-DRIFT",
      ageDays: 365,
      verifiedStatus: "drift",
      parentTicketId: "TCK-CLOSED-3",
    });

    const summary = await runCleanup({
      maxAgeDays: 90,
      dryRun: false,
      keepFlagged: false,
    });

    assert.equal(summary.deleted, 0);
    assert.equal(summary.kept_drift, 1);
    assert.equal(summary.total_after, 1);
  });

  it("fabricated IMMER behalten — auch alt + closed-Ticket", async () => {
    seedClosedTicket("TCK-CLOSED-4");
    seedRow({
      id: "AUD-FAB",
      ageDays: 365,
      verifiedStatus: "fabricated",
      parentTicketId: "TCK-CLOSED-4",
    });

    const summary = await runCleanup({
      maxAgeDays: 90,
      dryRun: false,
      keepFlagged: false,
    });

    assert.equal(summary.deleted, 0);
    assert.equal(summary.kept_fabricated, 1);
    assert.equal(summary.total_after, 1);
  });

  it("Recent Rows (< 90d) behalten — auch wenn ok+closed-Ticket", async () => {
    seedClosedTicket("TCK-CLOSED-5");
    seedRow({
      id: "AUD-RECENT",
      ageDays: 30,
      verifiedStatus: "ok",
      parentTicketId: "TCK-CLOSED-5",
    });

    const summary = await runCleanup({
      maxAgeDays: 90,
      dryRun: false,
      keepFlagged: false,
    });

    assert.equal(summary.deleted, 0);
    assert.equal(summary.kept_recent, 1);
    assert.equal(summary.total_after, 1);
  });

  it("Edge: parent_ticket_id NULL → behalten (kann nicht joinen)", async () => {
    seedRow({
      id: "AUD-NO-TICKET",
      ageDays: 120,
      verifiedStatus: "ok",
      parentTicketId: null,
    });

    const summary = await runCleanup({
      maxAgeDays: 90,
      dryRun: false,
      keepFlagged: false,
    });

    assert.equal(summary.deleted, 0);
    assert.equal(summary.kept_no_ticket, 1);
    assert.equal(summary.total_after, 1);
  });

  it("Edge: Ticket noch open (kein closed-Event) → Row behalten", async () => {
    // Kein seedClosedTicket() → Ticket gilt als open.
    seedRow({
      id: "AUD-OPEN-TICKET",
      ageDays: 120,
      verifiedStatus: "ok",
      parentTicketId: "TCK-OPEN-1",
    });

    const summary = await runCleanup({
      maxAgeDays: 90,
      dryRun: false,
      keepFlagged: false,
    });

    assert.equal(summary.deleted, 0);
    assert.equal(summary.kept_open_ticket, 1);
    assert.equal(summary.total_after, 1);
  });

  it("Mix: 6 Rows, nur 2 löschbar", async () => {
    seedClosedTicket("TCK-MIX-CLOSED");
    // Löschbar: alt + ok/null + closed-Ticket
    seedRow({
      id: "AUD-DEL-1",
      ageDays: 200,
      verifiedStatus: "ok",
      parentTicketId: "TCK-MIX-CLOSED",
    });
    seedRow({
      id: "AUD-DEL-2",
      ageDays: 200,
      verifiedStatus: null,
      parentTicketId: "TCK-MIX-CLOSED",
    });
    // Behalten: drift
    seedRow({
      id: "AUD-DRIFT-MIX",
      ageDays: 200,
      verifiedStatus: "drift",
      parentTicketId: "TCK-MIX-CLOSED",
    });
    // Behalten: recent
    seedRow({
      id: "AUD-RECENT-MIX",
      ageDays: 10,
      verifiedStatus: "ok",
      parentTicketId: "TCK-MIX-CLOSED",
    });
    // Behalten: kein Ticket
    seedRow({
      id: "AUD-NO-TICKET-MIX",
      ageDays: 200,
      verifiedStatus: "ok",
      parentTicketId: null,
    });
    // Behalten: open ticket
    seedRow({
      id: "AUD-OPEN-MIX",
      ageDays: 200,
      verifiedStatus: "ok",
      parentTicketId: "TCK-MIX-OPEN",
    });

    const summary = await runCleanup({
      maxAgeDays: 90,
      dryRun: false,
      keepFlagged: false,
    });

    assert.equal(summary.deleted, 2);
    assert.equal(summary.total_before, 6);
    assert.equal(summary.total_after, 4);
    assert.equal(summary.kept_drift, 1);
    assert.equal(summary.kept_recent, 1);
    assert.equal(summary.kept_no_ticket, 1);
    assert.equal(summary.kept_open_ticket, 1);
  });
});
