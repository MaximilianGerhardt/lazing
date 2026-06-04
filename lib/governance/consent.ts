/**
 * G1 — Consent-Levels (Phase 2 W2.1 · Lane G Governance · 2026-05-29).
 *
 * Master-Briefing §13.2 (verbatim, N1):
 *   „Opt-in · Transparenz · Zweckbindung · Datenminimierung · Pause/Stop
 *    jederzeit · Redaction · keine geheimen Screenshots · keine Passwörter ·
 *    keine privaten Daten · Review durch betroffene Person · Betriebsrat/
 *    Arbeitsrecht beachten"
 *
 * Lane G ist die FUNDAMENTAL-Lane (Stage 1, Governance Gate Contract). Alle
 * anderen Lanes hängen am Gate, das diese Funktionen liefern.
 *
 * Mechanik (analog lib/reasoning/beliefs-repo.ts):
 *   - Nimmt ein ROHES better-sqlite3-Handle entgegen — kein getDb()-Singleton,
 *     direkt in-memory testbar.
 *   - PURE/IO-arm: nur DB-Read/Write, KEIN LLM, KEINE Netz-I/O.
 *   - N1:  reason_text VERBATIM (kein .slice).
 *   - N9:  workspaceId-scoped.
 *   - N10: content_hash (sha256 über kanonisches JSON) je Grant-Row.
 *
 * Append-only-Disziplin (N8) ist in Migration 0118 via Trigger codiert:
 *   - DELETE auf consent_grants → RAISE ABORT.
 *   - UPDATE auf id/workspace_id/user_id/data_source/level/scope_json/
 *     reason_text/granted_at/content_hash → RAISE ABORT.
 *   - revoked_at darf NUR via revokeConsent gesetzt werden (eine kontrollierte
 *     UPDATE-Operation, die NEBEN dem Spalten-Update auch noch einen Audit-
 *     Row in governance_audit anlegt — siehe lib/governance/audit.ts).
 *
 * Public API:
 *   hasConsent(raw, req)       — boolean, deterministisch
 *   grantConsent(raw, input)   — legt NEUE Grant-Row an
 *   revokeConsent(raw, input)  — setzt revoked_at auf einer existierenden
 *                                Grant-Row + schreibt Audit-Row (Trigger
 *                                erlaubt UPDATE NUR auf revoked_at)
 *   listConsents(raw, workspaceId, opts?)
 *                              — alle Grants (aktiv + revoked), neueste zuerst
 *
 * Level-Ordnung (höhere Stufe deckt niedrigere ab):
 *   none < read-only < read-derive < read-derive-act < full-automation
 */

import { createHash } from "node:crypto";

import { ulid } from "@/lib/ulid";

type RawDb = import("better-sqlite3").Database;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Owner-Direktive §13.2 — granularer Consent. */
export type ConsentLevel =
  | "none"
  | "read-only"
  | "read-derive"
  | "read-derive-act"
  | "full-automation";

/** Datenquellen, die Consent benötigen. */
export type DataSource =
  | "whatsapp"
  | "telegram"
  | "voice"
  | "meeting"
  | "email"
  | "browser-shadow"
  | "screen-capture"
  | "keystroke-capture"
  | "workspace-derive";

export interface ConsentScope {
  /** Optionales Zeitfenster für die Erlaubnis (ms-Epoch). */
  readonly timeWindow?: { readonly fromMs?: number; readonly toMs?: number };
  /** Optionales Datenminimierungs-Profil (Whitelist von Feldern). */
  readonly dataMin?: readonly string[];
}

export interface ConsentGrant {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly dataSource: DataSource | string;
  readonly level: ConsentLevel;
  readonly scope: ConsentScope | null;
  /** §13.2 verbatim Begründung (N1). */
  readonly reasonText: string;
  readonly grantedAt: number;
  /** Nullable. Wenn gesetzt → Grant ist zurückgenommen. */
  readonly revokedAt: number | null;
  readonly contentHash: string;
}

export interface HasConsentArgs {
  readonly workspaceId: string;
  readonly userId: string;
  readonly dataSource: DataSource | string;
  readonly requiredLevel: ConsentLevel;
  /** Optional: Zeitpunkt der Prüfung (default Date.now()). */
  readonly nowMs?: number;
}

export interface GrantConsentInput {
  readonly workspaceId: string;
  readonly userId: string;
  readonly dataSource: DataSource | string;
  readonly level: ConsentLevel;
  readonly scope?: ConsentScope | null;
  /** §13.2 verbatim Begründung (N1). */
  readonly reasonText: string;
}

export interface RevokeConsentInput {
  readonly workspaceId: string;
  readonly userId: string;
  readonly dataSource: DataSource | string;
  /** Optional: spezifische Grant-ID, sonst die jüngste aktive Grant-Row. */
  readonly grantId?: string;
}

// ---------------------------------------------------------------------------
// Level-Ordnung
// ---------------------------------------------------------------------------

const LEVEL_RANK: Record<ConsentLevel, number> = {
  none: 0,
  "read-only": 1,
  "read-derive": 2,
  "read-derive-act": 3,
  "full-automation": 4,
};

/**
 * true ⇔ `granted` deckt `required` ab. Höhere Stufe deckt niedrigere.
 * Pure Funktion — exportiert für Tests + canAutoRun (no-auto-run.ts).
 */
export function levelCovers(granted: ConsentLevel, required: ConsentLevel): boolean {
  return LEVEL_RANK[granted] >= LEVEL_RANK[required];
}

const VALID_LEVELS: ReadonlySet<ConsentLevel> = new Set([
  "none",
  "read-only",
  "read-derive",
  "read-derive-act",
  "full-automation",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowMs(): number {
  return Date.now();
}

/** N10: sha256 über kanonisches JSON → immer 64 hex-Zeichen. */
function sha256hex(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function mapGrantRow(r: Record<string, unknown>): ConsentGrant {
  let scope: ConsentScope | null = null;
  const rawScope = r.scope_json;
  if (typeof rawScope === "string" && rawScope.length > 0) {
    try {
      scope = JSON.parse(rawScope) as ConsentScope;
    } catch {
      // fail-soft: ungültiges scope_json → null. Niemals werfen.
      scope = null;
    }
  }
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    userId: String(r.user_id),
    dataSource: String(r.data_source),
    level: String(r.level) as ConsentLevel,
    scope,
    reasonText: String(r.reason_text),
    grantedAt: Number(r.granted_at),
    revokedAt: r.revoked_at == null ? null : Number(r.revoked_at),
    contentHash: String(r.content_hash),
  };
}

function validateArgs(args: {
  workspaceId: string;
  userId: string;
  dataSource: string;
}): void {
  if (typeof args.workspaceId !== "string" || args.workspaceId.length === 0) {
    throw new Error("consent: workspaceId required");
  }
  if (typeof args.userId !== "string" || args.userId.length === 0) {
    throw new Error("consent: userId required");
  }
  if (typeof args.dataSource !== "string" || args.dataSource.length === 0) {
    throw new Error("consent: dataSource required");
  }
}

// ---------------------------------------------------------------------------
// hasConsent — deterministische Prüfung (N6: Validatoren vor LLM)
// ---------------------------------------------------------------------------

/**
 * Prüft, ob für (workspaceId, userId, dataSource) ein AKTIVER Grant mit
 * mindestens dem geforderten Level existiert.
 *
 * „Aktiv" = revoked_at IS NULL UND (kein timeWindow ODER nowMs liegt im
 * Fenster). Eine höhere ConsentLevel-Stufe deckt eine niedrigere ab
 * (siehe levelCovers).
 *
 * Pure DB-Read, kein LLM, fail-closed: jede ungültige Eingabe → false.
 */
export function hasConsent(raw: RawDb, args: HasConsentArgs): boolean {
  if (
    typeof args.workspaceId !== "string" ||
    args.workspaceId.length === 0 ||
    typeof args.userId !== "string" ||
    args.userId.length === 0 ||
    typeof args.dataSource !== "string" ||
    args.dataSource.length === 0
  ) {
    return false;
  }
  if (!VALID_LEVELS.has(args.requiredLevel)) {
    return false;
  }
  const now = args.nowMs ?? nowMs();
  const rows = raw
    .prepare(
      `SELECT * FROM consent_grants
        WHERE workspace_id = ? AND user_id = ? AND data_source = ?
          AND revoked_at IS NULL
        ORDER BY granted_at DESC, id DESC`,
    )
    .all(args.workspaceId, args.userId, args.dataSource) as Record<
    string,
    unknown
  >[];

  for (const row of rows) {
    const grant = mapGrantRow(row);
    // Time-Window-Check (falls scope.timeWindow gesetzt).
    if (grant.scope?.timeWindow) {
      const { fromMs, toMs } = grant.scope.timeWindow;
      if (typeof fromMs === "number" && now < fromMs) continue;
      if (typeof toMs === "number" && now > toMs) continue;
    }
    if (levelCovers(grant.level, args.requiredLevel)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// grantConsent — legt eine NEUE Grant-Row an (Append-only-Geist)
// ---------------------------------------------------------------------------

/**
 * Legt einen neuen Consent-Grant an. Frühere Grants für dieselbe
 * (workspace, user, dataSource)-Kombination bleiben erhalten — die Historie
 * ist über listConsents nachvollziehbar. hasConsent betrachtet automatisch
 * den höchstwertigen NICHT-REVOZIERTEN Grant.
 *
 * reason_text wird VERBATIM persistiert (N1). content_hash (N10) wird über
 * das kanonische JSON der Grant-Felder berechnet.
 */
export function grantConsent(raw: RawDb, input: GrantConsentInput): ConsentGrant {
  validateArgs({
    workspaceId: input.workspaceId,
    userId: input.userId,
    dataSource: input.dataSource,
  });
  if (!VALID_LEVELS.has(input.level)) {
    throw new Error(
      `grantConsent: invalid level '${String(input.level)}' — must be one of ${[
        ...VALID_LEVELS,
      ].join(", ")}`,
    );
  }
  if (typeof input.reasonText !== "string" || input.reasonText.length === 0) {
    throw new Error(
      "grantConsent: reasonText required (§13.2 verbatim Begründung, N1)",
    );
  }

  const id = `CGT-${ulid()}`;
  const ts = nowMs();
  const scopeJson = input.scope ? JSON.stringify(input.scope) : null;
  const contentHash = sha256hex({
    workspace_id: input.workspaceId,
    user_id: input.userId,
    data_source: input.dataSource,
    level: input.level,
    scope_json: scopeJson,
    reason_text: input.reasonText,
    granted_at: ts,
  });

  raw
    .prepare(
      `INSERT INTO consent_grants
         (id, workspace_id, user_id, data_source, level, scope_json,
          reason_text, granted_at, revoked_at, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      id,
      input.workspaceId,
      input.userId,
      input.dataSource,
      input.level,
      scopeJson,
      input.reasonText, // N1: verbatim
      ts,
      contentHash,
    );

  return {
    id,
    workspaceId: input.workspaceId,
    userId: input.userId,
    dataSource: input.dataSource,
    level: input.level,
    scope: input.scope ?? null,
    reasonText: input.reasonText,
    grantedAt: ts,
    revokedAt: null,
    contentHash,
  };
}

// ---------------------------------------------------------------------------
// revokeConsent — setzt revoked_at auf der jüngsten aktiven Grant-Row
// ---------------------------------------------------------------------------

/**
 * Owner-Direktive §13.2 „Pause/Stop jederzeit": eine Person kann ihren
 * Consent jederzeit zurückziehen. Die Grant-Row bleibt aus N8-Gründen
 * erhalten (DELETE-Trigger blockt); revoked_at wird gesetzt.
 *
 * Falls grantId angegeben ist, wird dieser konkrete Grant revoziert. Sonst:
 * der jüngste AKTIVE Grant (revoked_at IS NULL) für die (workspace, user,
 * dataSource)-Kombination.
 *
 * Gibt die revozierte Grant-Row zurück, oder null, wenn nichts revoziert
 * werden konnte (fail-soft).
 */
export function revokeConsent(
  raw: RawDb,
  input: RevokeConsentInput,
): ConsentGrant | null {
  validateArgs({
    workspaceId: input.workspaceId,
    userId: input.userId,
    dataSource: input.dataSource,
  });

  const target = input.grantId
    ? (raw
        .prepare(
          `SELECT * FROM consent_grants
            WHERE id = ? AND workspace_id = ? AND user_id = ? AND data_source = ?
              AND revoked_at IS NULL
            LIMIT 1`,
        )
        .get(
          input.grantId,
          input.workspaceId,
          input.userId,
          input.dataSource,
        ) as Record<string, unknown> | undefined)
    : (raw
        .prepare(
          `SELECT * FROM consent_grants
            WHERE workspace_id = ? AND user_id = ? AND data_source = ?
              AND revoked_at IS NULL
            ORDER BY granted_at DESC, id DESC
            LIMIT 1`,
        )
        .get(input.workspaceId, input.userId, input.dataSource) as Record<
        string,
        unknown
      > | undefined);

  if (!target) return null;

  const ts = nowMs();
  raw
    .prepare(`UPDATE consent_grants SET revoked_at = ? WHERE id = ?`)
    .run(ts, target.id);

  return { ...mapGrantRow(target), revokedAt: ts };
}

// ---------------------------------------------------------------------------
// listConsents — alle Grants (aktiv + revoked), neueste zuerst
// ---------------------------------------------------------------------------

export interface ListConsentsOpts {
  readonly userId?: string;
  readonly dataSource?: DataSource | string;
  readonly limit?: number;
  /** Wenn true, nur aktive (revoked_at IS NULL). Default false (alle). */
  readonly onlyActive?: boolean;
}

export function listConsents(
  raw: RawDb,
  workspaceId: string,
  opts: ListConsentsOpts = {},
): ConsentGrant[] {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("listConsents: workspaceId required");
  }

  const where: string[] = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (opts.userId) {
    where.push("user_id = ?");
    params.push(opts.userId);
  }
  if (opts.dataSource) {
    where.push("data_source = ?");
    params.push(opts.dataSource);
  }
  if (opts.onlyActive) {
    where.push("revoked_at IS NULL");
  }
  const limit =
    opts.limit && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.floor(opts.limit)
      : 500;
  params.push(limit);

  const rows = raw
    .prepare(
      `SELECT * FROM consent_grants
        WHERE ${where.join(" AND ")}
        ORDER BY granted_at DESC, id DESC
        LIMIT ?`,
    )
    .all(...params) as Record<string, unknown>[];
  return rows.map(mapGrantRow);
}
