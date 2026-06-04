/**
 * Experiment-Tracker Tests (P14, 2026-05-01).
 *
 * Run: `pnpm exec tsx --test lib/unlearning/__tests__/experiment-tracker.test.ts`
 *
 * Setup: Test-DB in os.tmpdir(), FK-Checks off (Migration 0036 referenziert
 * Parent-Org-IDs die in leerer Test-DB nicht existieren — bekanntes Pattern,
 * siehe lib/audit/reasoning-verify.test.ts).
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

if (!process.env.LAZYOS_DB_PATH) {
  process.env.LAZYOS_DB_PATH = join(
    mkdtempSync(join(tmpdir(), "lazyos-experiment-tracker-")),
    "experiment-tracker-test.db",
  );
}
process.env.LAZYOS_TEST_DISABLE_FK = "1";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const trackerMod = require("../experiment-tracker") as typeof import("../experiment-tracker");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dbMod = require("@/db/client") as typeof import("@/db/client");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const schemaMod = require("@/db/schema/failed_experiments") as typeof import("@/db/schema/failed_experiments");

const {
  recordFailedExperiment,
  loadUnresolvedExperiments,
  markResolved,
  incrementRetryCount,
  truncateHypothesis,
} = trackerMod;
const { failedExperiments } = schemaMod;

// Stoppe stuck-detector-Loop nach allen Tests (sonst hängt der Process).
after(async () => {
  try {
    const stuckMod = (await import(
      "@/lib/workstreams/stuck-detector"
    )) as typeof import("@/lib/workstreams/stuck-detector");
    stuckMod.stopStuckDetectorLoop();
  } catch {
    // ignore
  }
});

describe("truncateHypothesis", () => {
  it("kurzer String wird unverändert zurückgegeben", () => {
    const out = truncateHypothesis("kurz und knapp");
    assert.equal(out, "kurz und knapp");
  });

  it("genau 500 chars bleibt unverändert", () => {
    const exact = "x".repeat(500);
    const out = truncateHypothesis(exact);
    assert.equal(out, exact);
    assert.equal(out.length, 500);
  });

  it("> 500 chars wird auf 500 mit [truncated] gekürzt", () => {
    const long = "a".repeat(600);
    const out = truncateHypothesis(long);
    assert.equal(out.length, 500);
    assert.ok(out.endsWith("[truncated]"));
    assert.match(out, /^a+\[truncated\]$/);
  });
});

describe("recordFailedExperiment", () => {
  before(() => {
    // Touch DB to run migrations
    dbMod.getDb();
  });

  it("liefert eine ID zurück und schreibt Row", () => {
    const id = recordFailedExperiment({
      workspaceId: "lazyos",
      hypothesis: "Test-Hypothesis A",
      failureReason: "Quality nicht gut genug",
      modelUsed: "claude-opus-4-7",
    });
    assert.ok(id, "ID sollte zurückkommen");
    assert.match(id ?? "", /^fxp_/, "ID-Prefix fxp_");

    const db = dbMod.getDb();
    const rows = db.select().from(failedExperiments).all();
    assert.ok(rows.length >= 1);
    const row = rows.find((r) => r.id === id);
    assert.ok(row, "Row sollte existieren");
    assert.equal(row?.hypothesis, "Test-Hypothesis A");
    assert.equal(row?.workspaceId, "lazyos");
    assert.equal(row?.retryCount, 0);
    assert.equal(row?.resolvedAt, null);
  });

  it("hypothesis > 500 chars wird truncated mit [truncated]", () => {
    const long = "x".repeat(600);
    const id = recordFailedExperiment({ hypothesis: long });
    assert.ok(id);
    const db = dbMod.getDb();
    const row = db
      .select()
      .from(failedExperiments)
      .all()
      .find((r) => r.id === id);
    assert.ok(row);
    assert.ok(row.hypothesis.length <= 500);
    assert.ok(row.hypothesis.endsWith("[truncated]"));
  });
});

describe("loadUnresolvedExperiments", () => {
  it("filtert resolved Experiments", () => {
    const idA = recordFailedExperiment({ hypothesis: "alt-A — wird resolved" });
    const idB = recordFailedExperiment({ hypothesis: "alt-B — bleibt offen" });
    assert.ok(idA && idB);

    // Künstlich altmachen — beide direkt
    const db = dbMod.getDb();
    const oldTs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    db.$raw
      .prepare("UPDATE failed_experiments SET attempted_at = ? WHERE id IN (?, ?)")
      .run(oldTs, idA, idB);

    markResolved(idA!, "fixed by user");

    const rows = loadUnresolvedExperiments(14);
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes(idB!), "B sollte unresolved sein");
    assert.ok(!ids.includes(idA!), "A wurde resolved — nicht im Result");
  });

  it("filtert nach maxAgeDays — frische Experimente werden NICHT geliefert", () => {
    const idFresh = recordFailedExperiment({ hypothesis: "fresh — gerade eben" });
    assert.ok(idFresh);

    // attempted_at = jetzt → mit maxAgeDays=14 darf das NICHT erscheinen
    const rows = loadUnresolvedExperiments(14);
    const ids = rows.map((r) => r.id);
    assert.ok(!ids.includes(idFresh!), "frisches Experiment unter 14d-Cutoff");
  });
});

describe("markResolved", () => {
  it("setzt resolved_at + resolution_note", () => {
    const id = recordFailedExperiment({ hypothesis: "resolve-target" });
    assert.ok(id);

    markResolved(id!, "Lösung gefunden mit aktuellem Modell");

    const db = dbMod.getDb();
    const row = db
      .select()
      .from(failedExperiments)
      .all()
      .find((r) => r.id === id);
    assert.ok(row);
    assert.ok(row.resolvedAt !== null && row.resolvedAt > 0);
    assert.equal(row.resolutionNote, "Lösung gefunden mit aktuellem Modell");
  });
});

describe("incrementRetryCount", () => {
  it("zählt retry_count hoch und setzt last_retry_at", () => {
    const id = recordFailedExperiment({ hypothesis: "retry-target" });
    assert.ok(id);

    incrementRetryCount(id!);
    incrementRetryCount(id!);
    incrementRetryCount(id!);

    const db = dbMod.getDb();
    const row = db
      .select()
      .from(failedExperiments)
      .all()
      .find((r) => r.id === id);
    assert.ok(row);
    assert.equal(row.retryCount, 3);
    assert.ok(row.lastRetryAt !== null && row.lastRetryAt > 0);
  });
});
