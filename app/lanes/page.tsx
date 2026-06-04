/**
 * /lanes — DEPRECATED. Redirect to /workstreams?view=kanban.
 *
 * Workstreams have replaced lanes at a higher level: a workstream groups
 * tickets per user request, the kanban view visualizes them by status.
 * This route only remains for backlinks/bookmarks; everything current lives
 * under /workstreams.
 */

import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default function LanesRedirect() {
  redirect('/workstreams?view=kanban');
}
