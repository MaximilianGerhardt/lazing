/**
 * POST /api/intake — Lane-A communication intake made reachable
 * (Lane-D · 2026-05-30 · Opus 4.8).
 *
 * Lane-A ingestion via API — NO webhook, NO auto-run (§7.2: „Imported
 * context must not auto-run."). Every POST is an explicit owner call that
 * creates ONE intake_events row in the FSM start state `staged` (= received).
 * Nothing runs on automatically afterwards (Lane-B compile is the SEPARATE,
 * owner-triggered action at /api/lanes/compile).
 *
 * ── CONTRACT ──────────────────────────────────────────────────────────────
 *   POST { workspaceId: string, sourceKind: DataSource, rawContent: string,
 *          speaker?: string,
 *          // optional §7.3 step-2 fields (defaults set):
 *          sensitivity?, rawContentType?, externalId?, receivedAt? }
 *   → member auth (401 → 403 like compose-and-run)
 *   → buildSourceEnvelope(...) (pure, deterministic, N10 hash)
 *   → insertIntakeEvent(db.$raw, envelope)  (FSM=staged, no auto-run)
 *   → 200 { intakeEventId, deduplicated, contentHash, classificationStatus }
 *
 * N1: rawContent is written VERBATIM (no slice) into the envelope and into the
 * row.
 * Idempotency (N10): same content in the same workspace → same row
 * back (deduplicated=true), no double insert.
 *
 * Error mapping: invalid vocabulary / missing required fields are thrown by the
 * pure builder → we map to 400 with reqId (instead of 500).
 *
 * Which chat/client gesture calls this later (NOT in this scope): a
 * „Context Intake" surface in chat (owner pastes/forwards WhatsApp/meeting/
 * voice text) or a future connector hitting the same route —
 * but ALWAYS owner-confirmed, never as a silent webhook auto-run.
 *
 * Auth pattern 1:1 like app/api/flow/compose-and-run/route.ts. NO engine needed
 * (Lane A is deterministic, no LLM). ADDITIVE: no core flow file
 * touched, no next build/start.
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

  // 1. Auth gate (member-or-higher).
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: 'auth-required', reqId }, { status: 401 });
  }

  // 2. Parse body.
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
  // N1: rawContent VERBATIM (no slice). Only empty/type validation is trimmed.
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

  // 3. Workspace permission (member-or-higher; viewer/foreign user → 403).
  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, workspaceId))) {
    return NextResponse.json({ error: 'forbidden', reqId }, { status: 403 });
  }

  // 4. §7.3 step-2 fields with safe defaults (foreign vocabulary → 400).
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
  // externalId: from the caller (e.g. whatsapp message id) or locally generated,
  // so the idempotency/hash layer has an identity.
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

  // 5. Build envelope (pure, N10 hash) + persist (FSM=staged, no
  //    auto-run). buildSourceEnvelope throws on invalid vocabulary →
  //    map fail-soft to 400.
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
