/**
 * Tests für lib/credentials/vault.ts (ACL-1).
 *
 * Laufen via:
 *   NODE_OPTIONS='--experimental-require-module' npx vitest run lib/credentials/__tests__/vault.test.ts
 *
 * Setup:
 *   - In-memory SQLite mit den notwendigen Tabellen.
 *   - `getDb` und `lib/security/permissions` + `lib/orgs/repo` + `lib/security/membership`
 *     werden gemockt.
 *   - `lib/security/credentials` NICHT gemockt — nutzt echten AES-GCM.
 *   - LAZYOS_CREDENTIAL_KEY: gesetzt vor jedem Test via process.env.
 *
 * Szenarien:
 *   a) isolated workspace → KEIN Org-Fallback, null wenn kein WS-Credential.
 *   b) inherit workspace → erbt Org-Default wenn kein WS-Credential.
 *   c) Workspace-Override gewinnt über Org-Credential (inherit).
 *   d) Auth-Gate: Nicht-Member → null + deny-Audit.
 *   e) Provider-Isolation: heygen != openai credential.
 *   f) Audit-Row bei jedem resolve().
 *   g) P0-C1: Org-Fallback-Read-Gate — inherit + KEINE echte Membership → null + Audit.
 *   h) P0-C1: Org-Fallback-Read-Gate — inherit + echte Org-Membership → ok.
 *   i) P0-C1: Workspace-own-Credential-Read unverändert (kein echtes Membership erforderlich
 *      für den WS-eigenen Credential, nur canEditWorkspaceContent).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { randomBytes } from "node:crypto";

// ── Set credential key BEFORE importing vault (key is cached) ──────────────
const TEST_KEY = randomBytes(32).toString("hex"); // 64 hex chars
process.env.LAZYOS_CREDENTIAL_KEY = TEST_KEY;

// ─── In-memory SQLite setup ───────────────────────────────────────────────────

import Database from "better-sqlite3";

let testDb: ReturnType<typeof Database>;

// We mock getDb to return our in-memory DB with the same $raw interface.
vi.mock("@/db/client", () => ({
  getDb: () => testDb,
}));

// ─── Mock permissions ─────────────────────────────────────────────────────────

// We control who is a member by setting this before each test.
let memberWorkspaceIds = new Set<string>();
let nonMemberWorkspaceIds = new Set<string>();

vi.mock("@/lib/security/permissions", () => ({
  getEffectiveWorkspaceRole: (userId: string, workspaceId: string) => {
    if (nonMemberWorkspaceIds.has(workspaceId)) return null;
    if (memberWorkspaceIds.has(workspaceId)) return "member";
    return "member"; // default: allow
  },
  canEditWorkspaceContent: (role: string | null) => {
    if (role === null) return false;
    const RANK: Record<string, number> = {
      founder: 5, admin: 4, member: 3, viewer: 2, guest: 1,
    };
    return (RANK[role] ?? 0) >= 3; // >= member
  },
}));

// ─── Mock orgs/repo ───────────────────────────────────────────────────────────

let workspaceOrgMap: Map<string, { id: string; name: string }> = new Map();
// userId → orgId → role (für isOrgAdmin via findUserOrgMembership).
let orgMembershipMap: Map<string, Map<string, string>> = new Map();

vi.mock("@/lib/orgs/repo", () => ({
  findOrgForWorkspace: (workspaceId: string) => {
    return workspaceOrgMap.get(workspaceId) ?? null;
  },
  findUserOrgMembership: (userId: string, orgId: string) => {
    const role = orgMembershipMap.get(userId)?.get(orgId);
    return role ? { id: `mem-${userId}-${orgId}`, userId, orgId, role } : null;
  },
}));

function grantOrgRole(userId: string, orgId: string, role: string) {
  if (!orgMembershipMap.has(userId)) orgMembershipMap.set(userId, new Map());
  orgMembershipMap.get(userId)!.set(orgId, role);
}

// ─── Mock lib/security/membership ────────────────────────────────────────────
// hasRealWorkspaceMembership: per-Test steuerbar über realMembershipSet.
// true  → User hat eine ECHTE Membership (WS-Row oder Org-Membership).
// false → nur solo-implicit-founder (kein echter Nachweis).

let realMembershipSet = new Set<string>(); // key = `${userId}:${workspaceId}`

vi.mock("@/lib/security/membership", () => ({
  hasRealWorkspaceMembership: (userId: string, workspaceId: string) => {
    return realMembershipSet.has(`${userId}:${workspaceId}`);
  },
}));

function grantRealMembership(userId: string, workspaceId: string) {
  realMembershipSet.add(`${userId}:${workspaceId}`);
}
function revokeRealMembership(userId: string, workspaceId: string) {
  realMembershipSet.delete(`${userId}:${workspaceId}`);
}

// ─── Import vault AFTER mocks ─────────────────────────────────────────────────

import {
  putApiCredential,
  resolveApiCredential,
  deleteApiCredential,
  recordRevealAudit,
} from "../vault";

// ─── DB Helpers ───────────────────────────────────────────────────────────────

function setupInMemoryDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_credentials (
      id                   TEXT PRIMARY KEY,
      scope_kind           TEXT NOT NULL CHECK(scope_kind IN ('org', 'workspace')),
      scope_id             TEXT NOT NULL,
      provider             TEXT NOT NULL,
      credential_kind      TEXT NOT NULL CHECK(credential_kind IN ('api_key', 'pat', 'oauth')),
      encrypted_secret     TEXT NOT NULL,
      config_json          TEXT,
      last_validated_at    INTEGER,
      content_hash         TEXT NOT NULL,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL,
      UNIQUE(scope_kind, scope_id, provider)
    );

    CREATE TABLE IF NOT EXISTS credential_access_log (
      id          TEXT PRIMARY KEY,
      ts          INTEGER NOT NULL,
      scope_kind  TEXT NOT NULL,
      scope_id    TEXT NOT NULL,
      provider    TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      action      TEXT NOT NULL CHECK(action IN ('put', 'resolve', 'reveal', 'delete')),
      source      TEXT,
      success     INTEGER NOT NULL CHECK(success IN (0, 1)),
      reason      TEXT,
      content_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id                   TEXT PRIMARY KEY,
      label                TEXT NOT NULL DEFAULT 'test',
      accent               TEXT NOT NULL DEFAULT '#fff',
      path                 TEXT NOT NULL DEFAULT '/tmp',
      sensitivity          TEXT NOT NULL DEFAULT 'low',
      archived             INTEGER NOT NULL DEFAULT 0,
      sandbox_mode         INTEGER NOT NULL DEFAULT 0,
      workspace_type       TEXT NOT NULL DEFAULT 'default',
      created_at           INTEGER NOT NULL DEFAULT 0,
      updated_at           INTEGER NOT NULL DEFAULT 0,
      credential_isolation TEXT
    );
  `);
  return db;
}

function getAuditRows(db: ReturnType<typeof Database>) {
  return db.prepare("SELECT * FROM credential_access_log ORDER BY ts ASC").all() as Array<{
    id: string;
    ts: number;
    scope_kind: string;
    scope_id: string;
    provider: string;
    user_id: string;
    action: string;
    source: string | null;
    success: number;
    reason: string | null;
    content_hash: string;
  }>;
}

function insertWorkspace(
  db: ReturnType<typeof Database>,
  id: string,
  credentialIsolation: string | null,
) {
  db.prepare(
    `INSERT INTO workspaces (id, label, accent, path, created_at, updated_at, credential_isolation)
     VALUES (?, 'test', '#fff', '/tmp', 0, 0, ?)`,
  ).run(id, credentialIsolation);
}

// ─── beforeEach: fresh in-memory DB ──────────────────────────────────────────

beforeEach(() => {
  testDb = setupInMemoryDb() as ReturnType<typeof Database>;
  memberWorkspaceIds = new Set();
  nonMemberWorkspaceIds = new Set();
  workspaceOrgMap = new Map();
  orgMembershipMap = new Map();
  realMembershipSet = new Set();
  // Re-attach $raw to the test db (vault uses getDb().$raw)
  (testDb as unknown as Record<string, unknown>).$raw = testDb;
});

afterEach(() => {
  testDb.close();
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("vault.resolveApiCredential", () => {

  // (a) isolated workspace → KEIN Org-Fallback
  it("(a) credential_isolation=isolated: KEIN Org-Fallback, null wenn kein WS-Credential", () => {
    const wsId = "ws-isolated";
    const orgId = "org-1";
    const userId = "user-1";

    insertWorkspace(testDb, wsId, "isolated");
    workspaceOrgMap.set(wsId, { id: orgId, name: "Org 1" });
    memberWorkspaceIds.add(wsId);
    grantOrgRole(userId, orgId, "admin"); // darf Org-Credential schreiben

    // Org-Credential existiert, aber WS hat kein eigenes
    const putId = putApiCredential(
      { scopeKind: "org", scopeId: orgId, provider: "heygen", kind: "api_key", secret: "org-secret-abc" },
      { userId, source: "test" },
    );
    expect(putId).not.toBeNull();

    const result = resolveApiCredential(wsId, userId, "heygen");

    expect(result).toBeNull();

    // Audit muss deny mit reason=isolation-block haben
    const logs = getAuditRows(testDb);
    const resolveLog = logs.filter((l) => l.action === "resolve");
    expect(resolveLog.length).toBeGreaterThanOrEqual(1);
    const lastResolve = resolveLog[resolveLog.length - 1];
    expect(lastResolve.success).toBe(0);
    expect(lastResolve.reason).toBe("isolation-block");
  });

  // (b) inherit workspace → erbt Org-Default
  it("(b) credential_isolation=inherit: erbt Org-Default wenn kein WS-Credential", () => {
    const wsId = "ws-inherit";
    const orgId = "org-2";
    const userId = "user-1";

    insertWorkspace(testDb, wsId, "inherit");
    workspaceOrgMap.set(wsId, { id: orgId, name: "Org 2" });
    memberWorkspaceIds.add(wsId);
    grantOrgRole(userId, orgId, "admin");
    // P0-C1: echte Membership für den Org-Fallback-Read-Gate erforderlich.
    grantRealMembership(userId, wsId);

    putApiCredential(
      { scopeKind: "org", scopeId: orgId, provider: "openai", kind: "api_key", secret: "org-openai-key" },
      { userId, source: "test" },
    );

    const result = resolveApiCredential(wsId, userId, "openai");

    expect(result).not.toBeNull();
    expect(result!.secret).toBe("org-openai-key");
    expect(result!.source).toBe("org-fallback");

    const logs = getAuditRows(testDb);
    const resolveLog = logs.filter((l) => l.action === "resolve");
    const lastResolve = resolveLog[resolveLog.length - 1];
    expect(lastResolve.success).toBe(1);
    expect(lastResolve.reason).toBe("org-fallback");
  });

  // (B-1) FAIL-CLOSED: credential_isolation=null → isolated, KEIN Org-Fallback
  it("(B-1) credential_isolation=null (fehlendes/garbage Feld): fail-closed isolated, KEIN Org-Fallback", () => {
    const wsId = "ws-null-isolation";
    const orgId = "org-3";
    const userId = "user-1";

    // NULL in der DB → fail-closed: behandeln wie 'isolated' (Security-Critic B-1).
    insertWorkspace(testDb, wsId, null);
    workspaceOrgMap.set(wsId, { id: orgId, name: "Org 3" });
    memberWorkspaceIds.add(wsId);
    grantOrgRole(userId, orgId, "admin");

    // Org-Credential EXISTIERT — darf aber NICHT geerbt werden (null != 'inherit').
    putApiCredential(
      { scopeKind: "org", scopeId: orgId, provider: "heygen", kind: "api_key", secret: "org-must-not-leak" },
      { userId, source: "test" },
    );

    const result = resolveApiCredential(wsId, userId, "heygen");

    // FAIL-CLOSED: kein Leak des Org-Credentials.
    expect(result).toBeNull();

    // reason MUSS 'isolation-block' sein (NICHT 'org-fallback', NICHT 'not-found').
    const logs = getAuditRows(testDb);
    const resolveLog = logs.filter((l) => l.action === "resolve");
    const lastResolve = resolveLog[resolveLog.length - 1];
    expect(lastResolve.success).toBe(0);
    expect(lastResolve.reason).toBe("isolation-block");
  });

  // (B-1b) garbage isolation value → fail-closed isolated
  it("(B-1) credential_isolation='garbage' → fail-closed isolated, KEIN Org-Fallback", () => {
    const wsId = "ws-garbage-isolation";
    const orgId = "org-3b";
    const userId = "user-1";

    insertWorkspace(testDb, wsId, "wat-is-this");
    workspaceOrgMap.set(wsId, { id: orgId, name: "Org 3b" });
    memberWorkspaceIds.add(wsId);
    grantOrgRole(userId, orgId, "admin");

    putApiCredential(
      { scopeKind: "org", scopeId: orgId, provider: "openai", kind: "api_key", secret: "org-leak-attempt" },
      { userId, source: "test" },
    );

    const result = resolveApiCredential(wsId, userId, "openai");
    expect(result).toBeNull();

    const logs = getAuditRows(testDb);
    const resolveLog = logs.filter((l) => l.action === "resolve");
    expect(resolveLog[resolveLog.length - 1].reason).toBe("isolation-block");
  });

  // (c) Workspace-Override gewinnt über Org
  it("(c) WS-Credential gewinnt über Org-Credential (inherit)", () => {
    const wsId = "ws-override";
    const orgId = "org-4";
    const userId = "user-1";

    insertWorkspace(testDb, wsId, "inherit");
    workspaceOrgMap.set(wsId, { id: orgId, name: "Org 4" });
    memberWorkspaceIds.add(wsId);
    grantOrgRole(userId, orgId, "admin");

    // Org-Credential
    putApiCredential(
      { scopeKind: "org", scopeId: orgId, provider: "heygen", kind: "api_key", secret: "org-heygen" },
      { userId, source: "test" },
    );
    // WS-Credential (override)
    putApiCredential(
      { scopeKind: "workspace", scopeId: wsId, provider: "heygen", kind: "api_key", secret: "ws-heygen-override" },
      { userId, source: "test" },
    );

    const result = resolveApiCredential(wsId, userId, "heygen");

    expect(result).not.toBeNull();
    expect(result!.secret).toBe("ws-heygen-override");
    expect(result!.source).toBe("workspace-cred");

    const logs = getAuditRows(testDb);
    const resolveLog = logs.filter((l) => l.action === "resolve");
    const lastResolve = resolveLog[resolveLog.length - 1];
    expect(lastResolve.reason).toBe("workspace-cred");
  });

  // (d) Auth-Gate: Nicht-Member → null + deny-Audit
  it("(d) Auth-Gate: Nicht-Member → null, deny-Audit mit reason=auth-denied", () => {
    const wsId = "ws-private";
    const userId = "user-stranger";

    insertWorkspace(testDb, wsId, "inherit");
    // Markiere als non-member
    nonMemberWorkspaceIds.add(wsId);

    // Selbst wenn ein Credential existiert — Nicht-Member bekommt nichts
    putApiCredential(
      { scopeKind: "workspace", scopeId: wsId, provider: "openai", kind: "api_key", secret: "private-key" },
      { userId: "user-owner", source: "test" },
    );

    const result = resolveApiCredential(wsId, userId, "openai");

    expect(result).toBeNull();

    const logs = getAuditRows(testDb);
    const resolveLog = logs.filter((l) => l.action === "resolve" && l.user_id === userId);
    expect(resolveLog.length).toBe(1);
    expect(resolveLog[0].success).toBe(0);
    expect(resolveLog[0].reason).toBe("auth-denied");
  });

  // (e) Provider-Isolation: heygen != openai
  it("(e) Provider-Isolation: heygen-Credential gibt nicht openai zurück", () => {
    const wsId = "ws-multi-provider";
    const userId = "user-1";

    insertWorkspace(testDb, wsId, "inherit");
    memberWorkspaceIds.add(wsId);

    putApiCredential(
      { scopeKind: "workspace", scopeId: wsId, provider: "heygen", kind: "api_key", secret: "heygen-secret" },
      { userId, source: "test" },
    );

    const heygen = resolveApiCredential(wsId, userId, "heygen");
    const openai = resolveApiCredential(wsId, userId, "openai");

    expect(heygen).not.toBeNull();
    expect(heygen!.secret).toBe("heygen-secret");
    expect(heygen!.provider).toBe("heygen");

    // openai existiert nicht → null
    expect(openai).toBeNull();
  });

  // (f) Audit-Row pro resolve
  it("(f) schreibt Audit-Row bei jedem resolve (N8)", () => {
    const wsId = "ws-audit";
    const userId = "user-1";

    insertWorkspace(testDb, wsId, "inherit");
    memberWorkspaceIds.add(wsId);

    putApiCredential(
      { scopeKind: "workspace", scopeId: wsId, provider: "stripe", kind: "api_key", secret: "sk_test_123" },
      { userId, source: "test" },
    );

    // 3 resolves
    resolveApiCredential(wsId, userId, "stripe");
    resolveApiCredential(wsId, userId, "stripe");
    resolveApiCredential(wsId, userId, "stripe");

    const logs = getAuditRows(testDb);
    const resolveLogs = logs.filter((l) => l.action === "resolve");

    expect(resolveLogs.length).toBe(3);
    resolveLogs.forEach((l) => {
      expect(l.scope_id).toBe(wsId);
      expect(l.provider).toBe("stripe");
      expect(l.user_id).toBe(userId);
      expect(l.success).toBe(1);
      // N10: content_hash ist gesetzt und nicht leer
      expect(l.content_hash).toBeTruthy();
      expect(l.content_hash.length).toBe(64); // SHA-256 hex
    });
  });

  // N10: content_hash ist deterministisch und gesetzt
  it("putApiCredential setzt content_hash (N10)", () => {
    const userId = "user-1";
    const wsId = "ws-hash";
    insertWorkspace(testDb, wsId, "inherit");

    const id = putApiCredential(
      { scopeKind: "workspace", scopeId: wsId, provider: "anthropic", kind: "api_key", secret: "test-key" },
      { userId, source: "test" },
    );

    const row = testDb
      .prepare("SELECT content_hash FROM api_credentials WHERE id = ?")
      .get(id) as { content_hash: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.content_hash).toBeTruthy();
    expect(row!.content_hash.length).toBe(64); // SHA-256 hex
  });

  // deleteApiCredential + Audit
  it("deleteApiCredential löscht Row und schreibt Audit-Row", () => {
    const userId = "user-1";
    const wsId = "ws-delete";
    insertWorkspace(testDb, wsId, "inherit");
    memberWorkspaceIds.add(wsId);

    putApiCredential(
      { scopeKind: "workspace", scopeId: wsId, provider: "heygen", kind: "api_key", secret: "todelete" },
      { userId, source: "test" },
    );

    const deleted = deleteApiCredential("workspace", wsId, "heygen", { userId, source: "test" });
    expect(deleted).toBe(true);

    // Nach Delete: resolve gibt null
    const result = resolveApiCredential(wsId, userId, "heygen");
    expect(result).toBeNull();

    // Audit-Log: delete-Row vorhanden
    const logs = getAuditRows(testDb);
    const deleteLogs = logs.filter((l) => l.action === "delete");
    expect(deleteLogs.length).toBe(1);
    expect(deleteLogs[0].success).toBe(1);
    expect(deleteLogs[0].reason).toBe("deleted");
  });

  // (M-3) putApiCredential Auth-Gate: Nicht-Member → kein Write + deny-Audit
  it("(M-3) putApiCredential: Nicht-Member → kein Write, return null, deny-Audit", () => {
    const wsId = "ws-put-denied";
    const userId = "user-outsider";

    insertWorkspace(testDb, wsId, "inherit");
    nonMemberWorkspaceIds.add(wsId); // userId ist kein Member

    const putId = putApiCredential(
      { scopeKind: "workspace", scopeId: wsId, provider: "heygen", kind: "api_key", secret: "should-not-store" },
      { userId, source: "test" },
    );

    // Kein Write
    expect(putId).toBeNull();
    const rows = testDb
      .prepare("SELECT COUNT(*) as c FROM api_credentials WHERE scope_id = ?")
      .get(wsId) as { c: number };
    expect(rows.c).toBe(0);

    // deny-Audit
    const logs = getAuditRows(testDb);
    const putLogs = logs.filter((l) => l.action === "put");
    expect(putLogs.length).toBe(1);
    expect(putLogs[0].success).toBe(0);
    expect(putLogs[0].reason).toBe("auth-denied");
  });

  // (M-3) putApiCredential org-scope: Nicht-Admin → kein Write + deny-Audit
  it("(M-3) putApiCredential org-scope: Nicht-Org-Admin → kein Write, return null, deny-Audit", () => {
    const orgId = "org-put-denied";
    const userId = "user-member-only";

    // User ist nur 'member' in der Org, nicht 'admin' → darf KEINE Org-Credentials schreiben.
    grantOrgRole(userId, orgId, "member");

    const putId = putApiCredential(
      { scopeKind: "org", scopeId: orgId, provider: "openai", kind: "api_key", secret: "org-secret" },
      { userId, source: "test" },
    );

    expect(putId).toBeNull();
    const logs = getAuditRows(testDb);
    const putLogs = logs.filter((l) => l.action === "put");
    expect(putLogs[0].success).toBe(0);
    expect(putLogs[0].reason).toBe("auth-denied");
  });

  // (B-2) deleteApiCredential Auth-Gate: Nicht-Member → kein Delete + deny-Audit
  it("(B-2) deleteApiCredential: Nicht-Member → kein Delete, return false, deny-Audit", () => {
    const wsId = "ws-del-denied";
    const ownerId = "user-owner";
    const strangerId = "user-stranger";

    insertWorkspace(testDb, wsId, "inherit");
    memberWorkspaceIds.add(wsId); // owner ist Member (default mock = member)

    // Owner legt ein Credential an
    const putId = putApiCredential(
      { scopeKind: "workspace", scopeId: wsId, provider: "stripe", kind: "api_key", secret: "keep-me" },
      { userId: ownerId, source: "test" },
    );
    expect(putId).not.toBeNull();

    // Stranger versucht zu löschen → Deny
    nonMemberWorkspaceIds.add(wsId); // ab jetzt: stranger nicht-member (überschreibt default)
    const deleted = deleteApiCredential("workspace", wsId, "stripe", { userId: strangerId, source: "test" });

    expect(deleted).toBe(false);
    // Credential noch da
    const rows = testDb
      .prepare("SELECT COUNT(*) as c FROM api_credentials WHERE scope_id = ? AND provider = 'stripe'")
      .get(wsId) as { c: number };
    expect(rows.c).toBe(1);

    // deny-Audit
    const logs = getAuditRows(testDb);
    const delLogs = logs.filter((l) => l.action === "delete");
    expect(delLogs.length).toBe(1);
    expect(delLogs[0].success).toBe(0);
    expect(delLogs[0].reason).toBe("auth-denied");
  });

  // (N-1) Provider-Validierung: dreckiger Provider → kein Write + deny-Audit
  it("(N-1) putApiCredential: ungültiger Provider → kein Write, return null, deny-Audit", () => {
    const wsId = "ws-bad-provider";
    const userId = "user-1";

    insertWorkspace(testDb, wsId, "inherit");
    memberWorkspaceIds.add(wsId);

    const putId = putApiCredential(
      { scopeKind: "workspace", scopeId: wsId, provider: "He Ygen; DROP", kind: "api_key", secret: "x" },
      { userId, source: "test" },
    );

    expect(putId).toBeNull();
    const rows = testDb
      .prepare("SELECT COUNT(*) as c FROM api_credentials WHERE scope_id = ?")
      .get(wsId) as { c: number };
    expect(rows.c).toBe(0);

    const logs = getAuditRows(testDb);
    const putLogs = logs.filter((l) => l.action === "put");
    expect(putLogs[0].success).toBe(0);
    expect(putLogs[0].reason).toBe("invalid-provider");
  });

  // ── P0-C1: Org-Fallback-Read-Gate ────────────────────────────────────────────
  // Security-Critic P0-C1 (2026-05-25): der Org-Fallback-Read-Pfad in
  // resolveApiCredential verlangt jetzt eine ECHTE Membership (analog dem
  // Write-Gate in der Route). `solo-implicit-founder` allein NICHT ausreichend.

  // (g) Org-Fallback-Read ohne echte Membership → null + Audit reason='org-fallback-membership-denied'
  it("(g) P0-C1: Org-Fallback-Read ohne echte Membership → null, deny-Audit", () => {
    const wsId = "ws-inherit-no-real-mem";
    const orgId = "org-g1";
    const userId = "user-solo";

    // Workspace: inherit — würde normalerweise Org-Fallback ermöglichen.
    insertWorkspace(testDb, wsId, "inherit");
    workspaceOrgMap.set(wsId, { id: orgId, name: "Org G1" });
    // canEditWorkspaceContent = true (solo-implicit-founder rankt als founder).
    memberWorkspaceIds.add(wsId);
    grantOrgRole(userId, orgId, "admin");
    // KEINE echte Membership — simuliert solo-implicit-founder ohne WS/Org-Row.
    // revokeRealMembership ist hier der Default (realMembershipSet leer).

    // Org-Credential existiert.
    putApiCredential(
      { scopeKind: "org", scopeId: orgId, provider: "heygen", kind: "api_key", secret: "org-should-not-read" },
      { userId, source: "test" },
    );

    const result = resolveApiCredential(wsId, userId, "heygen");

    // FAIL-CLOSED: kein Secret-Leak ohne echte Membership.
    expect(result).toBeNull();

    // Audit: reason MUSS 'org-fallback-membership-denied' sein.
    const logs = getAuditRows(testDb);
    const resolveLogs = logs.filter((l) => l.action === "resolve" && l.user_id === userId);
    expect(resolveLogs.length).toBeGreaterThanOrEqual(1);
    const denyRow = resolveLogs[resolveLogs.length - 1];
    expect(denyRow.success).toBe(0);
    expect(denyRow.reason).toBe("org-fallback-membership-denied");
    expect(denyRow.scope_id).toBe(wsId);
    expect(denyRow.provider).toBe("heygen");
    // N10: content_hash gesetzt.
    expect(denyRow.content_hash.length).toBe(64);
  });

  // (h) Org-Fallback-Read mit echter Org-Membership → Credential zurückgegeben
  it("(h) P0-C1: Org-Fallback-Read mit echter Org-Membership → ok, secret verfügbar", () => {
    const wsId = "ws-inherit-real-org-mem";
    const orgId = "org-h1";
    const userId = "user-org-member";
    const adminId = "user-admin";

    insertWorkspace(testDb, wsId, "inherit");
    workspaceOrgMap.set(wsId, { id: orgId, name: "Org H1" });
    memberWorkspaceIds.add(wsId);
    // Admin kann Org-Credential schreiben (grantOrgRole VOR putApiCredential).
    grantOrgRole(adminId, orgId, "admin");
    putApiCredential(
      { scopeKind: "org", scopeId: orgId, provider: "openai", kind: "api_key", secret: "org-key-accessible" },
      { userId: adminId, source: "test" },
    );

    // Reader-User hat ECHTE Org-Membership → hasRealWorkspaceMembership = true.
    grantOrgRole(userId, orgId, "member");
    grantRealMembership(userId, wsId);

    const result = resolveApiCredential(wsId, userId, "openai");

    expect(result).not.toBeNull();
    expect(result!.secret).toBe("org-key-accessible");
    expect(result!.source).toBe("org-fallback");

    const logs = getAuditRows(testDb);
    const resolveLogs = logs.filter((l) => l.action === "resolve" && l.user_id === userId);
    const lastResolve = resolveLogs[resolveLogs.length - 1];
    expect(lastResolve.success).toBe(1);
    expect(lastResolve.reason).toBe("org-fallback");
  });

  // (i) Workspace-eigenes Credential lesen: kein hasRealWorkspaceMembership erforderlich
  // (bestehender Gate bleibt: canEditWorkspaceContent reicht für WS-eigenes Credential).
  it("(i) P0-C1: WS-eigenes Credential lesen ohne echte Membership (solo-founder) → ok", () => {
    const wsId = "ws-own-cred-solo";
    const userId = "user-solo-owner";

    insertWorkspace(testDb, wsId, "inherit");
    memberWorkspaceIds.add(wsId); // canEditWorkspaceContent = true
    // KEINE echte Membership — simuliert Solo-Founder mit eigenem Workspace.
    // realMembershipSet bleibt leer.

    putApiCredential(
      { scopeKind: "workspace", scopeId: wsId, provider: "stripe", kind: "api_key", secret: "solo-ws-secret" },
      { userId, source: "test" },
    );

    const result = resolveApiCredential(wsId, userId, "stripe");

    // Workspace-eigenes Credential: bestehender Gate (canEditWorkspaceContent) reicht.
    // hasRealWorkspaceMembership wird für den WS-eigenen Pfad NICHT geprüft.
    expect(result).not.toBeNull();
    expect(result!.secret).toBe("solo-ws-secret");
    expect(result!.source).toBe("workspace-cred");

    const logs = getAuditRows(testDb);
    const resolveLogs = logs.filter((l) => l.action === "resolve" && l.user_id === userId);
    const lastResolve = resolveLogs[resolveLogs.length - 1];
    expect(lastResolve.success).toBe(1);
    expect(lastResolve.reason).toBe("workspace-cred");
  });

  // (L-1) recordRevealAudit schreibt eine 'reveal'-Audit-Row (N8)
  it("(L-1) recordRevealAudit schreibt 'reveal'-Audit-Row mit content_hash (N10)", () => {
    const wsId = "ws-reveal-audit";
    const userId = "user-1";

    recordRevealAudit({
      scopeKind: "workspace",
      scopeId: wsId,
      provider: "heygen",
      userId,
      source: "test.reveal",
      success: true,
      reason: "revealed",
    });

    const logs = getAuditRows(testDb);
    const revealLogs = logs.filter((l) => l.action === "reveal");
    expect(revealLogs.length).toBe(1);
    expect(revealLogs[0].success).toBe(1);
    expect(revealLogs[0].reason).toBe("revealed");
    expect(revealLogs[0].scope_id).toBe(wsId);
    expect(revealLogs[0].provider).toBe("heygen");
    expect(revealLogs[0].content_hash.length).toBe(64); // SHA-256 hex
  });
});
