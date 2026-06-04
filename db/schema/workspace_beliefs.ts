/**
 * Drizzle schema for `workspace_beliefs` + `decision_outcomes`
 * (migration 0113 · Self-Learning / WHY engine · Stream A).
 *
 * Source: GOAL-lazyos-self-learning-why-engine +
 *         docs/plans/2026-05-27_self-learning-and-flow-completion-plan.md.
 *
 * workspace_beliefs is the learning store (workspace ReasoningBank): one active
 * conviction per topic per workspace; superseded beliefs are kept via
 * `supersedesId` as history (append-only spirit — "don't forget").
 * belief + rationale are persisted VERBATIM (N1); content_hash carries
 * tamper evidence (N10).
 *
 * decision_outcomes links a made decision (or a whole
 * workstream) additively with its outcome — because `workstream_decisions`
 * is append-only (0071 trigger) and may not be updated in-place.
 *
 * Scope (workspaceId) is ManifestCoord-analogous (N9). Deliberately NO hard FKs
 * on workspaces (orphan scope rows tolerated at runtime — analogous to
 * flow_*.ts / workspace_fs_roots.ts).
 */

import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workspaceBeliefs = sqliteTable(
  "workspace_beliefs",
  {
    id: text("id").primaryKey(),
    /** ManifestCoord scope (N9), no hard FK. */
    workspaceId: text("workspace_id").notNull(),
    /** Topic key (start: LIKE/exact-match recall). */
    topic: text("topic").notNull(),
    /** The conviction, VERBATIM (N1). */
    belief: text("belief").notNull(),
    /** The WHY, VERBATIM (N1). */
    rationale: text("rationale").notNull(),
    /** 'user' | 'ai' — who formed the conviction. */
    source: text("source").notNull(),
    /** Nullable: supersedes an older belief row (history is kept). */
    supersedesId: text("supersedes_id"),
    /** Nullable: 0..1 confidence (optional). */
    confidence: real("confidence"),
    /** N10 tamper-evidence (sha256 over canonical JSON). */
    contentHash: text("content_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    byWorkspace: index("idx_workspace_beliefs_ws").on(table.workspaceId),
    byWorkspaceTopic: index("idx_workspace_beliefs_ws_topic").on(
      table.workspaceId,
      table.topic,
    ),
    bySupersedes: index("idx_workspace_beliefs_supersedes").on(
      table.supersedesId,
    ),
  }),
);

export const decisionOutcomes = sqliteTable(
  "decision_outcomes",
  {
    id: text("id").primaryKey(),
    /** ManifestCoord scope (N9). */
    workspaceId: text("workspace_id").notNull(),
    /** Soft-FK on workstream_decisions.id (nullable). */
    decisionId: text("decision_id"),
    /** Soft-FK on workstreams.id (nullable). */
    workstreamId: text("workstream_id"),
    /** 'success' | 'failure' | 'partial' | 'unknown'. */
    outcome: text("outcome").notNull(),
    /** VERBATIM detail/reason (N1), nullable. */
    note: text("note"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({
    byWorkspace: index("idx_decision_outcomes_ws").on(table.workspaceId),
    byDecision: index("idx_decision_outcomes_decision").on(table.decisionId),
    byWorkstream: index("idx_decision_outcomes_workstream").on(
      table.workstreamId,
    ),
  }),
);

export type WorkspaceBeliefRow = typeof workspaceBeliefs.$inferSelect;
export type WorkspaceBeliefInsert = typeof workspaceBeliefs.$inferInsert;
export type DecisionOutcomeRow = typeof decisionOutcomes.$inferSelect;
export type DecisionOutcomeInsert = typeof decisionOutcomes.$inferInsert;
