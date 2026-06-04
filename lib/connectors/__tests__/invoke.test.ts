// Invocation-Executor Tests (ACL-5-D) — 2026-05-24.
//
// Tests cover:
//   (a) coverage-fail → blocked:'coverage-fail', kein Netzwerk.
//   (b) capability nicht im S4-hardened Set → blocked:'not-hardened', kein Netzwerk.
//   (c) trust='ask' ohne approved → blocked:'awaiting-approval'.
//   (d) LAZYOS_CONNECTOR_LIVE=off + alle Gates ok → dryRun:true, kein echter Call.
//   (e) Secret taucht in result/audit NICHT auf (maskiert/gehasht).
//   (f) approved=true ODER trust='auto' + LIVE on → echter Call-Pfad (mock fetch).
//   (g) previewCall schreibt audit-row mit phase='preview', secret nicht in Preview.
//   (h) PRE-1: kein Profil → blocked:'no-profile'.
//   (i) credential-missing → blocked:'credential-missing' (nach LIVE=on + approved).
//
// Strategy:
//   - vi.mock('@/db/client') injiziert in-memory SQLite (identisches Muster wie trust.test.ts).
//   - vi.mock('node:crypto') NICHT — wir nutzen echte Crypto-Hashes.
//   - globalThis.fetch wird via vi.stubGlobal für echte-Call-Tests gemockt.
//   - LAZYOS_CONNECTOR_LIVE + LAZYOS_CREDENTIAL_KEY via process.env gesetzt.
//   - resolveApiCredential gemockt (vermeidet workspace/org/permission Setup-Overhead).
//
// Run:
//   NODE_OPTIONS='--experimental-require-module' npx vitest run \
//     lib/connectors/__tests__/invoke.test.ts

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockedFunction,
} from "vitest";

// ─── In-memory DB DDL ────────────────────────────────────────────────────────

const INVOKE_DDL = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS connector_catalog (
    id            TEXT    PRIMARY KEY,
    provider      TEXT    NOT NULL UNIQUE,
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
    updated_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS connector_capabilities (
    id                TEXT    PRIMARY KEY,
    connector_id      TEXT    NOT NULL,
    name              TEXT    NOT NULL,
    description       TEXT,
    input_schema_json TEXT,
    output_schema_json TEXT,
    mcp_tool_name     TEXT,
    required          INTEGER NOT NULL DEFAULT 0,
    UNIQUE (connector_id, name)
  );

  CREATE TABLE IF NOT EXISTS connector_catalog_audit (
    id            TEXT    PRIMARY KEY,
    ts            INTEGER NOT NULL,
    action        TEXT    NOT NULL,
    actor         TEXT    NOT NULL DEFAULT 'system',
    provider      TEXT    NOT NULL,
    old_hash      TEXT,
    new_hash      TEXT,
    content_hash  TEXT    NOT NULL DEFAULT ''
  );

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

// ─── DB-Mock (muss vor allen anderen Imports stehen — vitest hoist) ───────────

let rawDb: Database.Database;

vi.mock("@/db/client", () => ({
  getDb: () => Object.assign(drizzle(rawDb), { $raw: rawDb }),
}));

// resolveApiCredential: gemockt damit wir keine workspace/org/permissions Tabellen brauchen.
// Der Mock gibt ein Credential mit bekanntem Secret zurück oder null.
const MOCK_SECRET = "sk-test-secret-value-that-must-never-appear-in-output";
const MOCK_CRED = {
  id: "apicred-test-1",
  provider: "heygen",
  kind: "api_key" as const,
  secret: MOCK_SECRET,
  config: null,
  lastValidatedAt: null,
  source: "workspace-cred" as const,
};

// ACL-5-D-Härtung: previewCall ruft credentialExists() (decrypt-frei), NICHT
// resolveApiCredential. Beide werden gemockt — resolveApiCredential darf in
// previewCall NIE aufgerufen werden (eigener Test dafür).
vi.mock("@/lib/credentials/vault", () => ({
  resolveApiCredential: vi.fn(),
  credentialExists: vi.fn(),
}));

// Imports NACH vi.mock.
import { upsertConnectorProfile } from "@/lib/connectors/catalog";
import { setTrust } from "@/lib/connectors/trust";
import {
  credentialExists,
  resolveApiCredential,
} from "@/lib/credentials/vault";
import {
  executeCall,
  previewCall,
  type InvokeArgs,
} from "../invoke";

// ─── Typed mock helper ───────────────────────────────────────────────────────

const mockedResolve = resolveApiCredential as MockedFunction<typeof resolveApiCredential>;
const mockedExists = credentialExists as MockedFunction<typeof credentialExists>;

// ─── Testdaten ───────────────────────────────────────────────────────────────

const NOW = Date.now();

/** Minimales Heygen-Profil mit render_video-Capability. */
function seedHeygenProfile(): void {
  upsertConnectorProfile({
    provider: "heygen",
    displayName: "HeyGen",
    authKind: "api_key",
    baseUrl: "https://api.heygen.com",
    capabilities: [
      {
        name: "render_video",
        mcpToolName: "mcp__heygen__render_video",
        description: "Render a video",
        required: true,
      },
      {
        name: "list_avatars",
        mcpToolName: "mcp__heygen__list_avatars",
        description: "List available avatars",
        required: false,
      },
    ],
  });
}

/** Profil OHNE Coverage für render_video (nur list_avatars). */
function seedHeygenProfileNoCoverage(): void {
  upsertConnectorProfile({
    provider: "heygen-nc",
    displayName: "HeyGen NoCoverage",
    authKind: "api_key",
    baseUrl: "https://api.heygen.com",
    capabilities: [
      {
        name: "list_avatars",
        mcpToolName: "mcp__heygen-nc__list_avatars",
        required: false,
      },
    ],
  });
}

/** Basis-Args für einen render_video Call. */
function baseArgs(overrides?: Partial<InvokeArgs>): InvokeArgs {
  return {
    provider: "heygen",
    capability: "render_video",
    requiredCaps: ["render_video"],
    payload: { template_id: "tmpl-1", ratio: 1.0 },
    workspaceId: "ws-test",
    userId: "user-max",
    ...overrides,
  };
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  rawDb = new Database(":memory:");
  rawDb.pragma("foreign_keys = ON");
  rawDb.exec(INVOKE_DDL);

  // Credential-Key für vault (muss gesetzt sein auch wenn vault gemockt ist —
  // maskedPreview in previewCall nutzt den echten vault-mock).
  process.env.LAZYOS_CREDENTIAL_KEY =
    "0000000000000000000000000000000000000000000000000000000000000001";

  // Default: LIVE off.
  delete process.env.LAZYOS_CONNECTOR_LIVE;

  // Default: kein Credential (weder resolve noch existence).
  mockedResolve.mockReturnValue(null);
  mockedExists.mockReturnValue({
    exists: false,
    source: null,
    scopeLabel: "workspace:ws-test",
  });
});

afterEach(() => {
  rawDb.close();
  delete process.env.LAZYOS_CONNECTOR_LIVE;
  vi.clearAllMocks();
});

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

/** Liest alle Audit-Rows aus der in-memory DB. */
function readAuditRows(): Array<{
  phase: string;
  provider: string;
  capability: string;
  live: number;
  payload_hash: string | null;
  result_summary: string | null;
  success: number;
  reason: string | null;
}> {
  return rawDb
    .prepare(
      `SELECT phase, provider, capability, live, payload_hash,
              result_summary, success, reason
       FROM connector_call_audit ORDER BY rowid ASC`,
    )
    .all() as ReturnType<typeof readAuditRows>;
}

// ─────────────────────────────────────────────────────────────────────────────
// (h) PRE-1: kein Profil → blocked:'no-profile'
// ─────────────────────────────────────────────────────────────────────────────

describe("(h) PRE-1: Kein Profil → blocked:'no-profile'", () => {
  it("Unbekannter Provider → blocked:'no-profile', kein Netzwerk-Call", async () => {
    const result = await executeCall(
      baseArgs({ provider: "unknown-provider" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe("no-profile");
    }
  });

  it("PRE-1 schreibt eine 'deny'-Audit-Row", async () => {
    await executeCall(baseArgs({ provider: "unknown-provider" }));
    const rows = readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].phase).toBe("deny");
    expect(rows[0].success).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (a) PRE-2: Coverage-fail → blocked:'coverage-fail'
// ─────────────────────────────────────────────────────────────────────────────

describe("(a) PRE-2: Coverage-fail → blocked:'coverage-fail'", () => {
  it("Provider hat Capability nicht → blocked:'coverage-fail', kein Netzwerk", async () => {
    seedHeygenProfileNoCoverage();
    const result = await executeCall(
      baseArgs({
        provider: "heygen-nc",
        capability: "render_video",
        requiredCaps: ["render_video"],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe("coverage-fail");
    }
  });

  it("Coverage-fail schreibt 'deny'-Audit-Row", async () => {
    seedHeygenProfileNoCoverage();
    await executeCall(
      baseArgs({
        provider: "heygen-nc",
        capability: "render_video",
        requiredCaps: ["render_video"],
      }),
    );
    const rows = readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].phase).toBe("deny");
    expect(rows[0].reason).toContain("coverage-fail");
  });

  it("Coverage-fail: fetch wird NIEMALS aufgerufen", async () => {
    const fetchMockFn = vi.fn();
    vi.stubGlobal("fetch", fetchMockFn);
    seedHeygenProfileNoCoverage();
    await executeCall(
      baseArgs({
        provider: "heygen-nc",
        capability: "render_video",
        requiredCaps: ["render_video"],
      }),
    );
    expect(fetchMockFn).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) PRE-3: Capability nicht im S4-hardened Set → blocked:'not-hardened'
// ─────────────────────────────────────────────────────────────────────────────

describe("(b) PRE-3: Capability nicht im S4-hardened Set → blocked:'not-hardened'", () => {
  it("Bekannte Capability aber wird mit Profil OHNE mcpToolName gebaut → blocked:'not-hardened'", async () => {
    // Seed: render_video mit mcpToolName=null (REST-only, kein MCP-Tool).
    upsertConnectorProfile({
      provider: "heygen-nomc",
      displayName: "HeyGen NoMCP",
      authKind: "api_key",
      baseUrl: "https://api.heygen.com",
      capabilities: [
        {
          name: "render_video",
          mcpToolName: null, // REST-only — assertCallAllowed muss werfen.
          required: true,
        },
      ],
    });

    const result = await executeCall(
      baseArgs({
        provider: "heygen-nomc",
        capability: "render_video",
        requiredCaps: ["render_video"],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe("not-hardened");
    }
  });

  it("K1-RAG-Tool in Capability → blocked:'not-hardened' (K1-Hard-Block)", async () => {
    // K1: mcp__local-rag__search ist von matchesK1Deny() geblockt.
    upsertConnectorProfile({
      provider: "local-rag",
      displayName: "Local RAG",
      authKind: "none",
      capabilities: [
        {
          name: "search",
          mcpToolName: "mcp__local-rag__search", // K1-geblockt.
          required: true,
        },
      ],
    });

    const result = await executeCall(
      baseArgs({
        provider: "local-rag",
        capability: "search",
        requiredCaps: ["search"],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe("not-hardened");
    }
  });

  it("S4-gate: fetch wird bei 'not-hardened' NICHT aufgerufen", async () => {
    const fetchMockFn = vi.fn();
    vi.stubGlobal("fetch", fetchMockFn);
    upsertConnectorProfile({
      provider: "heygen-nomc2",
      displayName: "X",
      authKind: "api_key",
      capabilities: [{ name: "render_video", mcpToolName: null, required: true }],
    });
    await executeCall(
      baseArgs({
        provider: "heygen-nomc2",
        capability: "render_video",
        requiredCaps: ["render_video"],
      }),
    );
    expect(fetchMockFn).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) PRE-4: trust='ask' ohne approved → blocked:'awaiting-approval'
// ─────────────────────────────────────────────────────────────────────────────

describe("(c) PRE-4: trust='ask' ohne approval → blocked:'awaiting-approval'", () => {
  it("Default trust='ask' ohne approved:true → blocked:'awaiting-approval'", async () => {
    seedHeygenProfile();
    const result = await executeCall(
      baseArgs({ approved: undefined }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe("awaiting-approval");
    }
  });

  it("approved:false explizit → blocked:'awaiting-approval'", async () => {
    seedHeygenProfile();
    const result = await executeCall(
      baseArgs({ approved: false }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe("awaiting-approval");
    }
  });

  it("awaiting-approval schreibt 'deny'-Audit-Row", async () => {
    seedHeygenProfile();
    await executeCall(baseArgs({ approved: undefined }));
    const rows = readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].phase).toBe("deny");
    expect(rows[0].reason).toContain("awaiting-approval");
  });

  it("awaiting-approval: fetch wird NICHT aufgerufen", async () => {
    const fetchMockFn = vi.fn();
    vi.stubGlobal("fetch", fetchMockFn);
    seedHeygenProfile();
    await executeCall(baseArgs({ approved: false }));
    expect(fetchMockFn).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) PRE-5: LIVE off + alle Gates ok → dryRun:true, kein echter Call
// ─────────────────────────────────────────────────────────────────────────────

describe("(d) PRE-5: LAZYOS_CONNECTOR_LIVE=off → dryRun:true", () => {
  it("LIVE nicht gesetzt + approved:true → ok:true dryRun:true", async () => {
    seedHeygenProfile();
    delete process.env.LAZYOS_CONNECTOR_LIVE;

    const result = await executeCall(baseArgs({ approved: true }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dryRun).toBe(true);
    }
  });

  it("LIVE=off (explizit) + trust='auto' → dryRun:true", async () => {
    seedHeygenProfile();
    process.env.LAZYOS_CONNECTOR_LIVE = "off";
    setTrust({
      scopeKind: "workspace",
      scopeId: "ws-test",
      provider: "heygen",
      trust: "auto",
      actor: "user-max",
    });
    // Trust-Audit-Row ignorieren.
    rawDb.exec("DELETE FROM connector_call_audit");

    const result = await executeCall(baseArgs({ approved: false }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dryRun).toBe(true);
    }
  });

  it("dryRun-Ergebnis enthält 'DRY-RUN' Label im simulatedResult", async () => {
    seedHeygenProfile();
    const result = await executeCall(baseArgs({ approved: true }));

    if (result.ok && result.dryRun) {
      expect(result.simulatedResult).toContain("DRY-RUN");
      expect(result.simulatedResult).toContain("LAZYOS_CONNECTOR_LIVE");
    }
  });

  it("dryRun schreibt 'dry-run'-Audit-Row mit live=0", async () => {
    seedHeygenProfile();
    await executeCall(baseArgs({ approved: true }));
    const rows = readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].phase).toBe("dry-run");
    expect(rows[0].live).toBe(0);
    expect(rows[0].success).toBe(1);
  });

  it("dryRun: fetch wird NICHT aufgerufen", async () => {
    const fetchMockFn = vi.fn();
    vi.stubGlobal("fetch", fetchMockFn);
    seedHeygenProfile();
    await executeCall(baseArgs({ approved: true }));
    expect(fetchMockFn).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (e) Secret-Leak-Prävention: Secret taucht in result/audit NICHT auf
// ─────────────────────────────────────────────────────────────────────────────

describe("(e) Secret-Leak-Prävention: Secret nie in result/audit", () => {
  it("dryRun-Ergebnis enthält das Secret NICHT", async () => {
    seedHeygenProfile();
    mockedResolve.mockReturnValue(MOCK_CRED);

    const result = await executeCall(baseArgs({ approved: true }));

    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain(MOCK_SECRET);
    expect(resultStr).not.toContain("sk-test-secret");
  });

  it("Audit-Rows enthalten das Secret NICHT (weder payload_hash noch result_summary)", async () => {
    seedHeygenProfile();
    mockedResolve.mockReturnValue(MOCK_CRED);

    await executeCall(baseArgs({ approved: true }));

    const rows = readAuditRows();
    for (const row of rows) {
      const rowStr = JSON.stringify(row);
      expect(rowStr).not.toContain(MOCK_SECRET);
      expect(rowStr).not.toContain("sk-test-secret");
    }
  });

  it("payload_hash in Audit-Row ist ein SHA-256-Hash (nicht der Payload)", async () => {
    seedHeygenProfile();
    await executeCall(baseArgs({ approved: true }));

    const rows = readAuditRows();
    const row = rows[0];
    // SHA-256 ist 64 hex chars.
    if (row.payload_hash) {
      expect(row.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    // Payload-Werte dürfen nicht im Hash-Feld sein.
    expect(row.payload_hash).not.toContain("tmpl-1");
  });

  it("previewCall: credentialPreview ist decrypt-freies Label (nicht der Klartext)", async () => {
    seedHeygenProfile();
    mockedExists.mockReturnValue({
      exists: true,
      source: "workspace-cred",
      scopeLabel: "workspace:ws-test",
    });

    const preview = previewCall(baseArgs());

    expect(preview.credentialPreview).not.toBe(MOCK_SECRET);
    expect(preview.credentialPreview).not.toContain("sk-test-secret");
    // Decrypt-freies Label mit Bullet-Points (UI-Konsistenz).
    if (preview.credentialPreview) {
      expect(preview.credentialPreview).toContain("•");
    }
  });

  it("ACL-5-D-Härtung: previewCall ruft resolveApiCredential (=decrypt) NICHT auf", () => {
    seedHeygenProfile();
    mockedExists.mockReturnValue({
      exists: true,
      source: "workspace-cred",
      scopeLabel: "workspace:ws-test",
    });

    previewCall(baseArgs());

    // Finding 3: kein decrypt-Pfad in previewCall — nur credentialExists.
    expect(mockedResolve).not.toHaveBeenCalled();
    expect(mockedExists).toHaveBeenCalledWith("ws-test", "heygen");
  });

  it("CallResult im LIVE-Pfad enthält das Secret NICHT (mock fetch)", async () => {
    seedHeygenProfile();
    process.env.LAZYOS_CONNECTOR_LIVE = "on";
    mockedResolve.mockReturnValue(MOCK_CRED);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => "512" },
      }),
    );

    const result = await executeCall(baseArgs({ approved: true }));

    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain(MOCK_SECRET);
    expect(resultStr).not.toContain("sk-test-secret");

    vi.unstubAllGlobals();
  });

  it("LIVE-Audit-Row enthält das Secret NICHT (mock fetch)", async () => {
    seedHeygenProfile();
    process.env.LAZYOS_CONNECTOR_LIVE = "on";
    mockedResolve.mockReturnValue(MOCK_CRED);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
      }),
    );

    await executeCall(baseArgs({ approved: true }));

    const rows = readAuditRows();
    for (const row of rows) {
      const rowStr = JSON.stringify(row);
      expect(rowStr).not.toContain(MOCK_SECRET);
    }

    vi.unstubAllGlobals();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (f) approved=true ODER trust='auto' + LIVE=on → echter Call-Pfad
// ─────────────────────────────────────────────────────────────────────────────

describe("(f) LIVE=on + approved/trust='auto' → echter Call-Pfad", () => {
  it("approved:true + LIVE=on → fetch wird aufgerufen (resolveApiCredential erst hier)", async () => {
    seedHeygenProfile();
    process.env.LAZYOS_CONNECTOR_LIVE = "on";
    mockedResolve.mockReturnValue(MOCK_CRED);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeCall(baseArgs({ approved: true }));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    if (result.ok && !result.dryRun) {
      expect(result.dryRun).toBe(false);
      expect(result.status).toBe(200);
    }

    vi.unstubAllGlobals();
  });

  it("resolveApiCredential wird ERST IM LIVE-PFAD aufgerufen (nicht davor)", async () => {
    seedHeygenProfile();
    process.env.LAZYOS_CONNECTOR_LIVE = "on";
    mockedResolve.mockReturnValue(MOCK_CRED);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
      }),
    );

    // Vor dem Call: noch nicht aufgerufen.
    expect(mockedResolve).not.toHaveBeenCalled();

    await executeCall(baseArgs({ approved: true }));

    // Nach dem Call: genau einmal aufgerufen (im echten Call-Block).
    expect(mockedResolve).toHaveBeenCalledOnce();
    expect(mockedResolve).toHaveBeenCalledWith("ws-test", "user-max", "heygen");

    vi.unstubAllGlobals();
  });

  it("trust='auto' + LIVE=on + kein approved:true → echter Call (auto-approve-Pfad)", async () => {
    seedHeygenProfile();
    process.env.LAZYOS_CONNECTOR_LIVE = "on";
    setTrust({
      scopeKind: "workspace",
      scopeId: "ws-test",
      provider: "heygen",
      trust: "auto",
      actor: "user-max",
    });
    // Audit-Rows vom setTrust bereinigen.
    rawDb.exec("DELETE FROM connector_call_audit");
    mockedResolve.mockReturnValue(MOCK_CRED);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeCall(baseArgs({ approved: false }));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    if (result.ok && !result.dryRun) {
      expect(result.dryRun).toBe(false);
    }

    vi.unstubAllGlobals();
  });

  it("LIVE=on + approved:true → 'invoke'-Audit-Row mit live=1", async () => {
    seedHeygenProfile();
    process.env.LAZYOS_CONNECTOR_LIVE = "on";
    mockedResolve.mockReturnValue(MOCK_CRED);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
      }),
    );

    await executeCall(baseArgs({ approved: true }));

    const rows = readAuditRows();
    const invokeRow = rows.find((r) => r.phase === "invoke");
    expect(invokeRow).toBeDefined();
    expect(invokeRow?.live).toBe(1);
    expect(invokeRow?.success).toBe(1);

    vi.unstubAllGlobals();
  });

  it("LIVE=on aber credential-missing → blocked:'credential-missing'", async () => {
    seedHeygenProfile();
    process.env.LAZYOS_CONNECTOR_LIVE = "on";
    mockedResolve.mockReturnValue(null); // kein Credential.

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeCall(baseArgs({ approved: true }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe("credential-missing");
    }
    // fetch NICHT aufgerufen — kein Credential → kein Call.
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("ACL-5-D-Härtung: Secret im Call-Error wird maskiert (nicht in result/audit)", async () => {
    seedHeygenProfile();
    process.env.LAZYOS_CONNECTOR_LIVE = "on";
    mockedResolve.mockReturnValue(MOCK_CRED);

    // fetch wirft einen Fehler dessen Message das Secret WÖRTLICH enthält
    // (z.B. eine embedded-credential-URL die fetch in der Message echot).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(
        new Error(`getaddrinfo ENOTFOUND https://${MOCK_SECRET}@api.heygen.com`),
      ),
    );

    const result = await executeCall(baseArgs({ approved: true }));

    // call-error → blocked.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe("call-error");
      // Secret darf NICHT im detail-Feld stehen.
      expect(result.detail ?? "").not.toContain(MOCK_SECRET);
      expect(result.detail ?? "").not.toContain("sk-test-secret");
    }

    // Secret darf NICHT in irgendeiner Audit-Row stehen.
    const rows = readAuditRows();
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain(MOCK_SECRET);
      expect(JSON.stringify(row)).not.toContain("sk-test-secret");
    }

    vi.unstubAllGlobals();
  });

  it("ACL-5-D-Härtung: kurzer Secret (>=12 Zeichen) im Error wird maskiert", async () => {
    seedHeygenProfile();
    process.env.LAZYOS_CONNECTOR_LIVE = "on";
    const SHORT_SECRET = "tok-abc123XYZ"; // 13 Zeichen — über {12,}-Schwelle.
    mockedResolve.mockReturnValue({ ...MOCK_CRED, secret: SHORT_SECRET });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error(`connect failed for key ${SHORT_SECRET}`)),
    );

    const result = await executeCall(baseArgs({ approved: true }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail ?? "").not.toContain(SHORT_SECRET);
    }
    const rows = readAuditRows();
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain(SHORT_SECRET);
    }

    vi.unstubAllGlobals();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (g) previewCall — S5 Vorschau ohne Netzwerk
// ─────────────────────────────────────────────────────────────────────────────

describe("(g) previewCall — S5 ohne Netzwerk", () => {
  it("previewCall gibt ok:true zurück (nie blockierend)", () => {
    seedHeygenProfile();
    const preview = previewCall(baseArgs());
    expect(preview.ok).toBe(true);
  });

  it("previewCall schreibt 'preview'-Audit-Row", () => {
    seedHeygenProfile();
    previewCall(baseArgs());
    const rows = readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].phase).toBe("preview");
    expect(rows[0].live).toBe(0);
  });

  it("previewCall: payloadSummary enthält Keys + Typen, keine Werte", () => {
    seedHeygenProfile();
    const preview = previewCall(
      baseArgs({ payload: { template_id: "tmpl-1", ratio: 1.5, active: true } }),
    );
    expect(preview.payloadSummary).toEqual({
      template_id: "string",
      ratio: "number",
      active: "boolean",
    });
    // Keine konkreten Werte.
    expect(JSON.stringify(preview.payloadSummary)).not.toContain("tmpl-1");
    expect(JSON.stringify(preview.payloadSummary)).not.toContain("1.5");
  });

  it("previewCall: mcpTool wird aus Capability-Profil befüllt", () => {
    seedHeygenProfile();
    const preview = previewCall(baseArgs());
    expect(preview.mcpTool).toBe("mcp__heygen__render_video");
  });

  it("previewCall: baseUrl aus Connector-Profil", () => {
    seedHeygenProfile();
    const preview = previewCall(baseArgs());
    expect(preview.baseUrl).toBe("https://api.heygen.com");
  });

  it("previewCall: currentTrust='ask' wenn kein Trust-Eintrag", () => {
    seedHeygenProfile();
    const preview = previewCall(baseArgs());
    expect(preview.currentTrust).toBe("ask");
  });

  it("previewCall: currentTrust='auto' nach setTrust", () => {
    seedHeygenProfile();
    setTrust({
      scopeKind: "workspace",
      scopeId: "ws-test",
      provider: "heygen",
      trust: "auto",
      actor: "user-max",
    });
    rawDb.exec("DELETE FROM connector_call_audit");

    const preview = previewCall(baseArgs());
    expect(preview.currentTrust).toBe("auto");
  });

  it("previewCall: liveEnabled=false wenn LAZYOS_CONNECTOR_LIVE nicht gesetzt", () => {
    seedHeygenProfile();
    delete process.env.LAZYOS_CONNECTOR_LIVE;
    const preview = previewCall(baseArgs());
    expect(preview.liveEnabled).toBe(false);
  });

  it("previewCall: liveEnabled=true wenn LAZYOS_CONNECTOR_LIVE='on'", () => {
    seedHeygenProfile();
    process.env.LAZYOS_CONNECTOR_LIVE = "on";
    const preview = previewCall(baseArgs());
    expect(preview.liveEnabled).toBe(true);
  });

  it("previewCall: credentialPreview=null wenn kein Credential", () => {
    seedHeygenProfile();
    mockedExists.mockReturnValue({
      exists: false,
      source: null,
      scopeLabel: "workspace:ws-test",
    });
    const preview = previewCall(baseArgs());
    expect(preview.credentialPreview).toBeNull();
  });

  it("previewCall: credentialPreview decrypt-freies Label wenn Credential vorhanden", () => {
    seedHeygenProfile();
    mockedExists.mockReturnValue({
      exists: true,
      source: "workspace-cred",
      scopeLabel: "workspace:ws-test",
    });
    const preview = previewCall(baseArgs());
    expect(preview.credentialPreview).not.toBe(MOCK_SECRET);
    expect(preview.credentialPreview).not.toBeNull();
    // resolveApiCredential (decrypt) wurde NICHT angefasst.
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it("previewCall: callId ist in der Ausgabe enthalten", () => {
    seedHeygenProfile();
    const preview = previewCall(baseArgs({ callId: "test-call-id-123" }));
    expect(preview.callId).toBe("test-call-id-123");
  });

  it("previewCall: fetch wird NICHT aufgerufen", () => {
    const fetchMockFn = vi.fn();
    vi.stubGlobal("fetch", fetchMockFn);
    seedHeygenProfile();
    previewCall(baseArgs());
    expect(fetchMockFn).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (i) credential-missing nach LIVE=on
// ─────────────────────────────────────────────────────────────────────────────

describe("(i) PRE-6: credential-missing (LIVE=on)", () => {
  it("LIVE=on + approved:true + kein Credential → blocked:'credential-missing'", async () => {
    seedHeygenProfile();
    process.env.LAZYOS_CONNECTOR_LIVE = "on";
    mockedResolve.mockReturnValue(null);

    const result = await executeCall(baseArgs({ approved: true }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe("credential-missing");
    }
  });

  it("credential-missing schreibt 'deny'-Audit-Row", async () => {
    seedHeygenProfile();
    process.env.LAZYOS_CONNECTOR_LIVE = "on";
    mockedResolve.mockReturnValue(null);

    await executeCall(baseArgs({ approved: true }));
    const rows = readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].phase).toBe("deny");
    expect(rows[0].reason).toContain("credential-missing");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Vorbedingungs-Reihenfolge — PRE-1 vor PRE-2 vor PRE-3 vor PRE-4
// ─────────────────────────────────────────────────────────────────────────────

describe("Vorbedingungs-Reihenfolge: PRE-1 wins zuerst", () => {
  it("Kein Profil + approved:true → 'no-profile' (nicht 'awaiting-approval')", async () => {
    const result = await executeCall(
      baseArgs({ provider: "ghost-provider", approved: true }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe("no-profile");
    }
  });

  it("Coverage-fail + approved:true → 'coverage-fail' (nicht 'awaiting-approval')", async () => {
    seedHeygenProfileNoCoverage();
    const result = await executeCall(
      baseArgs({
        provider: "heygen-nc",
        capability: "render_video",
        requiredCaps: ["render_video"],
        approved: true,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe("coverage-fail");
    }
  });
});
