/**
 * scripts/finalize-workstream.ts (2026-04-29).
 *
 * Pragmatischer Helper: für einen iterate-fertig-Workstream die ConsensusAction-
 * Card im Chat erzeugen + Master-Ticket workflowState='review' setzen.
 * Nutzt existing Surface-Library — kein neues UI.
 *
 * Usage:
 *   pnpm tsx scripts/finalize-workstream.ts <workstreamId>
 */

import { getDb } from '../db/client';
import { emitEvent, emitChatMessageCompleted } from '../lib/events/emit';
import { ulid } from '../lib/ulid';

async function main(): Promise<void> {
  const wsId = process.argv[2];
  if (!wsId) {
    console.error('Usage: pnpm tsx scripts/finalize-workstream.ts <workstreamId>');
    process.exit(1);
  }

  const db = getDb();
  const wsRow = db.$raw
    .prepare(
      'SELECT id, workspace_id, primary_ticket_id, status, name FROM workstreams WHERE id=?',
    )
    .get(wsId) as
    | { id: string; workspace_id: string; primary_ticket_id: string | null; status: string; name: string }
    | undefined;
  if (!wsRow || !wsRow.primary_ticket_id) {
    console.error('workstream/master-ticket not found');
    process.exit(2);
  }

  // Letzten iterate-version Plan-Text aus DB
  const planRow = db.$raw
    .prepare(
      `SELECT json_extract(payload,'$.text') as text,
              CAST(json_extract(payload,'$.version') AS INTEGER) as version
         FROM events
        WHERE entity_type='ticket' AND entity_id=?
          AND event_type='commented'
          AND json_extract(payload,'$.kind')='iterate-version'
        ORDER BY version DESC, created_at DESC LIMIT 1`,
    )
    .get(wsRow.primary_ticket_id) as
    | { text: string | null; version: number | null }
    | undefined;
  if (!planRow?.text) {
    console.error('no iterate-version event found for master-ticket');
    process.exit(3);
  }

  // 1) workflowState='review' Update-Event
  await emitEvent({
    segmentId: wsRow.workspace_id,
    entityType: 'ticket',
    entityId: wsRow.primary_ticket_id,
    eventType: 'updated',
    actor: 'system',
    payload: {
      workflowState: 'review',
      transition: 'iterate-final',
      workstreamId: wsRow.id,
    },
    sensitivity: 'low',
  });

  // 2) Master-Ticket workflow_state Spalte hochziehen (Auto-Dispatch
  //    nutzt das, nicht das Event direkt — siehe lib/tickets/auto-dispatch.ts).
  try {
    db.$raw
      .prepare("UPDATE tickets SET workflow_state='review' WHERE id=?")
      .run(wsRow.primary_ticket_id);
  } catch {
    /* tickets-Tabelle existiert evt. nicht (Event-Sourcing) — egal */
  }

  // 2b) Outlier-Aggregation aus Roaster-Events der letzten Welle.
  //     Sub-Plan 04 (2026-04-29) — Outlier-Inline-Daten statt extern.
  const lastVersionRow = db.$raw
    .prepare(
      `SELECT created_at FROM events
        WHERE entity_type='ticket' AND entity_id=?
          AND event_type='commented'
          AND json_extract(payload,'$.kind')='iterate-version'
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(wsRow.primary_ticket_id) as { created_at: number } | undefined;
  const sinceMs = lastVersionRow?.created_at ?? 0;
  const roastRows = db.$raw
    .prepare(
      `SELECT json_extract(payload,'$.roasterLabel') as label,
              json_extract(payload,'$.text') as text
         FROM events
        WHERE entity_type='ticket' AND entity_id=?
          AND event_type='commented'
          AND json_extract(payload,'$.kind')='iterate-roast'
          AND created_at >= ?`,
    )
    .all(wsRow.primary_ticket_id, sinceMs - 60_000) as Array<{
    label: string | null;
    text: string | null;
  }>;
  const outliers = roastRows
    .filter((r) => r.text)
    .map((r) => ({
      cluster: r.label ?? 'Roaster',
      summary: (r.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 220),
    }))
    .slice(0, 4);

  // 3) chat_message_completed-Event mit ConsensusActionCard-Surface-Tag.
  //    ChatShell rendert diesen als Assistant-Message + Surface.
  const consensusJson = JSON.stringify({
    workstreamId: wsRow.id,
    consensusLevel: 'majority',
    masterTicketId: wsRow.primary_ticket_id,
    outliers,
  });
  const cardText = [
    `**Master-Plan V${planRow.version ?? '?'} fertig — ${wsRow.name}**`,
    '',
    'Der iterate-Loop hat einen finalen Plan produziert. Sub-Tickets sind',
    'extrahiert. Approve startet die autonome Umsetzung mit Auto-Dispatch',
    '(25 s Sniper-Pause vor Spawn — du kannst noch eingreifen).',
    '',
    `<surface:consensus-action>${consensusJson}</surface:consensus-action>`,
  ].join('\n');

  await emitChatMessageCompleted({
    workspaceId: wsRow.workspace_id,
    entityId: ulid(),
    content: cardText,
    actor: 'system',
    outcome: 'ok',
  });

  console.log(`✓ ${wsId} finalisiert.`);
  console.log(`  workflowState='review' am Master-Ticket ${wsRow.primary_ticket_id}`);
  console.log(`  ConsensusActionCard im Chat von ${wsRow.workspace_id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(99);
});
