/**
 * Drizzle schema for workflow runs (migration 0050, Pattern 4 foundation).
 *
 * Workflow runs persist the state of a codified domain FSM
 * (dev-sprint, field-measurement, legal-brief, design-gate-flow,
 * legal-correspondence). Side-by-side versioning via `definition_version` —
 * old runs stay on v1, new runs start on v2/v3.
 *
 * Read pattern: Runner.runWorkflow() loads the run, reads `current_state` +
 * `data_json`, evaluates conditions, writes back.
 *
 * Write pattern: append-like via UPDATE on `current_state`/`data_json`/
 * `status`/`last_transition_at`. No real append-only events — but the
 * transitions are additionally emitted as events (workflow.transitioned)
 * for the audit log.
 */

import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const WORKFLOW_RUN_STATUSES = ['running', 'stuck', 'completed', 'aborted'] as const;
export type WorkflowRunStatusValue = (typeof WORKFLOW_RUN_STATUSES)[number];

export const workflowRuns = sqliteTable(
  'workflow_runs',
  {
    id: text('id').primaryKey(),
    workflowId: text('workflow_id').notNull(),
    definitionVersion: text('definition_version').notNull(),
    workspaceId: text('workspace_id'),
    workstreamId: text('workstream_id'),
    currentState: text('current_state').notNull(),
    dataJson: text('data_json').notNull().default('{}'),
    status: text('status').notNull().default('running'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastTransitionAt: integer('last_transition_at').notNull(),
  },
  (table) => ({
    byWorkflow: index('idx_wfr_workflow').on(table.workflowId, table.createdAt),
    byWorkstream: index('idx_wfr_workstream').on(table.workstreamId),
    byStatus: index('idx_wfr_status').on(table.status, table.lastTransitionAt),
  }),
);

export type WorkflowRunRow = typeof workflowRuns.$inferSelect;
export type WorkflowRunInsert = typeof workflowRuns.$inferInsert;
