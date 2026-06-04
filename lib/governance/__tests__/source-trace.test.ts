/**
 * Lane G Governance — source-trace.ts Tests.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  listSourceTraces,
  recordSourceTrace,
  traceLineage,
} from "@/lib/governance/source-trace";

const MIGRATION = path.join(
  process.cwd(),
  "db",
  "migrations",
  "0118_governance_consent.sql",
);

function freshDb(): import("better-sqlite3").Database {
  const raw = new Database(":memory:");
  const sql = readFileSync(MIGRATION, "utf8");
  raw.exec(sql);
  raw.exec(sql);
  return raw;
}

describe("Lane G · source-trace.ts", () => {
  let raw: import("better-sqlite3").Database;
  beforeEach(() => {
    raw = freshDb();
  });

  it("recordSourceTrace: raw entry gets rawDataDays retention", () => {
    const trace = recordSourceTrace(raw, {
      workspaceId: "wsp-1",
      dataSource: "whatsapp",
      externalId: "msg-42",
      contentHash: "a".repeat(64),
    });
    expect(trace.id).toMatch(/^STR-/);
    expect(trace.derivedFromTrace).toBeNull();
    expect(trace.rawRetentionUntil).toBeTypeOf("number");
    // Raw default: 30d → > now.
    expect(trace.rawRetentionUntil! > trace.createdAt).toBe(true);
  });

  it("traceLineage: returns the derive chain raw → derived → derived", () => {
    const rawT = recordSourceTrace(raw, {
      workspaceId: "wsp-1",
      dataSource: "whatsapp",
      externalId: "msg-1",
      contentHash: "h-raw",
    });
    const summary = recordSourceTrace(raw, {
      workspaceId: "wsp-1",
      dataSource: "workspace-derive",
      contentHash: "h-summary",
      derivedFromTrace: rawT.id,
    });
    const belief = recordSourceTrace(raw, {
      workspaceId: "wsp-1",
      dataSource: "workspace-derive",
      contentHash: "h-belief",
      derivedFromTrace: summary.id,
    });

    const lineage = traceLineage(raw, "h-belief");
    expect(lineage).toHaveLength(3);
    expect(lineage[0]!.id).toBe(belief.id);
    expect(lineage[1]!.id).toBe(summary.id);
    expect(lineage[2]!.id).toBe(rawT.id);
  });

  it("traceLineage: cross-workspace parent rejected at insert (fail-soft)", () => {
    const otherWs = recordSourceTrace(raw, {
      workspaceId: "wsp-A",
      dataSource: "whatsapp",
      contentHash: "h-other-ws",
    });
    const local = recordSourceTrace(raw, {
      workspaceId: "wsp-B",
      dataSource: "workspace-derive",
      contentHash: "h-local",
      derivedFromTrace: otherWs.id, // cross-scope → wird verworfen
    });
    expect(local.derivedFromTrace).toBeNull();
    expect(traceLineage(raw, "h-local")).toHaveLength(1);
  });

  it("traceLineage: unknown contentHash → empty", () => {
    expect(traceLineage(raw, "nope")).toEqual([]);
  });

  it("listSourceTraces filters by dataSource", () => {
    recordSourceTrace(raw, {
      workspaceId: "wsp-1",
      dataSource: "whatsapp",
      contentHash: "h-1",
    });
    recordSourceTrace(raw, {
      workspaceId: "wsp-1",
      dataSource: "telegram",
      contentHash: "h-2",
    });
    const wa = listSourceTraces(raw, "wsp-1", { dataSource: "whatsapp" });
    expect(wa).toHaveLength(1);
    expect(wa[0]!.dataSource).toBe("whatsapp");
  });

  it("recordSourceTrace: derived items get derivedDataDays retention (longer)", () => {
    const rawT = recordSourceTrace(raw, {
      workspaceId: "wsp-1",
      dataSource: "whatsapp",
      contentHash: "h-r",
    });
    const derived = recordSourceTrace(raw, {
      workspaceId: "wsp-1",
      dataSource: "workspace-derive",
      contentHash: "h-d",
      derivedFromTrace: rawT.id,
    });
    expect(derived.rawRetentionUntil! - derived.createdAt).toBeGreaterThan(
      rawT.rawRetentionUntil! - rawT.createdAt,
    );
  });
});
