/**
 * Drizzle schema for the `workstreams` table (Phase W).
 *
 * Workstream = container for one user request. Bundles 1 master-plan ticket,
 * N feature tickets (via event-sourced parent_ticket_id), one primary
 * Claude session, a tier mix for multi-agent spawn, and aggregated
 * cost/quality values.
 *
 * The workstream↔ticket link does NOT go through a DB FK (tickets are
 * event-sourced), but through `events.payload.workstreamId`.
 */

import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const workstreams = sqliteTable(
  'workstreams',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    name: text('name').notNull(),
    primarySessionId: text('primary_session_id'),
    primaryTicketId: text('primary_ticket_id'),
    /** JSON-encoded `{ opus:number, sonnet:number, haiku:number }`. */
    tierMix: text('tier_mix'),
    status: text('status').notNull().default('active'),
    costCents: integer('cost_cents').notNull().default(0),
    qualityScore: real('quality_score'),
    /** JSON-Array (384-dim Embedding). */
    classificationEmbedding: text('classification_embedding'),
    description: text('description'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    archivedAt: integer('archived_at'),
    // Phase Sub-WS (Sprint C, 2026-04-29) — Sub-Workstream-Felder.
    /** Parent-Workstream-ID. NULL = Master. */
    parentWorkstreamId: text('parent_workstream_id'),
    /** Rolle: lead / roaster-1 / roaster-2 / critic / cross-roast / sub-plan-sniper / etc. */
    role: text('role'),
    /** tmux-Session-Name fuer Klick-zu-Session. */
    tmuxSessionId: text('tmux_session_id'),
    /** Aggregierte Input-Tokens (rolling Sum aus allen Spawn-Calls). */
    tokensIn: integer('tokens_in').notNull().default(0),
    /** Aggregierte Output-Tokens. */
    tokensOut: integer('tokens_out').notNull().default(0),
    /** Aggregated cost in cents (separate from costCents so the master roll-up is not broken). */
    costCentsAggregated: integer('cost_cents_aggregated').notNull().default(0),
    // Phase tier-lock (2026-04-30) — workstream mode + iterate config +
    // dispatch lock. Sub-Plan A + G from the master plan 2026-04-30.
    /** Mode marker: 'iterate' | 'swarm' | NULL (legacy = iterate+standard). */
    mode: text('mode'),
    /** JSON-encoded IterateConfig (presetId, leadCount, roasterCount, sniperLoop, stages[], estMinutes). */
    iterateConfigJson: text('iterate_config_json'),
    /** ULID pro start-dispatch-Erwerb. NULL = kein Lock aktiv. */
    dispatchLockToken: text('dispatch_lock_token'),
    /** Timestamp (ms) des Lock-Erwerbs. >=60s alt = expired. */
    dispatchLockTs: integer('dispatch_lock_ts'),
    // 2026-05-01 — intent classification. Visible marker per workstream:
    // 'idea' | 'implementation' | 'bug-fix' | 'question' | 'discussion'.
    // NULL = legacy → normalized to 'discussion' in the service layer.
    intent: text('intent'),
  },
  (table) => ({
    byWorkspace: index('idx_workstreams_workspace').on(
      table.workspaceId,
      table.status,
      sql`${table.updatedAt} DESC`,
    ),
    bySession: index('idx_workstreams_session').on(table.primarySessionId),
    byStatus: index('idx_workstreams_status').on(
      table.status,
      sql`${table.updatedAt} DESC`,
    ),
    byParent: index('idx_workstreams_parent').on(table.parentWorkstreamId),
    byIntent: index('idx_workstreams_intent').on(table.intent),
  }),
);

export type WorkstreamRow = typeof workstreams.$inferSelect;
export type WorkstreamInsert = typeof workstreams.$inferInsert;
