/**
 * G5 — Retention-Policy (Phase 2 W2.1 · Lane G Governance · 2026-05-29).
 *
 * Integration-Plan §4 Lane G (verbatim, N1):
 *   „Retention Policy · Raw vs Derived Data Policy"
 *
 * Lane G hält fest:
 *   - Raw-Daten (z.B. originale whatsapp-Message) bekommen ein kurzes
 *     Retention-Fenster (default 30 Tage).
 *   - Derived-Daten (Zusammenfassung, embedding-chunk, belief, …) bekommen
 *     ein längeres Fenster (default 365 Tage).
 *   - Audit-Rows bleiben 7 Jahre (DSGVO Art. 30 Verzeichnis-Pflicht).
 *   - Eine Consent-Revoke hat eine Karenz-Periode von 14 Tagen (lokale
 *     Pipeline-Latenz) — danach werden weiter persistierte Derivate ebenfalls
 *     gelöscht oder anonymisiert.
 *
 * Diese Default-Werte sind workspace-überschreibbar. Die eigentliche
 * Garbage-Collection ist NICHT Teil von Lane G — sie ist Aufgabe einer
 * separaten Maintenance-Lane (Stage 3). Lane G liefert nur das Policy-
 * Objekt + die deterministische `isExpired`-Prüfung.
 *
 * Substrat-Disziplin:
 *   - PURE Module (kein DB-Read, kein LLM, kein IO) — getWorkspaceRetention
 *     hat zwar eine DB-Lookup-Spur, ist aber explizit ein DB-Read-Helper
 *     (rein lesend) und fail-soft (Workspace-Override missing → Default).
 *   - N1: alle Felder verbatim.
 */

import type { ConsentLevel } from "./consent";

type RawDb = import("better-sqlite3").Database;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetentionPolicy {
  /** Tage bis Raw-Daten gelöscht werden dürfen. */
  readonly rawDataDays: number;
  /** Tage bis Derived-Daten gelöscht werden dürfen. */
  readonly derivedDataDays: number;
  /** Tage bis Audit-Rows abgebaut werden dürfen (DSGVO Art. 30 = 7 Jahre). */
  readonly auditRetentionDays: number;
  /** Karenz-Periode (Tage) nach einer Consent-Revoke. */
  readonly consentRevocationGracePeriodDays: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  rawDataDays: 30,
  derivedDataDays: 365,
  auditRetentionDays: 2555, // ≈ 7 Jahre (DSGVO Art. 30)
  consentRevocationGracePeriodDays: 14,
};

// ---------------------------------------------------------------------------
// isExpired — pure Funktion
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Prüft, ob ein Item nach `days` Tagen ab `createdAt` als abgelaufen gilt.
 * Pure Funktion — `nowMs` ist optional und default Date.now() (für Tests
 * deterministisch überschreibbar).
 */
export function isExpired(
  createdAt: number,
  days: number,
  nowMs?: number,
): boolean {
  if (!Number.isFinite(createdAt) || !Number.isFinite(days) || days <= 0) {
    return false;
  }
  const now = nowMs ?? Date.now();
  return now - createdAt > days * MS_PER_DAY;
}

/**
 * Berechnet das Ablaufdatum (ms-Epoch) für ein Item — pure Funktion.
 */
export function retentionExpiresAt(createdAt: number, days: number): number {
  if (!Number.isFinite(createdAt) || !Number.isFinite(days) || days <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return createdAt + days * MS_PER_DAY;
}

// ---------------------------------------------------------------------------
// Per-Workspace-Override (optional)
// ---------------------------------------------------------------------------

/**
 * Lädt die wirksame RetentionPolicy für einen Workspace.
 *
 * Mechanik (additiv, fail-soft):
 *   - Liest user_preferences (Migration 0114) nach einer optionalen Override-
 *     Spalte. Da user_preferences in dieser Codebase user-scoped ist (nicht
 *     workspace-scoped), gibt es derzeit KEINE Workspace-Override-Quelle —
 *     diese Funktion liefert fortlaufend DEFAULT_RETENTION_POLICY. Eine
 *     zukünftige `workspace_retention_overrides`-Tabelle kann hier additiv
 *     verdrahtet werden, ohne Lane G zu ändern (rein Reader-Schicht).
 *
 *   - workspaceId wird validiert, ist aber DB-readonly: keine Errors,
 *     fail-soft Default-Rückgabe bei jedem Problem.
 */
export function getWorkspaceRetention(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- additiv reserviert für künftigen Override-Lesepfad
  raw: RawDb,
  workspaceId: string,
): RetentionPolicy {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    return DEFAULT_RETENTION_POLICY;
  }
  // Heute: keine workspace_retention_overrides-Tabelle → Default zurückgeben.
  // Hook für späteren Override-Lookup (additiv, ohne Lane-G-Änderung):
  //   const row = raw.prepare(
  //     `SELECT raw_days, derived_days, audit_days, grace_days
  //        FROM workspace_retention_overrides WHERE workspace_id = ?`,
  //   ).get(workspaceId) as Record<string, number> | undefined;
  //   if (row) return { rawDataDays: row.raw_days, ... };
  return DEFAULT_RETENTION_POLICY;
}

// ---------------------------------------------------------------------------
// Hilfs-Helpers für andere Lane-G-Module
// ---------------------------------------------------------------------------

/**
 * Liefert die für eine ConsentLevel-Ebene angemessene Default-Retention
 * (Tage). `none` und `read-only` haben raw-Retention; alles ab `read-derive`
 * darf länger gespeichert werden (derived).
 */
export function retentionDaysForLevel(
  level: ConsentLevel,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): number {
  switch (level) {
    case "none":
    case "read-only":
      return policy.rawDataDays;
    case "read-derive":
    case "read-derive-act":
    case "full-automation":
      return policy.derivedDataDays;
    default:
      // Fail-closed: unbekannter Level → minimal halten.
      return policy.rawDataDays;
  }
}
