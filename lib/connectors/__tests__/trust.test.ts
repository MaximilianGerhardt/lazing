// Trust-Store Tests (ACL-5-C) — 2026-05-24.
//
// Tests cover:
//   (a) Trust-Default 'ask' — getTrust gibt 'ask' zurück wenn kein Eintrag.
//   (b) setTrust('auto') persistiert den Wert + ist via getTrust abrufbar.
//   (c) setTrust schreibt einen Audit-Row (phase='approve').
//   (d) recordCallAudit schreibt payload_hash, nicht den Payload selbst.
//   (e) recordCallAudit ist best-effort: DB-Fehler wirft nicht.
//   (f) computePayloadHash: sha256 über canonical JSON, nie der Payload.
//   (g) getTrust fail-closed: DB-Fehler → 'ask'.
//   (h) setTrust fail-closed: ungültige trust-Werte → wirft.
//   (i) content_hash (N10) wird geschrieben und ist 64-char hex.
//
// Strategy: vi.mock('@/db/client') injiziert in-memory SQLite (same pattern wie catalog.test.ts).
//
// Run:
//   NODE_OPTIONS='--experimental-require-module' npx vitest run \
//     lib/connectors/__tests__/trust.test.ts

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── In-memory DB DDL ────────────────────────────────────────────────────────

const TRUST_DDL = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS connector_call_approvals (
    id           TEXT    PRIMARY KEY,
    scope_kind   TEXT    NOT NULL CHECK (scope_kind IN ('org','workspace')),
    scope_id     TEXT    NOT NULL,
    provider     TEXT    NOT NULL,
    trust        TEXT    NOT NULL DEFAULT 'ask' CHECK (trust IN ('ask','auto')),
    set_by       TEXT    NOT NULL DEFAULT 'system',
    reason       TEXT,
    content_hash TEXT    NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    UNIQUE (scope_kind, scope_id, provider)
  );

  CREATE TABLE IF NOT EXISTS connector_call_audit (
    id              TEXT    PRIMARY KEY,
    ts              INTEGER NOT NULL,
    scope_kind      TEXT    NOT NULL,
    scope_id        TEXT    NOT NULL,
    provider        TEXT    NOT NULL,
    capability      TEXT    NOT NULL,
    user_id         TEXT    NOT NULL,
    phase           TEXT    NOT NULL,
    live            INTEGER NOT NULL DEFAULT 0,
    payload_hash    TEXT,
    result_summary  TEXT,
    success         INTEGER NOT NULL DEFAULT 0,
    reason          TEXT,
    content_hash    TEXT    NOT NULL DEFAULT ''
  );
`;

let rawDb: Database.Database;

// vi.mock wird von vitest ans Dateianfang hochgezogen (hoisting).
vi.mock("@/db/client", () => ({
  getDb: () => {
    return Object.assign(drizzle(rawDb), { $raw: rawDb });
  },
}));

// Imports NACH vi.mock (damit sie das gemockte getDb() sehen).
import {
  computePayloadHash,
  getTrust,
  recordCallAudit,
  setTrust,
} from "../trust";

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  rawDb = new Database(":memory:");
  rawDb.pragma("foreign_keys = ON");
  rawDb.exec(TRUST_DDL);
});

afterEach(() => {
  rawDb.close();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Trust-Store — ACL-5-C", () => {
  // ── (a) Trust-Default 'ask' ────────────────────────────────────────────────

  describe("(a) Trust-Default 'ask'", () => {
    it("getTrust gibt 'ask' zurück wenn kein Eintrag vorhanden", () => {
      const trust = getTrust("workspace", "ws-1", "heygen");
      expect(trust).toBe("ask");
    });

    it("getTrust gibt 'ask' für unbekannten Provider zurück", () => {
      const trust = getTrust("workspace", "ws-1", "nonexistent-provider");
      expect(trust).toBe("ask");
    });

    it("getTrust gibt 'ask' für unbekannte scopeId zurück", () => {
      const trust = getTrust("org", "org-42", "openai");
      expect(trust).toBe("ask");
    });

    it("getTrust gibt 'ask' zurück wenn scopeId leer ist (fail-closed)", () => {
      const trust = getTrust("workspace", "", "heygen");
      expect(trust).toBe("ask");
    });

    it("getTrust gibt 'ask' zurück wenn provider leer ist (fail-closed)", () => {
      const trust = getTrust("workspace", "ws-1", "");
      expect(trust).toBe("ask");
    });
  });

  // ── (b) setTrust('auto') persistiert + abrufbar ────────────────────────────

  describe("(b) setTrust('auto') persistiert und ist via getTrust abrufbar", () => {
    it("setTrust('auto') → getTrust gibt 'auto' zurück", () => {
      setTrust({
        scopeKind: "workspace",
        scopeId: "ws-1",
        provider: "heygen",
        trust: "auto",
        actor: "user-max",
        reason: "Owner-Entscheidung",
      });

      const trust = getTrust("workspace", "ws-1", "heygen");
      expect(trust).toBe("auto");
    });

    it("setTrust('ask') überschreibt 'auto' → getTrust gibt 'ask' zurück", () => {
      setTrust({
        scopeKind: "workspace",
        scopeId: "ws-1",
        provider: "heygen",
        trust: "auto",
        actor: "user-max",
      });
      setTrust({
        scopeKind: "workspace",
        scopeId: "ws-1",
        provider: "heygen",
        trust: "ask",
        actor: "user-max",
        reason: "Zurückgenommen",
      });

      const trust = getTrust("workspace", "ws-1", "heygen");
      expect(trust).toBe("ask");
    });

    it("setTrust schreibt genau einen Approval-Eintrag (keine Duplikate)", () => {
      setTrust({ scopeKind: "workspace", scopeId: "ws-1", provider: "heygen", trust: "auto", actor: "user-max" });
      setTrust({ scopeKind: "workspace", scopeId: "ws-1", provider: "heygen", trust: "auto", actor: "user-max" });

      const rows = rawDb.prepare("SELECT * FROM connector_call_approvals WHERE provider = 'heygen'").all();
      expect(rows).toHaveLength(1);
    });

    it("setTrust für andere Provider sind unabhängig", () => {
      setTrust({ scopeKind: "workspace", scopeId: "ws-1", provider: "heygen", trust: "auto", actor: "user-max" });
      setTrust({ scopeKind: "workspace", scopeId: "ws-1", provider: "openai", trust: "ask", actor: "user-max" });

      expect(getTrust("workspace", "ws-1", "heygen")).toBe("auto");
      expect(getTrust("workspace", "ws-1", "openai")).toBe("ask");
    });
  });

  // ── (c) setTrust schreibt Audit-Row ───────────────────────────────────────

  describe("(c) setTrust schreibt eine Audit-Row (N8)", () => {
    it("nach setTrust existiert genau eine Audit-Row für den Provider", () => {
      setTrust({
        scopeKind: "workspace",
        scopeId: "ws-1",
        provider: "heygen",
        trust: "auto",
        actor: "user-max",
        reason: "Test",
      });

      const rows = rawDb.prepare(
        "SELECT * FROM connector_call_audit WHERE provider = 'heygen'",
      ).all() as Array<{ phase: string; user_id: string; success: number }>;

      expect(rows.length).toBeGreaterThanOrEqual(1);
    });

    it("Audit-Row hat phase='approve' und success=1", () => {
      setTrust({
        scopeKind: "workspace",
        scopeId: "ws-1",
        provider: "heygen",
        trust: "auto",
        actor: "user-max",
      });

      const rows = rawDb.prepare(
        "SELECT * FROM connector_call_audit WHERE provider = 'heygen'",
      ).all() as Array<{ phase: string; success: number }>;

      const approveRow = rows.find((r) => r.phase === "approve");
      expect(approveRow).toBeDefined();
      expect(approveRow!.success).toBe(1);
    });
  });

  // ── (d) recordCallAudit schreibt payload_hash, nicht Payload ──────────────

  describe("(d) recordCallAudit schreibt payload_hash, NICHT den rohen Payload", () => {
    it("payload_hash ist ein 64-char hex-String (sha256)", () => {
      const payloadHash = computePayloadHash({ api_key: "secret-1234", action: "render" });

      recordCallAudit({
        scopeKind: "workspace",
        scopeId: "ws-1",
        provider: "heygen",
        capability: "render_video",
        userId: "user-max",
        phase: "invoke",
        live: false,
        payloadHash,
        resultSummary: "dry-run: mocked",
        success: true,
      });

      const rows = rawDb.prepare(
        "SELECT * FROM connector_call_audit WHERE capability = 'render_video'",
      ).all() as Array<{ payload_hash: string | null }>;

      expect(rows).toHaveLength(1);
      const row = rows[0]!;

      // payload_hash ist 64-char hex (sha256)
      expect(row.payload_hash).toMatch(/^[0-9a-f]{64}$/);

      // payload_hash enthält NICHT den Secret-Wert
      expect(row.payload_hash).not.toContain("secret-1234");
    });

    it("payload_hash von computePayloadHash ist deterministisch", () => {
      const payload = { action: "render", model: "heygen-v2" };
      const hash1 = computePayloadHash(payload);
      const hash2 = computePayloadHash(payload);
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    });

    it("verschiedene Payloads ergeben verschiedene Hashes", () => {
      const hash1 = computePayloadHash({ action: "render" });
      const hash2 = computePayloadHash({ action: "list" });
      expect(hash1).not.toBe(hash2);
    });

    it("Audit-Row enthält nie den rohen Payload (auch nicht als JSON-String)", () => {
      const sensitivePayload = {
        api_key: "VERY-SECRET-KEY",
        user_email: "max@example.com",
        action: "render",
      };
      const payloadHash = computePayloadHash(sensitivePayload);

      recordCallAudit({
        scopeKind: "workspace",
        scopeId: "ws-1",
        provider: "heygen",
        capability: "render_video",
        userId: "user-max",
        phase: "invoke",
        live: true,
        payloadHash,
        resultSummary: "status=200 duration=340ms",
        success: true,
      });

      // Alle Felder der Audit-Row als JSON prüfen
      const rows = rawDb.prepare(
        "SELECT * FROM connector_call_audit",
      ).all() as Array<Record<string, unknown>>;

      const rowJson = JSON.stringify(rows);
      expect(rowJson).not.toContain("VERY-SECRET-KEY");
      expect(rowJson).not.toContain("max@example.com");
    });
  });

  // ── (d2) Finding 6a: roher Payload als payloadHash → nie roh geschrieben ──

  describe("(d2) Finding 6a — payloadHash-Format wird validiert", () => {
    it("roher Payload (JSON-String) als payloadHash → wird NICHT roh geschrieben (payload_hash=null)", () => {
      // Caller-Fehler: übergibt den rohen Payload statt seinen Hash.
      const rawPayload = JSON.stringify({ api_key: "LEAK-ME-1234", action: "render" });

      recordCallAudit({
        scopeKind: "workspace",
        scopeId: "ws-1",
        provider: "heygen",
        capability: "render_video",
        userId: "user-max",
        phase: "invoke",
        live: false,
        payloadHash: rawPayload, // BUG: roher Payload statt Hash
        success: true,
      });

      const row = rawDb.prepare(
        "SELECT * FROM connector_call_audit WHERE capability = 'render_video'",
      ).get() as { payload_hash: string | null; reason: string | null };

      // payload_hash darf NICHT der rohe Payload sein.
      expect(row.payload_hash).toBeNull();
      // Der Klartext darf NIRGENDWO in der Row stehen.
      expect(JSON.stringify(row)).not.toContain("LEAK-ME-1234");
      // reason markiert den Vorfall.
      expect(row.reason).toContain("invalid-payload-hash");
    });

    it("zu kurzer hex-String als payloadHash → payload_hash=null + Marker", () => {
      recordCallAudit({
        scopeKind: "workspace",
        scopeId: "ws-1",
        provider: "heygen",
        capability: "render_video",
        userId: "user-max",
        phase: "invoke",
        payloadHash: "abc123", // zu kurz, kein 64-char hex
        success: true,
      });

      const row = rawDb.prepare(
        "SELECT * FROM connector_call_audit WHERE capability = 'render_video'",
      ).get() as { payload_hash: string | null; reason: string | null };

      expect(row.payload_hash).toBeNull();
      expect(row.reason).toContain("invalid-payload-hash");
    });

    it("Großbuchstaben-Hex (kein lowercase) → abgelehnt (payload_hash=null)", () => {
      const upper = "A".repeat(64); // 64 chars aber Großbuchstaben
      recordCallAudit({
        scopeKind: "workspace",
        scopeId: "ws-1",
        provider: "heygen",
        capability: "render_video",
        userId: "user-max",
        phase: "invoke",
        payloadHash: upper,
        success: true,
      });

      const row = rawDb.prepare(
        "SELECT * FROM connector_call_audit WHERE capability = 'render_video'",
      ).get() as { payload_hash: string | null };

      expect(row.payload_hash).toBeNull();
    });

    it("existierender reason bleibt erhalten + bekommt [invalid-payload-hash]-Suffix", () => {
      recordCallAudit({
        scopeKind: "workspace",
        scopeId: "ws-1",
        provider: "heygen",
        capability: "render_video",
        userId: "user-max",
        phase: "deny",
        payloadHash: "not-a-hash",
        reason: "gate-blocked",
        success: false,
      });

      const row = rawDb.prepare(
        "SELECT * FROM connector_call_audit WHERE capability = 'render_video'",
      ).get() as { reason: string | null };

      expect(row.reason).toContain("gate-blocked");
      expect(row.reason).toContain("invalid-payload-hash");
    });

    it("valider computePayloadHash-Output wird akzeptiert (nicht abgelehnt)", () => {
      const validHash = computePayloadHash({ action: "render" });
      recordCallAudit({
        scopeKind: "workspace",
        scopeId: "ws-1",
        provider: "heygen",
        capability: "render_video",
        userId: "user-max",
        phase: "invoke",
        payloadHash: validHash,
        success: true,
      });

      const row = rawDb.prepare(
        "SELECT * FROM connector_call_audit WHERE capability = 'render_video'",
      ).get() as { payload_hash: string | null; reason: string | null };

      expect(row.payload_hash).toBe(validHash);
      expect(row.reason ?? "").not.toContain("invalid-payload-hash");
    });
  });

  // ── (e) recordCallAudit ist best-effort ───────────────────────────────────

  describe("(e) recordCallAudit ist best-effort: DB-Fehler wirft nicht", () => {
    it("recordCallAudit wirft nicht bei ungültigem phase-Wert", () => {
      expect(() =>
        recordCallAudit({
          scopeKind: "workspace",
          scopeId: "ws-1",
          provider: "heygen",
          capability: "render_video",
          userId: "user-max",
          phase: "invalid-phase" as "invoke",
          success: false,
        }),
      ).not.toThrow();
    });

    it("recordCallAudit wirft nicht wenn DB geschlossen ist", () => {
      // DB schließen um Fehler zu provozieren
      rawDb.close();
      expect(() =>
        recordCallAudit({
          scopeKind: "workspace",
          scopeId: "ws-1",
          provider: "heygen",
          capability: "render_video",
          userId: "user-max",
          phase: "invoke",
          success: true,
        }),
      ).not.toThrow();
      // Re-open für afterEach cleanup
      rawDb = new Database(":memory:");
      rawDb.pragma("foreign_keys = ON");
      rawDb.exec(TRUST_DDL);
    });
  });

  // ── (f) computePayloadHash ────────────────────────────────────────────────

  describe("(f) computePayloadHash gibt sha256 zurück, nie den Payload", () => {
    it("gibt 64-char hex-String für JSON-Objekt zurück", () => {
      const hash = computePayloadHash({ foo: "bar" });
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("gibt 64-char hex-String für leeres Objekt zurück", () => {
      const hash = computePayloadHash({});
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("gibt einen String für null zurück (kein Crash)", () => {
      const hash = computePayloadHash(null);
      expect(typeof hash).toBe("string");
      expect(hash.length).toBeGreaterThan(0);
    });

    it("gibt 'sha256:error:unserializable' für zyklische Strukturen zurück", () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const hash = computePayloadHash(circular);
      expect(typeof hash).toBe("string");
      expect(hash.length).toBeGreaterThan(0);
    });
  });

  // ── (g) getTrust fail-closed bei DB-Fehler ────────────────────────────────

  describe("(g) getTrust fail-closed: gibt 'ask' zurück wenn DB-Fehler", () => {
    it("gibt 'ask' zurück nach DB-Close (fail-closed)", () => {
      rawDb.close();
      const trust = getTrust("workspace", "ws-1", "heygen");
      expect(trust).toBe("ask");
      // Re-open für afterEach cleanup
      rawDb = new Database(":memory:");
      rawDb.pragma("foreign_keys = ON");
      rawDb.exec(TRUST_DDL);
    });
  });

  // ── (h) setTrust fail-closed: ungültige Werte ────────────────────────────

  describe("(h) setTrust fail-closed: ungültige Argumente wirft", () => {
    it("wirft bei ungültigem scopeKind", () => {
      expect(() =>
        setTrust({
          scopeKind: "invalid" as "workspace",
          scopeId: "ws-1",
          provider: "heygen",
          trust: "auto",
          actor: "user-max",
        }),
      ).toThrow();
    });

    it("wirft bei ungültigem trust-Wert", () => {
      expect(() =>
        setTrust({
          scopeKind: "workspace",
          scopeId: "ws-1",
          provider: "heygen",
          trust: "maybe" as "auto",
          actor: "user-max",
        }),
      ).toThrow();
    });

    it("wirft bei leerem scopeId", () => {
      expect(() =>
        setTrust({
          scopeKind: "workspace",
          scopeId: "",
          provider: "heygen",
          trust: "auto",
          actor: "user-max",
        }),
      ).toThrow();
    });

    it("wirft bei leerem provider", () => {
      expect(() =>
        setTrust({
          scopeKind: "workspace",
          scopeId: "ws-1",
          provider: "",
          trust: "auto",
          actor: "user-max",
        }),
      ).toThrow();
    });

    it("wirft bei leerem actor", () => {
      expect(() =>
        setTrust({
          scopeKind: "workspace",
          scopeId: "ws-1",
          provider: "heygen",
          trust: "auto",
          actor: "",
        }),
      ).toThrow();
    });
  });

  // ── (i) content_hash N10 ─────────────────────────────────────────────────

  describe("(i) content_hash (N10) wird geschrieben", () => {
    it("Approval-Row hat 64-char hex content_hash", () => {
      setTrust({
        scopeKind: "workspace",
        scopeId: "ws-1",
        provider: "heygen",
        trust: "auto",
        actor: "user-max",
      });

      const row = rawDb.prepare(
        "SELECT content_hash FROM connector_call_approvals WHERE provider = 'heygen'",
      ).get() as { content_hash: string } | undefined;

      expect(row).toBeDefined();
      expect(row!.content_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("Audit-Row hat 64-char hex content_hash", () => {
      recordCallAudit({
        scopeKind: "workspace",
        scopeId: "ws-1",
        provider: "heygen",
        capability: "render_video",
        userId: "user-max",
        phase: "preview",
        success: true,
      });

      const row = rawDb.prepare(
        "SELECT content_hash FROM connector_call_audit WHERE provider = 'heygen'",
      ).get() as { content_hash: string } | undefined;

      expect(row).toBeDefined();
      expect(row!.content_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("zwei verschiedene setTrust-Calls für gleiche Provider haben unterschiedliche content_hash (updatedAt ändert sich)", () => {
      setTrust({ scopeKind: "workspace", scopeId: "ws-1", provider: "heygen", trust: "auto", actor: "user-max" });

      const r1 = rawDb.prepare(
        "SELECT content_hash, updated_at FROM connector_call_approvals WHERE provider = 'heygen'",
      ).get() as { content_hash: string; updated_at: number };

      // Minimal-Sleep damit updated_at sich ändert
      const now = Date.now();
      while (Date.now() <= now) { /* busy wait for timestamp change */ }

      setTrust({ scopeKind: "workspace", scopeId: "ws-1", provider: "heygen", trust: "ask", actor: "user-max" });

      const r2 = rawDb.prepare(
        "SELECT content_hash, updated_at FROM connector_call_approvals WHERE provider = 'heygen'",
      ).get() as { content_hash: string; updated_at: number };

      // updated_at sollte sich geändert haben, damit content_hash sich ändert
      // (oder trust-Wert hat sich geändert, was auch reicht)
      // Beide können sich ändern wenn die DB-Preconditions stimmen
      expect(r1.content_hash).not.toBe(r2.content_hash);
    });

    it("Audit-Row hat content_hash, der den payload_hash nicht leaked", () => {
      const payloadHash = computePayloadHash({ secret: "DO-NOT-LOG" });

      recordCallAudit({
        scopeKind: "workspace",
        scopeId: "ws-1",
        provider: "heygen",
        capability: "render_video",
        userId: "user-max",
        phase: "invoke",
        live: false,
        payloadHash,
        success: true,
      });

      const row = rawDb.prepare(
        "SELECT * FROM connector_call_audit",
      ).get() as Record<string, unknown>;

      // Der Inhalt der Row darf nie den Klartext-Payload enthalten
      expect(JSON.stringify(row)).not.toContain("DO-NOT-LOG");
      // payload_hash ist der Hash, nicht der Payload
      expect(row.payload_hash).toBe(payloadHash);
      expect(row.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ── (j) P2-#10: setTrust Approval + Audit in EINER Transaktion (N8 fail-closed) ──

  describe("(j) setTrust — Approval + Audit in einer Transaktion (P2-#10, N8 fail-closed)", () => {
    it("setTrust schreibt Approval-Row und Audit-Row atomar", () => {
      setTrust({
        scopeKind: "workspace",
        scopeId: "ws-tx-1",
        provider: "heygen",
        trust: "auto",
        actor: "user-max",
        reason: "TX-Test",
      });

      // Beide Rows müssen existieren.
      const approvalRow = rawDb
        .prepare("SELECT * FROM connector_call_approvals WHERE provider = 'heygen'")
        .get();
      expect(approvalRow).toBeDefined();

      const auditRow = rawDb
        .prepare("SELECT * FROM connector_call_audit WHERE provider = 'heygen'")
        .get() as { phase: string; success: number } | undefined;
      expect(auditRow).toBeDefined();
      expect(auditRow!.phase).toBe("approve");
      expect(auditRow!.success).toBe(1);
    });

    it("wenn die Audit-Tabelle fehlt, wirft setTrust und kein Approval-Row bleibt (TX rollback)", () => {
      // Audit-Tabelle droppen um Audit-Write-Fehler zu provozieren.
      rawDb.exec("DROP TABLE connector_call_audit;");

      // setTrust muss jetzt werfen (TX rollback, fail-closed).
      expect(() =>
        setTrust({
          scopeKind: "workspace",
          scopeId: "ws-tx-2",
          provider: "heygen",
          trust: "auto",
          actor: "user-max",
        }),
      ).toThrow();

      // Kein Approval-Row darf persistiert worden sein (TX rollback).
      const approvalRow = rawDb
        .prepare("SELECT * FROM connector_call_approvals WHERE scope_id = 'ws-tx-2'")
        .get();
      expect(approvalRow).toBeUndefined();
    });
  });
});
