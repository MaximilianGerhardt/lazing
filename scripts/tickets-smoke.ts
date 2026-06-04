/**
 * Smoke-Test für die Ticket-Service-Schicht.
 * Ruft createTicket / updateTicket / closeTicket / listTickets / getTimeline
 * direkt auf — ohne HTTP/Middleware. Verifiziert, dass der Event-Log-
 * round-trip (append → projection) korrekt ist.
 *
 * Lauf:  npx tsx scripts/tickets-smoke.ts   (vom Repo-Root)
 */

import {
  addComment,
  closeTicket,
  createTicket,
  getTicket,
  getTimeline,
  listTickets,
  updateTicket,
} from '../lib/tickets/service';

async function main() {
  const log = (...parts: unknown[]) =>
    console.log('[smoke]', ...parts);

  log('1. createTicket()');
  const created = await createTicket({
    workspaceId: 'lazyos',
    title: 'Smoke-Test-Ticket (Stream C)',
    body: 'Automated smoke test — safe to delete.\n\nAcceptance: appears in list + timeline has `created` event.',
    prio: 'P2',
    tags: ['smoke', 'stream-c'],
    assignee: 'claude',
  });
  log('   created id:', created.id, 'title:', created.title);
  if (!created.id.startsWith('TCK-')) throw new Error('id missing TCK- prefix');

  log('2. getTicket()');
  const roundTrip = await getTicket(created.id);
  if (!roundTrip) throw new Error('getTicket returned null');
  if (roundTrip.title !== created.title) throw new Error('title mismatch');

  log('3. updateTicket()  — title + status');
  const updated = await updateTicket(created.id, {
    title: 'Smoke-Test (updated)',
    status: 'wait',
  });
  if (updated.title !== 'Smoke-Test (updated)') throw new Error('title not updated');
  if (updated.status !== 'wait') throw new Error('status not updated');

  log('4. addComment()');
  await addComment(created.id, { text: 'Mit Kommentar vom Smoke-Test.' });

  log('5. getTimeline()');
  const timeline = await getTimeline(created.id);
  const types = timeline.map((e) => e.eventType);
  log('   events:', types);
  if (!types.includes('created')) throw new Error('missing created');
  if (!types.includes('updated')) throw new Error('missing updated');
  if (!types.includes('status_changed')) throw new Error('missing status_changed');
  if (!types.includes('commented')) throw new Error('missing commented');

  log('6. listTickets() with filter');
  const list = await listTickets({ workspaceId: 'lazyos', limit: 100 });
  const found = list.find((t) => t.id === created.id);
  if (!found) throw new Error('ticket not in filtered list');

  log('7. closeTicket()');
  const closed = await closeTicket(created.id);
  if (closed.status !== 'done') throw new Error('close did not set status=done');
  if (!closed.closedAt) throw new Error('closedAt missing');

  log('8. timeline has closed event');
  const timeline2 = await getTimeline(created.id);
  if (!timeline2.some((e) => e.eventType === 'closed')) {
    throw new Error('closed event missing from timeline');
  }

  log('\nOK — all Stream-C ticket-service assertions passed.');
  log('   test ticket id (kept in log — append-only):', created.id);
}

main().catch((err) => {
  console.error('[smoke] FAIL', err);
  process.exit(1);
});
