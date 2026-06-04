/**
 * lib/subchats/questions-service.ts — Question-Spinning, Slice 1.
 *
 * Design: docs/plans/2026-06-03_group-chat-question-spinning-design.md §6.
 *
 * Mutations- + Lese-Pfad für angespinnte Fragen in Sub-/Gruppen-Chats. Folgt dem
 * Stil von lib/subchats/service.ts (ULID-IDs, getDb(), best-effort Event + RAG).
 *
 * Disziplin:
 *   - N1: text/label/free_text VERBATIM (kein .slice auf Inhalt).
 *   - N2: Antwort-Ingestion strikt workspace-isoliert (indexSource).
 *   - N9: workspace_id auf jeder Row.
 *   - append-only: Antworten werden nie geändert; jüngste pro Teilnehmer gilt.
 *   - Realtime über die vorhandene emitEvent-Pipeline (subchat_question /
 *     subchat_question_answer), gefiltert auf payload.subchatId — wie subchat_message.
 *   - SELBST-ENTHALTEN: importiert NICHT aus service.ts (vermeidet Zyklus; service.ts
 *     importiert von HIER den Hauptchat-Kontext-Block).
 */

import { and, asc, desc, eq, inArray } from 'drizzle-orm';

import { getDb } from '@/db/client';
import {
  subchatQuestionAnswers,
  subchatQuestionOptions,
  subchatQuestions,
  type SubchatQuestionAnswerRow,
  type SubchatQuestionOptionRow,
  type SubchatQuestionRow,
} from '@/db/schema/subchat_questions';
import { ulid } from '@/lib/ulid';

export type ParticipantKind = 'internal' | 'external' | 'ai';

export interface SpinQuestionInput {
  subchatId: string;
  workspaceId: string;
  authorKind: ParticipantKind;
  authorId?: string | null;
  authorName?: string | null;
  /** N1 verbatim. */
  text: string;
  /** Optionale Antwort-Optionen (0..n). */
  options?: string[];
}

export interface QuestionWithOptions {
  question: SubchatQuestionRow;
  options: SubchatQuestionOptionRow[];
}

export interface QuestionView extends QuestionWithOptions {
  /** Alle Antworten (append-only Historie). */
  answers: SubchatQuestionAnswerRow[];
}

/** Nächste seq für einen Sub-Chat (monoton, „aufeinanderfolgend"). */
function nextSeq(subchatId: string): number {
  const db = getDb();
  const row = db
    .select({ seq: subchatQuestions.seq })
    .from(subchatQuestions)
    .where(eq(subchatQuestions.subchatId, subchatId))
    .orderBy(desc(subchatQuestions.seq))
    .limit(1)
    .all()[0];
  return (row?.seq ?? 0) + 1;
}

/** Eine Frage anspinnen (+ optionale Optionen). Emittiert Realtime-Event. */
export function spinQuestion(input: SpinQuestionInput): QuestionWithOptions {
  const db = getDb();
  const now = Date.now();
  const qId = `SCQ-${ulid(now)}`;
  const text = input.text.trim();

  db.insert(subchatQuestions)
    .values({
      id: qId,
      subchatId: input.subchatId,
      workspaceId: input.workspaceId,
      authorKind: input.authorKind,
      authorId: input.authorId ?? null,
      authorName: input.authorName?.slice(0, 80) ?? null,
      text, // N1 verbatim (nur außen getrimmt)
      seq: nextSeq(input.subchatId),
      status: 'open',
      resolvedAt: null,
      resolvedBy: null,
      createdAt: now,
    })
    .run();

  const cleanOptions = (input.options ?? [])
    .map((o) => o.trim())
    .filter((o) => o.length > 0)
    .slice(0, 12);
  cleanOptions.forEach((label, i) => {
    db.insert(subchatQuestionOptions)
      .values({
        id: `SCO-${ulid(now + i + 1)}`,
        questionId: qId,
        subchatId: input.subchatId,
        workspaceId: input.workspaceId,
        label, // N1 verbatim
        addedByKind: input.authorKind,
        addedById: input.authorId ?? null,
        seq: i,
        createdAt: now,
      })
      .run();
  });

  const question = db
    .select()
    .from(subchatQuestions)
    .where(eq(subchatQuestions.id, qId))
    .limit(1)
    .all()[0]!;
  const options = db
    .select()
    .from(subchatQuestionOptions)
    .where(eq(subchatQuestionOptions.questionId, qId))
    .orderBy(asc(subchatQuestionOptions.seq))
    .all();

  void emitQuestionEvent('subchat_question', {
    subchatId: input.subchatId,
    workspaceId: input.workspaceId,
    questionId: qId,
    authorKind: input.authorKind,
    preview: text.slice(0, 120),
  });

  return { question, options };
}

export interface AnswerQuestionInput {
  questionId: string;
  subchatId: string;
  workspaceId: string;
  answererKind: ParticipantKind;
  answererId?: string | null;
  answererName?: string | null;
  /** Genau EINES setzen: */
  optionId?: string | null;
  freeText?: string | null;
}

/** Eine Frage beantworten (Option ODER Freitext). Ingestet in RAG (N2). */
export function answerQuestion(input: AnswerQuestionInput): SubchatQuestionAnswerRow {
  const db = getDb();
  const now = Date.now();
  const aId = `SCA-${ulid(now)}`;
  const freeText = input.freeText?.trim() || null;
  const optionId = input.optionId || null;

  db.insert(subchatQuestionAnswers)
    .values({
      id: aId,
      questionId: input.questionId,
      subchatId: input.subchatId,
      workspaceId: input.workspaceId,
      answererKind: input.answererKind,
      answererId: input.answererId ?? null,
      answererName: input.answererName?.slice(0, 80) ?? null,
      optionId,
      freeText, // N1 verbatim
      ingested: 0,
      createdAt: now,
    })
    .run();

  const row = db
    .select()
    .from(subchatQuestionAnswers)
    .where(eq(subchatQuestionAnswers.id, aId))
    .limit(1)
    .all()[0]!;

  void emitQuestionEvent('subchat_question_answer', {
    subchatId: input.subchatId,
    workspaceId: input.workspaceId,
    questionId: input.questionId,
    answererKind: input.answererKind,
  });
  // Wissen in die Workspace-RAG (fire-and-forget, N2).
  void ingestAnswer(row).catch(() => undefined);
  return row;
}

/** Frage explizit auf 'resolved' setzen (oder via 'auto:stale'). */
export function resolveQuestion(questionId: string, resolvedBy: string): void {
  const db = getDb();
  db.update(subchatQuestions)
    .set({ status: 'resolved', resolvedAt: Date.now(), resolvedBy })
    .where(eq(subchatQuestions.id, questionId))
    .run();
}

/** Offene Fragen eines Sub-Chats in seq-Reihenfolge (für die Pille). */
export function listOpenQuestions(subchatId: string): QuestionWithOptions[] {
  const db = getDb();
  const questions = db
    .select()
    .from(subchatQuestions)
    .where(and(eq(subchatQuestions.subchatId, subchatId), eq(subchatQuestions.status, 'open')))
    .orderBy(asc(subchatQuestions.seq))
    .all();
  return attachOptions(questions);
}

/** Alle Fragen (offen + resolved) mit Optionen + Antworten — für den GET-Endpoint. */
export function listQuestionViews(subchatId: string, limit = 50): QuestionView[] {
  const db = getDb();
  const questions = db
    .select()
    .from(subchatQuestions)
    .where(eq(subchatQuestions.subchatId, subchatId))
    .orderBy(asc(subchatQuestions.seq))
    .limit(limit)
    .all();
  if (questions.length === 0) return [];
  const ids = questions.map((q) => q.id);
  const options = db
    .select()
    .from(subchatQuestionOptions)
    .where(inArray(subchatQuestionOptions.questionId, ids))
    .orderBy(asc(subchatQuestionOptions.seq))
    .all();
  const answers = db
    .select()
    .from(subchatQuestionAnswers)
    .where(inArray(subchatQuestionAnswers.questionId, ids))
    .orderBy(asc(subchatQuestionAnswers.createdAt))
    .all();
  return questions.map((q) => ({
    question: q,
    options: options.filter((o) => o.questionId === q.id),
    answers: answers.filter((a) => a.questionId === q.id),
  }));
}

function attachOptions(questions: SubchatQuestionRow[]): QuestionWithOptions[] {
  if (questions.length === 0) return [];
  const db = getDb();
  const ids = questions.map((q) => q.id);
  const options = db
    .select()
    .from(subchatQuestionOptions)
    .where(inArray(subchatQuestionOptions.questionId, ids))
    .orderBy(asc(subchatQuestionOptions.seq))
    .all();
  return questions.map((q) => ({
    question: q,
    options: options.filter((o) => o.questionId === q.id),
  }));
}

/** RAG-Ingestion einer Antwort (workspace-isoliert, N2). */
export async function ingestAnswer(row: SubchatQuestionAnswerRow): Promise<void> {
  const db = getDb();
  const q = db
    .select()
    .from(subchatQuestions)
    .where(eq(subchatQuestions.id, row.questionId))
    .limit(1)
    .all()[0];
  if (!q) return;
  let answerText = row.freeText ?? '';
  if (!answerText && row.optionId) {
    const opt = db
      .select()
      .from(subchatQuestionOptions)
      .where(eq(subchatQuestionOptions.id, row.optionId))
      .limit(1)
      .all()[0];
    answerText = opt?.label ?? '';
  }
  if (answerText.trim().length === 0) return;
  const who = row.answererName || (row.answererKind === 'external' ? 'Kunde' : row.answererKind === 'ai' ? 'Assistent' : 'Team');
  try {
    const { indexSource } = await import('@/lib/rag/indexer');
    await indexSource({
      workspaceId: row.workspaceId,
      sourceType: 'subchat',
      sourceId: row.id,
      text: `[Sub-Chat Q&A] Frage: ${q.text.trim()} — Antwort (${who}): ${answerText.trim()}`,
      sensitivity: 'low',
    });
    db.update(subchatQuestionAnswers)
      .set({ ingested: 1 })
      .where(eq(subchatQuestionAnswers.id, row.id))
      .run();
  } catch {
    /* non-fatal — Antwort bleibt persistiert, ingested bleibt 0 (Retry-fähig) */
  }
}

/** Self-Heal: zieht nicht-ingestete Antworten nach (analog reindexUningestedSubchats). */
export async function reindexUningestedAnswers(limit = 50): Promise<number> {
  const db = getDb();
  const rows = db
    .select()
    .from(subchatQuestionAnswers)
    .where(eq(subchatQuestionAnswers.ingested, 0))
    .orderBy(asc(subchatQuestionAnswers.createdAt))
    .limit(limit)
    .all();
  let n = 0;
  for (const r of rows) {
    await ingestAnswer(r);
    n += 1;
  }
  return n;
}

/**
 * Hauptchat-Awareness: kompakter Block über OFFENE + jüngst beantwortete Fragen
 * aller Sub-Chats eines Workspaces. Wird von service.formatSubchatContextBlock
 * angehängt → der Hauptchat-Agent weiß immer, was im Kundenkanal gefragt/
 * beantwortet wurde (bewiesener Subchat→RAG→Hauptchat-Fluss). N2/N9.
 */
export function formatSubchatQuestionsContextBlock(
  workspaceId: string,
  limit = 8,
): string | null {
  const db = getDb();
  const open = db
    .select()
    .from(subchatQuestions)
    .where(and(eq(subchatQuestions.workspaceId, workspaceId), eq(subchatQuestions.status, 'open')))
    .orderBy(desc(subchatQuestions.createdAt))
    .limit(limit)
    .all();
  const resolved = db
    .select()
    .from(subchatQuestions)
    .where(and(eq(subchatQuestions.workspaceId, workspaceId), eq(subchatQuestions.status, 'resolved')))
    .orderBy(desc(subchatQuestions.resolvedAt))
    .limit(limit)
    .all();
  if (open.length === 0 && resolved.length === 0) return null;

  const lines: string[] = ['## Angespinnte Fragen in den Sub-Chats dieses Workspaces'];
  if (open.length > 0) {
    lines.push('Offene Fragen (warten auf Antwort):');
    for (const q of open) {
      const who = q.authorKind === 'ai' ? 'KI' : q.authorName || (q.authorKind === 'external' ? 'Kunde' : 'Team');
      lines.push(`- [offen, von ${who}] ${q.text.trim()}`);
    }
  }
  if (resolved.length > 0) {
    const answeredLines: string[] = [];
    for (const q of resolved.slice(0, limit)) {
      const ans = db
        .select()
        .from(subchatQuestionAnswers)
        .where(eq(subchatQuestionAnswers.questionId, q.id))
        .orderBy(desc(subchatQuestionAnswers.createdAt))
        .limit(1)
        .all()[0];
      let a = ans?.freeText ?? '';
      if (!a && ans?.optionId) {
        const opt = db
          .select()
          .from(subchatQuestionOptions)
          .where(eq(subchatQuestionOptions.id, ans.optionId))
          .limit(1)
          .all()[0];
        a = opt?.label ?? '';
      }
      answeredLines.push(`- ${q.text.trim()} → ${a.trim() || '(beantwortet)'}`);
    }
    if (answeredLines.length > 0) {
      lines.push('Kürzlich beantwortete Fragen:');
      lines.push(...answeredLines);
    }
  }
  return lines.join('\n');
}

async function emitQuestionEvent(
  eventType: 'subchat_question' | 'subchat_question_answer',
  payload: Record<string, unknown> & { subchatId: string; workspaceId: string },
): Promise<void> {
  try {
    const { emitEvent } = await import('@/lib/events/emit');
    await emitEvent({
      segmentId: payload.workspaceId,
      entityType: 'subchat',
      entityId: payload.subchatId,
      eventType,
      actor: 'system',
      payload,
      sensitivity: 'low',
    });
  } catch {
    /* non-fatal — Realtime ist best-effort */
  }
}
