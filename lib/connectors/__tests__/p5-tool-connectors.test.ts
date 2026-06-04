// P5 Flow Studio Tool-Connector tests · 2026-05-27.
//
// Covers:
//   (a) Seeding — ensureP5ToolConnectors() upserts the 3 connectors; idempotent.
//   (b) Findability — each connector is findable in the catalog (getConnectorProfile)
//       and lists its declared capability (listCapabilities).
//   (c) Coverage — validateCoverage() recognises image.generate / video.motion /
//       video.avatar against the seeded profiles (ok: true).
//   (d) auth_kind correctness — imagegen2='none' (engine-backed), higgsfield &
//       heygen-avatar='api_key'.
//   (e) live_gated — every registry def carries liveGated:true; imagegen2 is the
//       only engineBacked connector.
//   (f) NO live-call path without LAZYOS_CONNECTOR_LIVE — executeCall returns a
//       dry-run (dryRun:true) and performs NO external network call when the
//       master switch is unset.
//
// Strategy: vi.mock('@/db/client') injects an in-memory better-sqlite3 DB with
// the connector catalog tables (same pattern as catalog.test.ts).
//
// Run:
//   NODE_OPTIONS='--experimental-require-module' node_modules/.bin/vitest run \
//     lib/connectors/__tests__/p5-tool-connectors.test.ts

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

  -- Needed by executeCall PRE-4 (getTrust) and PRE-5 (dry-run audit).
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

vi.mock("@/db/client", () => ({
  getDb: () => Object.assign(drizzle(rawDb), { $raw: rawDb }),
}));

// Import AFTER vi.mock so the modules pick up the mocked getDb.
import {
  getConnectorProfile,
  listCapabilities,
} from "../catalog";
import { validateCoverage } from "../coverage";
import {
  P5_CAPABILITY_KEYS,
  P5_TOOL_CONNECTORS,
  ensureP5ToolConnectors,
  getP5ToolConnectorDef,
} from "../p5-tool-connectors";

beforeEach(() => {
  rawDb = new Database(":memory:");
  rawDb.exec(CATALOG_DDL);
});

afterEach(() => {
  rawDb.close();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// (a) Seeding — idempotent
// ---------------------------------------------------------------------------

describe("ensureP5ToolConnectors — seeding", () => {
  it("seeds exactly 3 connectors", () => {
    ensureP5ToolConnectors();
    expect(getConnectorProfile("imagegen2")).not.toBeNull();
    expect(getConnectorProfile("higgsfield")).not.toBeNull();
    expect(getConnectorProfile("heygen-avatar")).not.toBeNull();
  });

  it("is idempotent — second call does not duplicate or throw", () => {
    ensureP5ToolConnectors();
    ensureP5ToolConnectors();
    const count = rawDb
      .prepare(
        "SELECT COUNT(*) AS n FROM connector_catalog WHERE provider IN ('imagegen2','higgsfield','heygen-avatar')",
      )
      .get() as { n: number };
    expect(count.n).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// (b) Findability + (c) Coverage
// ---------------------------------------------------------------------------

describe("findability + coverage", () => {
  beforeEach(() => ensureP5ToolConnectors());

  it("imagegen2 declares image.generate and coverage recognises it", () => {
    const caps = listCapabilities("imagegen2");
    expect(caps.map((c) => c.name)).toContain(P5_CAPABILITY_KEYS.imagegen2);
    const profile = getConnectorProfile("imagegen2")!;
    const result = validateCoverage(["image.generate"], {
      provider: profile.provider,
      apiVersion: profile.apiVersion,
      capabilities: caps.map((c) => ({ name: c.name })),
    });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("higgsfield declares video.motion and coverage recognises it", () => {
    const caps = listCapabilities("higgsfield");
    expect(caps.map((c) => c.name)).toContain(P5_CAPABILITY_KEYS.higgsfield);
    const result = validateCoverage(["video.motion"], {
      provider: "higgsfield",
      capabilities: caps.map((c) => ({ name: c.name })),
    });
    expect(result.ok).toBe(true);
  });

  it("heygen-avatar declares video.avatar and coverage recognises it", () => {
    const caps = listCapabilities("heygen-avatar");
    expect(caps.map((c) => c.name)).toContain(P5_CAPABILITY_KEYS.heygenAvatar);
    const result = validateCoverage(["video.avatar"], {
      provider: "heygen-avatar",
      capabilities: caps.map((c) => ({ name: c.name })),
    });
    expect(result.ok).toBe(true);
  });

  it("coverage fails closed for a capability the connector does NOT declare", () => {
    const caps = listCapabilities("heygen-avatar");
    const result = validateCoverage(["image.generate"], {
      provider: "heygen-avatar",
      capabilities: caps.map((c) => ({ name: c.name })),
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("image.generate");
  });
});

// ---------------------------------------------------------------------------
// (d) auth_kind correctness
// ---------------------------------------------------------------------------

describe("auth_kind", () => {
  beforeEach(() => ensureP5ToolConnectors());

  it("imagegen2 is auth_kind 'none' (engine-backed)", () => {
    expect(getConnectorProfile("imagegen2")!.authKind).toBe("none");
    expect(getP5ToolConnectorDef("imagegen2")!.engineBacked).toBe(true);
  });

  it("higgsfield is auth_kind 'api_key'", () => {
    expect(getConnectorProfile("higgsfield")!.authKind).toBe("api_key");
    expect(getP5ToolConnectorDef("higgsfield")!.engineBacked).toBe(false);
  });

  it("heygen-avatar is auth_kind 'api_key'", () => {
    expect(getConnectorProfile("heygen-avatar")!.authKind).toBe("api_key");
    expect(getP5ToolConnectorDef("heygen-avatar")!.engineBacked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (e) live_gated registry markers
// ---------------------------------------------------------------------------

describe("live_gated markers", () => {
  it("every P5 connector is liveGated:true", () => {
    expect(P5_TOOL_CONNECTORS).toHaveLength(3);
    for (const def of P5_TOOL_CONNECTORS) {
      expect(def.liveGated).toBe(true);
      expect(def.onboardingSopRef).toBe("SOP-BUILTIN-CONNECTOR-ONBOARD-01");
    }
  });

  it("only imagegen2 is engine-backed", () => {
    const backed = P5_TOOL_CONNECTORS.filter((c) => c.engineBacked).map(
      (c) => c.profile.provider,
    );
    expect(backed).toEqual(["imagegen2"]);
  });

  it("onboarding fields never carry a credential value (PII guard would reject)", () => {
    for (const def of P5_TOOL_CONNECTORS) {
      for (const field of def.onboardingFields) {
        // Field declares only key/label/kind/required/help — no secret value.
        expect(Object.keys(field).sort()).toEqual(
          ["help", "key", "kind", "label", "required"].sort(),
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (f) NO live-call path without LAZYOS_CONNECTOR_LIVE
// ---------------------------------------------------------------------------

describe("dry-run gate — no live call without LAZYOS_CONNECTOR_LIVE", () => {
  beforeEach(() => ensureP5ToolConnectors());

  it("executeCall returns dryRun:true and performs NO network call when the switch is unset", async () => {
    vi.stubEnv("LAZYOS_CONNECTOR_LIVE", "");

    // Spy on fetch — it must NEVER be called in dry-run.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    const { executeCall } = await import("../invoke");

    const result = await executeCall({
      provider: "heygen-avatar",
      capability: "video.avatar",
      requiredCaps: ["video.avatar"],
      payload: { script: "Hello world" },
      workspaceId: "ws-p5-test",
      userId: "user-p5-test",
      approved: true,
    });

    // Dry-run: ok=true, dryRun=true, no fetch.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dryRun).toBe(true);
    }
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });
});
