/**
 * Drizzle schema for `knowledge_forms`
 * (migration 0120 · Lane B Expertise Compiler · Phase 2 W2.2 · 2026-05-29).
 *
 * Source: master briefing §8 (Lane B knowledge forms) +
 *         integration plan §4 Lane B outputs.
 *
 * This table is the additively added substrate for the 12 knowledge forms
 * that Lane B (expertise compiler) extracts from user/expert input.
 *
 * Discipline:
 *   - N1:  statement / rationale / term / example_cases_json /
 *          counter_cases_json VERBATIM.
 *   - N4:  purely additive — nothing changed; beliefs are mirrored AFTER human-review
 *          via upsertBelief into workspace_beliefs (0113).
 *   - N8:  append-only-light (trigger in 0120) — UPDATE on review_state /
 *          supersedes_id / updated_at allowed; id/kind/term/statement/
 *          content_hash immutable.
 *   - N9:  workspaceId-scoped, ManifestCoord-analogous. NO hard FK on
 *          workspaces.
 *   - N10: content_hash (sha256 over canonical JSON) per row.
 */

import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const knowledgeForms = sqliteTable(
  "knowledge_forms",
  {
    id: text("id").primaryKey(),
    /** ManifestCoord scope (N9), no hard FK. */
    workspaceId: text("workspace_id").notNull(),
    /** One of the 12 knowledge forms (§8.2). */
    kind: text("kind").notNull(),
    /** Term (nullable — only for kind='glossary'). */
    term: text("term"),
    /** Main statement, VERBATIM (N1). */
    statement: text("statement").notNull(),
    /** Why this statement is important, VERBATIM (N1). */
    rationale: text("rationale"),
    /** JSON array of illustrative cases (VERBATIM N1). */
    exampleCasesJson: text("example_cases_json"),
    /** JSON array of exceptions / counter-examples (VERBATIM N1). */
    counterCasesJson: text("counter_cases_json"),
    /** Domain classification, e.g. 'pv-planning'. */
    domain: text("domain"),
    /**
     * Provenance + back-FK, JSON-encoded:
     *   { intakeEventId?: string;   // §7.3 Lane-A source (0119)
     *     userInputTurnId?: string; // owner chat-turn source
     *     beliefId?: string }       // N4: after mirroring into workspace_beliefs
     *                               // (0113), set by mirrorApproved-
     *                               // KnowledgeFormToBelief — back-FK to the
     *                               // mirrored belief row, so re-mirror
     *                               // is idempotent and no duplicate holding
     *                               // arises.
     */
    sourceJson: text("source_json"),
    /** 0..1 confidence (CHECK enforced in the migration). */
    confidence: real("confidence"),
    /**
     * Review state: pending-review | approved | rejected | superseded.
     * Owner directive: Lane B outputs always land with pending-review;
     * approval only after human-review. (consent + governance gate)
     */
    reviewState: text("review_state").notNull(),
    /** Supersedes an older row (nullable; history is preserved). */
    supersedesId: text("supersedes_id"),
    /** N10 tamper evidence. */
    contentHash: text("content_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    byWorkspaceKind: index("idx_knowledge_ws_kind").on(
      table.workspaceId,
      table.kind,
      table.reviewState,
    ),
    byTerm: index("idx_knowledge_term").on(table.workspaceId, table.term),
    bySupersedes: index("idx_knowledge_supersedes").on(table.supersedesId),
    byHash: index("idx_knowledge_hash").on(table.contentHash),
  }),
);

export type KnowledgeFormRow = typeof knowledgeForms.$inferSelect;
export type KnowledgeFormInsert = typeof knowledgeForms.$inferInsert;
