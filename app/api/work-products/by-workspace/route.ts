/**
 * GET /api/work-products/by-workspace?workspaceId=ID&limit=50
 *
 * Listet die letzten N Work-Products pro Workspace, gruppiert nach
 * Ticket-ID. Sub-Plan H2 (Work-Product-First-View).
 *
 * Privacy-Gate: high-sensitivity-Workspaces 403.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/db/client';
import { workProducts } from '@/db/schema/work_products';
import { events } from '@/db/schema/events';
import { eq, and, desc, ne, inArray } from 'drizzle-orm';
import { getWorkspace } from '@/lib/workspaces';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const url = req.nextUrl;
  const workspaceId = url.searchParams.get('workspaceId');
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? '50')));

  if (!workspaceId) {
    return NextResponse.json({ error: 'workspaceId required' }, { status: 400 });
  }

  const ws = await getWorkspace(workspaceId).catch(() => null);
  if (!ws) {
    return NextResponse.json({ error: 'workspace-not-found' }, { status: 404 });
  }
  if (ws.sensitivity === 'high') {
    return NextResponse.json({ error: 'high-sensitivity' }, { status: 403 });
  }

  const db = getDb();

  // 1. Tickets im Workspace finden (via events.entityType='ticket' segmentId=ws)
  const ticketRows = db
    .select({ entityId: events.entityId })
    .from(events)
    .where(
      and(
        eq(events.segmentId, workspaceId),
        eq(events.entityType, 'ticket'),
        eq(events.eventType, 'created'),
      ),
    )
    .orderBy(desc(events.createdAt))
    .limit(500)
    .all();

  const ticketIds = Array.from(new Set(ticketRows.map((r) => r.entityId).filter((id): id is string => !!id)));

  if (ticketIds.length === 0) {
    return NextResponse.json({ workspaceId, items: [], total: 0 });
  }

  // 2. Work-Products für diese Tickets
  const wpRows = db
    .select()
    .from(workProducts)
    .where(
      and(
        inArray(workProducts.ticketId, ticketIds),
        ne(workProducts.status, 'superseded'),
      ),
    )
    .orderBy(desc(workProducts.createdAt))
    .limit(limit)
    .all();

  return NextResponse.json({
    workspaceId,
    total: wpRows.length,
    items: wpRows.map((wp) => ({
      id: wp.id,
      ticketId: wp.ticketId,
      type: wp.type,
      title: wp.title,
      bytes: wp.bytes,
      status: wp.status,
      createdBy: wp.createdBy,
      createdAt: wp.createdAt,
      updatedAt: wp.updatedAt,
      preview: wp.type === 'markdown' ? String(wp.content).slice(0, 280) : null,
    })),
  });
}
