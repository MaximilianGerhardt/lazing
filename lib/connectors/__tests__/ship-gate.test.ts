/**
 * ACL-5 Ship-Gate-E2E-Test (ACL5-F — 2026-05-24).
 *
 * Beweist, dass die verriegelten Grenzen der Auto-Connect-Gate-Kette halten.
 * Jeder Test ist eine klare fail-closed-Invariante — ein Fehlschlag ist ein BLOCKER.
 *
 * ── 6 Ship-Gate-Invarianten ──────────────────────────────────────────────────
 *   INV-1  Kein echter Call ohne Approval: trust='ask' + approved nicht gesetzt
 *          → blocked:'awaiting-approval', fetch NIEMALS aufgerufen.
 *   INV-2  Credential nie im Transcript/Card: maybeAutoConnect für
 *          missing='credential' → Card-Payload enthält KEIN Secret/Klartext-Feld.
 *          previewCall-Output enthält nur maskiertes Credential (•-Zeichen).
 *   INV-3  S4 blockt nicht-allowlistete Tools: executeCall für Capability die
 *          nicht im gehärteten Set ist (null mcpToolName oder K1-Tool)
 *          → blocked:'not-hardened', fetch NIEMALS aufgerufen.
 *   INV-4  LIVE off → Dry-Run: alle Vorbedingungen erfüllt + approved:true
 *          ABER LAZYOS_CONNECTOR_LIVE unset → dryRun:true, fetch NIEMALS aufgerufen.
 *   INV-5  Coverage-Fail → kein Call: required capability nicht im Profil
 *          → blocked:'coverage-fail', fetch NIEMALS aufgerufen.
 *   INV-6  LIVE on + approved + hardened + coverage-ok → echter Call-Pfad:
 *          mock-fetch genau EINMAL aufgerufen mit Auth-Header-Shape.
 *          Secret taucht NICHT im Audit/result auf.
 *
 * ── Constraints ───────────────────────────────────────────────────────────────
 *   - KEIN echter externer Call — fetch immer gemockt.
 *   - Berührt nur diese Test-Datei. Keine Produktionsdateien geändert.
 *   - vi.stubEnv / process.env für LAZYOS_CONNECTOR_LIVE.
 *   - In-Memory-SQLite (DDL aus Migrations 0100/0101/0105).
 *   - resolveApiCredential gemockt (kein workspace/org/permissions Setup nötig).
 *   - emitOrUpdateCard gemockt (kein In-Process-EventEmitter nötig).
 *
 * ── Run ───────────────────────────────────────────────────────────────────────
 *   NODE_OPTIONS='--experimental-require-module' npx vitest run \
 *     lib/connectors/__tests__/ship-gate.test.ts
 */

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

// ─────────────────────────────────────────────────────────────────────────────
// In-Memory-DB DDL (aus Migrations 0100 api_credentials + 0101 connector_catalog
// + 0105 connector_calls).
// ─────────────────────────────────────────────────────────────────────────────

const SHIP_GATE_DDL = `
  PRAGMA foreign_keys = ON;

  -- Migration 0101: connector_catalog + connector_capabilities
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
    connector_id      TEXT    NOT NULL
                      REFERENCES connector_catalog(id) ON DELETE CASCADE,
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

  -- Migration 0105: connector_calls (trust + audit)
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

// ─────────────────────────────────────────────────────────────────────────────
// DB-Mock — MUSS vor allen anderen Imports stehen (vitest hoist)
// ─────────────────────────────────────────────────────────────────────────────

let rawDb: Database.Database;

vi.mock("@/db/client", () => ({
  getDb: () => Object.assign(drizzle(rawDb), { $raw: rawDb }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// resolveApiCredential — gemockt (kein workspace/org/permissions Setup)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bekanntes Test-Secret: eindeutig genug dass ein versehentliches Vorkommen
 * im Output sofort auffällt. NIEMALS in result/audit/card erwünscht.
 */
const MOCK_SECRET = "sk-SHIPGATE-secret-MUST-NOT-APPEAR-IN-OUTPUT-7x9z";
const MOCK_CRED = {
  id: "apicred-shipgate-1",
  provider: "acme",
  kind: "api_key" as const,
  secret: MOCK_SECRET,
  config: null,
  lastValidatedAt: null,
  source: "workspace-cred" as const,
};

vi.mock("@/lib/credentials/vault", () => ({
  resolveApiCredential: vi.fn(),
  credentialExists: vi.fn(),
}));

// ─────────────────────────────────────────────────────────────────────────────
// emitOrUpdateCard — gemockt (kein In-Process-EventEmitter im Testprozess)
// ─────────────────────────────────────────────────────────────────────────────

/** Captures alle Card-Payloads die an emitOrUpdateCard übergeben werden. */
const emitCalls: Array<{ coords: unknown; content: string }> = [];

vi.mock("@/lib/events/emit-or-update-card", () => ({
  emitOrUpdateCard: vi.fn(async (args: { coords: unknown; content: string }) => {
    emitCalls.push({ coords: args.coords, content: args.content });
    return { event: { id: "evt-shipgate" }, mode: "inserted" as const };
  }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// detectConnector — für INV-2 (auto-connect credential-request-Pfad)
// ─────────────────────────────────────────────────────────────────────────────

const detectResultRef = {
  provider: "acme" as string | null,
  missing: "credential" as "no-connector" | "profile" | "credential" | "none",
  neededCapabilities: ["send_notification"] as string[],
  confidence: 1.0,
  rationale: "ship-gate-test",
};

vi.mock("@/lib/connectors/detect", () => ({
  detectConnector: vi.fn(() => ({
    provider: detectResultRef.provider,
    missing: detectResultRef.missing,
    neededCapabilities: detectResultRef.neededCapabilities,
    confidence: detectResultRef.confidence,
    rationale: detectResultRef.rationale,
  })),
}));

// listSops — leere Registry (nicht relevant für Ship-Gate)
vi.mock("@/lib/sop/registry", () => ({
  listSops: vi.fn(() => []),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Lazy imports NACH vi.mock
// ─────────────────────────────────────────────────────────────────────────────

import { upsertConnectorProfile } from "@/lib/connectors/catalog";
import { setTrust } from "@/lib/connectors/trust";
import {
  credentialExists,
  resolveApiCredential,
} from "@/lib/credentials/vault";
import { executeCall, previewCall, type InvokeArgs } from "../invoke";

const mockedResolve = resolveApiCredential as MockedFunction<typeof resolveApiCredential>;
const mockedExists = credentialExists as MockedFunction<typeof credentialExists>;

// ─────────────────────────────────────────────────────────────────────────────
// Seed-Helfer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Provider 'acme' mit send_notification-Capability — hardened (mcpToolName gesetzt,
 * Provider-Namespace korrekt, kein K1-Tool).
 */
function seedAcmeProfile(): void {
  upsertConnectorProfile({
    provider: "acme",
    displayName: "ACME Corp",
    authKind: "api_key",
    baseUrl: "https://api.acme.example",
    capabilities: [
      {
        name: "send_notification",
        mcpToolName: "mcp__acme__send_notification",
        description: "Send a notification",
        required: true,
      },
    ],
  });
}

/**
 * Provider 'acme-nocov' mit ANDERER Capability — coverage für 'send_notification' schlägt fehl.
 */
function seedAcmeProfileNoCoverage(): void {
  upsertConnectorProfile({
    provider: "acme-nocov",
    displayName: "ACME NoCoverage",
    authKind: "api_key",
    baseUrl: "https://api.acme.example",
    capabilities: [
      {
        name: "list_events",
        mcpToolName: "mcp__acme-nocov__list_events",
        required: false,
      },
    ],
  });
}

/**
 * Provider 'acme-k1' mit einem K1-verbotenen RAG-Tool.
 */
function seedAcmeProfileK1(): void {
  upsertConnectorProfile({
    provider: "acme-k1",
    displayName: "ACME K1 Banned",
    authKind: "api_key",
    baseUrl: "https://api.acme.example",
    capabilities: [
      {
        name: "rag_search",
        mcpToolName: "mcp__local-rag__search",  // K1-verboten
        required: true,
      },
    ],
  });
}

/** Basis-InvokeArgs für send_notification bei acme. */
function baseArgs(overrides?: Partial<InvokeArgs>): InvokeArgs {
  return {
    provider: "acme",
    capability: "send_notification",
    requiredCaps: ["send_notification"],
    payload: { message: "hello", channel: "email" },
    workspaceId: "ws-shipgate",
    userId: "user-max",
    ...overrides,
  };
}

/** Liest alle Audit-Rows aus der in-memory DB. */
function readAuditRows(): Array<{
  phase: string;
  provider: string;
  live: number;
  payload_hash: string | null;
  result_summary: string | null;
  success: number;
  reason: string | null;
}> {
  return rawDb
    .prepare(
      `SELECT phase, provider, live, payload_hash, result_summary, success, reason
       FROM connector_call_audit ORDER BY rowid ASC`,
    )
    .all() as ReturnType<typeof readAuditRows>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  rawDb = new Database(":memory:");
  rawDb.pragma("foreign_keys = ON");
  rawDb.exec(SHIP_GATE_DDL);

  process.env.LAZYOS_CREDENTIAL_KEY =
    "0000000000000000000000000000000000000000000000000000000000000001";

  // Default: LIVE OFF (Master-Schalter nie ungewollt an)
  delete process.env.LAZYOS_CONNECTOR_LIVE;

  // Default: kein Credential (fail-closed) — resolve (decrypt) + existence.
  mockedResolve.mockReturnValue(null);
  mockedExists.mockReturnValue({
    exists: false,
    source: null,
    scopeLabel: "workspace:ws-shipgate",
  });

  // Card-Capture zurücksetzen
  emitCalls.length = 0;

  // detectConnector auf credential-Pfad zurücksetzen (INV-2-Default)
  detectResultRef.provider = "acme";
  detectResultRef.missing = "credential";
  detectResultRef.neededCapabilities = ["send_notification"];
});

afterEach(() => {
  rawDb.close();
  delete process.env.LAZYOS_CONNECTOR_LIVE;
  vi.clearAllMocks();
  emitCalls.length = 0;
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-1: Kein echter Call ohne Approval
// ─────────────────────────────────────────────────────────────────────────────

describe("INV-1: Kein echter Call ohne Approval (trust='ask' + approved nicht gesetzt)", () => {
  it("INV-1a: trust='ask' + approved=undefined → blocked:'awaiting-approval'", async () => {
    seedAcmeProfile();

    const result = await executeCall(baseArgs({ approved: undefined }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe("awaiting-approval");
    }
  });

  it("INV-1b: trust='ask' + approved=false → blocked:'awaiting-approval'", async () => {
    seedAcmeProfile();

    const result = await executeCall(baseArgs({ approved: false }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe("awaiting-approval");
    }
  });

  it("INV-1c: fetch wird bei awaiting-approval NIEMALS aufgerufen", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    seedAcmeProfile();

    await executeCall(baseArgs({ approved: undefined }));
    await executeCall(baseArgs({ approved: false }));

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("INV-1d: awaiting-approval schreibt deny-Audit-Row (N8-Beweis)", async () => {
    seedAcmeProfile();

    await executeCall(baseArgs({ approved: undefined }));

    const rows = readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].phase).toBe("deny");
    expect(rows[0].success).toBe(0);
    expect(rows[0].reason).toContain("awaiting-approval");
  });

  it("INV-1e: trust='auto' via setTrust ERLAUBT den Pfad — kein blocked (LIVE off → dryRun)", async () => {
    // Sicherheits-Prüfung: wenn trust='auto', muss executeCall NICHT awaiting-approval zurückgeben.
    // (Er landet im Dry-Run, weil LIVE off ist — aber das Gate selbst ist offen.)
    seedAcmeProfile();
    setTrust({
      scopeKind: "workspace",
      scopeId: "ws-shipgate",
      provider: "acme",
      trust: "auto",
      actor: "user-max",
    });
    rawDb.exec("DELETE FROM connector_call_audit");

    const result = await executeCall(baseArgs({ approved: false }));

    // Nicht blocked:'awaiting-approval' — trust='auto' öffnet das Gate.
    if (!result.ok) {
      expect(result.blocked).not.toBe("awaiting-approval");
    } else {
      // ok:true + dryRun:true (LIVE off) ist der erwartete Pfad.
      expect(result.dryRun).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-2: Credential nie im Transcript/Card
// ─────────────────────────────────────────────────────────────────────────────

describe("INV-2: Credential nie im Transcript/Card (kein Secret-Klartext)", () => {
  it("INV-2a: previewCall gibt credentialPreview NUR als decrypt-freies Label (•-Zeichen)", () => {
    seedAcmeProfile();
    // ACL-5-D-Härtung: previewCall nutzt credentialExists (decrypt-frei).
    mockedExists.mockReturnValue({
      exists: true,
      source: "workspace-cred",
      scopeLabel: "workspace:ws-shipgate",
    });

    const preview = previewCall(baseArgs());

    // Klartext-Secret darf NICHT erscheinen.
    expect(preview.credentialPreview).not.toBe(MOCK_SECRET);
    expect(preview.credentialPreview).not.toContain("sk-SHIPGATE");
    expect(preview.credentialPreview).not.toContain("MUST-NOT-APPEAR");

    // Decrypt-freies Label: muss •-Zeichen enthalten (UI-Konsistenz).
    if (preview.credentialPreview !== null) {
      expect(preview.credentialPreview).toContain("•");
    }

    // Finding 3: kein decrypt-Pfad in previewCall.
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it("INV-2b: previewCall enthält das Secret in KEINEM Feld des CallPreview-Objekts", () => {
    seedAcmeProfile();
    mockedExists.mockReturnValue({
      exists: true,
      source: "workspace-cred",
      scopeLabel: "workspace:ws-shipgate",
    });

    const preview = previewCall(baseArgs());

    // JSON-Scan: kein Feld darf das Klartext-Secret enthalten.
    const previewJson = JSON.stringify(preview);
    expect(previewJson).not.toContain(MOCK_SECRET);
    expect(previewJson).not.toContain("sk-SHIPGATE");
    // previewCall hat resolveApiCredential (decrypt) NIE aufgerufen.
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it("INV-2c: maybeAutoConnect credential-request-Card enthält kein secret/token-Feld", async () => {
    // auto-connect.ts sendet eine credential-request-Card wenn credential fehlt.
    // Wir prüfen den emittierten Card-Content auf verbotene Schlüssel.
    detectResultRef.provider = "acme";
    detectResultRef.missing = "credential";
    detectResultRef.neededCapabilities = ["send_notification"];

    // Lazy-import nach mock-setup (muss per dynamic import da Mocks nach Toplevel-imports)
    const { maybeAutoConnect } = await import("../auto-connect");

    await maybeAutoConnect("Send me a notification via ACME", {
      workspaceId: "ws-shipgate",
      userId: "user-max",
    });

    // Mindestens eine Card muss emittiert worden sein.
    expect(emitCalls.length).toBeGreaterThanOrEqual(1);

    // Jede emittierte Card: kein Secret/Token/Passwort-Feld im JSON-Content.
    const FORBIDDEN_CARD_KEYS = new Set([
      '"secret"', '"token"', '"api_key"', '"apiKey"', '"password"',
      '"private_key"', '"privateKey"', '"access_token"', '"accessToken"',
      '"refresh_token"', '"refreshToken"', '"client_secret"', '"clientSecret"',
    ]);

    for (const call of emitCalls) {
      for (const forbidden of FORBIDDEN_CARD_KEYS) {
        expect(call.content).not.toContain(forbidden);
      }
      // Das Secret selbst darf ebenfalls nicht auftauchen.
      expect(call.content).not.toContain(MOCK_SECRET);
      expect(call.content).not.toContain("sk-SHIPGATE");
    }
  });

  it("INV-2d: previewCall payloadSummary enthält Keys+Typen aber KEINE Payload-Werte", () => {
    seedAcmeProfile();

    const preview = previewCall(
      baseArgs({ payload: { message: "top-secret-payload", channel: "email" } }),
    );

    // Payload-Wert darf nicht im Summary erscheinen.
    expect(JSON.stringify(preview.payloadSummary)).not.toContain("top-secret-payload");
    // Aber der Key-Typ ist vorhanden.
    expect(preview.payloadSummary["message"]).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-3: S4 blockt nicht-allowlistete Tools (K1 + fehlendes mcpToolName)
// ─────────────────────────────────────────────────────────────────────────────

describe("INV-3: S4 blockt nicht-allowlistete Tools", () => {
  it("INV-3a: Capability ohne mcpToolName → blocked:'not-hardened'", async () => {
    // Profil mit mcpToolName=null (REST-only) — S4 hat kein Tool → blocked.
    upsertConnectorProfile({
      provider: "acme-nomc",
      displayName: "ACME No MCP",
      authKind: "api_key",
      baseUrl: "https://api.acme.example",
      capabilities: [
        {
          name: "send_notification",
          mcpToolName: null,  // kein MCP-Tool → S4 hat nichts zu härten.
          required: true,
        },
      ],
    });

    const result = await executeCall(
      baseArgs({ provider: "acme-nomc", approved: true }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe("not-hardened");
    }
  });

  it("INV-3b: K1-RAG-Tool (mcp__local-rag__search) → blocked:'not-hardened'", async () => {
    seedAcmeProfileK1();

    const result = await executeCall(
      baseArgs({
        provider: "acme-k1",
        capability: "rag_search",
        requiredCaps: ["rag_search"],
        approved: true,
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe("not-hardened");
    }
  });

  it("INV-3c: fetch wird bei not-hardened NIEMALS aufgerufen", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    // Case 1: kein MCP-Tool
    upsertConnectorProfile({
      provider: "acme-nomc2",
      displayName: "X",
      authKind: "api_key",
      capabilities: [{ name: "send_notification", mcpToolName: null, required: true }],
    });
    await executeCall(baseArgs({ provider: "acme-nomc2", approved: true }));

    // Case 2: K1-Tool
    seedAcmeProfileK1();
    await executeCall(
      baseArgs({
        provider: "acme-k1",
        capability: "rag_search",
        requiredCaps: ["rag_search"],
        approved: true,
      }),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("INV-3d: Cross-Provider-Tool → blocked:'not-hardened' (Provider-Namespace-Check)", async () => {
    // Tool gehört zu anderem Provider-Namespace.
    upsertConnectorProfile({
      provider: "acme-xprov",
      displayName: "ACME CrossProvider",
      authKind: "api_key",
      baseUrl: "https://api.acme.example",
      capabilities: [
        {
          name: "send_notification",
          // Falscher Provider-Namespace (mcp__other-provider__ statt mcp__acme-xprov__)
          mcpToolName: "mcp__other-provider__send_notification",
          required: true,
        },
      ],
    });

    const result = await executeCall(
      baseArgs({ provider: "acme-xprov", approved: true }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe("not-hardened");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-4: LIVE off → Dry-Run (kein echter fetch)
// ─────────────────────────────────────────────────────────────────────────────

describe("INV-4: LIVE off → Dry-Run, KEIN echter fetch", () => {
  it("INV-4a: alle Vorbedingungen ok + approved:true + LIVE unset → dryRun:true", async () => {
    seedAcmeProfile();
    delete process.env.LAZYOS_CONNECTOR_LIVE;

    const result = await executeCall(baseArgs({ approved: true }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dryRun).toBe(true);
    }
  });

  it("INV-4b: LIVE='off' explizit → dryRun:true", async () => {
    seedAcmeProfile();
    process.env.LAZYOS_CONNECTOR_LIVE = "off";

    const result = await executeCall(baseArgs({ approved: true }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dryRun).toBe(true);
    }
  });

  it("INV-4c: LIVE='false' → dryRun:true", async () => {
    seedAcmeProfile();
    process.env.LAZYOS_CONNECTOR_LIVE = "false";

    const result = await executeCall(baseArgs({ approved: true }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dryRun).toBe(true);
    }
  });

  it("INV-4d: fetch wird bei LIVE=off NIEMALS aufgerufen (auch bei approved:true)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    seedAcmeProfile();
    delete process.env.LAZYOS_CONNECTOR_LIVE;

    await executeCall(baseArgs({ approved: true }));

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("INV-4e: Dry-Run-Ergebnis ist klar als DRY-RUN gelabelt (simulatedResult)", async () => {
    seedAcmeProfile();
    delete process.env.LAZYOS_CONNECTOR_LIVE;

    const result = await executeCall(baseArgs({ approved: true }));

    if (result.ok && result.dryRun) {
      expect(result.simulatedResult).toContain("DRY-RUN");
      expect(result.simulatedResult).toContain("LAZYOS_CONNECTOR_LIVE");
    }
  });

  it("INV-4f: previewCall zeigt liveEnabled:false wenn LIVE=off", () => {
    seedAcmeProfile();
    delete process.env.LAZYOS_CONNECTOR_LIVE;

    const preview = previewCall(baseArgs());

    expect(preview.liveEnabled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-5: Coverage-Fail → kein Call
// ─────────────────────────────────────────────────────────────────────────────

describe("INV-5: Coverage-Fail → kein Call", () => {
  it("INV-5a: required capability nicht im Profil → blocked:'coverage-fail'", async () => {
    seedAcmeProfileNoCoverage();

    const result = await executeCall(
      baseArgs({
        provider: "acme-nocov",
        capability: "send_notification",
        requiredCaps: ["send_notification"],
        approved: true,
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe("coverage-fail");
    }
  });

  it("INV-5b: fetch wird bei coverage-fail NIEMALS aufgerufen", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    seedAcmeProfileNoCoverage();
    await executeCall(
      baseArgs({
        provider: "acme-nocov",
        capability: "send_notification",
        requiredCaps: ["send_notification"],
        approved: true,
      }),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("INV-5c: coverage-fail schreibt deny-Audit-Row (N8-Beweis)", async () => {
    seedAcmeProfileNoCoverage();

    await executeCall(
      baseArgs({
        provider: "acme-nocov",
        capability: "send_notification",
        requiredCaps: ["send_notification"],
        approved: true,
      }),
    );

    const rows = readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].phase).toBe("deny");
    expect(rows[0].success).toBe(0);
    expect(rows[0].reason).toContain("coverage-fail");
  });

  it("INV-5d: leeres Profil (keine Capabilities) → coverage-fail für jede Anforderung", async () => {
    upsertConnectorProfile({
      provider: "acme-empty",
      displayName: "ACME Empty",
      authKind: "api_key",
      capabilities: [],  // keine Capabilities
    });

    const result = await executeCall(
      baseArgs({
        provider: "acme-empty",
        capability: "send_notification",
        requiredCaps: ["send_notification"],
        approved: true,
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe("coverage-fail");
    }
  });

  it("INV-5e: multiple required capabilities, eine fehlt → coverage-fail", async () => {
    // Profil hat nur send_notification, aber auch list_events required.
    seedAcmeProfile();

    const result = await executeCall(
      baseArgs({
        provider: "acme",
        capability: "send_notification",
        requiredCaps: ["send_notification", "list_events"],  // list_events fehlt
        approved: true,
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe("coverage-fail");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INV-6: LIVE on + approved + hardened + coverage-ok → echter Call-Pfad
// ─────────────────────────────────────────────────────────────────────────────

describe("INV-6: LIVE=on + approved + hardened + coverage-ok → echter Call-Pfad", () => {
  it("INV-6a: mock-fetch wird GENAU EINMAL aufgerufen", async () => {
    seedAcmeProfile();
    process.env.LAZYOS_CONNECTOR_LIVE = "on";
    mockedResolve.mockReturnValue(MOCK_CRED);

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (_h: string) => null },
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await executeCall(baseArgs({ approved: true }));

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dryRun).toBe(false);
    }

    vi.unstubAllGlobals();
  });

  it("INV-6b: fetch wird mit Auth-Header-Shape aufgerufen (X-API-Key für api_key)", async () => {
    seedAcmeProfile();
    process.env.LAZYOS_CONNECTOR_LIVE = "on";
    mockedResolve.mockReturnValue(MOCK_CRED);

    let capturedHeaders: Record<string, string> | undefined;
    const fetchSpy = vi.fn().mockImplementation(
      (_url: unknown, init?: { headers?: Record<string, string> }) => {
        capturedHeaders = init?.headers;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: (_h: string) => null },
        });
      },
    );
    vi.stubGlobal("fetch", fetchSpy);

    await executeCall(baseArgs({ approved: true }));

    // Auth-Header-Shape prüfen: für authKind='api_key' → 'X-API-Key' gesetzt.
    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!["X-API-Key"]).toBeDefined();
    // Der Header MUSS das Secret enthalten (das ist der Sinn des Calls).
    // Aber er darf NICHT im result oder audit erscheinen.
    expect(capturedHeaders!["X-API-Key"]).toBe(MOCK_SECRET);

    vi.unstubAllGlobals();
  });

  it("INV-6c: Secret erscheint NICHT im CallResult (LiveCallResult)", async () => {
    seedAcmeProfile();
    process.env.LAZYOS_CONNECTOR_LIVE = "on";
    mockedResolve.mockReturnValue(MOCK_CRED);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: (_h: string) => "1024" },
      }),
    );

    const result = await executeCall(baseArgs({ approved: true }));

    const resultJson = JSON.stringify(result);
    expect(resultJson).not.toContain(MOCK_SECRET);
    expect(resultJson).not.toContain("sk-SHIPGATE");
    expect(resultJson).not.toContain("MUST-NOT-APPEAR");

    vi.unstubAllGlobals();
  });

  it("INV-6d: Secret erscheint NICHT in Audit-Rows (N8-Beweis)", async () => {
    seedAcmeProfile();
    process.env.LAZYOS_CONNECTOR_LIVE = "on";
    mockedResolve.mockReturnValue(MOCK_CRED);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: (_h: string) => null },
      }),
    );

    await executeCall(baseArgs({ approved: true }));

    const rows = readAuditRows();
    expect(rows.length).toBeGreaterThanOrEqual(1);

    // Kein Secret in irgend einem Audit-Feld.
    for (const row of rows) {
      const rowJson = JSON.stringify(row);
      expect(rowJson).not.toContain(MOCK_SECRET);
      expect(rowJson).not.toContain("sk-SHIPGATE");
      expect(rowJson).not.toContain("MUST-NOT-APPEAR");
    }

    vi.unstubAllGlobals();
  });

  it("INV-6e: invoke-Audit-Row hat live=1 + success=1 + payload_hash ist SHA-256 (64 hex)", async () => {
    seedAcmeProfile();
    process.env.LAZYOS_CONNECTOR_LIVE = "on";
    mockedResolve.mockReturnValue(MOCK_CRED);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: (_h: string) => null },
      }),
    );

    await executeCall(baseArgs({ approved: true }));

    const rows = readAuditRows();
    const invokeRow = rows.find((r) => r.phase === "invoke");
    expect(invokeRow).toBeDefined();
    expect(invokeRow!.live).toBe(1);
    expect(invokeRow!.success).toBe(1);

    // payload_hash muss SHA-256-Format haben (N10/D3).
    if (invokeRow!.payload_hash) {
      expect(invokeRow!.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    }

    vi.unstubAllGlobals();
  });

  it("INV-6f: resolveApiCredential wird ERST im echten Call aufgerufen (PRE-6-Timing)", async () => {
    seedAcmeProfile();
    process.env.LAZYOS_CONNECTOR_LIVE = "on";
    mockedResolve.mockReturnValue(MOCK_CRED);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: (_h: string) => null },
      }),
    );

    // Vor dem Call: noch nicht aufgerufen.
    expect(mockedResolve).not.toHaveBeenCalled();

    await executeCall(baseArgs({ approved: true }));

    // Nach dem Call: genau einmal aufgerufen.
    expect(mockedResolve).toHaveBeenCalledOnce();
    expect(mockedResolve).toHaveBeenCalledWith("ws-shipgate", "user-max", "acme");

    vi.unstubAllGlobals();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gate-Reihenfolge: PRE-1 gewinnt vor PRE-2 gewinnt vor PRE-3 gewinnt vor PRE-4
// ─────────────────────────────────────────────────────────────────────────────

describe("Gate-Reihenfolge (fail-closed: erstes Fail wins)", () => {
  it("kein Profil + approved:true → 'no-profile' (nicht 'awaiting-approval')", async () => {
    const result = await executeCall(
      baseArgs({ provider: "ghost-acme", approved: true }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe("no-profile");
    }
  });

  it("coverage-fail + approved:true → 'coverage-fail' (nicht 'awaiting-approval')", async () => {
    seedAcmeProfileNoCoverage();
    const result = await executeCall(
      baseArgs({
        provider: "acme-nocov",
        capability: "send_notification",
        requiredCaps: ["send_notification"],
        approved: true,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe("coverage-fail");
    }
  });

  it("not-hardened + approved:true → 'not-hardened' (nicht 'awaiting-approval')", async () => {
    upsertConnectorProfile({
      provider: "acme-ord",
      displayName: "ACME Order",
      authKind: "api_key",
      capabilities: [{ name: "send_notification", mcpToolName: null, required: true }],
    });
    const result = await executeCall(
      baseArgs({ provider: "acme-ord", approved: true }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe("not-hardened");
    }
  });
});
