// Connector Catalog tests — ACL-2 · 2026-05-24.
//
// Tests cover:
//   (a) upsert + get roundtrip — profile survives a write/read cycle intact.
//   (b) assertNonSensitiveProfile — throws on workspace_id / token / email
//       in top-level profile AND in capabilities array.
//   (c) Capabilities CASCADE — capabilities are replaced on re-upsert;
//       raw CASCADE verified via direct SQL delete.
//   (d) content_hash deterministic / N10 — same input always yields same hash,
//       64-char hex.
//   (e) Versioning — api_version update bumps the hash; old capabilities
//       are fully replaced.
//
// Strategy: vi.mock('@/db/client') injects an in-memory better-sqlite3 DB
// with only the two connector catalog tables. Same pattern used by
// server/streaming-snapshots.test.ts.
//
// Run:
//   NODE_OPTIONS='--experimental-require-module' npx vitest run \
//     lib/connectors/__tests__/catalog.test.ts

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory DB setup — injected via vi.mock below
// ---------------------------------------------------------------------------

const CATALOG_DDL = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS connector_catalog (
    id            TEXT    PRIMARY KEY,
    provider      TEXT    NOT NULL,
    display_name  TEXT    NOT NULL,
    description   TEXT,
    auth_kind     TEXT    NOT NULL DEFAULT 'api_key',
    base_url      TEXT,
    api_version   TEXT,
    docs_url      TEXT,
    source        TEXT    NOT NULL DEFAULT 'manual',
    validated_at  INTEGER,
    content_hash  TEXT    NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    UNIQUE (provider)
  );

  CREATE TABLE IF NOT EXISTS connector_capabilities (
    id                  TEXT    PRIMARY KEY,
    connector_id        TEXT    NOT NULL
                        REFERENCES connector_catalog(id) ON DELETE CASCADE,
    name                TEXT    NOT NULL,
    description         TEXT,
    input_schema_json   TEXT,
    output_schema_json  TEXT,
    mcp_tool_name       TEXT,
    required            INTEGER NOT NULL DEFAULT 0,
    UNIQUE (connector_id, name)
  );

  CREATE TABLE IF NOT EXISTS connector_catalog_audit (
    id            TEXT    PRIMARY KEY,
    ts            INTEGER NOT NULL,
    action        TEXT    NOT NULL CHECK (action IN ('upsert','delete')),
    actor         TEXT    NOT NULL DEFAULT 'system',
    provider      TEXT    NOT NULL,
    old_hash      TEXT,
    new_hash      TEXT,
    content_hash  TEXT    NOT NULL DEFAULT ''
  );
`;

let rawDb: Database.Database;

// Mock @/db/client so catalog.ts uses our in-memory DB.
// IMPORTANT: vi.mock is hoisted to the top of the file by vitest.
vi.mock("@/db/client", () => ({
  getDb: () => {
    // Lazy-create drizzle wrapper around the in-memory rawDb instance.
    // We import here (inside the factory) to avoid circular hoisting issues.
    return Object.assign(drizzle(rawDb), { $raw: rawDb });
  },
}));

// Import catalog AFTER vi.mock so it picks up the mocked getDb.
import {
  assertNonSensitiveProfile,
  assertSchemaFieldsAreStrings,
  deleteConnectorProfile,
  getConnectorProfile,
  hashCatalogRow,
  listCapabilities,
  listCatalogAudit,
  listConnectors,
  upsertConnectorProfile,
} from "../catalog";

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  rawDb = new Database(":memory:");
  rawDb.pragma("foreign_keys = ON");
  rawDb.exec(CATALOG_DDL);
});

afterEach(() => {
  rawDb.close();
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Connector Catalog — ACL-2", () => {
  // ─────────────────────────────────────────────────────────────────────────
  // (a) upsert + get roundtrip
  // ─────────────────────────────────────────────────────────────────────────

  describe("(a) upsert + get roundtrip", () => {
    it("writes a minimal profile and reads it back correctly", () => {
      upsertConnectorProfile({
        provider: "heygen",
        displayName: "HeyGen Video API",
        authKind: "api_key",
        source: "doc-research",
      });

      const row = getConnectorProfile("heygen");
      expect(row).not.toBeNull();
      expect(row!.provider).toBe("heygen");
      expect(row!.displayName).toBe("HeyGen Video API");
      expect(row!.authKind).toBe("api_key");
      expect(row!.source).toBe("doc-research");
    });

    it("writes a full profile with all optional fields and reads them back", () => {
      upsertConnectorProfile({
        provider: "stripe",
        displayName: "Stripe Payments API",
        description: "Payment processing platform",
        authKind: "api_key",
        baseUrl: "https://api.stripe.com",
        apiVersion: "2024-06-20",
        docsUrl: "https://stripe.com/docs/api",
        source: "manual",
        validatedAt: 1716000000000,
      });

      const row = getConnectorProfile("stripe");
      expect(row).not.toBeNull();
      expect(row!.description).toBe("Payment processing platform");
      expect(row!.baseUrl).toBe("https://api.stripe.com");
      expect(row!.apiVersion).toBe("2024-06-20");
      expect(row!.docsUrl).toBe("https://stripe.com/docs/api");
      expect(row!.validatedAt).toBe(1716000000000);
    });

    it("returns null for an unknown provider", () => {
      const row = getConnectorProfile("nonexistent-provider-xyz");
      expect(row).toBeNull();
    });

    it("re-upsert with same data keeps the same row id (no duplication)", () => {
      const profile = {
        provider: "openai",
        displayName: "OpenAI API",
        authKind: "api_key" as const,
        apiVersion: "v1",
        source: "manual" as const,
      };

      upsertConnectorProfile(profile);
      const first = getConnectorProfile("openai")!;

      // Re-upsert with identical data.
      upsertConnectorProfile(profile);
      const second = getConnectorProfile("openai")!;

      // ME-3: content_hash now includes updated_at, so a re-write moves the
      // hash even for identical substantive data. The ROW IDENTITY is what
      // must stay stable (single row per provider, not duplicated).
      expect(first.id).toBe(second.id);
      expect(second.provider).toBe("openai");
    });

    it("hashCatalogRow with identical input (incl. updatedAt) is deterministic (N10)", () => {
      // N10 determinism is verified at the pure-function level where updatedAt
      // is held constant — see the (d) content_hash suite.
      const fixed = {
        id: "CONN-FIXED",
        provider: "openai",
        displayName: "OpenAI API",
        description: null,
        authKind: "api_key" as const,
        baseUrl: null,
        apiVersion: "v1",
        docsUrl: null,
        source: "manual" as const,
        validatedAt: null,
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      };
      expect(hashCatalogRow(fixed)).toBe(hashCatalogRow(fixed));
    });

    it("listConnectors returns all upserted providers", () => {
      upsertConnectorProfile({ provider: "heygen", displayName: "HeyGen" });
      upsertConnectorProfile({ provider: "stripe", displayName: "Stripe" });
      upsertConnectorProfile({ provider: "openai", displayName: "OpenAI" });

      const rows = listConnectors();
      const providers = rows.map((r) => r.provider).sort();
      expect(providers).toEqual(["heygen", "openai", "stripe"]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (b) PII Hard-Guard (assertNonSensitiveProfile)
  // ─────────────────────────────────────────────────────────────────────────

  describe("(b) PII Hard-Guard (assertNonSensitiveProfile)", () => {
    it("throws CONNECTOR_PII_GUARD when workspace_id is present", () => {
      expect(() =>
        assertNonSensitiveProfile({
          provider: "heygen",
          displayName: "HeyGen",
          workspace_id: "ws-123",
        }),
      ).toThrow("CONNECTOR_PII_GUARD");
    });

    it("throws CONNECTOR_PII_GUARD when token key is present", () => {
      expect(() =>
        assertNonSensitiveProfile({
          provider: "stripe",
          displayName: "Stripe",
          token: "sk-live-secret-value",
        }),
      ).toThrow("CONNECTOR_PII_GUARD");
    });

    it("throws CONNECTOR_PII_GUARD when email key is present", () => {
      expect(() =>
        assertNonSensitiveProfile({
          provider: "sendgrid",
          displayName: "SendGrid",
          email: "user@example.com",
        }),
      ).toThrow("CONNECTOR_PII_GUARD");
    });

    it("throws CONNECTOR_PII_GUARD when org_id key is present", () => {
      expect(() =>
        assertNonSensitiveProfile({
          provider: "heygen",
          displayName: "HeyGen",
          org_id: "org-abc",
        }),
      ).toThrow("CONNECTOR_PII_GUARD");
    });

    it("throws CONNECTOR_PII_GUARD when user_id key is present", () => {
      expect(() =>
        assertNonSensitiveProfile({
          provider: "heygen",
          displayName: "HeyGen",
          user_id: "user-abc",
        }),
      ).toThrow("CONNECTOR_PII_GUARD");
    });

    it("throws CONNECTOR_PII_GUARD when api_key value key is present", () => {
      expect(() =>
        assertNonSensitiveProfile({
          provider: "heygen",
          displayName: "HeyGen",
          api_key: "live-key-value",
        }),
      ).toThrow("CONNECTOR_PII_GUARD");
    });

    it("throws CONNECTOR_PII_GUARD when credential key is inside a capability", () => {
      expect(() =>
        assertNonSensitiveProfile({
          provider: "heygen",
          displayName: "HeyGen",
          capabilities: [
            {
              name: "render_video",
              credential: "secret-bearer",
            },
          ],
        }),
      ).toThrow("CONNECTOR_PII_GUARD");
    });

    it("does NOT throw for a clean, non-sensitive profile", () => {
      expect(() =>
        assertNonSensitiveProfile({
          provider: "heygen",
          displayName: "HeyGen Video API",
          description: "Video generation platform",
          authKind: "api_key",
          baseUrl: "https://api.heygen.com",
          apiVersion: "v2",
          docsUrl: "https://docs.heygen.com",
          source: "doc-research",
          capabilities: [
            {
              name: "render_video",
              description: "Render an avatar video",
              inputSchemaJson: '{"type":"object"}',
            },
          ],
        }),
      ).not.toThrow();
    });

    it("upsertConnectorProfile throws before writing if profile is sensitive", () => {
      expect(() =>
        upsertConnectorProfile({
          provider: "should-not-exist",
          displayName: "Poisoned Profile",
          // @ts-expect-error -- deliberate PII injection test
          workspace_id: "ws-poison",
        }),
      ).toThrow("CONNECTOR_PII_GUARD");

      // Verify nothing was written to the DB
      expect(getConnectorProfile("should-not-exist")).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (c) Capabilities CRUD + CASCADE
  // ─────────────────────────────────────────────────────────────────────────

  describe("(c) Capabilities CRUD + CASCADE", () => {
    it("writes capabilities and lists them back", () => {
      upsertConnectorProfile({
        provider: "heygen",
        displayName: "HeyGen Video API",
        capabilities: [
          {
            name: "render_video",
            description: "Render an avatar video from a script",
            inputSchemaJson: '{"type":"object","properties":{"script":{"type":"string"}}}',
            mcpToolName: "mcp__heygen__render_video",
            required: true,
          },
          {
            name: "list_avatars",
            description: "List available avatars",
            inputSchemaJson: '{"type":"object"}',
            mcpToolName: "mcp__heygen__list_avatars",
            required: false,
          },
        ],
      });

      const caps = listCapabilities("heygen");
      expect(caps).toHaveLength(2);
      const names = caps.map((c) => c.name).sort();
      expect(names).toEqual(["list_avatars", "render_video"]);
    });

    it("capabilities carry the correct connector_id FK", () => {
      upsertConnectorProfile({
        provider: "heygen",
        displayName: "HeyGen Video API",
        capabilities: [{ name: "render_video", required: true }],
      });

      const catalogRow = getConnectorProfile("heygen")!;
      const caps = listCapabilities("heygen");
      expect(caps.every((c) => c.connectorId === catalogRow.id)).toBe(true);
    });

    it("listCapabilities returns empty array for unknown provider", () => {
      const caps = listCapabilities("nonexistent-xyz");
      expect(caps).toHaveLength(0);
    });

    it("CASCADE: deleting the catalog row removes all capabilities", () => {
      upsertConnectorProfile({
        provider: "heygen",
        displayName: "HeyGen",
        capabilities: [
          { name: "render_video" },
          { name: "list_avatars" },
        ],
      });

      expect(listCapabilities("heygen")).toHaveLength(2);

      // Delete the catalog row via raw SQL (simulates external DELETE)
      const row = getConnectorProfile("heygen")!;
      rawDb.exec(`DELETE FROM connector_catalog WHERE id = '${row.id}'`);

      // Capabilities must be removed by CASCADE
      expect(listCapabilities("heygen")).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (d) content_hash — deterministic / N10
  // ─────────────────────────────────────────────────────────────────────────

  describe("(d) content_hash — N10 determinism", () => {
    it("hashCatalogRow returns a 64-char hex string", () => {
      const hash = hashCatalogRow({
        id: "CONN-TEST-001",
        provider: "heygen",
        displayName: "HeyGen",
        description: null,
        authKind: "api_key",
        baseUrl: null,
        apiVersion: null,
        docsUrl: null,
        source: "manual",
        validatedAt: null,
        createdAt: 1716000000000,
        updatedAt: 1716000000000,
      });
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("hashCatalogRow is deterministic — same input always yields same hash", () => {
      const input = {
        id: "CONN-TEST-001",
        provider: "heygen",
        displayName: "HeyGen Video API",
        description: "Video generation",
        authKind: "api_key" as const,
        baseUrl: "https://api.heygen.com",
        apiVersion: "v2",
        docsUrl: "https://docs.heygen.com",
        source: "doc-research" as const,
        validatedAt: 1716000000000,
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      };
      const h1 = hashCatalogRow(input);
      const h2 = hashCatalogRow(input);
      expect(h1).toBe(h2);
    });

    it("hashCatalogRow changes when content changes (N10 tamper-evidence)", () => {
      const base = {
        id: "CONN-TEST-001",
        provider: "heygen",
        displayName: "HeyGen Video API",
        description: null,
        authKind: "api_key" as const,
        baseUrl: null,
        apiVersion: "v1",
        docsUrl: null,
        source: "manual" as const,
        validatedAt: null,
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      };
      const h1 = hashCatalogRow(base);
      const h2 = hashCatalogRow({ ...base, apiVersion: "v2" });
      expect(h1).not.toBe(h2);
    });

    it("ME-3: hashCatalogRow changes when only updated_at moves", () => {
      const base = {
        id: "CONN-TEST-001",
        provider: "heygen",
        displayName: "HeyGen Video API",
        description: null,
        authKind: "api_key" as const,
        baseUrl: null,
        apiVersion: "v1",
        docsUrl: null,
        source: "manual" as const,
        validatedAt: null,
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      };
      const h1 = hashCatalogRow(base);
      const h2 = hashCatalogRow({ ...base, updatedAt: 1700000999999 });
      expect(h1).not.toBe(h2);
    });

    it("upserted catalog row has a valid content_hash (64-char hex)", () => {
      upsertConnectorProfile({
        provider: "heygen",
        displayName: "HeyGen Video API",
        authKind: "api_key",
      });
      const row = getConnectorProfile("heygen")!;
      expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (e) Versioning — api_version update bumps hash; capabilities replaced
  // ─────────────────────────────────────────────────────────────────────────

  describe("(e) Versioning — api_version update + capability replacement", () => {
    it("updating api_version changes the content_hash", () => {
      upsertConnectorProfile({
        provider: "heygen",
        displayName: "HeyGen Video API",
        apiVersion: "v1",
      });
      const v1Row = getConnectorProfile("heygen")!;

      upsertConnectorProfile({
        provider: "heygen",
        displayName: "HeyGen Video API",
        apiVersion: "v2",
      });
      const v2Row = getConnectorProfile("heygen")!;

      // Same id — row was updated, not duplicated
      expect(v1Row.id).toBe(v2Row.id);
      // api_version was updated
      expect(v2Row.apiVersion).toBe("v2");
      // content_hash changed (N10: hash reflects current content)
      expect(v1Row.contentHash).not.toBe(v2Row.contentHash);
    });

    it("upsert with new capabilities replaces old capabilities completely", () => {
      upsertConnectorProfile({
        provider: "heygen",
        displayName: "HeyGen",
        capabilities: [
          { name: "render_video" },
          { name: "list_avatars" },
        ],
      });
      expect(listCapabilities("heygen")).toHaveLength(2);

      // Re-upsert with different capability set
      upsertConnectorProfile({
        provider: "heygen",
        displayName: "HeyGen",
        capabilities: [
          { name: "render_video" },
          { name: "generate_script" },
          { name: "list_voices" },
        ],
      });

      const caps = listCapabilities("heygen");
      expect(caps).toHaveLength(3);
      const names = caps.map((c) => c.name).sort();
      expect(names).toEqual(["generate_script", "list_voices", "render_video"]);
      // list_avatars must be gone (replaced, not merged)
      expect(names).not.toContain("list_avatars");
    });

    it("upsert WITHOUT capabilities field leaves existing capabilities unchanged", () => {
      upsertConnectorProfile({
        provider: "heygen",
        displayName: "HeyGen",
        capabilities: [{ name: "render_video" }, { name: "list_avatars" }],
      });

      // Re-upsert without capabilities key — existing caps must be preserved
      upsertConnectorProfile({
        provider: "heygen",
        displayName: "HeyGen Updated",
        // capabilities intentionally omitted
      });

      expect(listCapabilities("heygen")).toHaveLength(2);
      // displayName update was applied
      expect(getConnectorProfile("heygen")!.displayName).toBe("HeyGen Updated");
    });

    it("each provider gets its own independent capabilities (no cross-contamination)", () => {
      upsertConnectorProfile({
        provider: "heygen",
        displayName: "HeyGen",
        capabilities: [{ name: "render_video" }],
      });
      upsertConnectorProfile({
        provider: "openai",
        displayName: "OpenAI",
        capabilities: [{ name: "chat_completion" }, { name: "embeddings" }],
      });

      expect(listCapabilities("heygen")).toHaveLength(1);
      expect(listCapabilities("openai")).toHaveLength(2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (f) ME-1 — schema fields must be serialized strings, not raw objects
  // ─────────────────────────────────────────────────────────────────────────

  describe("(f) ME-1 schema-string guard", () => {
    it("accepts string inputSchemaJson", () => {
      expect(() =>
        assertSchemaFieldsAreStrings([
          { name: "render_video", inputSchemaJson: '{"type":"object"}' },
        ]),
      ).not.toThrow();
    });

    it("accepts null / absent schema fields", () => {
      expect(() =>
        assertSchemaFieldsAreStrings([
          { name: "render_video", inputSchemaJson: null },
          { name: "list_avatars" },
        ]),
      ).not.toThrow();
    });

    it("throws CONNECTOR_PII_GUARD when inputSchemaJson is a raw object", () => {
      expect(() =>
        assertSchemaFieldsAreStrings([
          // A raw object could smuggle nested PII past the key-name guard.
          { name: "render_video", inputSchemaJson: { token: "leaked-secret" } },
        ]),
      ).toThrow("CONNECTOR_PII_GUARD");
    });

    it("throws CONNECTOR_PII_GUARD when outputSchemaJson is a raw object", () => {
      expect(() =>
        assertSchemaFieldsAreStrings([
          { name: "render_video", outputSchemaJson: { workspace_id: "ws-1" } },
        ]),
      ).toThrow("CONNECTOR_PII_GUARD");
    });

    it("upsertConnectorProfile rejects a raw schema object before writing", () => {
      expect(() =>
        upsertConnectorProfile({
          provider: "should-not-exist",
          displayName: "Bad Schema",
          capabilities: [
            {
              name: "render_video",
              // @ts-expect-error -- deliberate raw-object injection (must be string)
              inputSchemaJson: { token: "leaked" },
            },
          ],
        }),
      ).toThrow("CONNECTOR_PII_GUARD");

      // Nothing was written
      expect(getConnectorProfile("should-not-exist")).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (g) ME-4 — N8 audit trail for catalog writes
  // ─────────────────────────────────────────────────────────────────────────

  describe("(g) ME-4 N8 audit trail", () => {
    it("upsert writes an 'upsert' audit row with new_hash and null old_hash on first insert", () => {
      upsertConnectorProfile(
        { provider: "heygen", displayName: "HeyGen" },
        { actor: "user-123" },
      );

      const audit = listCatalogAudit("heygen");
      expect(audit).toHaveLength(1);
      expect(audit[0].action).toBe("upsert");
      expect(audit[0].actor).toBe("user-123");
      expect(audit[0].provider).toBe("heygen");
      expect(audit[0].oldHash).toBeNull();
      expect(audit[0].newHash).toMatch(/^[0-9a-f]{64}$/);
      // N10: the audit row itself carries a content_hash.
      expect(audit[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("defaults actor to 'system' when no context is given", () => {
      upsertConnectorProfile({ provider: "openai", displayName: "OpenAI" });
      const audit = listCatalogAudit("openai");
      expect(audit).toHaveLength(1);
      expect(audit[0].actor).toBe("system");
    });

    it("re-upsert records old_hash → new_hash transition", () => {
      upsertConnectorProfile({
        provider: "heygen",
        displayName: "HeyGen",
        apiVersion: "v1",
      });
      const firstHash = getConnectorProfile("heygen")!.contentHash;

      upsertConnectorProfile({
        provider: "heygen",
        displayName: "HeyGen",
        apiVersion: "v2",
      });
      const secondHash = getConnectorProfile("heygen")!.contentHash;

      const audit = listCatalogAudit("heygen");
      expect(audit).toHaveLength(2);
      // Second audit row chains old → new.
      const second = audit[1];
      expect(second.oldHash).toBe(firstHash);
      expect(second.newHash).toBe(secondHash);
    });

    it("delete writes a 'delete' audit row with null new_hash and returns true", () => {
      upsertConnectorProfile({ provider: "heygen", displayName: "HeyGen" });
      const hashBefore = getConnectorProfile("heygen")!.contentHash;

      const deleted = deleteConnectorProfile("heygen", { actor: "user-9" });
      expect(deleted).toBe(true);
      expect(getConnectorProfile("heygen")).toBeNull();

      const audit = listCatalogAudit("heygen");
      // 1 upsert + 1 delete
      expect(audit).toHaveLength(2);
      const del = audit.find((a) => a.action === "delete")!;
      expect(del.actor).toBe("user-9");
      expect(del.oldHash).toBe(hashBefore);
      expect(del.newHash).toBeNull();
    });

    it("delete of an unknown provider returns false and writes no audit row", () => {
      const deleted = deleteConnectorProfile("nonexistent-xyz");
      expect(deleted).toBe(false);
      expect(listCatalogAudit("nonexistent-xyz")).toHaveLength(0);
    });

    it("best-effort: audit failure does not abort the catalog write", () => {
      // Drop the audit table to simulate a broken/missing audit surface.
      rawDb.exec("DROP TABLE connector_catalog_audit;");

      // The catalog write must still succeed (best-effort audit).
      expect(() =>
        upsertConnectorProfile({ provider: "heygen", displayName: "HeyGen" }),
      ).not.toThrow();
      expect(getConnectorProfile("heygen")).not.toBeNull();
    });
  });
});
