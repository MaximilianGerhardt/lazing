/**
 * Generic API-Credential-Vault (ACL-1, Migration 0100).
 *
 * Server-only. Raw better-sqlite3 prepared statements via getDb().$raw
 * (gleiches Muster wie lib/github/org-repo.ts).
 *
 * Kernfunktionen:
 *   putApiCredential  — Upsert + verschlüsseln + Audit-Row.
 *   resolveApiCredential — D2-Policy-Resolution mit credential_isolation.
 *   deleteApiCredential — Löschen + Audit-Row.
 *   decryptApiSecret  — Best-effort Decrypt, NIEMALS geloggt.
 *
 * D2-Resolution-Policy:
 *   1. Auth-Gate: canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, wsId))
 *      → null (kein Fehler-Leak) bei Deny.
 *   2. Workspace-eigenes Credential zuerst (scope_kind='workspace').
 *   3. Org-Fallback NUR wenn credential_isolation='inherit' (oder Feld fehlt — default 'inherit').
 *      Bei 'isolated' → KEIN Org-Fallback (externe Kunden-Isolation).
 *   4. Jedes resolve() schreibt eine Audit-Row (success oder deny).
 *
 * N8  — Audit-Row bei jedem write/resolve/delete.
 * N9  — scope_kind + scope_id als Isolation-Anker auf jeder Query.
 * N10 — content_hash SHA-256 über canonical JSON (tamper-evident).
 */

import { createHash, randomUUID } from "node:crypto";

import { getDb } from "@/db/client";
import type { MembershipRole } from "@/db/schema/memberships";
import {
  decryptCredential,
  encryptCredential,
} from "@/lib/security/credentials";
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from "@/lib/security/permissions";
import { hasRealWorkspaceMembership } from "@/lib/security/membership";
import { findOrgForWorkspace, findUserOrgMembership } from "@/lib/orgs/repo";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ScopeKind = "org" | "workspace";
export type CredentialKind = "api_key" | "pat" | "oauth";
export type AccessAction = "put" | "resolve" | "reveal" | "delete";

export interface PutApiCredentialInput {
  scopeKind: ScopeKind;
  scopeId: string;
  provider: string;
  kind: CredentialKind;
  /** Plaintext — wird sofort verschlüsselt, niemals gespeichert. */
  secret: string;
  /** Optionale Provider-Metadaten (baseUrl, version, scope). */
  config?: Record<string, unknown> | null;
}

export interface PutActor {
  userId: string;
  source?: string;
}

export interface ResolvedApiCredential {
  id: string;
  provider: string;
  kind: CredentialKind;
  /** Entschlüsseltes Secret — NIEMALS in Response-Body oder Logs. */
  secret: string;
  config: Record<string, unknown> | null;
  lastValidatedAt: number | null;
  /** Woher das Credential kommt: 'workspace-cred' | 'org-fallback'. */
  source: "workspace-cred" | "org-fallback";
}

// ─── Raw Row Types ────────────────────────────────────────────────────────────

interface ApiCredRaw {
  id: string;
  scope_kind: string;
  scope_id: string;
  provider: string;
  credential_kind: string;
  encrypted_secret: string;
  config_json: string | null;
  last_validated_at: number | null;
  content_hash: string;
  created_at: number;
  updated_at: number;
}

// ─── Auth-Helpers (Vault-eigene Gates, Security-Critic B-2 / M-3) ─────────────

/** Rang-Tabelle gespiegelt aus lib/security/permissions.ts. */
const ORG_ROLE_RANK: Record<MembershipRole, number> = {
  founder: 5,
  admin: 4,
  member: 3,
  viewer: 2,
  guest: 1,
};

/**
 * userId-basierter Org-Admin-Check (kein RequestLike — Vault wird auch von
 * Nicht-HTTP-Callern aufgerufen, ACL-4/ACL-5). Liefert true wenn der User
 * mindestens `admin` in der Org ist. Org-Credentials (write/delete) sind
 * Struktur-Operationen → Admin-Schwelle, nicht member.
 */
function isOrgAdmin(userId: string, orgId: string): boolean {
  const membership = findUserOrgMembership(userId, orgId);
  if (!membership) return false;
  const rank = ORG_ROLE_RANK[membership.role as MembershipRole] ?? 0;
  return rank >= ORG_ROLE_RANK.admin;
}

/**
 * Zentrale Write/Delete-Authorisierung für den Vault.
 *
 * - scope_kind='workspace' → canEditWorkspaceContent(getEffectiveWorkspaceRole).
 *   Caller MUSS scopeId = workspaceId übergeben.
 * - scope_kind='org' → isOrgAdmin(userId, scopeId=orgId).
 *
 * Gibt true zurück wenn erlaubt. Schreibt KEINE Audit-Row (das macht der
 * Caller deterministisch mit dem korrekten action-Wert).
 */
function isVaultWriteAllowed(
  scopeKind: ScopeKind,
  scopeId: string,
  userId: string,
): boolean {
  if (scopeKind === "workspace") {
    return canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, scopeId));
  }
  // scopeKind === 'org'
  return isOrgAdmin(userId, scopeId);
}

/**
 * Provider-Validierung (Security-Critic N-1). Verhindert dreckige
 * Audit-/DB-Werte. Lowercase-alphanumerisch + '-' '_', max 64 Zeichen,
 * muss mit Buchstabe starten.
 */
const PROVIDER_RE = /^[a-z][a-z0-9_-]{0,63}$/;

function isValidProvider(provider: string): boolean {
  return PROVIDER_RE.test(provider);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCredId(): string {
  return `apicred-${randomUUID()}`;
}

function makeLogId(): string {
  return `aclog-${randomUUID()}`;
}

/**
 * N10: SHA-256 über canonical JSON der Row.
 * Canonical = alphabetisch sortierte Keys, kein content_hash-Feld selbst.
 */
function computeCredHash(fields: {
  scopeKind: string;
  scopeId: string;
  provider: string;
  credentialKind: string;
  encryptedSecret: string;
  configJson: string | null;
  createdAt: number;
  updatedAt: number;
}): string {
  const payload = JSON.stringify({
    config_json: fields.configJson,
    credential_kind: fields.credentialKind,
    encrypted_secret: fields.encryptedSecret,
    provider: fields.provider,
    scope_id: fields.scopeId,
    scope_kind: fields.scopeKind,
    ts_created: fields.createdAt,
    ts_updated: fields.updatedAt,
  });
  return createHash("sha256").update(payload).digest("hex");
}

function computeLogHash(fields: {
  id: string;
  ts: number;
  scopeKind: string;
  scopeId: string;
  provider: string;
  userId: string;
  action: string;
  source: string | null;
  success: number;
  reason: string | null;
}): string {
  const payload = JSON.stringify({
    action: fields.action,
    id: fields.id,
    provider: fields.provider,
    reason: fields.reason,
    scope_id: fields.scopeId,
    scope_kind: fields.scopeKind,
    source: fields.source,
    success: fields.success,
    ts: fields.ts,
    user_id: fields.userId,
  });
  return createHash("sha256").update(payload).digest("hex");
}

// ─── Audit-Row Writer ─────────────────────────────────────────────────────────

function writeAuditRow(entry: {
  scopeKind: string;
  scopeId: string;
  provider: string;
  userId: string;
  action: AccessAction;
  source: string | null;
  success: boolean;
  reason: string | null;
}): void {
  const db = getDb();
  const id = makeLogId();
  const ts = Date.now();
  const success = entry.success ? 1 : 0;
  const hash = computeLogHash({
    id,
    ts,
    scopeKind: entry.scopeKind,
    scopeId: entry.scopeId,
    provider: entry.provider,
    userId: entry.userId,
    action: entry.action,
    source: entry.source ?? null,
    success,
    reason: entry.reason ?? null,
  });

  db.$raw
    .prepare(
      `INSERT INTO credential_access_log
         (id, ts, scope_kind, scope_id, provider, user_id, action, source, success, reason, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ts,
      entry.scopeKind,
      entry.scopeId,
      entry.provider,
      entry.userId,
      entry.action,
      entry.source ?? null,
      success,
      entry.reason ?? null,
      hash,
    );
}

// ─── Internal: fetch raw credential row ──────────────────────────────────────

function fetchCredRow(
  scopeKind: ScopeKind,
  scopeId: string,
  provider: string,
): ApiCredRaw | null {
  const db = getDb();
  const row = db.$raw
    .prepare(
      `SELECT * FROM api_credentials
       WHERE scope_kind = ? AND scope_id = ? AND provider = ?
       LIMIT 1`,
    )
    .get(scopeKind, scopeId, provider) as ApiCredRaw | undefined;
  return row ?? null;
}

// ─── Internal: read credential_isolation from workspace ───────────────────────

/**
 * Liest `credential_isolation` defensiv und FAIL-CLOSED (Security-Critic B-1).
 *
 * NUR der explizite String 'inherit' ergibt 'inherit'. Alles andere — null,
 * Garbage, fehlende Spalte (catch), Workspace existiert nicht — ergibt
 * 'isolated'. Begründung: ein faktisch-externer Workspace darf NIEMALS aus
 * Versehen Org-Credentials erben. Bestehende Workspaces haben DB-DEFAULT
 * 'inherit' (Migration ACL-3) → unverändert; nur Unbekanntes wird isoliert.
 *
 * N6: deterministisch. Fail-safe Richtung = MEHR Isolation (sichere Seite).
 */
function readCredentialIsolation(workspaceId: string): "inherit" | "isolated" {
  const db = getDb();
  try {
    const row = db.$raw
      .prepare(
        `SELECT credential_isolation FROM workspaces WHERE id = ? LIMIT 1`,
      )
      .get(workspaceId) as { credential_isolation?: string | null } | undefined;

    const val = row?.credential_isolation;
    // FAIL-CLOSED: nur explizit 'inherit' erlaubt Org-Fallback.
    return val === "inherit" ? "inherit" : "isolated";
  } catch {
    // Spalte existiert noch nicht (ACL-3 nicht gelandet) → fail-closed isoliert.
    return "isolated";
  }
}

// ─── putApiCredential ─────────────────────────────────────────────────────────

/**
 * Upsert eines API-Credentials für scope+provider.
 *
 * Auth-Gate (Security-Critic M-3): workspace-scope → canEditWorkspaceContent,
 * org-scope → isOrgAdmin. Deny → KEIN Write + deny-Audit + return null.
 * Provider-Validierung (N-1): ungültiger Provider → kein Write + deny-Audit.
 *
 * Verschlüsselt das Secret sofort mit encryptCredential (AES-256-GCM).
 * Schreibt eine Audit-Row ('put'). Gibt die Row-ID zurück, oder null bei Deny.
 *
 * N9: scope_kind + scope_id sind der Isolation-Anker.
 * N10: content_hash wird über die Row berechnet.
 */
export function putApiCredential(
  input: PutApiCredentialInput,
  actor: PutActor,
): string | null {
  // ── N-1: Provider-Validierung (vor jedem DB-Zugriff) ──────────────────────
  if (!isValidProvider(input.provider)) {
    writeAuditRow({
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      provider: input.provider,
      userId: actor.userId,
      action: "put",
      source: actor.source ?? "vault.putApiCredential",
      success: false,
      reason: "invalid-provider",
    });
    return null;
  }

  // ── M-3: Auth-Gate ─────────────────────────────────────────────────────────
  if (!isVaultWriteAllowed(input.scopeKind, input.scopeId, actor.userId)) {
    writeAuditRow({
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      provider: input.provider,
      userId: actor.userId,
      action: "put",
      source: actor.source ?? "vault.putApiCredential",
      success: false,
      reason: "auth-denied",
    });
    return null;
  }

  const db = getDb();
  const now = Date.now();
  const encrypted = encryptCredential(input.secret);
  const configJson = input.config ? JSON.stringify(input.config) : null;

  const existing = fetchCredRow(input.scopeKind, input.scopeId, input.provider);

  let id: string;

  if (existing) {
    id = existing.id;
    const hash = computeCredHash({
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      provider: input.provider,
      credentialKind: input.kind,
      encryptedSecret: encrypted,
      configJson,
      createdAt: existing.created_at,
      updatedAt: now,
    });

    db.$raw
      .prepare(
        `UPDATE api_credentials
         SET credential_kind = ?, encrypted_secret = ?, config_json = ?,
             content_hash = ?, updated_at = ?
         WHERE scope_kind = ? AND scope_id = ? AND provider = ?`,
      )
      .run(
        input.kind,
        encrypted,
        configJson,
        hash,
        now,
        input.scopeKind,
        input.scopeId,
        input.provider,
      );
  } else {
    id = makeCredId();
    const hash = computeCredHash({
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      provider: input.provider,
      credentialKind: input.kind,
      encryptedSecret: encrypted,
      configJson,
      createdAt: now,
      updatedAt: now,
    });

    db.$raw
      .prepare(
        `INSERT INTO api_credentials
           (id, scope_kind, scope_id, provider, credential_kind,
            encrypted_secret, config_json, content_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.scopeKind,
        input.scopeId,
        input.provider,
        input.kind,
        encrypted,
        configJson,
        hash,
        now,
        now,
      );
  }

  writeAuditRow({
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
    provider: input.provider,
    userId: actor.userId,
    action: "put",
    source: actor.source ?? "vault.putApiCredential",
    success: true,
    reason: existing ? "updated" : "created",
  });

  return id;
}

// ─── resolveApiCredential ─────────────────────────────────────────────────────

/**
 * D2-Policy-Resolution:
 *
 *   1. Auth-Gate via canEditWorkspaceContent(getEffectiveWorkspaceRole).
 *      Nicht-Member → null (kein Error-Leak) + deny-Audit-Row.
 *   2. Workspace-eigenes Credential (scope_kind='workspace', scope_id=workspaceId).
 *      Workspace-eigenes Credential lesen: bestehender Gate (Workspace-Editor darf).
 *   3. Org-Fallback — NUR wenn credential_isolation='inherit' (defensiver default).
 *      Bei 'isolated' → KEIN Org-Fallback, null wenn kein WS-Credential.
 *      Org-Fallback (scope='org'): zusätzlich ECHTE Org-/Workspace-Membership via
 *      hasRealWorkspaceMembership verlangen — `solo-implicit-founder` allein reicht
 *      NICHT (Security-Critic P0-C1: Read-Asymmetrie-Fix 2026-05-25).
 *   4. Audit-Row bei jedem Aufruf (success + reason ODER deny + reason).
 *
 * Gibt ResolvedApiCredential zurück oder null (bei Auth-Deny, nicht-gefunden,
 * Decrypt-Fehler). Niemals Exceptions nach oben werfen.
 *
 * N2: kein global-fallback — Org-Fallback ist explizit scope-gated.
 * N8: Audit-Row pro Aufruf.
 * N9: Scope-Anker auf jeder Query.
 */
export function resolveApiCredential(
  workspaceId: string,
  userId: string,
  provider: string,
): ResolvedApiCredential | null {
  // ── 1. Auth-Gate ───────────────────────────────────────────────────────────
  const role = getEffectiveWorkspaceRole(userId, workspaceId);
  if (!canEditWorkspaceContent(role)) {
    writeAuditRow({
      scopeKind: "workspace",
      scopeId: workspaceId,
      provider,
      userId,
      action: "resolve",
      source: "vault.resolveApiCredential",
      success: false,
      reason: "auth-denied",
    });
    return null;
  }

  // ── 2. Workspace-eigenes Credential ───────────────────────────────────────
  const wsRow = fetchCredRow("workspace", workspaceId, provider);
  if (wsRow) {
    const secret = safeDecrypt(wsRow.encrypted_secret);
    if (secret === null) {
      writeAuditRow({
        scopeKind: "workspace",
        scopeId: workspaceId,
        provider,
        userId,
        action: "resolve",
        source: "vault.resolveApiCredential",
        success: false,
        reason: "decrypt-error",
      });
      return null;
    }

    writeAuditRow({
      scopeKind: "workspace",
      scopeId: workspaceId,
      provider,
      userId,
      action: "resolve",
      source: "vault.resolveApiCredential",
      success: true,
      reason: "workspace-cred",
    });

    return {
      id: wsRow.id,
      provider,
      kind: wsRow.credential_kind as CredentialKind,
      secret,
      config: wsRow.config_json ? safeJsonParse(wsRow.config_json) : null,
      lastValidatedAt: wsRow.last_validated_at,
      source: "workspace-cred",
    };
  }

  // ── 3. Org-Fallback — nur wenn credential_isolation='inherit' ─────────────
  const isolation = readCredentialIsolation(workspaceId);
  if (isolation === "isolated") {
    // Externe Kunden-Isolation: kein Fallback, kein Leak.
    writeAuditRow({
      scopeKind: "workspace",
      scopeId: workspaceId,
      provider,
      userId,
      action: "resolve",
      source: "vault.resolveApiCredential",
      success: false,
      reason: "isolation-block",
    });
    return null;
  }

  // isolation='inherit' → Org-Membership-Gate (Security-Critic P0-C1).
  //
  // canEditWorkspaceContent() gibt auch bei 'solo-implicit-founder' true zurück —
  // das ist ein impliziter Bootstrap-Fallback ohne nachgewiesene Zugehörigkeit.
  // Für den Org-Fallback-Read verlangen wir eine ECHTE Membership:
  //   (A) explizites workspace_memberships-Row, ODER
  //   (B) org_memberships-Row für die Org des Workspace.
  // Ohne echte Membership: deny + Audit + null (kein Secret-Leak).
  if (!hasRealWorkspaceMembership(userId, workspaceId)) {
    writeAuditRow({
      scopeKind: "workspace",
      scopeId: workspaceId,
      provider,
      userId,
      action: "resolve",
      source: "vault.resolveApiCredential",
      success: false,
      reason: "org-fallback-membership-denied",
    });
    return null;
  }

  // Echte Membership bestätigt → Org-Lookup
  const org = findOrgForWorkspace(workspaceId);
  if (!org) {
    writeAuditRow({
      scopeKind: "workspace",
      scopeId: workspaceId,
      provider,
      userId,
      action: "resolve",
      source: "vault.resolveApiCredential",
      success: false,
      reason: "not-found",
    });
    return null;
  }

  const orgRow = fetchCredRow("org", org.id, provider);
  if (!orgRow) {
    writeAuditRow({
      scopeKind: "workspace",
      scopeId: workspaceId,
      provider,
      userId,
      action: "resolve",
      source: "vault.resolveApiCredential",
      success: false,
      reason: "not-found",
    });
    return null;
  }

  const orgSecret = safeDecrypt(orgRow.encrypted_secret);
  if (orgSecret === null) {
    writeAuditRow({
      scopeKind: "workspace",
      scopeId: workspaceId,
      provider,
      userId,
      action: "resolve",
      source: "vault.resolveApiCredential",
      success: false,
      reason: "decrypt-error",
    });
    return null;
  }

  writeAuditRow({
    // Audit referenziert den Workspace-Kontext (wo die Resolution stattfand),
    // nicht die Org-Scope (um N9-Scope-Klarheit zu erhalten).
    scopeKind: "workspace",
    scopeId: workspaceId,
    provider,
    userId,
    action: "resolve",
    source: "vault.resolveApiCredential",
    success: true,
    reason: "org-fallback",
  });

  return {
    id: orgRow.id,
    provider,
    kind: orgRow.credential_kind as CredentialKind,
    secret: orgSecret,
    config: orgRow.config_json ? safeJsonParse(orgRow.config_json) : null,
    lastValidatedAt: orgRow.last_validated_at,
    source: "org-fallback",
  };
}

// ─── deleteApiCredential ──────────────────────────────────────────────────────

/**
 * Löscht ein Credential (scope_kind + scope_id + provider).
 *
 * Auth-Gate (Security-Critic B-2): workspace-scope → canEditWorkspaceContent,
 * org-scope → isOrgAdmin. Deny → KEIN Delete + deny-Audit + return false.
 * Vault verlässt sich NICHT mehr auf den Caller.
 *
 * Schreibt immer eine Audit-Row.
 *
 * N9: Löschen nur über alle drei Isolation-Schlüssel möglich.
 */
export function deleteApiCredential(
  scopeKind: ScopeKind,
  scopeId: string,
  provider: string,
  actor: PutActor,
): boolean {
  // ── B-2: Auth-Gate ─────────────────────────────────────────────────────────
  if (!isVaultWriteAllowed(scopeKind, scopeId, actor.userId)) {
    writeAuditRow({
      scopeKind,
      scopeId,
      provider,
      userId: actor.userId,
      action: "delete",
      source: actor.source ?? "vault.deleteApiCredential",
      success: false,
      reason: "auth-denied",
    });
    return false;
  }

  const db = getDb();
  const res = db.$raw
    .prepare(
      `DELETE FROM api_credentials
       WHERE scope_kind = ? AND scope_id = ? AND provider = ?`,
    )
    .run(scopeKind, scopeId, provider);

  const deleted = res.changes > 0;
  writeAuditRow({
    scopeKind,
    scopeId,
    provider,
    userId: actor.userId,
    action: "delete",
    source: actor.source ?? "vault.deleteApiCredential",
    success: deleted,
    reason: deleted ? "deleted" : "not-found",
  });

  return deleted;
}

// ─── decryptApiSecret (best-effort) ──────────────────────────────────────────

/**
 * Entschlüsselt einen encrypted_secret-Wert.
 *
 * NIEMALS das Ergebnis in Logs, HTTP-Responses oder Trace-Rows schreiben.
 * Gibt null zurück bei Decrypt-Fehler (statt Exception).
 */
export function decryptApiSecret(encryptedSecret: string): string | null {
  return safeDecrypt(encryptedSecret);
}

// ─── credentialExists (decrypt-free Existenz/Scope-Check, ACL-5-D-Härtung) ─────

/**
 * Ergebnis von credentialExists — decrypt-FREI.
 *
 * Enthält NIEMALS das (entschlüsselte) Secret. Es wird KEIN decrypt ausgeführt —
 * nur ein Existenz-Lookup + Scope-Ableitung + die Länge des verschlüsselten
 * Blobs (NICHT die Klartext-Länge, NICHT der Klartext).
 */
export interface CredentialExistence {
  /** true wenn ein Credential für scope+provider (oder Org-Fallback) existiert. */
  exists: boolean;
  /**
   * Woher das Credential käme: 'workspace-cred' | 'org-fallback' | null.
   * null wenn keins existiert.
   */
  source: "workspace-cred" | "org-fallback" | null;
  /** Menschenlesbares Scope-Label, z.B. 'workspace:ws-1' oder 'org-fallback'. */
  scopeLabel: string;
}

/**
 * Decrypt-FREIER Existenz- und Scope-Check für ein API-Credential.
 *
 * ACL-5-D-Härtung (Security-Critic Finding 3): previewCall darf NICHT bei jeder
 * keyword-matchenden Chat-Nachricht das echte Secret entschlüsseln. Diese
 * Funktion ermittelt NUR ob ein Credential existiert und in welchem Scope —
 * OHNE decryptCredential() aufzurufen. Kein Klartext-Secret wird je berührt.
 *
 * Spiegelt die D2-Resolution-Reihenfolge von resolveApiCredential (Workspace
 * zuerst, Org-Fallback nur bei credential_isolation='inherit') — aber OHNE
 * decrypt und OHNE Auth-Gate-Audit-Row (es ist ein billiger, lese-only,
 * nicht-offenbarender Check, kein 'resolve'-Event).
 *
 * @returns CredentialExistence (exists, source, scopeLabel) — nie ein Secret.
 */
export function credentialExists(
  workspaceId: string,
  provider: string,
): CredentialExistence {
  // 1. Workspace-eigenes Credential.
  const wsRow = fetchCredRow("workspace", workspaceId, provider);
  if (wsRow) {
    return {
      exists: true,
      source: "workspace-cred",
      scopeLabel: `workspace:${workspaceId}`,
    };
  }

  // 2. Org-Fallback — nur bei credential_isolation='inherit' (fail-closed).
  const isolation = readCredentialIsolation(workspaceId);
  if (isolation === "isolated") {
    return { exists: false, source: null, scopeLabel: `workspace:${workspaceId}` };
  }

  const org = findOrgForWorkspace(workspaceId);
  if (!org) {
    return { exists: false, source: null, scopeLabel: `workspace:${workspaceId}` };
  }

  const orgRow = fetchCredRow("org", org.id, provider);
  if (orgRow) {
    return {
      exists: true,
      source: "org-fallback",
      scopeLabel: `org-fallback (workspace:${workspaceId})`,
    };
  }

  return { exists: false, source: null, scopeLabel: `workspace:${workspaceId}` };
}

// ─── recordRevealAudit (Security-Critic L-1) ──────────────────────────────────

/**
 * Schreibt eine 'reveal'-Audit-Row (N8). Jede Klartext-Offenbarung eines
 * Credentials — egal über welche Route oder welches Vault — MUSS audit-iert
 * werden, nicht nur via last_revealed_at.
 *
 * Wrapper über den internen writeAuditRow-Mechanismus damit HTTP-Routes
 * (die KEINEN Zugriff auf den privaten Helper haben) konsistente Reveal-Rows
 * mit korrektem content_hash (N10) schreiben.
 */
export function recordRevealAudit(entry: {
  scopeKind: ScopeKind;
  scopeId: string;
  provider: string;
  userId: string;
  source?: string;
  success: boolean;
  reason?: string;
}): void {
  writeAuditRow({
    scopeKind: entry.scopeKind,
    scopeId: entry.scopeId,
    provider: entry.provider,
    userId: entry.userId,
    action: "reveal",
    source: entry.source ?? "api.credentials.reveal",
    success: entry.success,
    reason: entry.reason ?? (entry.success ? "revealed" : "reveal-failed"),
  });
}

// ─── Private Helpers ──────────────────────────────────────────────────────────

function safeDecrypt(encrypted: string): string | null {
  try {
    return decryptCredential(encrypted);
  } catch {
    return null;
  }
}

function safeJsonParse(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
