/**
 * Tests für scripts/audit-rag-coverage.ts (P12, 2026-05-01).
 *
 * Run: `npx tsx --test --test-force-exit scripts/__tests__/audit-rag-coverage.test.ts`
 *
 * Strategie: frische temp-DB, rag_chunks-Tabelle manuell anlegen, Rows seeden,
 * Coverage prüfen.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, beforeEach, describe, it } from "node:test";

if (!process.env.LAZYOS_DB_PATH) {
  process.env.LAZYOS_DB_PATH = join(
    mkdtempSync(join(tmpdir(), "lazyos-rag-coverage-")),
    "rag-coverage-test.db",
  );
}
process.env.LAZYOS_TEST_DISABLE_FK = "1";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const dbMod = require("@/db/client") as typeof import("@/db/client");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const auditMod = require("../audit-rag-coverage") as typeof import("../audit-rag-coverage");

const { getCoverage, classifyStatus, renderMarkdown } = auditMod;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function ensureRagChunksTable(): void {
  const db = dbMod.getDb();
  db.$raw.exec(
    `CREATE TABLE IF NOT EXISTS rag_chunks (
       id TEXT PRIMARY KEY,
       workspace_id TEXT NOT NULL,
       source_type TEXT NOT NULL,
       source_id TEXT NOT NULL,
       source_version INTEGER,
       chunk_index INTEGER NOT NULL,
       text TEXT NOT NULL,
       embedding BLOB NOT NULL,
       token_count INTEGER,
       sensitivity TEXT NOT NULL DEFAULT 'low',
       indexed_at INTEGER NOT NULL,
       expires_at INTEGER
     );`,
  );
}

function clearChunks(): void {
  const db = dbMod.getDb();
  db.$raw.exec(`DELETE FROM rag_chunks;`);
}

function insertChunk(opts: {
  sourceType: string;
  ageHours: number;
  count?: number;
}): void {
  const db = dbMod.getDb();
  const now = Date.now();
  const ts = now - opts.ageHours * HOUR_MS;
  const stmt = db.$raw.prepare(
    `INSERT INTO rag_chunks (id, workspace_id, source_type, source_id,
       chunk_index, text, embedding, token_count, sensitivity, indexed_at)
     VALUES (?, 'ws_test', ?, ?, 0, 'sample-text-content', X'00', 10, 'low', ?)`,
  );
  const count = opts.count ?? 1;
  for (let i = 0; i < count; i++) {
    stmt.run(
      `id_${opts.sourceType}_${opts.ageHours}_${i}_${Math.random().toString(36).slice(2, 8)}`,
      opts.sourceType,
      `src_${opts.sourceType}_${i}`,
      ts - i * 1000,
    );
  }
}

before(() => {
  ensureRagChunksTable();
});

beforeEach(() => {
  clearChunks();
});

describe("classifyStatus", () => {
  it("liefert 'fresh' für < 24h", () => {
    assert.equal(classifyStatus(HOUR_MS), "fresh");
    assert.equal(classifyStatus(23 * HOUR_MS), "fresh");
  });
  it("liefert 'stale' für 24h..7d", () => {
    assert.equal(classifyStatus(25 * HOUR_MS), "stale");
    assert.equal(classifyStatus(6 * DAY_MS), "stale");
  });
  it("liefert 'very-stale' für ≥ 7d", () => {
    assert.equal(classifyStatus(7 * DAY_MS + 1), "very-stale");
    assert.equal(classifyStatus(30 * DAY_MS), "very-stale");
  });
  it("liefert 'missing' für null", () => {
    assert.equal(classifyStatus(null), "missing");
  });
});

describe("getCoverage", () => {
  it("liefert alle bekannten + Pseudo-Types als 'missing' bei leerer DB", () => {
    const rows = getCoverage();
    // 4 known + 3 pseudo
    assert.equal(rows.length, 7);
    for (const r of rows) {
      assert.equal(r.status, "missing");
      assert.equal(r.countChunks, 0);
      assert.equal(r.lastIndexedTs, null);
    }
  });

  it("erkennt 'fresh' für eben indexed chunks", () => {
    insertChunk({ sourceType: "file", ageHours: 1 });
    const rows = getCoverage();
    const fileRow = rows.find((r) => r.sourceType === "file");
    assert.ok(fileRow);
    assert.equal(fileRow!.status, "fresh");
    assert.equal(fileRow!.countChunks, 1);
    assert.ok(fileRow!.lastIndexedTs !== null);
  });

  it("erkennt 'stale' für 2-Tage-alte chunks", () => {
    insertChunk({ sourceType: "ticket", ageHours: 48 });
    const rows = getCoverage();
    const ticketRow = rows.find((r) => r.sourceType === "ticket");
    assert.ok(ticketRow);
    assert.equal(ticketRow!.status, "stale");
  });

  it("erkennt 'very-stale' für 10-Tage-alte chunks", () => {
    insertChunk({ sourceType: "chat", ageHours: 240 });
    const rows = getCoverage();
    const chatRow = rows.find((r) => r.sourceType === "chat");
    assert.ok(chatRow);
    assert.equal(chatRow!.status, "very-stale");
  });

  it("aggregiert count korrekt", () => {
    insertChunk({ sourceType: "work-product", ageHours: 1, count: 5 });
    const rows = getCoverage();
    const wpRow = rows.find((r) => r.sourceType === "work-product");
    assert.ok(wpRow);
    assert.equal(wpRow!.countChunks, 5);
  });

  it("Pseudo-Types bleiben 'missing' auch nach known-Index", () => {
    insertChunk({ sourceType: "file", ageHours: 1 });
    const rows = getCoverage();
    for (const t of ["standard", "memory", "skill"]) {
      const r = rows.find((x) => x.sourceType === t);
      assert.ok(r, `pseudo-type ${t} not present`);
      assert.equal(r!.status, "missing");
    }
  });

  it("sortiert: missing zuerst, dann very-stale, stale, fresh", () => {
    insertChunk({ sourceType: "file", ageHours: 1 }); // fresh
    insertChunk({ sourceType: "ticket", ageHours: 48 }); // stale
    insertChunk({ sourceType: "chat", ageHours: 240 }); // very-stale
    const rows = getCoverage();
    let lastOrder = -1;
    const orderMap = { missing: 0, "very-stale": 1, stale: 2, fresh: 3 };
    for (const r of rows) {
      const o = orderMap[r.status];
      assert.ok(
        o >= lastOrder,
        `out-of-order: ${r.sourceType}=${r.status} (${o} < ${lastOrder})`,
      );
      lastOrder = o;
    }
  });
});

describe("renderMarkdown", () => {
  it("generiert valides Markdown mit Header + Table", () => {
    insertChunk({ sourceType: "file", ageHours: 1 });
    const rows = getCoverage();
    const md = renderMarkdown(rows);
    assert.ok(md.includes("# RAG Coverage Audit"));
    assert.ok(md.includes("| Status |"));
    assert.ok(md.includes("`file`"));
    assert.ok(md.includes("**Summary**"));
  });

  it("zeigt Pseudo-Types-Hint bei missing", () => {
    const rows = getCoverage();
    const md = renderMarkdown(rows);
    assert.ok(md.includes("Pseudo-Types"));
  });
});
