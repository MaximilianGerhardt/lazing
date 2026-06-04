/**
 * Org-GitHub Security-Hardening Tests (Task #38, MEDIUM-1 + LOW-1).
 *
 * Prüft:
 *   (a) getOrgCredentialMeta gibt KEIN encrypted_token zurück (MEDIUM-1).
 *   (b) getOrgCredentialMeta gibt Metadaten zurück wenn Row vorhanden.
 *   (c) getOrgCredentialMeta gibt null zurück wenn keine Row vorhanden.
 *   (d) decryptOrgToken schreibt Audit-Row in org_github_token_use_audit (LOW-1).
 *   (e) Audit-Row enthält org_id, purpose, ts, content_hash — KEIN Token-Wert.
 *   (f) decryptOrgToken mit purpose-Argument befüllt purpose-Feld korrekt.
 *   (g) decryptOrgToken gibt null zurück wenn keine Row — kein Audit-Write.
 *   (h) content_hash in Audit-Row ist 64-char hex (N10).
 *   (i) getOrgCredential (intern) liefert encrypted_token (für upsertOrgCredential).
 *
 * Strategy: vi.mock('@/db/client') mit in-memory SQLite + vi.mock('@/lib/security/credentials')
 * für deterministische encrypt/decrypt ohne echten AES-Key.
 *
 * Run:
 *   NODE_OPTIONS='--experimental-require-module' npx vitest run \
 *     lib/github/__tests__/org-repo-hardening.test.ts
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── DDL für in-memory DB ─────────────────────────────────────────────────────

const ORG_GITHUB_DDL = `
  PRAGMA foreign_keys = OFF;

  CREATE TABLE IF NOT EXISTS org_github_credentials (
    id                TEXT PRIMARY KEY,
    org_id            TEXT NOT NULL,
    auth_kind         TEXT NOT NULL DEFAULT 'pat',
    encrypted_token   TEXT NOT NULL,
    github_login      TEXT,
    github_user_id    INTEGER,
    avatar_url        TEXT,
    scope             TEXT,
    expires_at        INTEGER,
    last_validated_at INTEGER,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    UNIQUE(org_id)
  );

  CREATE TABLE IF NOT EXISTS org_github_token_use_audit (
    id           TEXT PRIMARY KEY,
    org_id       TEXT NOT NULL,
    purpose      TEXT NOT NULL DEFAULT 'unspecified',
    ts           INTEGER NOT NULL,
    content_hash TEXT NOT NULL
  );
`;

// ─── Mocks (hoisted by vitest) ────────────────────────────────────────────────

let rawDb: Database.Database;

// vi.mock wird von vitest an den Dateianfang hochgezogen (hoisting).
vi.mock("@/db/client", () => ({
  getDb: () => Object.assign(drizzle(rawDb), { $raw: rawDb }),
}));

// Deterministisches encrypt/decrypt ohne echten AES-Key.
vi.mock("@/lib/security/credentials", () => ({
  encryptCredential: (plaintext: string) => `enc:${plaintext}`,
  decryptCredential: (ciphertext: string) => {
    if (ciphertext.startsWith("enc:")) return ciphertext.slice(4);
    return null;
  },
}));

// Imports NACH vi.mock so dass sie das gemockte getDb()/credentials sehen.
import {
  decryptOrgToken,
  getOrgCredential,
  getOrgCredentialMeta,
} from "../org-repo";

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

function insertTestRow(orgId: string, token = "plaintext-token"): void {
  rawDb
    .prepare(
      `INSERT INTO org_github_credentials
         (id, org_id, auth_kind, encrypted_token,
          github_login, github_user_id, avatar_url,
          scope, expires_at, last_validated_at,
          created_at, updated_at)
       VALUES (?, ?, 'pat', ?, 'octocat', 12345, 'https://avatar.url',
               'repo,read:org', NULL, 1716000000000,
               1716000000000, 1716000000000)`,
    )
    .run(`id-${orgId}`, orgId, `enc:${token}`);
}

function getAuditRows(orgId: string) {
  return rawDb
    .prepare(
      `SELECT * FROM org_github_token_use_audit WHERE org_id = ? ORDER BY ts ASC`,
    )
    .all(orgId) as {
    id: string;
    org_id: string;
    purpose: string;
    ts: number;
    content_hash: string;
  }[];
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  rawDb = new Database(":memory:");
  rawDb.pragma("foreign_keys = OFF");
  rawDb.exec(ORG_GITHUB_DDL);
});

afterEach(() => {
  rawDb.close();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("MEDIUM-1: getOrgCredentialMeta — public-safe getter ohne encrypted_token", () => {
  it("(a) gibt null zurück wenn keine Row vorhanden", () => {
    const meta = getOrgCredentialMeta("org-does-not-exist");
    expect(meta).toBeNull();
  });

  it("(b) gibt Metadaten zurück wenn Row vorhanden", () => {
    insertTestRow("org-1");
    const meta = getOrgCredentialMeta("org-1");
    expect(meta).not.toBeNull();
    expect(meta!.org_id).toBe("org-1");
    expect(meta!.github_login).toBe("octocat");
    expect(meta!.github_user_id).toBe(12345);
    expect(meta!.auth_kind).toBe("pat");
    expect(meta!.last_validated_at).toBe(1716000000000);
  });

  it("(a) KEIN encrypted_token in Ergebnis (MEDIUM-1 Defense-in-depth)", () => {
    insertTestRow("org-2");
    const meta = getOrgCredentialMeta("org-2");
    expect(meta).not.toBeNull();
    // encrypted_token darf im Ergebnis-Objekt nicht vorhanden sein.
    expect(Object.prototype.hasOwnProperty.call(meta, "encrypted_token")).toBe(false);
    // Auch kein Wert am Key (TypeScript-Typ erlaubt es nicht, aber Laufzeit-Check).
    expect((meta as unknown as Record<string, unknown>)["encrypted_token"]).toBeUndefined();
  });
});

describe("Interner getOrgCredential — hat encrypted_token (für upsert/decrypt)", () => {
  it("(i) gibt encrypted_token zurück (nötig für decrypt-Pfad)", () => {
    insertTestRow("org-3");
    const row = getOrgCredential(rawDb, "org-3");
    expect(row).not.toBeNull();
    expect(row!.encrypted_token).toBe("enc:plaintext-token");
  });
});

describe("LOW-1: decryptOrgToken — schreibt N8-Audit-Row", () => {
  it("(d) schreibt Audit-Row in org_github_token_use_audit nach erfolgreichem decrypt", () => {
    insertTestRow("org-4");
    const token = decryptOrgToken("org-4");
    expect(token).toBe("plaintext-token");

    const rows = getAuditRows("org-4");
    expect(rows).toHaveLength(1);
  });

  it("(e) Audit-Row enthält org_id und ts — KEIN Token-Wert", () => {
    insertTestRow("org-5");
    decryptOrgToken("org-5");

    const rows = getAuditRows("org-5");
    expect(rows).toHaveLength(1);
    const row = rows[0];

    expect(row.org_id).toBe("org-5");
    expect(row.ts).toBeGreaterThan(0);

    // Sicherstellen dass der Token-Wert in keinem Feld vorkommt.
    const rowJson = JSON.stringify(row);
    expect(rowJson).not.toContain("plaintext-token");
    expect(rowJson).not.toContain("enc:plaintext-token");
  });

  it("(f) purpose-Feld wird korrekt befüllt", () => {
    insertTestRow("org-6");
    decryptOrgToken("org-6", "list-repos");

    const rows = getAuditRows("org-6");
    expect(rows).toHaveLength(1);
    expect(rows[0].purpose).toBe("list-repos");
  });

  it("(f) Default-purpose 'unspecified' wenn kein purpose übergeben", () => {
    insertTestRow("org-7");
    decryptOrgToken("org-7");

    const rows = getAuditRows("org-7");
    expect(rows).toHaveLength(1);
    expect(rows[0].purpose).toBe("unspecified");
  });

  it("(g) kein Audit-Write wenn keine Credential-Row vorhanden", () => {
    const token = decryptOrgToken("org-not-found");
    expect(token).toBeNull();

    const rows = getAuditRows("org-not-found");
    expect(rows).toHaveLength(0);
  });

  it("(h) content_hash ist 64-char hex (N10)", () => {
    insertTestRow("org-8");
    decryptOrgToken("org-8");

    const rows = getAuditRows("org-8");
    expect(rows).toHaveLength(1);
    expect(rows[0].content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("(d) mehrere Aufrufe → mehrere Audit-Rows (jeder Zugriff wird geloggt)", () => {
    insertTestRow("org-9");
    decryptOrgToken("org-9", "list-repos");
    decryptOrgToken("org-9", "token-resolver");

    const rows = getAuditRows("org-9");
    expect(rows).toHaveLength(2);
    expect(rows[0].purpose).toBe("list-repos");
    expect(rows[1].purpose).toBe("token-resolver");
  });
});
