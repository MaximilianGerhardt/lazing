/**
 * Lane G Governance — audit.ts Tests.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  listGovernanceAudit,
  writeGovernanceAudit,
} from "@/lib/governance/audit";

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

describe("Lane G · audit.ts", () => {
  let raw: import("better-sqlite3").Database;
  beforeEach(() => {
    raw = freshDb();
  });

  it("writeGovernanceAudit roundtrip + verbatim N1 + content_hash N10", () => {
    const longReason = "weil " + "x".repeat(5000); // N1
    const row = writeGovernanceAudit(raw, {
      workspaceId: "wsp-1",
      userId: "u-1",
      action: "connector-invoke-live",
      dataSource: "whatsapp",
      decision: "allowed",
      reason: longReason,
    });
    expect(row.id).toMatch(/^GAU-/);
    expect(row.reason).toBe(longReason);
    expect(row.reason.length).toBe(longReason.length);
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const list = listGovernanceAudit(raw, "wsp-1");
    expect(list).toHaveLength(1);
    expect(list[0]!.action).toBe("connector-invoke-live");
    expect(list[0]!.decision).toBe("allowed");
  });

  it("DELETE on governance_audit raises (N8)", () => {
    writeGovernanceAudit(raw, {
      workspaceId: "wsp-1",
      userId: "u-1",
      action: "execute-bash",
      decision: "denied",
      reason: "kein freerein-Mode",
    });
    expect(() =>
      raw.prepare(`DELETE FROM governance_audit`).run(),
    ).toThrow(/append-only/);
  });

  it("UPDATE on governance_audit raises (N8)", () => {
    const row = writeGovernanceAudit(raw, {
      workspaceId: "wsp-1",
      userId: "u-1",
      action: "fs-write",
      decision: "denied",
      reason: "denied A",
    });
    expect(() =>
      raw
        .prepare(`UPDATE governance_audit SET reason = ? WHERE id = ?`)
        .run("manipulated", row.id),
    ).toThrow(/append-only/);
  });

  it("listGovernanceAudit: filter by decision", () => {
    writeGovernanceAudit(raw, {
      workspaceId: "wsp-1",
      userId: "u-1",
      action: "execute-bash",
      decision: "denied",
      reason: "deny",
    });
    writeGovernanceAudit(raw, {
      workspaceId: "wsp-1",
      userId: "u-1",
      action: "execute-bash",
      decision: "allowed",
      reason: "allow",
    });
    const denied = listGovernanceAudit(raw, "wsp-1", { decision: "denied" });
    expect(denied).toHaveLength(1);
    expect(denied[0]!.decision).toBe("denied");
  });

  it("invalid decision throws", () => {
    expect(() =>
      writeGovernanceAudit(raw, {
        workspaceId: "wsp-1",
        userId: "u-1",
        action: "x",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        decision: "maybe" as any,
        reason: "r",
      }),
    ).toThrow();
  });

  it("missing reason throws (N1 verbatim required)", () => {
    expect(() =>
      writeGovernanceAudit(raw, {
        workspaceId: "wsp-1",
        userId: "u-1",
        action: "x",
        decision: "allowed",
        reason: "",
      }),
    ).toThrow(/reason required/);
  });
});
