/**
 * Drizzle schema — question spinning in sub/group chats (2026-06-03).
 *
 * Design: docs/plans/2026-06-03_group-chat-question-spinning-design.md §3.
 *
 * Owner vision: "spin up questions in the chats with group members … so that
 * something does not get lost in the chat. Every user can spin up questions, add answer
 * options or answer with free text. And the AI must have these things
 * for itself too."
 *
 * Three append-only, `workspace_id`-scoped (N9) tables:
 *   - subchat_questions          — the spun-up question (status via resolved_at).
 *   - subchat_question_options   — answer options (own rows → everyone can
 *                                  append independently, no JSON race).
 *   - subchat_question_answers   — answers per participant (option OR free text),
 *                                  append-only (the most recent per participant applies).
 *
 * Discipline: N1 (text/label/free_text VERBATIM), N2 (workspace-isolated
 * RAG ingestion of the answers), N9 (workspace_id as ManifestCoord on every row).
 */

import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const subchatQuestions = sqliteTable(
  'subchat_questions',
  {
    /** ULID, prefix `SCQ-`. */
    id: text('id').primaryKey(),
    subchatId: text('subchat_id').notNull(),
    /** N9 Scope (denormalisiert, wie subchat_messages). */
    workspaceId: text('workspace_id').notNull(),
    /** WER hat angespinnt: 'internal' | 'external' | 'ai'. */
    authorKind: text('author_kind').notNull(),
    /** user-id (internal) | session-id (external) | NULL (ai). */
    authorId: text('author_id'),
    /** Anzeigename ('Team' / Gast-Name / 'Assistent'). */
    authorName: text('author_name'),
    /** N1: VERBATIM Frage-Text, nie truncated. */
    text: text('text').notNull(),
    /** Monoton steigend pro subchat_id — das „aufeinanderfolgend" der Vision. */
    seq: integer('seq').notNull(),
    /** 'open' | 'resolved'. */
    status: text('status').notNull().default('open'),
    /** Epoch ms; NULL solange offen. */
    resolvedAt: integer('resolved_at'),
    /** author_id, der zuletzt auf resolved setzte (oder 'auto:stale'). */
    resolvedBy: text('resolved_by'),
    /** Epoch ms. */
    createdAt: integer('created_at').notNull(),
  },
  (table) => ({
    bySubchat: index('idx_subchat_questions_subchat').on(table.subchatId, table.seq),
    byOpen: index('idx_subchat_questions_open').on(table.subchatId, table.status),
    byWorkspace: index('idx_subchat_questions_ws').on(table.workspaceId),
  }),
);

export const subchatQuestionOptions = sqliteTable(
  'subchat_question_options',
  {
    /** ULID, prefix `SCO-`. */
    id: text('id').primaryKey(),
    questionId: text('question_id').notNull(),
    /** Denormalisiert für Scope-/Realtime-Filter. */
    subchatId: text('subchat_id').notNull(),
    /** N9. */
    workspaceId: text('workspace_id').notNull(),
    /** N1 verbatim Option-Label. */
    label: text('label').notNull(),
    /** WER hat die Option hinzugefügt: 'internal' | 'external' | 'ai'. */
    addedByKind: text('added_by_kind').notNull(),
    addedById: text('added_by_id'),
    /** Anzeige-Reihenfolge der Optionen. */
    seq: integer('seq').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => ({
    byQuestion: index('idx_scq_options_question').on(table.questionId, table.seq),
    bySubchat: index('idx_scq_options_subchat').on(table.subchatId),
  }),
);

export const subchatQuestionAnswers = sqliteTable(
  'subchat_question_answers',
  {
    /** ULID, prefix `SCA-`. */
    id: text('id').primaryKey(),
    questionId: text('question_id').notNull(),
    subchatId: text('subchat_id').notNull(),
    /** N9. */
    workspaceId: text('workspace_id').notNull(),
    /** WER antwortet: 'internal' | 'external' | 'ai'. */
    answererKind: text('answerer_kind').notNull(),
    answererId: text('answerer_id'),
    answererName: text('answerer_name'),
    /** Gesetzt, wenn via Option beantwortet. */
    optionId: text('option_id'),
    /** Gesetzt, wenn Freitext (N1 verbatim). */
    freeText: text('free_text'),
    /** In RAG aufgenommen? (wie subchat_messages.ingested). */
    ingested: integer('ingested').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (table) => ({
    byQuestion: index('idx_scq_answers_question').on(table.questionId, table.createdAt),
    byAnswerer: index('idx_scq_answers_answerer').on(
      table.questionId,
      table.answererKind,
      table.answererId,
    ),
    byIngest: index('idx_scq_answers_ingest').on(table.ingested),
  }),
);

export type SubchatQuestionRow = typeof subchatQuestions.$inferSelect;
export type SubchatQuestionOptionRow = typeof subchatQuestionOptions.$inferSelect;
export type SubchatQuestionAnswerRow = typeof subchatQuestionAnswers.$inferSelect;
