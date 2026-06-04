/**
 * DB-Repo für Org-Level GitHub-Credentials (Migration 0096, Slice A).
 *
 * Server-only — raw better-sqlite3 prepared statements via `getDb().$raw`
 * (gleiches Muster wie `lib/github/repo.ts`).
 *
 * Isolation-Invariante (SICHERHEITS-GEBOT):
 *   - JEDE Funktion filtert hart auf `org_id = ?`.
 *   - `encrypted_token` wird NIEMALS im Klartext zurückgegeben — nutze
 *     `decryptOrgToken` nur wenn du den Plaintext wirklich brauchst
 *     (z.B. für einen Live-GitHub-API-Call).
 *   - `getOrgCredential` ist intern und gibt die Row MIT encrypted_token
 *     zurück (nur für `decryptOrgToken` + `upsertOrgCredential`).
 *   - `getOrgCredentialMeta` ist der public-safe Getter: gibt Metadaten
 *     OHNE `encrypted_token` zurück (für Status-Routes / UI-Panels).
 *   - Token NIEMALS in Logs oder API-Responses schreiben.
 *
 * N8-Audit: `decryptOrgToken` schreibt bei jedem Token-Zugriff eine
 *   best-effort Audit-Row in `org_github_token_use_audit` (Migration 0106).
 *   KEIN Token-Wert im Audit. Idempotenz-Guard via N10 content_hash.
 */

import { createHash, randomUUID } from "node:crypto";

import { getDb } from "@/db/client";
import { canonicalJSON } from "@/lib-v1/audit/canonical-json";
import {
  decryptCredential,
  encryptCredential,
} from "@/lib/security/credentials";

// ─── Row-Typen (raw SQL, nicht Drizzle-inferiert) ─────────────────────

/** Vollständige Row inkl. encrypted_token — NUR intern (getOrgCredential). */
export interface OrgGithubCredentialRow {
  id: string;
  org_id: string;
  auth_kind: "pat" | "oauth" | "github_app";
  /** AES-256-GCM ciphertext — NIEMALS plaintext. */
  encrypted_token: string;
  github_login: string | null;
  github_user_id: number | null;
  avatar_url: string | null;
  scope: string | null;
  expires_at: number | null;
  last_validated_at: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * Public-safe Projektion ohne `encrypted_token`.
 *
 * Für Status-Routes, UI-Panels und alle Caller, die nur Metadaten brauchen.
 * `encrypted_token` ist NICHT enthalten — verlässt die Repo-Schicht nicht.
 */
export interface OrgGithubCredentialMeta {
  id: string;
  org_id: string;
  auth_kind: "pat" | "oauth" | "github_app";
  github_login: string | null;
  github_user_id: number | null;
  avatar_url: string | null;
  scope: string | null;
  expires_at: number | null;
  last_validated_at: number | null;
  created_at: number;
  updated_at: number;
}

// ─── Upsert ───────────────────────────────────────────────────────────

export interface UpsertOrgCredentialInput {
  orgId: string;
  authKind: "pat" | "oauth" | "github_app";
  /** Plaintext token — wird sofort verschlüsselt, nie gespeichert. */
  token: string;
  githubLogin: string | null;
  githubUserId: number | null;
  avatarUrl: string | null;
  scope?: string | null;
  expiresAt?: number | null;
}

/**
 * Upsert einer Org-GitHub-Verbindung.
 *
 * Token wird vor dem Speichern mit `encryptCredential` verschlüsselt.
 * Setzt `last_validated_at` auf jetzt (da der Caller erst `validateToken`
 * aufruft und dann `upsertOrgCredential`).
 *
 * WHERE org_id = ? (via UNIQUE-Index + conditional UPDATE/INSERT).
 */
export function upsertOrgCredential(
  input: UpsertOrgCredentialInput,
): OrgGithubCredentialRow {
  const db = getDb();
  const now = Date.now();
  const encryptedToken = encryptCredential(input.token);

  const existing = getOrgCredential(db.$raw, input.orgId);

  if (existing) {
    db.$raw
      .prepare(
        `UPDATE org_github_credentials SET
           auth_kind = ?,
           encrypted_token = ?,
           github_login = ?,
           github_user_id = ?,
           avatar_url = ?,
           scope = ?,
           expires_at = ?,
           last_validated_at = ?,
           updated_at = ?
         WHERE org_id = ?`,
      )
      .run(
        input.authKind,
        encryptedToken,
        input.githubLogin,
        input.githubUserId,
        input.avatarUrl,
        input.scope ?? null,
        input.expiresAt ?? null,
        now,
        now,
        input.orgId, // WHERE org_id = ? — Isolation-Anker
      );
  } else {
    db.$raw
      .prepare(
        `INSERT INTO org_github_credentials (
           id, org_id, auth_kind, encrypted_token,
           github_login, github_user_id, avatar_url,
           scope, expires_at, last_validated_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `orgghc-${randomUUID()}`,
        input.orgId,
        input.authKind,
        encryptedToken,
        input.githubLogin,
        input.githubUserId,
        input.avatarUrl,
        input.scope ?? null,
        input.expiresAt ?? null,
        now,
        now,
        now,
      );
  }

  const updated = getOrgCredential(db.$raw, input.orgId);
  if (!updated) {
    throw new Error("upsertOrgCredential: row missing after insert/update");
  }
  return updated;
}

// ─── Get (encrypted — kein plaintext) ────────────────────────────────

/**
 * Interner Getter: gibt die vollständige Row zurück (encrypted_token NOT
 * decrypted) oder null.
 *
 * NICHT für API-Responses oder UI-Panels — nur für:
 *   - `decryptOrgToken` (braucht encrypted_token zum Entschlüsseln).
 *   - `upsertOrgCredential` (UPDATE/INSERT-Pfad, braucht die bestehende Row).
 *
 * Akzeptiert `db.$raw` (better-sqlite3 Database) als Parameter damit
 * Caller die gleiche Verbindung wiederverwenden können ohne getDb()
 * mehrfach aufzurufen.
 *
 * WHERE org_id = ? — Isolation-Anker.
 */
export function getOrgCredential(
  raw: import("better-sqlite3").Database,
  orgId: string,
): OrgGithubCredentialRow | null {
  const row = raw
    .prepare(
      `SELECT * FROM org_github_credentials WHERE org_id = ? LIMIT 1`,
    )
    .get(orgId) as OrgGithubCredentialRow | undefined;
  return row ?? null;
}

/**
 * Public-safe Getter: gibt Metadaten OHNE `encrypted_token` zurück.
 *
 * Für Status-Routes, UI-Panels und alle Caller, die NUR Metadaten
 * (connected-Status, github_login, last_validated_at, …) brauchen.
 * `encrypted_token` ist NICHT im Ergebnis enthalten.
 *
 * WHERE org_id = ? — Isolation-Anker.
 */
export function getOrgCredentialMeta(
  orgId: string,
): OrgGithubCredentialMeta | null {
  const db = getDb();
  const row = db.$raw
    .prepare(
      `SELECT id, org_id, auth_kind,
              github_login, github_user_id, avatar_url,
              scope, expires_at, last_validated_at,
              created_at, updated_at
       FROM org_github_credentials
       WHERE org_id = ?
       LIMIT 1`,
    )
    .get(orgId) as OrgGithubCredentialMeta | undefined;
  return row ?? null;
}

// ─── N8-Audit-Hilfsfunktionen ─────────────────────────────────────────

/**
 * Berechnet den N10-content_hash für eine Token-Use-Audit-Row.
 * Felder: org_id, purpose, ts — KEIN Token-Wert.
 */
function computeTokenUseHash(row: {
  org_id: string;
  purpose: string;
  ts: number;
}): string {
  try {
    return createHash("sha256")
      .update(canonicalJSON({ org_id: row.org_id, purpose: row.purpose, ts: row.ts }), "utf8")
      .digest("hex");
  } catch {
    return createHash("sha256")
      .update(JSON.stringify(row), "utf8")
      .digest("hex");
  }
}

/**
 * Schreibt eine best-effort N8-Audit-Row in `org_github_token_use_audit`
 * (Migration 0106) wenn `decryptOrgToken` für einen echten GitHub-Call
 * aufgerufen wird.
 *
 * Best-effort: wirft nie — ein fehlgeschlagener Audit-Write darf den
 * echten GitHub-Call NICHT blockieren.
 * N8-Observability: Fehler werden als console.warn sichtbar gemacht.
 * KEIN Token-Wert im Audit (D5 / SICHERHEITS-GEBOT).
 * N10: content_hash über canonicalJSON.
 */
function writeTokenUseAuditRow(orgId: string, purpose: string): void {
  try {
    const db = getDb();
    const ts = Date.now();
    const id = `oghtua-${randomUUID()}`;
    const content_hash = computeTokenUseHash({ org_id: orgId, purpose, ts });
    db.$raw
      .prepare(
        `INSERT INTO org_github_token_use_audit
           (id, org_id, purpose, ts, content_hash)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, orgId, purpose, ts, content_hash);
  } catch (err) {
    // Best-effort — sichtbar für N8-Observability, aber nie blockierend.
    // eslint-disable-next-line no-console
    console.warn("[org-github-audit] token-use audit write failed:", err);
  }
}

// ─── Decrypt (Klartext nur für interne API-Calls) ─────────────────────

/**
 * Entschlüsselt das Token für einen Live-GitHub-API-Call.
 *
 * Schreibt eine best-effort N8-Audit-Row (org_id, purpose, ts, content_hash)
 * in `org_github_token_use_audit` (Migration 0106). KEIN Token-Wert im Audit.
 *
 * NIEMALS in einem HTTP-Response zurückgeben.
 * NIEMALS in Logs schreiben.
 *
 * @param orgId   Org-ID (N9 Isolation-Anker).
 * @param purpose Kurze Zweckbeschreibung für die Audit-Row (z.B. 'list-repos',
 *                'token-resolver'). Default: 'unspecified'.
 *
 * WHERE org_id = ? — Isolation-Anker.
 */
export function decryptOrgToken(orgId: string, purpose = "unspecified"): string | null {
  const db = getDb();
  const row = getOrgCredential(db.$raw, orgId);
  if (!row) return null;
  const plaintext = decryptCredential(row.encrypted_token);
  // N8: Audit-Row schreiben NACHDEM das Token erfolgreich entschlüsselt wurde.
  // Nur wenn wir tatsächlich ein Token zurückgeben (nicht null).
  if (plaintext !== null) {
    writeTokenUseAuditRow(orgId, purpose);
  }
  return plaintext;
}

// ─── Delete ───────────────────────────────────────────────────────────

/**
 * Löscht die Org-GitHub-Verbindung.
 *
 * WHERE org_id = ? — Isolation-Anker.
 * Gibt true zurück wenn eine Row gelöscht wurde, false wenn keine
 * Verbindung vorhanden war.
 */
export function deleteOrgCredential(orgId: string): boolean {
  const db = getDb();
  const res = db.$raw
    .prepare(
      `DELETE FROM org_github_credentials WHERE org_id = ?`,
    )
    .run(orgId);
  return res.changes > 0;
}
