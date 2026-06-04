/**
 * /lanes — DEPRECATED. Redirect zu /workstreams?view=kanban.
 *
 * Workstreams haben Lanes auf höherer Ebene ersetzt: ein Workstream gruppiert
 * Tickets pro User-Anfrage, der Kanban-View visualisiert sie nach Status.
 * Diese Route bleibt nur fuer Backlinks/Bookmarks; alles Aktuelle lebt unter
 * /workstreams.
 */

import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default function LanesRedirect() {
  redirect('/workstreams?view=kanban');
}
