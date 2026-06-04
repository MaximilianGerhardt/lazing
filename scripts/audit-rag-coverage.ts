#!/usr/bin/env tsx
/**
 * audit-rag-coverage.ts — RAG-Index-Coverage-Audit (P12, 2026-05-01).
 *
 * Listet pro Source-Type, wie frisch der RAG-Index ist:
 *   - file / chat / ticket / work-product (existing 4 types)
 *   - standard / memory / skill           (Pseudo-Types für externe Quellen,
 *                                          die heute NICHT indexiert werden —
 *                                          ein Audit-Output zeigt die Lücke)
 *
 * Coverage-Status:
 *   fresh      < 24h
 *   stale      24h ≤ x < 7d
 *   very-stale ≥ 7d
 *   missing    keine Chunks in rag_chunks für diesen Source-Type
 *
 * Output: Markdown-Table (Default) oder JSON (`--json`).
 *
 * Run:
 *   pnpm tsx scripts/audit-rag-coverage.ts
 *   pnpm tsx scripts/audit-rag-coverage.ts --json
 *
 * Performance: Single-Aggregation-Query, < 5s. Kein DB-Lock (read-only).
 */

import { getDb } from "@/db/client";

export type CoverageStatus = "fresh" | "stale" | "very-stale" | "missing";

export interface CoverageRow {
  sourceType: string;
  countChunks: number;
  lastIndexedTs: number | null;
  oldestChunkTs: number | null;
  ageHours: number | null;
  status: CoverageStatus;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const KNOWN_INDEXED_TYPES = ["file", "chat", "ticket", "work-product"] as const;
const PSEUDO_TYPES = ["standard", "memory", "skill"] as const;
const ALL_TYPES = [...KNOWN_INDEXED_TYPES, ...PSEUDO_TYPES] as const;

export function classifyStatus(ageMs: number | null): CoverageStatus {
  if (ageMs === null) return "missing";
  if (ageMs < DAY_MS) return "fresh";
  if (ageMs < 7 * DAY_MS) return "stale";
  return "very-stale";
}

interface DbAggRow {
  source_type: string;
  cnt: number;
  max_ts: number | null;
  min_ts: number | null;
}

/**
 * Hauptfunktion. Liefert Coverage pro Source-Type, sortiert nach
 * (status:missing|very-stale|stale|fresh, sourceType).
 */
export function getCoverage(now: number = Date.now()): CoverageRow[] {
  const db = getDb();
  // Drizzle-orm 0.45 + better-sqlite3: $raw vs raw — wir nehmen einen
  // einfachen sql.execute auf den Driver. Die Tabelle existiert via Migration
  // 0042 (rag_chunks). Wir aggregieren pro source_type.
  let aggRows: DbAggRow[] = [];
  try {
    // better-sqlite3 raw-Driver — bypassed Drizzle für simple Aggregation
    const stmt = db.$raw.prepare(
      `SELECT
         source_type as source_type,
         COUNT(*) as cnt,
         MAX(indexed_at) as max_ts,
         MIN(indexed_at) as min_ts
       FROM rag_chunks
       GROUP BY source_type`,
    );
    aggRows = stmt.all() as DbAggRow[];
  } catch (err) {
    // rag_chunks-Tabelle fehlt (frische DB) → leeres Aggregat statt Crash
    if (err instanceof Error && /no such table/i.test(err.message)) {
      aggRows = [];
    } else {
      throw err;
    }
  }

  const byType = new Map<string, DbAggRow>();
  for (const r of aggRows) {
    byType.set(r.source_type, r);
  }

  const out: CoverageRow[] = [];
  for (const t of ALL_TYPES) {
    const agg = byType.get(t);
    if (!agg || agg.cnt === 0) {
      out.push({
        sourceType: t,
        countChunks: 0,
        lastIndexedTs: null,
        oldestChunkTs: null,
        ageHours: null,
        status: "missing",
      });
      continue;
    }
    const ageMs = agg.max_ts !== null ? now - agg.max_ts : null;
    out.push({
      sourceType: t,
      countChunks: agg.cnt,
      lastIndexedTs: agg.max_ts,
      oldestChunkTs: agg.min_ts,
      ageHours: ageMs === null ? null : Math.round(ageMs / HOUR_MS),
      status: classifyStatus(ageMs),
    });
  }

  // Auch unbekannte Source-Types (zukünftige) anzeigen
  for (const [t, agg] of byType.entries()) {
    if ((ALL_TYPES as readonly string[]).includes(t)) continue;
    const ageMs = agg.max_ts !== null ? now - agg.max_ts : null;
    out.push({
      sourceType: t,
      countChunks: agg.cnt,
      lastIndexedTs: agg.max_ts,
      oldestChunkTs: agg.min_ts,
      ageHours: ageMs === null ? null : Math.round(ageMs / HOUR_MS),
      status: classifyStatus(ageMs),
    });
  }

  const order: Record<CoverageStatus, number> = {
    missing: 0,
    "very-stale": 1,
    stale: 2,
    fresh: 3,
  };
  out.sort((a, b) => {
    if (order[a.status] !== order[b.status]) {
      return order[a.status] - order[b.status];
    }
    return a.sourceType.localeCompare(b.sourceType);
  });
  return out;
}

function statusEmoji(s: CoverageStatus): string {
  switch (s) {
    case "fresh":
      return "✓";
    case "stale":
      return "⚠";
    case "very-stale":
      return "✗";
    case "missing":
      return "—";
  }
}

export function renderMarkdown(rows: CoverageRow[]): string {
  const lines: string[] = [];
  lines.push("# RAG Coverage Audit");
  lines.push("");
  lines.push(`Stand: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(
    "| Status | Source-Type | Chunks | Last-Indexed | Age (h) | Oldest |",
  );
  lines.push(
    "|--------|-------------|-------:|--------------|--------:|--------|",
  );
  for (const r of rows) {
    const last = r.lastIndexedTs
      ? new Date(r.lastIndexedTs).toISOString().replace("T", " ").slice(0, 16)
      : "—";
    const oldest = r.oldestChunkTs
      ? new Date(r.oldestChunkTs).toISOString().slice(0, 10)
      : "—";
    lines.push(
      `| ${statusEmoji(r.status)} ${r.status} | \`${r.sourceType}\` | ${r.countChunks} | ${last} | ${r.ageHours ?? "—"} | ${oldest} |`,
    );
  }
  lines.push("");
  // Summary
  const missing = rows.filter((r) => r.status === "missing").length;
  const veryStale = rows.filter((r) => r.status === "very-stale").length;
  const stale = rows.filter((r) => r.status === "stale").length;
  const fresh = rows.filter((r) => r.status === "fresh").length;
  lines.push(
    `**Summary**: ${fresh} fresh · ${stale} stale · ${veryStale} very-stale · ${missing} missing`,
  );
  if (missing > 0) {
    lines.push("");
    lines.push(
      "> Pseudo-Types (`standard`, `memory`, `skill`) sind aktuell NICHT in `rag_chunks` indexiert. Re-Index via `pnpm tsx scripts/daily-full-sweep.ts --apply` (P12).",
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const rows = getCoverage();
  if (json) {
    process.stdout.write(JSON.stringify({ rows }, null, 2) + "\n");
    return;
  }
  process.stdout.write(renderMarkdown(rows) + "\n");
}

if (
  typeof process !== "undefined" &&
  process.argv[1] &&
  /audit-rag-coverage\.ts$/.test(process.argv[1])
) {
  void main().catch((err: unknown) => {
    console.error("[audit-rag-coverage] fatal:", err);
    process.exit(1);
  });
}
