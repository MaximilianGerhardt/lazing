/**
 * App-Store Foundation Tests (C4 · 2026-05-25).
 *
 * Coverage:
 *   manifest  — parse valid/invalid, PII guard throws, schema-string guard
 *   signature — unverified/invalid/valid status semantics (N6 deterministic)
 *   registry  — install → audit row, enable, disable, uninstall, idempotent,
 *               upsertManifest PII guard, upsertManifest validation error,
 *               hashManifestRow N10 determinism
 *
 * Strategy: vi.mock('@/db/client') injects an in-memory better-sqlite3 DB
 * with the three app_store tables. Same pattern as catalog.test.ts.
 *
 * Run:
 *   NODE_OPTIONS='--experimental-require-module' npx vitest run \
 *     lib/appstore/__tests__/app-store.test.ts
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory DB DDL
// ---------------------------------------------------------------------------

const APP_STORE_DDL = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS app_manifests (
    id               TEXT    PRIMARY KEY,
    app_id           TEXT    NOT NULL,
    name             TEXT    NOT NULL,
    version          TEXT    NOT NULL,
    description      TEXT,
    publisher        TEXT,
    kind             TEXT    NOT NULL,
    manifest_json    TEXT    NOT NULL,
    signature        TEXT,
    signature_status TEXT    NOT NULL DEFAULT 'unsigned',
    source           TEXT    NOT NULL DEFAULT 'local',
    content_hash     TEXT    NOT NULL DEFAULT '',
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    UNIQUE (app_id)
  );

  CREATE TABLE IF NOT EXISTS app_installs (
    id           TEXT    PRIMARY KEY,
    app_id       TEXT    NOT NULL REFERENCES app_manifests(app_id) ON DELETE CASCADE,
    scope_kind   TEXT    NOT NULL,
    scope_id     TEXT    NOT NULL,
    status       TEXT    NOT NULL DEFAULT 'pending',
    installed_by TEXT    NOT NULL DEFAULT 'system',
    installed_at INTEGER NOT NULL,
    content_hash TEXT    NOT NULL DEFAULT '',
    UNIQUE (app_id, scope_kind, scope_id)
  );

  CREATE TABLE IF NOT EXISTS app_install_audit (
    id           TEXT    PRIMARY KEY,
    ts           INTEGER NOT NULL,
    app_id       TEXT    NOT NULL,
    scope        TEXT    NOT NULL,
    actor        TEXT    NOT NULL DEFAULT 'system',
    action       TEXT    NOT NULL,
    success      INTEGER NOT NULL DEFAULT 1,
    reason       TEXT,
    content_hash TEXT    NOT NULL DEFAULT ''
  );
`;

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------

let mockDb: ReturnType<typeof drizzle> & { $raw: Database.Database };

vi.mock("@/db/client", () => ({
  getDb: () => mockDb,
}));

beforeEach(() => {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(APP_STORE_DDL);
  mockDb = Object.assign(drizzle(sqlite), { $raw: sqlite }) as typeof mockDb;
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(overrides: Record<string, unknown> = {}) {
  return {
    appId: "com.example.test-app",
    name: "Test App",
    version: "1.0.0",
    kind: "mcp-server" as const,
    description: "A test MCP server app",
    publisher: "Example Corp",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// manifest.ts — parseManifest / validateManifest / PII guard
// ---------------------------------------------------------------------------

describe("parseManifest", () => {
  it("parses valid JSON object", async () => {
    const { parseManifest } = await import("@/lib/appstore/manifest");
    const raw = parseManifest(JSON.stringify(makeManifest()));
    expect(raw).toMatchObject({ appId: "com.example.test-app" });
  });

  it("throws APP_MANIFEST_PARSE_ERROR on invalid JSON", async () => {
    const { parseManifest } = await import("@/lib/appstore/manifest");
    expect(() => parseManifest("not-json{")).toThrowError(/APP_MANIFEST_PARSE_ERROR/);
  });

  it("throws APP_MANIFEST_PARSE_ERROR on JSON array", async () => {
    const { parseManifest } = await import("@/lib/appstore/manifest");
    expect(() => parseManifest("[1,2,3]")).toThrowError(/APP_MANIFEST_PARSE_ERROR/);
  });
});

describe("validateManifest — valid cases", () => {
  it("validates a minimal mcp-server manifest", async () => {
    const { validateManifest } = await import("@/lib/appstore/manifest");
    const result = validateManifest(makeManifest() as Record<string, unknown>);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.appId).toBe("com.example.test-app");
      expect(result.manifest.kind).toBe("mcp-server");
    }
  });

  it("validates a connector manifest with capabilities", async () => {
    const { validateManifest } = await import("@/lib/appstore/manifest");
    const m = makeManifest({
      kind: "connector",
      capabilities: [{ name: "render_video", required: true }],
    });
    const result = validateManifest(m as Record<string, unknown>);
    expect(result.ok).toBe(true);
  });

  it("validates a skill-pack manifest", async () => {
    const { validateManifest } = await import("@/lib/appstore/manifest");
    const result = validateManifest(
      makeManifest({ appId: "lazing.skill-pack.research", kind: "skill-pack" }) as Record<string, unknown>,
    );
    expect(result.ok).toBe(true);
  });

  it("validates mcpTools with inputSchemaJson as string", async () => {
    const { validateManifest } = await import("@/lib/appstore/manifest");
    const result = validateManifest(
      makeManifest({
        mcpTools: [
          {
            name: "mcp__test-server__do_thing",
            inputSchemaJson: JSON.stringify({ type: "object" }),
          },
        ],
      }) as Record<string, unknown>,
    );
    expect(result.ok).toBe(true);
  });
});

describe("validateManifest — invalid cases (Zod failures)", () => {
  it("rejects invalid appId (uppercase)", async () => {
    const { validateManifest } = await import("@/lib/appstore/manifest");
    const result = validateManifest(
      makeManifest({ appId: "Com.Example.App" }) as Record<string, unknown>,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("appId"))).toBe(true);
    }
  });

  it("rejects invalid version (missing patch)", async () => {
    const { validateManifest } = await import("@/lib/appstore/manifest");
    const result = validateManifest(
      makeManifest({ version: "1.0" }) as Record<string, unknown>,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects unknown kind", async () => {
    const { validateManifest } = await import("@/lib/appstore/manifest");
    const result = validateManifest(
      makeManifest({ kind: "unknown-kind" }) as Record<string, unknown>,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects missing required fields (appId absent)", async () => {
    const { validateManifest } = await import("@/lib/appstore/manifest");
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { appId: _removed, ...noAppId } = makeManifest();
    const result = validateManifest(noAppId as Record<string, unknown>);
    expect(result.ok).toBe(false);
  });
});

describe("assertNonSensitiveManifest — PII guard", () => {
  it("throws APP_STORE_PII_GUARD on workspace_id", async () => {
    const { assertNonSensitiveManifest } = await import("@/lib/appstore/manifest");
    expect(() =>
      assertNonSensitiveManifest({ workspace_id: "ws-1", appId: "x" }),
    ).toThrowError(/APP_STORE_PII_GUARD/);
  });

  it("throws on token at top level", async () => {
    const { assertNonSensitiveManifest } = await import("@/lib/appstore/manifest");
    expect(() =>
      assertNonSensitiveManifest({ token: "sk-abc", appId: "x" }),
    ).toThrowError(/APP_STORE_PII_GUARD/);
  });

  it("throws on email at top level", async () => {
    const { assertNonSensitiveManifest } = await import("@/lib/appstore/manifest");
    expect(() =>
      assertNonSensitiveManifest({ email: "user@example.com", appId: "x" }),
    ).toThrowError(/APP_STORE_PII_GUARD/);
  });

  it("throws on forbidden key inside capabilities array", async () => {
    const { assertNonSensitiveManifest } = await import("@/lib/appstore/manifest");
    expect(() =>
      assertNonSensitiveManifest({
        appId: "com.test.app",
        capabilities: [{ name: "tool", secret: "leaked" }],
      }),
    ).toThrowError(/APP_STORE_PII_GUARD/);
  });

  it("throws on api_key inside mcpTools array", async () => {
    const { assertNonSensitiveManifest } = await import("@/lib/appstore/manifest");
    expect(() =>
      assertNonSensitiveManifest({
        appId: "com.test.app",
        mcpTools: [{ name: "tool", api_key: "leaked-key" }],
      }),
    ).toThrowError(/APP_STORE_PII_GUARD/);
  });

  it("does NOT throw for valid non-sensitive manifest", async () => {
    const { assertNonSensitiveManifest } = await import("@/lib/appstore/manifest");
    expect(() =>
      assertNonSensitiveManifest(makeManifest() as Record<string, unknown>),
    ).not.toThrow();
  });
});

describe("assertSchemaStringsInManifest — schema-string guard", () => {
  it("throws APP_STORE_PII_GUARD when inputSchemaJson is a raw object", async () => {
    const { assertSchemaStringsInManifest } = await import("@/lib/appstore/manifest");
    expect(() =>
      assertSchemaStringsInManifest({
        mcpTools: [{ name: "t", inputSchemaJson: { type: "object" } }],
      }),
    ).toThrowError(/APP_STORE_PII_GUARD/);
  });

  it("does not throw when inputSchemaJson is a string", async () => {
    const { assertSchemaStringsInManifest } = await import("@/lib/appstore/manifest");
    expect(() =>
      assertSchemaStringsInManifest({
        mcpTools: [{ name: "t", inputSchemaJson: '{"type":"object"}' }],
      }),
    ).not.toThrow();
  });

  it("does not throw when inputSchemaJson is absent", async () => {
    const { assertSchemaStringsInManifest } = await import("@/lib/appstore/manifest");
    expect(() =>
      assertSchemaStringsInManifest({ mcpTools: [{ name: "t" }] }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// signature.ts — verifyManifestSignature
// ---------------------------------------------------------------------------

describe("verifyManifestSignature — status semantics (N6 deterministic)", () => {
  it("returns 'unsigned' when signature is null", async () => {
    const { verifyManifestSignature } = await import("@/lib/appstore/signature");
    const manifest = makeManifest() as Parameters<typeof verifyManifestSignature>[0];
    const result = verifyManifestSignature(manifest, null);
    expect(result.status).toBe("unsigned");
  });

  it("returns 'unsigned' when signature is empty string", async () => {
    const { verifyManifestSignature } = await import("@/lib/appstore/signature");
    const manifest = makeManifest() as Parameters<typeof verifyManifestSignature>[0];
    const result = verifyManifestSignature(manifest, "");
    expect(result.status).toBe("unsigned");
  });

  it("returns 'unverified' when signature is present but no pubkey", async () => {
    const { verifyManifestSignature } = await import("@/lib/appstore/signature");
    const manifest = makeManifest() as Parameters<typeof verifyManifestSignature>[0];
    const result = verifyManifestSignature(manifest, "c29tZXNpZw==", null);
    expect(result.status).toBe("unverified");
    expect(result.reason).toMatch(/PHASE2_APP_ACTIVATE/);
  });

  it("returns 'invalid' when signature is garbage but pubkey is present", async () => {
    const { verifyManifestSignature } = await import("@/lib/appstore/signature");
    const { generateKeyPairSync } = await import("node:crypto");

    const { publicKey } = generateKeyPairSync("ed25519");
    const pubkeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;

    const manifest = makeManifest() as Parameters<typeof verifyManifestSignature>[0];
    const result = verifyManifestSignature(manifest, "bm90YXZhbGlkc2ln", pubkeyPem);
    expect(result.status).toBe("invalid");
  });

  it("returns 'valid' when signature matches pubkey", async () => {
    const { verifyManifestSignature, buildSignaturePayload } = await import(
      "@/lib/appstore/signature"
    );
    const { generateKeyPairSync, sign } = await import("node:crypto");

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pubkeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;

    const manifest = makeManifest() as Parameters<typeof verifyManifestSignature>[0];
    const payload = buildSignaturePayload(manifest);

    // Ed25519 in node:crypto uses sign(null, data, key) — algorithm is null
    // because Ed25519 has its own built-in hash (RFC 8032).
    const dataBuffer = Buffer.from(payload, "utf8");
    const sigBuffer = sign(null, dataBuffer, privateKey);
    const sig = sigBuffer.toString("base64url");

    const result = verifyManifestSignature(manifest, sig, pubkeyPem);
    expect(result.status).toBe("valid");
  });
});

// ---------------------------------------------------------------------------
// registry.ts — upsertManifest / installApp / audit / idempotent
// ---------------------------------------------------------------------------

describe("upsertManifest", () => {
  it("registers a manifest and returns the row", async () => {
    const { upsertManifest } = await import("@/lib/appstore/registry");
    const manifest = makeManifest();
    const row = upsertManifest({ manifest });
    expect(row.appId).toBe("com.example.test-app");
    expect(row.version).toBe("1.0.0");
    expect(row.signatureStatus).toBe("unsigned");
    expect(row.contentHash).toHaveLength(64);
    expect(row.id).toMatch(/^AMANI-/);
  });

  it("upsert is idempotent — same app_id updates existing row", async () => {
    const { upsertManifest, getApp } = await import("@/lib/appstore/registry");
    upsertManifest({ manifest: makeManifest() });
    const updated = upsertManifest({
      manifest: makeManifest({ version: "2.0.0" }),
    });
    expect(updated.version).toBe("2.0.0");

    const row = getApp("com.example.test-app");
    expect(row?.version).toBe("2.0.0");
  });

  it("N10: content_hash is 64-char hex and deterministic for same input", async () => {
    const { hashManifestRow } = await import("@/lib/appstore/registry");
    const fields = {
      appId: "com.test.app",
      name: "Test",
      version: "1.0.0",
      description: null,
      publisher: null,
      kind: "mcp-server",
      manifestJson: "{}",
      signature: null,
      signatureStatus: "unsigned",
      source: "local",
      createdAt: 1000,
      updatedAt: 1000,
    };
    const hash1 = hashManifestRow(fields);
    const hash2 = hashManifestRow(fields);
    expect(hash1).toHaveLength(64);
    expect(hash1).toBe(hash2);
  });

  it("N10: hash changes when version changes", async () => {
    const { hashManifestRow } = await import("@/lib/appstore/registry");
    const base = {
      appId: "com.test.app",
      name: "Test",
      version: "1.0.0",
      description: null,
      publisher: null,
      kind: "mcp-server",
      manifestJson: "{}",
      signature: null,
      signatureStatus: "unsigned",
      source: "local",
      createdAt: 1000,
      updatedAt: 1000,
    };
    const h1 = hashManifestRow(base);
    const h2 = hashManifestRow({ ...base, version: "2.0.0" });
    expect(h1).not.toBe(h2);
  });

  it("throws APP_STORE_PII_GUARD when manifest has token field", async () => {
    const { upsertManifest } = await import("@/lib/appstore/registry");
    const badManifest = {
      ...makeManifest(),
      token: "sk-leaked",
    } as unknown as Parameters<typeof upsertManifest>[0]["manifest"];
    expect(() => upsertManifest({ manifest: badManifest })).toThrowError(
      /APP_STORE_PII_GUARD/,
    );
  });

  it("throws APP_MANIFEST_VALIDATION_ERROR on invalid appId", async () => {
    const { upsertManifest } = await import("@/lib/appstore/registry");
    const badManifest = makeManifest({
      appId: "INVALID-UPPERCASE",
    }) as unknown as Parameters<typeof upsertManifest>[0]["manifest"];
    expect(() => upsertManifest({ manifest: badManifest })).toThrowError(
      /APP_MANIFEST_VALIDATION_ERROR/,
    );
  });

  it("sets signatureStatus=unverified when signature present but no pubkey", async () => {
    const { upsertManifest } = await import("@/lib/appstore/registry");
    const row = upsertManifest({
      manifest: makeManifest(),
      signature: "c29tZXNpZw==",
    });
    expect(row.signatureStatus).toBe("unverified");
  });
});

describe("installApp → audit row (N8)", () => {
  it("creates an install record and writes an audit row", async () => {
    const { upsertManifest, installApp, listInstallAudit } = await import(
      "@/lib/appstore/registry"
    );

    upsertManifest({ manifest: makeManifest() });
    const install = installApp({
      appId: "com.example.test-app",
      scopeKind: "workspace",
      scopeId: "ws-abc123",
      actor: "user-1",
    });

    expect(install.id).toMatch(/^AINST-/);
    expect(install.appId).toBe("com.example.test-app");
    expect(install.scopeKind).toBe("workspace");
    expect(install.status).toBe("pending");
    expect(install.contentHash).toHaveLength(64);

    const auditRows = listInstallAudit("com.example.test-app");
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const installRow = auditRows.find((r) => r.action === "install");
    expect(installRow).toBeDefined();
    expect(installRow?.success).toBe(true);
    expect(installRow?.contentHash).toHaveLength(64);
  });

  it("throws APP_NOT_FOUND for unknown appId", async () => {
    const { installApp } = await import("@/lib/appstore/registry");
    expect(() =>
      installApp({ appId: "nonexistent.app", scopeKind: "workspace", scopeId: "ws-1" }),
    ).toThrowError(/APP_NOT_FOUND/);
  });

  it("install is idempotent — second call does not create a second row", async () => {
    const { upsertManifest, installApp, listInstalls } = await import(
      "@/lib/appstore/registry"
    );

    upsertManifest({ manifest: makeManifest() });
    installApp({ appId: "com.example.test-app", scopeKind: "workspace", scopeId: "ws-abc" });
    installApp({ appId: "com.example.test-app", scopeKind: "workspace", scopeId: "ws-abc" });

    const installs = listInstalls("workspace", "ws-abc");
    expect(installs).toHaveLength(1);
  });
});

describe("enableApp / disableApp", () => {
  it("enables a pending install → status=installed", async () => {
    const { upsertManifest, installApp, enableApp, getInstall } = await import(
      "@/lib/appstore/registry"
    );

    upsertManifest({ manifest: makeManifest() });
    installApp({
      appId: "com.example.test-app",
      scopeKind: "workspace",
      scopeId: "ws-1",
    });

    const enabled = enableApp("com.example.test-app", "workspace", "ws-1", "admin");
    expect(enabled).toBe(true);

    const row = getInstall("com.example.test-app", "workspace", "ws-1");
    expect(row?.status).toBe("installed");
  });

  it("disables an installed app → status=disabled", async () => {
    const { upsertManifest, installApp, enableApp, disableApp, getInstall } = await import(
      "@/lib/appstore/registry"
    );

    upsertManifest({ manifest: makeManifest() });
    installApp({ appId: "com.example.test-app", scopeKind: "org", scopeId: "org-1" });
    enableApp("com.example.test-app", "org", "org-1");
    disableApp("com.example.test-app", "org", "org-1", "admin");

    const row = getInstall("com.example.test-app", "org", "org-1");
    expect(row?.status).toBe("disabled");
  });

  it("enable on non-existent install returns false and writes audit row", async () => {
    const { upsertManifest, enableApp, listInstallAudit } = await import(
      "@/lib/appstore/registry"
    );
    upsertManifest({ manifest: makeManifest() });
    const result = enableApp("com.example.test-app", "workspace", "ws-nonexistent");
    expect(result).toBe(false);

    const auditRows = listInstallAudit("com.example.test-app");
    const failRow = auditRows.find((r) => r.action === "enable" && !r.success);
    expect(failRow).toBeDefined();
    expect(failRow?.reason).toBe("not-found");
  });
});

describe("uninstallApp", () => {
  it("removes the install record and writes an uninstall audit row", async () => {
    const { upsertManifest, installApp, uninstallApp, getInstall, listInstallAudit } =
      await import("@/lib/appstore/registry");

    upsertManifest({ manifest: makeManifest() });
    installApp({
      appId: "com.example.test-app",
      scopeKind: "workspace",
      scopeId: "ws-del",
    });

    const result = uninstallApp("com.example.test-app", "workspace", "ws-del", "user-2");
    expect(result).toBe(true);

    const row = getInstall("com.example.test-app", "workspace", "ws-del");
    expect(row).toBeNull();

    const auditRows = listInstallAudit("com.example.test-app");
    const uninstallRow = auditRows.find((r) => r.action === "uninstall");
    expect(uninstallRow).toBeDefined();
    expect(uninstallRow?.success).toBe(true);
    expect(uninstallRow?.actor).toBe("user-2");
  });

  it("uninstall on non-existent install returns false", async () => {
    const { upsertManifest, uninstallApp } = await import("@/lib/appstore/registry");
    upsertManifest({ manifest: makeManifest() });
    const result = uninstallApp("com.example.test-app", "workspace", "ws-none");
    expect(result).toBe(false);
  });
});

describe("N8 audit trail completeness", () => {
  it("install → enable → disable → uninstall all produce audit rows", async () => {
    const {
      upsertManifest,
      installApp,
      enableApp,
      disableApp,
      uninstallApp,
      listInstallAudit,
    } = await import("@/lib/appstore/registry");

    upsertManifest({ manifest: makeManifest() });
    installApp({ appId: "com.example.test-app", scopeKind: "workspace", scopeId: "ws-full" });
    enableApp("com.example.test-app", "workspace", "ws-full");
    disableApp("com.example.test-app", "workspace", "ws-full");
    uninstallApp("com.example.test-app", "workspace", "ws-full");

    const rows = listInstallAudit("com.example.test-app");
    const actions = rows.map((r) => r.action);

    expect(actions).toContain("install");
    expect(actions).toContain("enable");
    expect(actions).toContain("disable");
    expect(actions).toContain("uninstall");

    // All rows have N10 hashes
    for (const row of rows) {
      expect(row.contentHash).toHaveLength(64);
    }
  });
});

// ---------------------------------------------------------------------------
// AUTH-1 — assertAccess callback gates writes
// ---------------------------------------------------------------------------

describe("AUTH-1 — assertAccess gate", () => {
  it("installApp: assertAccess that throws → no install row + no success audit", async () => {
    const { upsertManifest, installApp, listInstalls, listInstallAudit } =
      await import("@/lib/appstore/registry");

    upsertManifest({ manifest: makeManifest() });

    const deny = () => {
      throw new Error("[APP_STORE_AUTH_DENIED] not a member");
    };

    expect(() =>
      installApp({
        appId: "com.example.test-app",
        scopeKind: "workspace",
        scopeId: "ws-denied",
        actor: "intruder",
        assertAccess: deny,
      }),
    ).toThrowError(/APP_STORE_AUTH_DENIED/);

    // No install row written
    const installs = listInstalls("workspace", "ws-denied");
    expect(installs).toHaveLength(0);

    // No success audit row (the throw happened before any write)
    const audit = listInstallAudit("com.example.test-app");
    const successInstall = audit.find(
      (r) => r.action === "install" && r.success,
    );
    expect(successInstall).toBeUndefined();
  });

  it("installApp: assertAccess that passes → install proceeds", async () => {
    const { upsertManifest, installApp, getInstall } = await import(
      "@/lib/appstore/registry"
    );

    upsertManifest({ manifest: makeManifest() });

    const allow = () => {
      /* member — no throw */
    };

    installApp({
      appId: "com.example.test-app",
      scopeKind: "workspace",
      scopeId: "ws-allowed",
      actor: "member",
      assertAccess: allow,
    });

    const row = getInstall("com.example.test-app", "workspace", "ws-allowed");
    expect(row).not.toBeNull();
  });

  it("enableApp: assertAccess that throws → status unchanged", async () => {
    const { upsertManifest, installApp, enableApp, getInstall } = await import(
      "@/lib/appstore/registry"
    );

    upsertManifest({ manifest: makeManifest() });
    installApp({ appId: "com.example.test-app", scopeKind: "workspace", scopeId: "ws-e" });

    const deny = () => {
      throw new Error("[APP_STORE_AUTH_DENIED] denied");
    };

    expect(() =>
      enableApp("com.example.test-app", "workspace", "ws-e", "intruder", deny),
    ).toThrowError(/APP_STORE_AUTH_DENIED/);

    // Still pending — enable never ran
    const row = getInstall("com.example.test-app", "workspace", "ws-e");
    expect(row?.status).toBe("pending");
  });

  it("disableApp + uninstallApp: assertAccess that throws → no mutation", async () => {
    const { upsertManifest, installApp, enableApp, disableApp, uninstallApp, getInstall } =
      await import("@/lib/appstore/registry");

    upsertManifest({ manifest: makeManifest() });
    installApp({ appId: "com.example.test-app", scopeKind: "org", scopeId: "org-x" });
    enableApp("com.example.test-app", "org", "org-x");

    const deny = () => {
      throw new Error("[APP_STORE_AUTH_DENIED] denied");
    };

    expect(() =>
      disableApp("com.example.test-app", "org", "org-x", "intruder", deny),
    ).toThrowError(/APP_STORE_AUTH_DENIED/);
    expect(getInstall("com.example.test-app", "org", "org-x")?.status).toBe("installed");

    expect(() =>
      uninstallApp("com.example.test-app", "org", "org-x", "intruder", deny),
    ).toThrowError(/APP_STORE_AUTH_DENIED/);
    expect(getInstall("com.example.test-app", "org", "org-x")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PII-1 — requestedCredentialScopes value scan
// ---------------------------------------------------------------------------

describe("PII-1 — requestedCredentialScopes value scan", () => {
  it("throws APP_STORE_PII_GUARD when a scope value contains '='", async () => {
    const { assertNonSensitiveManifest } = await import("@/lib/appstore/manifest");
    expect(() =>
      assertNonSensitiveManifest({
        appId: "com.test.app",
        requestedCredentialScopes: ["api_key=sk-abc123"],
      }),
    ).toThrowError(/APP_STORE_PII_GUARD/);
  });

  it("throws when a scope value has uppercase or whitespace", async () => {
    const { assertNonSensitiveManifest } = await import("@/lib/appstore/manifest");
    expect(() =>
      assertNonSensitiveManifest({
        appId: "com.test.app",
        requestedCredentialScopes: ["OpenAI Token"],
      }),
    ).toThrowError(/APP_STORE_PII_GUARD/);
  });

  it("allows valid plain and structured scope values", async () => {
    const { assertNonSensitiveManifest } = await import("@/lib/appstore/manifest");
    expect(() =>
      assertNonSensitiveManifest({
        appId: "com.test.app",
        requestedCredentialScopes: ["openai", "my-server:my-tool:read", "stripe.v2"],
      }),
    ).not.toThrow();
  });

  it("validateManifest rejects a manifest with '=' in scope", async () => {
    const { validateManifest } = await import("@/lib/appstore/manifest");
    // PII guard throws (not a soft Zod failure) — it runs first in validateManifest.
    expect(() =>
      validateManifest(
        makeManifest({ requestedCredentialScopes: ["token=ghp_xxx"] }) as Record<
          string,
          unknown
        >,
      ),
    ).toThrowError(/APP_STORE_PII_GUARD/);
  });
});

// ---------------------------------------------------------------------------
// PII-2 — mcpServerArgs embedded-secret scan
// ---------------------------------------------------------------------------

describe("PII-2 — mcpServerArgs embedded-secret scan", () => {
  it("throws on --api-key= with inline value", async () => {
    const { assertNonSensitiveManifest } = await import("@/lib/appstore/manifest");
    expect(() =>
      assertNonSensitiveManifest({
        appId: "com.test.app",
        mcpServerArgs: ["--api-key=sk-realsecret123456"],
      }),
    ).toThrowError(/APP_STORE_PII_GUARD/);
  });

  it("throws on a bare 'sk-' token prefix arg", async () => {
    const { assertNonSensitiveManifest } = await import("@/lib/appstore/manifest");
    expect(() =>
      assertNonSensitiveManifest({
        appId: "com.test.app",
        mcpServerArgs: ["sk-abcdefgh12345678"],
      }),
    ).toThrowError(/APP_STORE_PII_GUARD/);
  });

  it("allows env-var placeholder references", async () => {
    const { assertNonSensitiveManifest } = await import("@/lib/appstore/manifest");
    expect(() =>
      assertNonSensitiveManifest({
        appId: "com.test.app",
        mcpServerArgs: ["--api-key=${OPENAI_API_KEY}", "--port=8080", "--verbose"],
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// QUERY-1 — compound filter
// ---------------------------------------------------------------------------

describe("QUERY-1 — listApps compound filter", () => {
  it("applies all set filters as AND (not just the first)", async () => {
    const { upsertManifest, listApps } = await import("@/lib/appstore/registry");

    // Two mcp-server apps, different sources
    upsertManifest({
      manifest: makeManifest({ appId: "com.a.local", kind: "mcp-server" }),
      source: "local",
    });
    upsertManifest({
      manifest: makeManifest({ appId: "com.b.builtin", kind: "mcp-server" }),
      source: "builtin",
    });
    // A connector app with source=local (should be excluded by kind filter)
    upsertManifest({
      manifest: makeManifest({ appId: "com.c.connector", kind: "connector" }),
      source: "local",
    });

    // Compound: kind=mcp-server AND source=local → only com.a.local
    const result = listApps({ kind: "mcp-server", source: "local" });
    expect(result).toHaveLength(1);
    expect(result[0].appId).toBe("com.a.local");
  });

  it("returns all rows when no filter is given", async () => {
    const { upsertManifest, listApps } = await import("@/lib/appstore/registry");
    upsertManifest({ manifest: makeManifest({ appId: "com.x.one" }) });
    upsertManifest({ manifest: makeManifest({ appId: "com.y.two" }) });
    expect(listApps()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// R3-1/SIG-1 — invalid signature install-block
// ---------------------------------------------------------------------------

describe("R3-1/SIG-1 — invalid-signature install gate", () => {
  it("throws APP_SIGNATURE_INVALID when initialStatus=installed and sig=invalid", async () => {
    const { upsertManifest, installApp } = await import("@/lib/appstore/registry");
    const { generateKeyPairSync } = await import("node:crypto");

    // Register a manifest with a present-but-garbage signature + a real pubkey
    // → signatureStatus becomes 'invalid'.
    const { publicKey } = generateKeyPairSync("ed25519");
    const pubkeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;

    const row = upsertManifest({
      manifest: makeManifest(),
      signature: "bm90YXZhbGlkc2ln",
      pubkeyPem,
    });
    expect(row.signatureStatus).toBe("invalid");

    expect(() =>
      installApp({
        appId: "com.example.test-app",
        scopeKind: "workspace",
        scopeId: "ws-sig",
        initialStatus: "installed",
      }),
    ).toThrowError(/APP_SIGNATURE_INVALID/);
  });

  it("allows initialStatus=pending even when sig=invalid", async () => {
    const { upsertManifest, installApp, getInstall } = await import(
      "@/lib/appstore/registry"
    );
    const { generateKeyPairSync } = await import("node:crypto");

    const { publicKey } = generateKeyPairSync("ed25519");
    const pubkeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;

    upsertManifest({
      manifest: makeManifest(),
      signature: "bm90YXZhbGlkc2ln",
      pubkeyPem,
    });

    // Default initialStatus='pending' must NOT be blocked
    installApp({
      appId: "com.example.test-app",
      scopeKind: "workspace",
      scopeId: "ws-sig2",
    });
    expect(getInstall("com.example.test-app", "workspace", "ws-sig2")?.status).toBe(
      "pending",
    );
  });
});
