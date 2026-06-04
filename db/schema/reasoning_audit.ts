/**
 * Drizzle schema for reasoning audit (migration 0044, Pattern 5 traceability).
 *
 * Separation from existing logs:
 *   - audit_log = auth/org/identity events
 *   - events    = business domain (tickets, decisions, surfaces)
 *   - reasoning_audit = LLM calls with inputs+outputs+hashes for hallucination detection
 *
 * Read pattern: on "why did Sniper say that?" → query by workstreamId+phase,
 * load source_chunks_json, prior_outputs_json, prompt_hash. Reproduce inputs,
 * cross-check against the current answer. If it diverges → mark verified_status='drift'.
 *
 * Write pattern: the hot path in the tier orchestrator runs writeReasoningAudit() BEFORE
 * persisting as an event. Fail-soft (try/catch), never block the tier spawn.
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const REASONING_PHASES = [
  "v1",
  "v2",
  "v3",
  "v4",
  "v5",
  "synthesis",
  "cross-roast",
  "sniper-inject",
  "swarm-spawn",
  "swarm-synthesis",
  "sub-spawn",
] as const;
export type ReasoningPhase = (typeof REASONING_PHASES)[number] | string;

export const REASONING_ROLES = [
  "iterate-lead",
  "iterate-roaster-1",
  "iterate-roaster-2",
  "cross-roast",
  "synthesis",
  "sub-spawn",
  "sniper-resume",
] as const;
export type ReasoningRole = (typeof REASONING_ROLES)[number] | string;

export const VERIFIED_STATUS = ["ok", "drift", "fabricated"] as const;
export type VerifiedStatus = (typeof VERIFIED_STATUS)[number];

export const reasoningAudit = sqliteTable(
  "reasoning_audit",
  {
    id: text("id").primaryKey(),
    ts: integer("ts", { mode: "timestamp_ms" }).notNull(),
    workspaceId: text("workspace_id"),
    workstreamId: text("workstream_id"),
    parentTicketId: text("parent_ticket_id"),
    phase: text("phase").notNull(),
    role: text("role").notNull(),
    llmProvider: text("llm_provider").notNull(),
    llmModel: text("llm_model").notNull(),
    promptHash: text("prompt_hash").notNull(),
    claimText: text("claim_text").notNull(),
    sourceChunksJson: text("source_chunks_json"),
    priorOutputsJson: text("prior_outputs_json"),
    userCorrectionsJson: text("user_corrections_json"),
    costCents: integer("cost_cents").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    outputTokens: integer("output_tokens"),
    verifiedStatus: text("verified_status"),
    verifiedAt: integer("verified_at"),
    verifiedNote: text("verified_note"),
    // Migration 0046 (Pattern 5 wave 3, 2026-05-01): optional plaintext prompts
    // for drift re-spawn. Default NULL — only when LAZYOS_AUDIT_FULL_PROMPTS=1
    // was set at write time.
    systemPromptText: text("system_prompt_text"),
    userPromptText: text("user_prompt_text"),
  },
  (table) => ({
    byTs: index("idx_reasoning_audit_ts").on(table.ts),
    byWs: index("idx_reasoning_audit_ws").on(table.workstreamId, table.ts),
    byTicket: index("idx_reasoning_audit_ticket").on(table.parentTicketId, table.ts),
    byPhase: index("idx_reasoning_audit_phase").on(table.phase, table.ts),
    byUnverified: index("idx_reasoning_audit_unverified").on(table.verifiedStatus, table.ts),
  }),
);

export type ReasoningAuditRow = typeof reasoningAudit.$inferSelect;
export type ReasoningAuditInsert = typeof reasoningAudit.$inferInsert;
