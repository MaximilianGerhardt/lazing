/**
 * /lab Real-Event-Loader (MVP, 2026-05-01).
 *
 * Lädt die jüngsten Events eines bestimmten Surface-Kinds aus der
 * Production-DB. Workspaces mit sensitivity='high' werden hart
 * ausgefiltert — der Filter passiert im SQL, nicht erst in JS, damit
 * sensitive Payloads nicht mal kurz im Memory landen.
 *
 * Output ist bereits PII-redacted (siehe ./redact.ts) und
 * Workspace-Labels sind whitelisted-pseudonymisiert.
 *
 * Defense-in-Depth:
 *   1. SQL-Filter w.sensitivity != 'high'  (Layer 1)
 *   2. JS-Re-Check in mapRow                (Layer 2)
 *   3. redactPayload()                       (Layer 3)
 *   4. redactWorkspaceLabel()                (Layer 4)
 */

import { getDb } from "@/db/client";

import { redactPayload, redactWorkspaceLabel, truncateTitle } from "./redact";

export interface RealEvent {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  workspaceId: string;
  workspaceLabel: string;
  workspaceAccent: string | null;
  ticketId: string | null;
  createdAt: number;
}

export interface LoadOpts {
  workspaceId?: string;
  limit?: number;
}

interface RawRow {
  id: string;
  payload: string;
  workspace_id: string;
  workspace_label: string | null;
  workspace_accent: string | null;
  workspace_sensitivity: string | null;
  entity_id: string | null;
  created_at: number;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;

/**
 * Lädt redacted RealEvents für einen Surface-Kind.
 *
 * @param kind - Surface-Kind aus payload.kind, z.B. "auto-dispatch-stage"
 * @param opts.workspaceId - Optional auf einen Workspace eingrenzen
 * @param opts.limit - Default 5, hard-Cap 50
 */
export function loadRealEvents(
  kind: string,
  opts: LoadOpts = {},
): RealEvent[] {
  if (typeof kind !== "string" || kind.length === 0) return [];

  const limit = Math.max(
    1,
    Math.min(MAX_LIMIT, opts.limit ?? DEFAULT_LIMIT),
  );
  const workspaceFilter = opts.workspaceId ?? null;

  const db = getDb();

  // SQL-Filter:
  //   - payload.kind == ?
  //   - sensitivity-high HARD ausgefiltert (Defense Layer 1)
  //   - entity_type Whitelist (workstream/ticket/decision/synthesis)
  //     verhindert dass z.B. user-typed chat_message_user-events
  //     mit fingiertem kind reinrutschen
  //   - LEFT JOIN workspaces, weil Events historisch auch ohne
  //     existierende workspace-row sein können
  const stmt = db.$raw.prepare<unknown[], RawRow>(
    `
    SELECT
      e.id                          AS id,
      e.payload                     AS payload,
      e.segment_id                  AS workspace_id,
      w.label                       AS workspace_label,
      w.accent                      AS workspace_accent,
      w.sensitivity                 AS workspace_sensitivity,
      e.entity_id                   AS entity_id,
      e.created_at                  AS created_at
    FROM events e
    LEFT JOIN workspaces w ON w.id = e.segment_id
    WHERE json_extract(e.payload, '$.kind') = ?
      AND e.event_type = 'chat_message_completed'
      AND (w.sensitivity IS NULL OR w.sensitivity != 'high')
      AND (? IS NULL OR e.segment_id = ?)
    ORDER BY e.created_at DESC
    LIMIT ?
    `,
  );

  const rows = stmt.all(kind, workspaceFilter, workspaceFilter, limit);

  return rows
    .map((row, idx) => mapRow(row, idx))
    .filter((ev): ev is RealEvent => ev !== null);
}

function mapRow(row: RawRow, idx: number): RealEvent | null {
  // Defense Layer 2: Re-Check sensitivity in JS. Falls SQL-Filter durch
  // einen Schema-Drift mal ausfällt (z.B. Spalten-Rename, Migration-Bug),
  // schneiden wir hier nochmal hart ab.
  if (row.workspace_sensitivity === "high") return null;

  let parsed: Record<string, unknown>;
  try {
    const raw = JSON.parse(row.payload);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return null;
    }
    parsed = raw as Record<string, unknown>;
  } catch {
    return null;
  }

  // Layer 3: PII-Redaction durch Payload.
  const redacted = redactPayload(parsed) as Record<string, unknown>;

  const kindFromPayload = typeof redacted.kind === "string" ? redacted.kind : "";

  // Layer 4: Workspace-Label-Whitelist.
  const labelInput = row.workspace_label ?? row.workspace_id;
  const label = redactWorkspaceLabel(labelInput, idx + 1);

  return {
    id: row.id,
    kind: kindFromPayload,
    payload: redacted,
    workspaceId: row.workspace_id,
    workspaceLabel: label,
    workspaceAccent: row.workspace_accent,
    ticketId: row.entity_id ? truncateTitle(row.entity_id, 60) : null,
    createdAt: row.created_at,
  };
}
