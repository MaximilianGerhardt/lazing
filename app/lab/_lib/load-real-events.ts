/**
 * /lab real-event loader (MVP, 2026-05-01).
 *
 * Loads the most recent events of a given surface kind from the
 * production DB. Workspaces with sensitivity='high' are hard-filtered
 * out — the filter happens in the SQL, not first in JS, so that
 * sensitive payloads never land in memory even briefly.
 *
 * Output is already PII-redacted (see ./redact.ts) and
 * workspace labels are whitelisted/pseudonymized.
 *
 * Defense-in-depth:
 *   1. SQL filter w.sensitivity != 'high'  (Layer 1)
 *   2. JS re-check in mapRow                (Layer 2)
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
 * Loads redacted RealEvents for a surface kind.
 *
 * @param kind - Surface kind from payload.kind, e.g. "auto-dispatch-stage"
 * @param opts.workspaceId - Optionally narrow to a single workspace
 * @param opts.limit - Default 5, hard cap 50
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

  // SQL filter:
  //   - payload.kind == ?
  //   - sensitivity-high HARD filtered out (defense layer 1)
  //   - entity_type whitelist (workstream/ticket/decision/synthesis)
  //     prevents e.g. user-typed chat_message_user events
  //     with a faked kind from slipping in
  //   - LEFT JOIN workspaces, because events can historically also
  //     exist without an existing workspace row
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
  // Defense layer 2: re-check sensitivity in JS. If the SQL filter ever
  // fails due to a schema drift (e.g. column rename, migration bug),
  // we cut hard here once more.
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

  // Layer 3: PII redaction through the payload.
  const redacted = redactPayload(parsed) as Record<string, unknown>;

  const kindFromPayload = typeof redacted.kind === "string" ? redacted.kind : "";

  // Layer 4: workspace-label whitelist.
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
