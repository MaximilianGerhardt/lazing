/**
 * GET /api/admin/rag-audit?limit=100&userId=...
 *
 * Liefert die letzten N (default 100, max 500) Cross-Workspace-RAG-Audit-Rows.
 *
 * Privacy/Auth-Gate:
 *   - requireSession (currentUserIdResolved). 401 ohne Session.
 *   - Caller MUSS in mindestens einer Org Rolle 'admin' oder 'founder'
 *     haben. 403 sonst.
 *
 * Response: { rows: [...], generatedAt }.
 *
 * Phase 2 Workspace-Isolation, 2026-05-03 (DSGVO Art. 30 VVT-Auskunft).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { desc, eq, sql } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { ragCrossWorkspaceAudit } from '@/db/schema/rag';
import { orgMemberships } from '@/db/schema/memberships';
import { currentUserIdResolved } from '@/lib/security/subject-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function isAdminOrFounder(userId: string): boolean {
  const db = getDb();
  const r = db
    .select({ n: sql<number>`COUNT(*)` })
    .from(orgMemberships)
    .where(
      sql`${orgMemberships.userId} = ${userId}
          AND ${orgMemberships.role} IN ('admin','founder')`,
    )
    .all();
  return Number(r[0]?.n ?? 0) > 0;
}

export async function GET(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json(
      { error: 'auth-required', hint: 'Bitte einloggen.' },
      { status: 401 },
    );
  }
  if (!isAdminOrFounder(userId)) {
    return NextResponse.json(
      {
        error: 'forbidden',
        hint: 'Rolle admin oder founder erforderlich (DSGVO Art. 30 VVT-Auskunft).',
      },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const rawLimit = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(1, Math.floor(rawLimit)), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const userFilter = url.searchParams.get('userId');

  const db = getDb();
  const baseQuery = db
    .select({
      id: ragCrossWorkspaceAudit.id,
      userId: ragCrossWorkspaceAudit.userId,
      query: ragCrossWorkspaceAudit.query,
      workspacesSeen: ragCrossWorkspaceAudit.workspacesSeen,
      hits: ragCrossWorkspaceAudit.hits,
      reason: ragCrossWorkspaceAudit.reason,
      createdAt: ragCrossWorkspaceAudit.createdAt,
    })
    .from(ragCrossWorkspaceAudit);

  const filtered = userFilter
    ? baseQuery.where(eq(ragCrossWorkspaceAudit.userId, userFilter))
    : baseQuery;

  const rows = filtered
    .orderBy(desc(ragCrossWorkspaceAudit.createdAt))
    .limit(limit)
    .all();

  // workspacesSeen ist im Schema TEXT (JSON-Array). Parsen, sonst kommt
  // der Caller mit String und muss selbst JSON.parse aufrufen.
  const decoded = rows.map((r) => ({
    ...r,
    workspacesSeen: safeParseArray(r.workspacesSeen),
  }));

  return NextResponse.json({
    rows: decoded,
    count: decoded.length,
    limit,
    generatedAt: Date.now(),
  });
}

function safeParseArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.map(String);
    return [];
  } catch {
    return [];
  }
}
