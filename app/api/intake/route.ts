/**
 * POST /api/intake — Lane-A Communication-Intake erreichbar gemacht
 * (Lane-D · 2026-05-30 · Opus 4.8).
 *
 * Lane-A-Ingestion per API — KEIN Webhook, KEIN auto-run (§7.2: „Imported
 * context must not auto-run."). Jeder POST ist ein expliziter Owner-Aufruf, der
 * EINE intake_events-Row im FSM-Startzustand `staged` (= received) anlegt.
 * Nichts läuft danach automatisch weiter (Lane-B-Compile ist die SEPARATE,
 * owner-getriggerte Aktion an /api/lanes/compile).
 *
 * ── VERTRAG ───────────────────────────────────────────────────────────────
 *   POST { workspaceId: string, sourceKind: DataSource, rawContent: string,
 *          speaker?: string,
 *          // optionale §7.3-Schritt-2-Felder (Defaults gesetzt):
 *          sensitivity?, rawContentType?, externalId?, receivedAt? }
 *   → member-auth (401 → 403 wie compose-and-run)
 *   → buildSourceEnvelope(...) (pure, deterministisch, N10-Hash)
 *   → insertIntakeEvent(db.$raw, envelope)  (FSM=staged, kein auto-run)
 *   → 200 { intakeEventId, deduplicated, contentHash, classificationStatus }
 *
 * N1: rawContent wird VERBATIM (kein slice) ins Envelope und in die Row
 * geschrieben.
 * Idempotenz (N10): gleicher Inhalt im selben Workspace → dieselbe Row
 * zurück (deduplicated=true), kein Doppel-Insert.
 *
 * Fehlerabbildung: ungültiges Vokabular / fehlende Pflichtfelder werden vom
 * pure builder geworfen → wir mappen auf 400 mit reqId (statt 500).
 *
 * Welche Chat-/Client-Geste das später aufruft (NICHT in diesem Scope): eine
 * „Context Intake"-Surface im Chat (Owner pastet/leitet WhatsApp-/Meeting-/
 * Voice-Text weiter) bzw. ein künftiger Connector, der dieselbe Route trifft —
 * aber IMMER owner-bestätigt, nie als stiller Webhook-Auto-Run.
 *
 * Auth-Muster 1:1 wie app/api/flow/compose-and-run/route.ts. KEINE Engine nötig
 * (Lane A ist deterministisch, kein LLM). ADDITIV: keine Kern-Flow-Datei
 * berührt, kein next build/start.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getDb } from '@/db/client';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
import { buildSourceEnvelope } from '@/lib/lanes/communication-intake/source-envelope';
import { insertIntakeEvent } from '@/lib/lanes/communication-intake/intake-writer';
import {
  DATA_SOURCES,
  INTAKE_SENSITIVITIES,
  RAW_CONTENT_TYPES,
  type DataSource,
  type IntakeSensitivity,
  type RawContentType,
} from '@/lib/lanes/communication-intake/types';
import { ulid } from '@/lib/ulid';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function makeReqId(): string {
  return `ink_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isValidWorkspaceId(id: string): boolean {
  return /^[a-z0-9_(][a-z0-9_()-]{0,63}$/i.test(id);
}

const DATA_SOURCE_SET = new Set<string>(DATA_SOURCES);
const SENSITIVITY_SET = new Set<string>(INTAKE_SENSITIVITIES);
const RAW_CONTENT_TYPE_SET = new Set<string>(RAW_CONTENT_TYPES);

interface PostBody {
  workspaceId?: unknown;
  sourceKind?: unknown;
  rawContent?: unknown;
  speaker?: unknown;
  sensitivity?: unknown;
  rawContentType?: unknown;
  externalId?: unknown;
  receivedAt?: unknown;
}

export async function POST(req: NextRequest): Promise<Response> {
  const reqId = makeReqId();

  // 1. Auth-Gate (member-or-higher).
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: 'auth-required', reqId }, { status: 401 });
  }

  // 2. Body parsen.
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json', reqId }, { status: 400 });
  }

  const workspaceId =
    typeof body.workspaceId === 'string' ? body.workspaceId : '';
  const sourceKind =
    typeof body.sourceKind === 'string' ? body.sourceKind : '';
  // N1: rawContent VERBATIM (kein slice). Nur Leer-/Typ-Validierung getrimmt.
  const rawContent =
    typeof body.rawContent === 'string' ? body.rawContent : '';
  const speaker =
    typeof body.speaker === 'string' && body.speaker.length > 0
      ? body.speaker
      : undefined;

  if (!isValidWorkspaceId(workspaceId)) {
    return NextResponse.json(
      { error: 'invalid_workspace_id', reqId },
      { status: 400 },
    );
  }
  if (!DATA_SOURCE_SET.has(sourceKind)) {
    return NextResponse.json(
      {
        error: 'invalid_source_kind',
        hint: `sourceKind ∈ ${DATA_SOURCES.join(' | ')}`,
        reqId,
      },
      { status: 400 },
    );
  }
  if (rawContent.trim().length === 0) {
    return NextResponse.json(
      { error: 'invalid_raw_content', hint: 'rawContent Pflicht', reqId },
      { status: 400 },
    );
  }

  // 3. Workspace-Permission (member-or-higher; Viewer/fremde User → 403).
  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, workspaceId))) {
    return NextResponse.json({ error: 'forbidden', reqId }, { status: 403 });
  }

  // 4. §7.3-Schritt-2-Felder mit sicheren Defaults (fremdes Vokabular → 400).
  const sensitivity: IntakeSensitivity = SENSITIVITY_SET.has(
    String(body.sensitivity),
  )
    ? (body.sensitivity as IntakeSensitivity)
    : 'internal';
  if (
    body.sensitivity !== undefined &&
    !SENSITIVITY_SET.has(String(body.sensitivity))
  ) {
    return NextResponse.json(
      {
        error: 'invalid_sensitivity',
        hint: `sensitivity ∈ ${INTAKE_SENSITIVITIES.join(' | ')}`,
        reqId,
      },
      { status: 400 },
    );
  }
  const rawContentType: RawContentType = RAW_CONTENT_TYPE_SET.has(
    String(body.rawContentType),
  )
    ? (body.rawContentType as RawContentType)
    : 'text';
  if (
    body.rawContentType !== undefined &&
    !RAW_CONTENT_TYPE_SET.has(String(body.rawContentType))
  ) {
    return NextResponse.json(
      {
        error: 'invalid_raw_content_type',
        hint: `rawContentType ∈ ${RAW_CONTENT_TYPES.join(' | ')}`,
        reqId,
      },
      { status: 400 },
    );
  }
  // externalId: vom Caller (z.B. whatsapp message id) oder lokal generiert,
  // damit die Idempotenz-/Hash-Schicht eine Identität hat.
  const externalId =
    typeof body.externalId === 'string' && body.externalId.length > 0
      ? body.externalId
      : `intake_${ulid()}`;
  const receivedAt =
    typeof body.receivedAt === 'number' &&
    Number.isFinite(body.receivedAt) &&
    body.receivedAt >= 0
      ? body.receivedAt
      : Date.now();

  // 5. Envelope bauen (pure, N10-Hash) + persistieren (FSM=staged, kein
  //    auto-run). buildSourceEnvelope wirft bei ungültigem Vokabular →
  //    fail-soft auf 400 mappen.
  try {
    const envelope = buildSourceEnvelope({
      externalId,
      dataSource: sourceKind as DataSource,
      ...(speaker ? { speakerExternalId: speaker } : {}),
      receivedAt,
      sensitivity,
      projectScope: workspaceId, // N9
      rawContent, // N1: verbatim
      rawContentType,
    });

    const { event, deduplicated } = insertIntakeEvent(getDb().$raw, envelope);

    return NextResponse.json(
      {
        reqId,
        intakeEventId: event.id,
        deduplicated,
        contentHash: event.contentHash,
        classificationStatus: event.classificationStatus,
      },
      { status: 200 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: 'intake_failed', message, reqId },
      { status: 400 },
    );
  }
}
