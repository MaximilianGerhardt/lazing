/**
 * Phase CTX — Compact-with-Snapshot.
 *
 * Liefert einen Markdown-Block, der den aktuellen Stand eines Workspaces
 * komprimiert. Kein Claude-Spawn — pure data-driven (Phase 1). Spätere
 * Phasen können einen Lead-Agent dazwischen schalten.
 *
 * Verwendung:
 *   const block = buildSnapshot({ workspaceId, userId });
 *   prependPlanSnapshot('/root/.claude/plans/active.md', block);
 */

import { getDb } from "@/db/client";
import { listTickets } from "@/lib/tickets/service";

export interface SnapshotInput {
  workspaceId: string;
  userId: string;
}

export interface SnapshotResult {
  /** ISO-String, beginnt mit `## Stand <ISO>`. */
  block: string;
  /** Plain-Text-Summary für Chat-Toast (max 300 Zeichen). */
  summary: string;
  /** Anzahl der einbezogenen Events. */
  eventCount: number;
}

/** Async-Version (nutzt event-sourced ticket-Projection). */
export async function buildSnapshotAsync(
  input: SnapshotInput,
): Promise<SnapshotResult> {
  return buildSnapshotInternal(input);
}

interface ChatMessageRow {
  id: string;
  event_type: string;
  payload: string;
  created_at: number;
}

interface WorkstreamRow {
  id: string;
  name: string;
  status: string;
  updated_at: number;
}

interface WorkspaceRow {
  id: string;
  label: string;
  description: string | null;
}

interface TicketProjectionLite {
  id: string;
  title: string;
  workflowState?: string;
}

async function buildSnapshotInternal(input: SnapshotInput): Promise<SnapshotResult> {
  const db = getDb();
  const now = new Date();
  const isoNow = now.toISOString();

  // 1. Workspace-Header
  const wsRow = db.$raw
    .prepare("SELECT id, label, description FROM workspaces WHERE id = ?")
    .get(input.workspaceId) as WorkspaceRow | undefined;
  const wsLabel = wsRow?.label ?? input.workspaceId;
  const wsDesc = wsRow?.description ?? null;

  // 2. Letzte 30 chat_message-Events
  const chatRows = db.$raw
    .prepare(
      `SELECT id, event_type, payload, created_at
         FROM events
        WHERE entity_type = 'chat_message'
          AND segment_id = ?
        ORDER BY created_at DESC
        LIMIT 30`,
    )
    .all(input.workspaceId) as ChatMessageRow[];

  // 3. Aktive Tickets (workflowState in review/approved/executing).
  // Tickets sind event-sourced — wir gehen über listTickets/projectTickets
  // statt eine `tickets`-Tabelle zu queryen (die existiert nicht).
  let ticketRowsLite: TicketProjectionLite[] = [];
  try {
    const all = await listTickets({ workspaceId: input.workspaceId, limit: 200 });
    ticketRowsLite = all
      .map((t) => {
        const tt = t as unknown as {
          id: string;
          title: string;
          workflowState?: string;
        };
        return {
          id: tt.id,
          title: tt.title,
          workflowState: tt.workflowState,
        };
      })
      .filter((t) =>
        ["review", "approved", "executing"].includes(t.workflowState ?? ""),
      )
      .slice(0, 20);
  } catch {
    /* noop — Snapshot bleibt ohne Tickets-Sektion */
  }

  // 4. Aktive Workstreams
  const wsRows = db.$raw
    .prepare(
      `SELECT id, name, status, updated_at
         FROM workstreams
        WHERE workspace_id = ?
          AND status IN ('active', 'paused')
        ORDER BY updated_at DESC
        LIMIT 10`,
    )
    .all(input.workspaceId) as WorkstreamRow[];

  // --- Markdown bauen ---
  const lines: string[] = [];
  lines.push(`## Stand ${isoNow}`);
  lines.push("");
  lines.push(`**Workspace:** \`${wsLabel}\` (\`${input.workspaceId}\`)`);
  if (wsDesc) lines.push(`**Beschreibung:** ${wsDesc}`);
  lines.push("");

  // Aktive Tickets
  if (ticketRowsLite.length > 0) {
    lines.push("### Aktive Tickets");
    for (const t of ticketRowsLite) {
      const wf = t.workflowState ?? "—";
      lines.push(`- \`${t.id}\` · **${t.title}** · *${wf}*`);
    }
    lines.push("");
  }

  // Aktive Workstreams
  if (wsRows.length > 0) {
    lines.push("### Aktive Workstreams");
    for (const w of wsRows) {
      lines.push(`- \`${w.id}\` · **${w.name}** · *${w.status}*`);
    }
    lines.push("");
  }

  // Letzte Chat-Aktivität
  if (chatRows.length > 0) {
    lines.push(`### Letzte ${chatRows.length} Chat-Events`);
    for (const ev of chatRows.slice(0, 10)) {
      const ts = new Date(ev.created_at).toISOString();
      let role = "?";
      let snippet = "";
      try {
        const p = JSON.parse(ev.payload) as {
          role?: string;
          content?: string;
          partial?: boolean;
        };
        role = p.role ?? "?";
        snippet = (p.content ?? "").slice(0, 100).replace(/\n/g, " ");
      } catch {
        /* ignore */
      }
      lines.push(`- \`${ts}\` *${role}* — ${snippet}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");

  const block = lines.join("\n");

  const summary = [
    `Snapshot ${wsLabel}: ${ticketRowsLite.length} aktive Tickets, ${wsRows.length} laufende Workstreams, ${chatRows.length} Chat-Events.`,
  ]
    .join(" ")
    .slice(0, 300);

  return {
    block,
    summary,
    eventCount: chatRows.length + ticketRowsLite.length + wsRows.length,
  };
}

/**
 * Sync-Wrapper für Backward-Compat. Liefert ein Promise — Caller muss
 * awaiten. Behält den Original-Namen damit existing imports nicht brechen.
 */
export function buildSnapshot(input: SnapshotInput): Promise<SnapshotResult> {
  return buildSnapshotInternal(input);
}
