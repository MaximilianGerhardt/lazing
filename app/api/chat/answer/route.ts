/**
 * POST / GET `/api/chat/answer` — 2026-05-29 · Phase 1 Track AB · Befund B.
 *
 * ZWECK (verbatim aus Handoff §7+§8, N1):
 *   „Antworten auf Fragen werden zu einem Textblock 'Frage:.../Antwort:...'
 *    gebaut und als normaler Chat-Turn gesendet. Es ist unklar bzw.
 *    unwahrscheinlich, dass workstreamId, flowRunId, planId, questionSetId
 *    und questionId zuverlässig mitgesendet werden."
 *
 *   Akzeptanz:
 *     - Antwort persistiert als strukturierte Answer
 *     - Kann eindeutig zugeordnet werden
 *     - Re-Render nach Reload zeigt beantwortete Frage korrekt
 *     - Fortsetzung des FlowRuns nutzt die strukturierte Antwort.
 *
 * Owner-Direktive (verbatim, additiv-only):
 *   „Die lesbare Chat-Nachricht darf zusätzlich existieren. Die Ausführung
 *    darf aber nicht an dieser Chat-Nachricht hängen."
 *   → Dieser Endpoint ist die strukturierte Spur PARALLEL zum Chat-Turn,
 *     nicht statt ihm.
 *
 * ── POST ──────────────────────────────────────────────────────────────────
 *
 * Body (Envelope, verbatim Handoff §8):
 *   {
 *     "workspaceId":"...",    // PFLICHT
 *     "workstreamId":"...",   // optional
 *     "flowRunId":"...",      // optional
 *     "planId":"...",         // optional
 *     "questionSetId":"...",  // optional
 *     "questionId":"...",     // PFLICHT
 *     "answer":"...",         // PFLICHT (VERBATIM, N1 — kein .slice/.substring)
 *     "sourceTurnId":"...",   // PFLICHT (ChatShell-internal HistoryItem.id)
 *     "surfaceId":"..."       // optional
 *   }
 *
 * Subject-Gate (kopiert aus app/api/chat/open-questions/dismiss/route.ts):
 *   - Auth 401 ohne userId.
 *   - 400 bei kaputtem JSON.
 *   - 200 + ok=false bei missing Pflicht (workspaceId/questionId/answer/sourceTurnId).
 *   - 200 + ok=false bei forbidden-Workspace-Permission (kein Schreiben).
 *   - 200 + ok=true + answerId bei Erfolg.
 *   - 200 + ok=true + duplicate=true bei zweitem identischem Post (Idempotenz).
 *   - 200 + ok=false bei DB-Throw (fail-soft, nie 500 — UI darf nicht hängen).
 *
 * Idempotenz (zwei UNIQUE-Indizes in Migration 0117):
 *   - UNIQUE(content_hash) — N10-Tamper-Evidence, kanonische Envelope-sha256.
 *   - UNIQUE(source_turn_id, question_id) — defense-in-depth gegen Client-Bugs.
 *   INSERT OR IGNORE schlägt den zweiten Post still nieder; wir lesen anschließend
 *   die vorhandene Row und liefern `duplicate=true`.
 *
 * Fortsetzungs-Hint (workstream-Continuation):
 *   Bei erfolgreichem Insert UND vorhandenem workstreamId: best-effort
 *   `writeDecision` mit decision_kind='override' und rationale, der die
 *   Frage-ID + getrimmten Frage-Text-Hinweis hält (analog dismiss-route).
 *   Das macht die Antwort N8-spurbar; falls writeDecision wirft, wird das
 *   ignoriert (Audit-Bonus, nicht User-Pflicht).
 *
 * ── GET ───────────────────────────────────────────────────────────────────
 *
 * Query: `?wsId=<workspaceId>&qid=<questionId>` — beide Pflicht.
 *
 * Antwort:
 *   200 { ok: true, answered: boolean, answer?: string, answeredAt?: number,
 *          workstreamId?: string|null }
 *   401 ohne userId.
 *   200 + ok=false bei fehlenden Query-Params oder forbidden.
 *
 * Wird vom ChatShell-Hydration-Pfad genutzt: beim Laden der Open-Questions-Pill
 * für einen Workspace check ob es schon eine strukturierte Antwort gibt →
 * wenn ja, Pill-Item als „beantwortet" markieren statt offen.
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

/** Optional-Feld → trim oder null. */
function optTrimmed(v: unknown): string | null {
  const s = asNonEmptyString(v);
  return s;
}

/**
 * VERBATIM (N1) — der Antwort-Text darf NICHT getrimmt oder gekürzt werden.
 * Nur die String-Identität wird verlangt.
 */
function answerString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Kanonische sha256 über das Envelope — Reihenfolge der Felder fixiert für
 * Tamper-Evidence (N10) und reproduzierbare Idempotenz.
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
  // Stable JSON: keys in fixierter Reihenfolge.
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
// POST — strukturierte Answer persistieren
// ===========================================================================

export async function POST(req: NextRequest): Promise<Response> {
  // 1. Auth-Gate. Ohne user keine strukturierte Spur sinnvoll.
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  // 2. Body-Parsing.
  let body: AnswerBody;
  try {
    body = (await req.json()) as AnswerBody;
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  // 3. Validation. Pflicht: workspaceId, questionId, answer, sourceTurnId.
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

  // 4. Optionals — fail-soft auf null bei missing.
  const workstreamId = optTrimmed(body.workstreamId);
  const flowRunId = optTrimmed(body.flowRunId);
  const planId = optTrimmed(body.planId);
  const questionSetId = optTrimmed(body.questionSetId);
  const surfaceId = optTrimmed(body.surfaceId);

  // 5. Permission-Gate. Strukturierte Antwort = Workspace-Inhalt.
  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, workspaceId))) {
    return NextResponse.json(
      { ok: false, reason: "forbidden" },
      { status: 200 },
    );
  }

  // 6. Envelope-Hash für Idempotenz + N10.
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

  // 7. INSERT OR IGNORE — idempotent via beide UNIQUE-Indizes
  //    (content_hash + (source_turn_id, question_id)). Bei Konflikt lesen wir
  //    die existierende Row und antworten duplicate=true.
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
      // Duplikat — bereits vorhanden (gleicher content_hash ODER gleiches
      // (source_turn_id, question_id)). Existierende Row zurückgeben.
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

    // 8. Fortsetzungs-Hint (best-effort, fail-soft) — schreibt eine
    //    workstream_decisions-Row, damit der Workstream-Trace die
    //    strukturierte Antwort als N8-Evidence führt. Nur wenn ein
    //    Workstream gebunden ist.
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
        // Fail-soft — Audit ist Bonus.
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
// GET — Hydration: ist eine konkrete Frage in einem Workspace schon beantwortet?
// ===========================================================================

export async function GET(req: NextRequest): Promise<Response> {
  // Auth-Gate.
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

  // Permission-Gate (lesend, aber wir liefern strukturierte Daten nur an
  // berechtigte User; forbidden → answered=false + reason).
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
