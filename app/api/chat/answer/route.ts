/**
 * POST / GET `/api/chat/answer` — 2026-05-29 · Phase 1 Track AB · Befund B.
 *
 * PURPOSE (verbatim from handoff §7+§8, N1):
 *   „Antworten auf Fragen werden zu einem Textblock 'Frage:.../Antwort:...'
 *    gebaut und als normaler Chat-Turn gesendet. Es ist unklar bzw.
 *    unwahrscheinlich, dass workstreamId, flowRunId, planId, questionSetId
 *    und questionId zuverlässig mitgesendet werden."
 *
 *   Acceptance:
 *     - the answer is persisted as a structured answer
 *     - it can be uniquely associated
 *     - re-render after reload shows the answered question correctly
 *     - continuation of the FlowRun uses the structured answer.
 *
 * Owner directive (verbatim, additive-only):
 *   „Die lesbare Chat-Nachricht darf zusätzlich existieren. Die Ausführung
 *    darf aber nicht an dieser Chat-Nachricht hängen."
 *   → This endpoint is the structured trace PARALLEL to the chat turn,
 *     not instead of it.
 *
 * ── POST ──────────────────────────────────────────────────────────────────
 *
 * Body (envelope, verbatim handoff §8):
 *   {
 *     "workspaceId":"...",    // REQUIRED
 *     "workstreamId":"...",   // optional
 *     "flowRunId":"...",      // optional
 *     "planId":"...",         // optional
 *     "questionSetId":"...",  // optional
 *     "questionId":"...",     // REQUIRED
 *     "answer":"...",         // REQUIRED (VERBATIM, N1 — no .slice/.substring)
 *     "sourceTurnId":"...",   // REQUIRED (ChatShell-internal HistoryItem.id)
 *     "surfaceId":"..."       // optional
 *   }
 *
 * Subject gate (copied from app/api/chat/open-questions/dismiss/route.ts):
 *   - Auth 401 without userId.
 *   - 400 on broken JSON.
 *   - 200 + ok=false on missing required field (workspaceId/questionId/answer/sourceTurnId).
 *   - 200 + ok=false on forbidden workspace permission (no write).
 *   - 200 + ok=true + answerId on success.
 *   - 200 + ok=true + duplicate=true on a second identical post (idempotency).
 *   - 200 + ok=false on DB throw (fail-soft, never 500 — the UI must not hang).
 *
 * Idempotency (two UNIQUE indexes in migration 0117):
 *   - UNIQUE(content_hash) — N10 tamper-evidence, canonical envelope sha256.
 *   - UNIQUE(source_turn_id, question_id) — defense-in-depth against client bugs.
 *   INSERT OR IGNORE silently swallows the second post; we then read
 *   the existing row and return `duplicate=true`.
 *
 * Continuation hint (workstream continuation):
 *   On a successful insert AND a present workstreamId: best-effort
 *   `writeDecision` with decision_kind='override' and a rationale that holds
 *   the question ID + a trimmed question-text hint (analogous to the dismiss route).
 *   This makes the answer N8-traceable; if writeDecision throws, it is
 *   ignored (audit bonus, not a user obligation).
 *
 * ── GET ───────────────────────────────────────────────────────────────────
 *
 * Query: `?wsId=<workspaceId>&qid=<questionId>` — both required.
 *
 * Response:
 *   200 { ok: true, answered: boolean, answer?: string, answeredAt?: number,
 *          workstreamId?: string|null }
 *   401 without userId.
 *   200 + ok=false on missing query params or forbidden.
 *
 * Used by the ChatShell hydration path: when loading the open-questions pill
 * for a workspace, check whether a structured answer already exists →
 * if so, mark the pill item as „beantwortet" instead of open.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createHash, randomUUID } from "node:crypto";

import { getDb } from "@/db/client";
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from "@/lib/security/permissions";
import { currentUserIdResolved } from "@/lib/security/subject-server";
import { writeDecision } from "@/lib/workstreams/trace-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AnswerBody {
  workspaceId?: unknown;
  workstreamId?: unknown;
  flowRunId?: unknown;
  planId?: unknown;
  questionSetId?: unknown;
  questionId?: unknown;
  answer?: unknown;
  sourceTurnId?: unknown;
  surfaceId?: unknown;
}

interface AnswerRow {
  id: string;
  workspace_id: string;
  workstream_id: string | null;
  flow_run_id: string | null;
  plan_id: string | null;
  question_set_id: string | null;
  question_id: string;
  answer: string;
  source_turn_id: string;
  surface_id: string | null;
  created_at: number;
  content_hash: string;
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/** Optional field → trim or null. */
function optTrimmed(v: unknown): string | null {
  const s = asNonEmptyString(v);
  return s;
}

/**
 * VERBATIM (N1) — the answer text must NOT be trimmed or shortened.
 * Only the string identity is required.
 */
function answerString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Canonical sha256 over the envelope — field order fixed for
 * tamper-evidence (N10) and reproducible idempotency.
 */
function computeContentHash(env: {
  workspaceId: string;
  workstreamId: string | null;
  flowRunId: string | null;
  planId: string | null;
  questionSetId: string | null;
  questionId: string;
  answer: string;
  sourceTurnId: string;
  surfaceId: string | null;
}): string {
  // Stable JSON: keys in fixed order.
  const canonical = JSON.stringify({
    workspaceId: env.workspaceId,
    workstreamId: env.workstreamId,
    flowRunId: env.flowRunId,
    planId: env.planId,
    questionSetId: env.questionSetId,
    questionId: env.questionId,
    answer: env.answer,
    sourceTurnId: env.sourceTurnId,
    surfaceId: env.surfaceId,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

// ===========================================================================
// POST — persist a structured answer
// ===========================================================================

export async function POST(req: NextRequest): Promise<Response> {
  // 1. Auth gate. Without a user there is no point in a structured trace.
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  // 2. Body parsing.
  let body: AnswerBody;
  try {
    body = (await req.json()) as AnswerBody;
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  // 3. Validation. Required: workspaceId, questionId, answer, sourceTurnId.
  const workspaceId = asNonEmptyString(body.workspaceId);
  const questionId = asNonEmptyString(body.questionId);
  const answer = answerString(body.answer);
  const sourceTurnId = asNonEmptyString(body.sourceTurnId);

  if (!workspaceId) {
    return NextResponse.json(
      { ok: false, reason: "missing-workspaceId" },
      { status: 200 },
    );
  }
  if (!questionId) {
    return NextResponse.json(
      { ok: false, reason: "missing-questionId" },
      { status: 200 },
    );
  }
  if (!answer) {
    return NextResponse.json(
      { ok: false, reason: "missing-answer" },
      { status: 200 },
    );
  }
  if (!sourceTurnId) {
    return NextResponse.json(
      { ok: false, reason: "missing-sourceTurnId" },
      { status: 200 },
    );
  }

  // 4. Optionals — fail-soft to null when missing.
  const workstreamId = optTrimmed(body.workstreamId);
  const flowRunId = optTrimmed(body.flowRunId);
  const planId = optTrimmed(body.planId);
  const questionSetId = optTrimmed(body.questionSetId);
  const surfaceId = optTrimmed(body.surfaceId);

  // 5. Permission gate. A structured answer = workspace content.
  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, workspaceId))) {
    return NextResponse.json(
      { ok: false, reason: "forbidden" },
      { status: 200 },
    );
  }

  // 6. Envelope hash for idempotency + N10.
  const contentHash = computeContentHash({
    workspaceId,
    workstreamId,
    flowRunId,
    planId,
    questionSetId,
    questionId,
    answer,
    sourceTurnId,
    surfaceId,
  });

  // 7. INSERT OR IGNORE — idempotent via both UNIQUE indexes
  //    (content_hash + (source_turn_id, question_id)). On conflict we read
  //    the existing row and respond duplicate=true.
  const db = getDb();
  const id = `qa_${randomUUID()}`;
  const createdAt = Date.now();

  try {
    const ins = db.$raw
      .prepare(
        `INSERT OR IGNORE INTO question_answers
           (id, workspace_id, workstream_id, flow_run_id, plan_id,
            question_set_id, question_id, answer, source_turn_id,
            surface_id, created_at, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        workstreamId,
        flowRunId,
        planId,
        questionSetId,
        questionId,
        answer,
        sourceTurnId,
        surfaceId,
        createdAt,
        contentHash,
      );

    if (ins.changes === 0) {
      // Duplicate — already present (same content_hash OR same
      // (source_turn_id, question_id)). Return the existing row.
      const existing = db.$raw
        .prepare(
          `SELECT id FROM question_answers
             WHERE content_hash = ?
                OR (source_turn_id = ? AND question_id = ?)
             LIMIT 1`,
        )
        .get(contentHash, sourceTurnId, questionId) as
        | { id: string }
        | undefined;
      return NextResponse.json({
        ok: true,
        answerId: existing?.id ?? null,
        duplicate: true,
      });
    }

    // 8. Continuation hint (best-effort, fail-soft) — writes a
    //    workstream_decisions row so the workstream trace carries the
    //    structured answer as N8 evidence. Only when a
    //    workstream is bound.
    if (workstreamId) {
      try {
        writeDecision({
          workspaceId,
          workstreamId,
          coordKey: `${workspaceId}/${workstreamId}`,
          decisionKind: "override",
          rationale: [
            `User hat die offene Frage „${questionId}" strukturiert beantwortet (chat_answer_received).`,
            `answerId=${id}`,
            sourceTurnId ? `sourceTurnId=${sourceTurnId}` : null,
            flowRunId ? `flowRunId=${flowRunId}` : null,
            planId ? `planId=${planId}` : null,
            questionSetId ? `questionSetId=${questionSetId}` : null,
          ]
            .filter((s): s is string => Boolean(s))
            .join(" "),
          actor: "user",
        });
      } catch (err) {
        // Fail-soft — the audit is a bonus.
        console.warn(
          "[chat/answer] writeDecision threw (non-fatal):",
          err,
        );
      }
    }

    return NextResponse.json({
      ok: true,
      answerId: id,
      duplicate: false,
    });
  } catch (err) {
    console.warn("[chat/answer] INSERT threw (non-fatal):", err);
    return NextResponse.json(
      { ok: false, reason: "write-failed" },
      { status: 200 },
    );
  }
}

// ===========================================================================
// GET — hydration: is a specific question in a workspace already answered?
// ===========================================================================

export async function GET(req: NextRequest): Promise<Response> {
  // Auth gate.
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const wsId = asNonEmptyString(searchParams.get("wsId"));
  const qid = asNonEmptyString(searchParams.get("qid"));
  if (!wsId) {
    return NextResponse.json(
      { ok: false, reason: "missing-wsId", answered: false },
      { status: 200 },
    );
  }
  if (!qid) {
    return NextResponse.json(
      { ok: false, reason: "missing-qid", answered: false },
      { status: 200 },
    );
  }

  // Permission gate (read, but we only return structured data to
  // authorized users; forbidden → answered=false + reason).
  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, wsId))) {
    return NextResponse.json(
      { ok: false, reason: "forbidden", answered: false },
      { status: 200 },
    );
  }

  const db = getDb();
  try {
    const row = db.$raw
      .prepare(
        `SELECT id, workspace_id, workstream_id, flow_run_id, plan_id,
                question_set_id, question_id, answer, source_turn_id,
                surface_id, created_at, content_hash
           FROM question_answers
          WHERE workspace_id = ? AND question_id = ?
          ORDER BY created_at DESC
          LIMIT 1`,
      )
      .get(wsId, qid) as AnswerRow | undefined;

    if (!row) {
      return NextResponse.json({ ok: true, answered: false });
    }
    return NextResponse.json({
      ok: true,
      answered: true,
      answerId: row.id,
      answer: row.answer,
      answeredAt: row.created_at,
      workstreamId: row.workstream_id,
      flowRunId: row.flow_run_id,
      planId: row.plan_id,
      questionSetId: row.question_set_id,
      sourceTurnId: row.source_turn_id,
      surfaceId: row.surface_id,
    });
  } catch (err) {
    console.warn("[chat/answer] SELECT threw (non-fatal):", err);
    return NextResponse.json(
      { ok: false, reason: "read-failed", answered: false },
      { status: 200 },
    );
  }
}
