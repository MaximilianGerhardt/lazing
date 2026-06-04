/**
 * User-Preferences Repository (Owner-Fix Live-Test 2026-05-28).
 *
 * Owner-Befund (verbatim):
 *   „Vollzugriff war bereits aktiviert. im neuen Workspace war es nicht
 *    aktiviert. Ggf. diese Einstellung Systemübergreifend nutzbar machen."
 *
 * Verantwortung dieses Moduls:
 *   - Schreibt & liest `user_preferences` (Migration 0114).
 *   - Kapselt N10 content_hash (sha256 über kanonisches JSON).
 *   - Provider-Pattern bewahrt N4 (additiv, keine Änderung an `users` oder
 *     `lazyos_permission_modes`).
 *
 * Konsumenten:
 *   - POST /api/workspaces           — liest den Default beim Anlegen und
 *                                       seedet `lazyos_permission_modes`
 *                                       für die neue Workspace SOFORT.
 *   - PATCH /api/permission/[wsId]/mode — schreibt den Default auf den vom
 *                                          User explizit gewählten Mode
 *                                          (Owner-Direktive: User-Default
 *                                          folgt der letzten expliziten Aktion).
 *   - GET /api/user/preferences      — UI-Fallback für AllAccessToggle, wenn
 *                                       der Workspace keinen expliziten Mode
 *                                       hat.
 *
 * Konvention: das Repo selbst kennt KEINE Workspaces — es schreibt rein die
 * cross-workspace User-Settings. Pro-Workspace-State bleibt in
 * `lazyos_permission_modes` (Single-Source-of-Truth pro Workspace).
 */

import { createHash } from "node:crypto";

import { getDb } from "@/db/client";
import {
  PERMISSION_MODES,
  type PermissionMode,
} from "../../lib-v1/permission/settings/schema";

/** Whitelist gespiegelt aus Migration 0114 CHECK-Constraint. */
const SOURCE_VALUES = new Set([
  "system",
  "permission-toggle",
  "api",
  "migration",
]);

/** Persisted shape (camelCase). */
export interface UserPreferences {
  userId: string;
  defaultPermissionMode: PermissionMode | null;
  reason: string | null;
  source: "system" | "permission-toggle" | "api" | "migration";
  contentHash: string;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  user_id: string;
  default_permission_mode: string | null;
  reason: string | null;
  source: string;
  content_hash: string;
  created_at: number;
  updated_at: number;
}

function rowToPrefs(row: Row): UserPreferences {
  const mode =
    row.default_permission_mode != null &&
    (PERMISSION_MODES as readonly string[]).includes(row.default_permission_mode)
      ? (row.default_permission_mode as PermissionMode)
      : null;
  const source = SOURCE_VALUES.has(row.source)
    ? (row.source as UserPreferences["source"])
    : "system";
  return {
    userId: row.user_id,
    defaultPermissionMode: mode,
    reason: row.reason,
    source,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * N10 content_hash über die fachlichen Felder. Wir lassen `created_at`,
 * `updated_at`, `id`, `content_hash` bewusst aus dem Hash heraus — sie sind
 * Provenance-Metadaten, nicht der eigentliche Inhalt der „belief".
 */
function hashPrefs(
  userId: string,
  mode: PermissionMode | null,
  reason: string | null,
  source: string,
): string {
  const canonical: Record<string, unknown> = {};
  for (const [k, v] of Object.entries({
    user_id: userId,
    default_permission_mode: mode,
    reason,
    source,
  }).sort(([a], [b]) => a.localeCompare(b))) {
    if (v !== undefined) canonical[k] = v;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
}

/**
 * Liest die Preferences-Row für den User. NULL = der User hat keine Row
 * (frisch — alle Defaults sind ungesetzt, der Aufrufer entscheidet was das
 * heißt: typischerweise „sicherer Default 'ask'").
 */
export function getUserPreferences(userId: string): UserPreferences | null {
  if (!userId) return null;
  try {
    const db = getDb();
    const row = db.$raw
      .prepare(
        `SELECT user_id, default_permission_mode, reason, source,
                content_hash, created_at, updated_at
           FROM user_preferences
          WHERE user_id = ?
          LIMIT 1`,
      )
      .get(userId) as Row | undefined;
    return row ? rowToPrefs(row) : null;
  } catch {
    // Tabelle fehlt (frische DB) → kein Fehler werfen, der Aufrufer
    // soll den sicheren Default selbst wählen.
    return null;
  }
}

/**
 * Bequemer Reader für genau das Feld, das alle Aufrufer interessieren.
 * Liefert NULL wenn keine Row existiert ODER `default_permission_mode IS NULL`.
 */
export function getUserDefaultPermissionMode(
  userId: string,
): PermissionMode | null {
  return getUserPreferences(userId)?.defaultPermissionMode ?? null;
}

export interface SetDefaultPermissionModeArgs {
  userId: string;
  mode: PermissionMode | null;
  /** N1: VERBATIM weiter — kein .slice. */
  reason?: string | null;
  /** N8 Provenance. Default 'api'. */
  source?: UserPreferences["source"];
}

/**
 * Setzt (upserts) den User-Default-Permission-Mode. Idempotent.
 *
 * Aufrufer-Pattern (Owner-Direktive 2026-05-28):
 *   - Wenn der User in PATCH /api/permission/[wsId]/mode den Workspace-Mode
 *     ändert, wird ZUSÄTZLICH der User-Default auf denselben Mode gesetzt
 *     (source='permission-toggle'). So folgt der Default der letzten
 *     expliziten Owner-Aktion.
 *   - GET /api/user/preferences liest das Feld dann beim Mount eines neuen
 *     Workspaces ohne explizite Permission-Row, damit der Toggle ohne
 *     zweiten Klick den korrekten Stand zeigt.
 */
export function setUserDefaultPermissionMode({
  userId,
  mode,
  reason,
  source = "api",
}: SetDefaultPermissionModeArgs): UserPreferences {
  if (!userId) {
    throw new Error("setUserDefaultPermissionMode: userId required");
  }
  if (mode !== null && !(PERMISSION_MODES as readonly string[]).includes(mode)) {
    throw new Error(
      `setUserDefaultPermissionMode: invalid mode '${String(mode)}'`,
    );
  }
  const safeSource = SOURCE_VALUES.has(source) ? source : "api";
  const now = Date.now();
  const contentHash = hashPrefs(userId, mode, reason ?? null, safeSource);

  const db = getDb();
  db.$raw
    .prepare(
      `INSERT INTO user_preferences
         (user_id, default_permission_mode, reason, source, content_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         default_permission_mode = excluded.default_permission_mode,
         reason                  = excluded.reason,
         source                  = excluded.source,
         content_hash            = excluded.content_hash,
         updated_at              = excluded.updated_at`,
    )
    .run(userId, mode, reason ?? null, safeSource, contentHash, now, now);

  // Re-read for a stable return shape (and ensures the row really landed).
  const after = getUserPreferences(userId);
  if (!after) {
    // Should not happen — upsert just succeeded.
    throw new Error("setUserDefaultPermissionMode: row vanished after upsert");
  }
  return after;
}
