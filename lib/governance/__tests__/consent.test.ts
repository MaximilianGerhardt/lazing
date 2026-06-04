/**
 * Lane G Governance — consent.ts Tests.
 *
 * Strategy: in-memory better-sqlite3 DB, Schema aus der ECHTEN Migration
 * db/migrations/0118_governance_consent.sql via readFileSync (beweist
 * nebenbei, dass die Migration-SQL gültig + idempotent ist). Repo nimmt
 * ein rohes DB-Handle — kein getDb()-Singleton.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  grantConsent,
  hasConsent,
  levelCovers,
  listConsents,
  revokeConsent,
  type ConsentLevel,
} from "@/lib/governance/consent";

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
  raw.exec(sql); // re-apply → IF NOT EXISTS idempotency
  return raw;
}

describe("Lane G · consent.ts", () => {
  let raw: import("better-sqlite3").Database;
  beforeEach(() => {
    raw = freshDb();
  });

  it("hasConsent returns false when no grant exists", () => {
    expect(
      hasConsent(raw, {
        workspaceId: "wsp-1",
        userId: "u-1",
        dataSource: "whatsapp",
        requiredLevel: "read-only",
      }),
    ).toBe(false);
  });

  it("hasConsent: higher level covers lower (read-derive covers read-only)", () => {
    grantConsent(raw, {
      workspaceId: "wsp-1",
      userId: "u-1",
      dataSource: "whatsapp",
      level: "read-derive",
      reasonText:
        "Opt-in der betroffenen Person für read-derive (Master-Briefing §13.2).",
    });
    expect(
      hasConsent(raw, {
        workspaceId: "wsp-1",
        userId: "u-1",
        dataSource: "whatsapp",
        requiredLevel: "read-only",
      }),
    ).toBe(true);
    expect(
      hasConsent(raw, {
        workspaceId: "wsp-1",
        userId: "u-1",
        dataSource: "whatsapp",
        requiredLevel: "read-derive-act",
      }),
    ).toBe(false);
  });

  it("levelCovers: deterministic ordering", () => {
    expect(levelCovers("full-automation", "read-only")).toBe(true);
    expect(levelCovers("read-only", "read-derive")).toBe(false);
    expect(levelCovers("none", "read-only")).toBe(false);
    expect(levelCovers("read-derive-act", "read-derive")).toBe(true);
  });

  it("grantConsent persists reason_text verbatim (N1)", () => {
    const longReason = "warum ".repeat(2000);
    const grant = grantConsent(raw, {
      workspaceId: "wsp-1",
      userId: "u-1",
      dataSource: "voice",
      level: "read-derive-act",
      reasonText: longReason,
    });
    expect(grant.id).toMatch(/^CGT-/);
    expect(grant.reasonText).toBe(longReason);
    expect(grant.reasonText.length).toBe(longReason.length);
    expect(grant.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(grant.revokedAt).toBeNull();
  });

  it("grantConsent: scope JSON roundtrip", () => {
    const grant = grantConsent(raw, {
      workspaceId: "wsp-1",
      userId: "u-1",
      dataSource: "meeting",
      level: "read-only",
      scope: { timeWindow: { fromMs: 1000, toMs: 2000 }, dataMin: ["a", "b"] },
      reasonText: "Mit zeitlicher Begrenzung.",
    });
    const list = listConsents(raw, "wsp-1");
    expect(list).toHaveLength(1);
    expect(list[0]!.scope).toEqual({
      timeWindow: { fromMs: 1000, toMs: 2000 },
      dataMin: ["a", "b"],
    });
    expect(list[0]!.id).toBe(grant.id);
  });

  it("hasConsent: respects scope.timeWindow", () => {
    grantConsent(raw, {
      workspaceId: "wsp-1",
      userId: "u-1",
      dataSource: "email",
      level: "read-only",
      scope: { timeWindow: { fromMs: 1000, toMs: 2000 } },
      reasonText: "Nur in diesem Zeitfenster.",
    });
    expect(
      hasConsent(raw, {
        workspaceId: "wsp-1",
        userId: "u-1",
        dataSource: "email",
        requiredLevel: "read-only",
        nowMs: 500,
      }),
    ).toBe(false);
    expect(
      hasConsent(raw, {
        workspaceId: "wsp-1",
        userId: "u-1",
        dataSource: "email",
        requiredLevel: "read-only",
        nowMs: 1500,
      }),
    ).toBe(true);
    expect(
      hasConsent(raw, {
        workspaceId: "wsp-1",
        userId: "u-1",
        dataSource: "email",
        requiredLevel: "read-only",
        nowMs: 3000,
      }),
    ).toBe(false);
  });

  it("revokeConsent: sets revoked_at and hasConsent flips to false", () => {
    grantConsent(raw, {
      workspaceId: "wsp-1",
      userId: "u-1",
      dataSource: "telegram",
      level: "read-derive",
      reasonText: "Opt-in.",
    });
    expect(
      hasConsent(raw, {
        workspaceId: "wsp-1",
        userId: "u-1",
        dataSource: "telegram",
        requiredLevel: "read-derive",
      }),
    ).toBe(true);

    const revoked = revokeConsent(raw, {
      workspaceId: "wsp-1",
      userId: "u-1",
      dataSource: "telegram",
    });
    expect(revoked).not.toBeNull();
    expect(revoked!.revokedAt).toBeTypeOf("number");

    expect(
      hasConsent(raw, {
        workspaceId: "wsp-1",
        userId: "u-1",
        dataSource: "telegram",
        requiredLevel: "read-derive",
      }),
    ).toBe(false);
  });

  it("revokeConsent: returns null when no active grant", () => {
    const result = revokeConsent(raw, {
      workspaceId: "wsp-1",
      userId: "u-1",
      dataSource: "voice",
    });
    expect(result).toBeNull();
  });

  it("workspace-scope isolation: cross-workspace consent does not leak", () => {
    grantConsent(raw, {
      workspaceId: "wsp-A",
      userId: "u-1",
      dataSource: "whatsapp",
      level: "full-automation",
      reasonText: "Workspace A.",
    });
    expect(
      hasConsent(raw, {
        workspaceId: "wsp-B",
        userId: "u-1",
        dataSource: "whatsapp",
        requiredLevel: "read-only",
      }),
    ).toBe(false);
  });

  it("listConsents: onlyActive filter", () => {
    grantConsent(raw, {
      workspaceId: "wsp-1",
      userId: "u-1",
      dataSource: "whatsapp",
      level: "read-only",
      reasonText: "Erst-Opt-in.",
    });
    grantConsent(raw, {
      workspaceId: "wsp-1",
      userId: "u-1",
      dataSource: "whatsapp",
      level: "read-derive",
      reasonText: "Erweitert.",
    });
    revokeConsent(raw, {
      workspaceId: "wsp-1",
      userId: "u-1",
      dataSource: "whatsapp",
    });
    const all = listConsents(raw, "wsp-1");
    expect(all).toHaveLength(2);
    const active = listConsents(raw, "wsp-1", { onlyActive: true });
    expect(active).toHaveLength(1);
    expect(active[0]!.level).toBe("read-only");
  });

  it("DELETE on consent_grants raises (append-only trigger N8)", () => {
    grantConsent(raw, {
      workspaceId: "wsp-1",
      userId: "u-1",
      dataSource: "voice",
      level: "read-only",
      reasonText: "Test.",
    });
    expect(() =>
      raw.prepare(`DELETE FROM consent_grants WHERE workspace_id = ?`).run("wsp-1"),
    ).toThrow(/append-only/);
  });

  it("UPDATE on core fields raises (immutable trigger N8)", () => {
    const grant = grantConsent(raw, {
      workspaceId: "wsp-1",
      userId: "u-1",
      dataSource: "voice",
      level: "read-only",
      reasonText: "Test.",
    });
    expect(() =>
      raw.prepare(`UPDATE consent_grants SET level = ? WHERE id = ?`).run(
        "full-automation",
        grant.id,
      ),
    ).toThrow(/immutable/);
    expect(() =>
      raw
        .prepare(`UPDATE consent_grants SET reason_text = ? WHERE id = ?`)
        .run("manipulated", grant.id),
    ).toThrow(/immutable/);
    // revoked_at darf gesetzt werden — das ist der Pause/Stop-Pfad.
    expect(() =>
      raw
        .prepare(`UPDATE consent_grants SET revoked_at = ? WHERE id = ?`)
        .run(9999, grant.id),
    ).not.toThrow();
  });

  it("grantConsent: invalid level throws", () => {
    expect(() =>
      grantConsent(raw, {
        workspaceId: "wsp-1",
        userId: "u-1",
        dataSource: "voice",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        level: "super-secret" as unknown as ConsentLevel,
        reasonText: "x",
      }),
    ).toThrow(/invalid level/);
  });

  it("grantConsent: missing reasonText throws (N1 verbatim required)", () => {
    expect(() =>
      grantConsent(raw, {
        workspaceId: "wsp-1",
        userId: "u-1",
        dataSource: "voice",
        level: "read-only",
        reasonText: "",
      }),
    ).toThrow(/reasonText required/);
  });
});
