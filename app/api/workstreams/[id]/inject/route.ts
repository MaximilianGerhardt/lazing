/**
 * POST /api/workstreams/[id]/inject  { message: string }
 *
 * Sniper-Hook (2026-04-28). Während ein Workstream läuft, kann der User
 * eine Mid-Course-Correction reinwerfen. Wir hängen sie als Comment ans
 * Master-Ticket mit `kind='user-correction'`. Folgende Lead-Spawns lesen
 * den Thread und integrieren die Korrektur in ihre nächste Iteration.
 *
 * Bewusst minimal: kein Pause-Mechanism für laufende Spawns. Wenn V1+Roast
 * gerade fliegen, korrigiert die nächste V2-Iteration. Synchrone Pause
 * kommt in einer zweiten Welle.
 *
 * Auth: User muss eingeloggt sein UND mind. member im Workspace des
 * Workstreams.
 */

import { NextResponse, type NextRequest } from "next/server";

import { getDb } from "@/db/client";
import { emitEvent } from "@/lib/events/emit";
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from "@/lib/security/permissions";
import { currentUserIdResolved } from "@/lib/security/subject-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PostBody {
  message?: string;
  /**
   * Phase RA (2026-04-29): optional Sub-Ticket-ID. Wenn gesetzt, wird das
   * user-correction-Event am Sub-Ticket emittiert (statt Master-Ticket) —
   * damit kann der User mid-flight in einer Sub-Plan-Sniper-Loop oder
   * Cross-Roast-Phase eingreifen.
   */
  subTicketId?: string;
}

interface WorkstreamRow {
  id: string;
  workspace_id: string;
  primary_ticket_id: string | null;
  status: string;
  name: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: workstreamId } = await params;

  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const message = body.message?.trim();
  if (!message || message.length < 2) {
    return NextResponse.json(
      { error: "missing-message", hint: "message muss ≥2 Zeichen sein" },
      { status: 400 },
    );
  }
  if (message.length > 4000) {
    return NextResponse.json(
      { error: "message-too-long", hint: "max 4000 Zeichen" },
      { status: 400 },
    );
  }

  const db = getDb();
  const ws = db.$raw
    .prepare(
      "SELECT id, workspace_id, primary_ticket_id, status, name FROM workstreams WHERE id = ?",
    )
    .get(workstreamId) as WorkstreamRow | undefined;
  if (!ws) {
    return NextResponse.json(
      { error: "not-found", hint: "Workstream existiert nicht" },
      { status: 404 },
    );
  }

  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, ws.workspace_id))) {
    return NextResponse.json(
      { error: "forbidden", hint: "Du musst mind. Member im Workspace sein." },
      { status: 403 },
    );
  }

  if (!ws.primary_ticket_id) {
    return NextResponse.json(
      {
        error: "no-master-ticket",
        hint: "Workstream hat kein primary_ticket_id — Korrektur kann nicht angehängt werden.",
      },
      { status: 409 },
    );
  }

  // Phase RA: Wenn subTicketId mitkommt + Sub gehört zum Master, emittiere
  // an das Sub-Ticket. Sonst Master.
  let targetTicketId = ws.primary_ticket_id;
  const requestedSubId = body.subTicketId?.trim();
  if (requestedSubId) {
    const subRow = db.$raw
      .prepare(
        `SELECT id FROM tickets WHERE id = ? AND parent_ticket_id = ?`,
      )
      .get(requestedSubId, ws.primary_ticket_id) as { id?: string } | undefined;
    if (!subRow?.id) {
      return NextResponse.json(
        { error: 'invalid-sub-ticket', hint: 'subTicketId gehört nicht zu diesem Workstream-Master.' },
        { status: 400 },
      );
    }
    targetTicketId = subRow.id;
  }

  // Comment-Event mit kind='user-correction' damit folgende Lead-Spawns
  // es im Thread erkennen.
  const ev = await emitEvent({
    segmentId: ws.workspace_id,
    entityType: "ticket",
    entityId: targetTicketId,
    eventType: "commented",
    actor: `user:${userId}`,
    payload: {
      kind: "user-correction",
      workstreamId,
      message,
      subTicketId: targetTicketId !== ws.primary_ticket_id ? targetTicketId : undefined,
      injectedAt: new Date().toISOString(),
    },
    sensitivity: "low",
  }).catch((err) => {
    console.warn("[inject] emit failed:", err);
    return null;
  });

  return NextResponse.json({
    ok: true,
    workstreamId,
    masterTicketId: ws.primary_ticket_id,
    targetTicketId,
    eventId: ev?.id ?? null,
    status: ws.status,
    name: ws.name,
  });
}
