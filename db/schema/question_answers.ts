/**
 * Drizzle schema for `question_answers` (migration 0116, Phase 1 Track AB · finding B).
 *
 * Closes the binding gap from handoff §8:
 *
 *   Answers to open-questions are TODAY sent as a plain "Question:.../Answer:..."
 *   text block (lib/chat/ChatShell.tsx::buildQAReply) into the normal chat stream.
 *   workstreamId, flowRunId, planId, questionSetId, questionId
 *   do NOT travel along → no unique assignment, no hydration after reload,
 *   no continuation of the FlowRun from a structured answer.
 *
 * This table is the structured answer store. The textual echo
 * in the chat stream may additionally exist (owner directive verbatim:
 *   "The readable chat message may additionally exist. But the execution
 *    must not hang on this chat message.").
 *
 * Fields mirror the envelope 1:1:
 *   workspaceId · workstreamId · flowRunId · planId
 *   questionSetId · questionId · answer · sourceTurnId · surfaceId
 *
 * + N10 tamper evidence (contentHash) + standard ts.
 *
 * All ID fields except workspaceId+questionId+sourceTurnId are optional
 * (free-chat without an active workstream possible; analogous to dismiss-route).
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const questionAnswers = sqliteTable(
  "question_answers",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    workstreamId: text("workstream_id"),
    flowRunId: text("flow_run_id"),
    planId: text("plan_id"),
    questionSetId: text("question_set_id"),
    questionId: text("question_id").notNull(),
    /** VERBATIM (N1) — no .slice/.substring in the writer. */
    answer: text("answer").notNull(),
    /** ChatShell-internal HistoryItem.id (idempotency anchor). */
    sourceTurnId: text("source_turn_id").notNull(),
    surfaceId: text("surface_id"),
    /** Epoch ms. Default 0 for test determinism (analogous to 0115). */
    createdAt: integer("created_at").notNull().default(0),
    /** N10 — sha256 over the canonically serialized envelope. */
    contentHash: text("content_hash").notNull(),
  },
  (t) => ({
    byWsWorkstream: index("idx_question_answers_ws_workstream").on(
      t.workspaceId,
      t.workstreamId,
    ),
    byQuestion: index("idx_question_answers_question_id").on(t.questionId),
    uniqHash: uniqueIndex("uniq_question_answers_content_hash").on(t.contentHash),
    uniqTurnQuestion: uniqueIndex("uniq_question_answers_turn_question").on(
      t.sourceTurnId,
      t.questionId,
    ),
  }),
);

export type QuestionAnswerRow = typeof questionAnswers.$inferSelect;
export type NewQuestionAnswerRow = typeof questionAnswers.$inferInsert;
