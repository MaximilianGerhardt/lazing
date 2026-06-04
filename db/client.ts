/**
 * SQLite/Drizzle client — singleton with auto-migrate.
 *
 * Persistence strategy (MVP, Phase 2 + Sprint 2):
 *   - Local dev / self-hosted: `LAZYOS_DB_PATH` OR `~/.lazyos/lazyos.db`
 *   - Vercel serverless: `/tmp/lazyos-events.db` — EPHEMERAL
 *     Each new lambda instance starts with an empty DB and rebuilds the
 *     schemas via `CREATE TABLE IF NOT EXISTS`. Acceptable for the
 *     single-user MVP; a later phase migrates to Turso/Vercel-Postgres
 *     with an identical schema.
 *
 * Idempotency:
 *   - All migrations use `CREATE TABLE IF NOT EXISTS` +
 *     `CREATE INDEX IF NOT EXISTS`.
 *   - Workspaces are NOT seeded here — `scripts/discover-workspaces.ts`
 *     scans the projects root and performs the upsert.
 *   - Fallback ticket/decision seeds from Phase 2 are removed (Sprint 2 7C).
 */

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as auditLogSchema from "./schema/audit_log";
import * as cloudSchema from "./schema/cloud";
import * as eventsSchema from "./schema/events";
import * as heartbeatsSchema from "./schema/heartbeats";
import * as magicTokensSchema from "./schema/magic_tokens";
import * as membershipsSchema from "./schema/memberships";
import * as pushRuleOverridesSchema from "./schema/push_rule_overrides";
import * as reasoningAuditSchema from "./schema/reasoning_audit";
import * as routinesSchema from "./schema/routines";
import * as schemaVersionSchema from "./schema/schema_version";
import * as segmentsSchema from "./schema/segments";
import * as shareTokensSchema from "./schema/share_tokens";
import * as usersSchema from "./schema/users";
import * as workProductsSchema from "./schema/work_products";
import * as workflowRunsSchema from "./schema/workflow_runs";
import * as failedExperimentsSchema from "./schema/failed_experiments";
import * as githubSchema from "./schema/github";
import * as orgGithubSchema from "./schema/org_github";
import * as workspaceKeysSchema from "./schema/workspace_keys";
import * as workspacesSchema from "./schema/workspaces";
import * as workstreamsSchema from "./schema/workstreams";
// BACKPORT-01 (chat_ledger) + BACKPORT-03 (recursive-plans) schemas:
import * as chatLedgerSchema from "./schema/chat_ledger";
import * as workstreamPlanStepsSchema from "./schema/workstream_plan_steps";
import * as workstreamPlanCriticsSchema from "./schema/workstream_plan_critics";
// SAR-2 (2026-05-24) — SOP-Framework: sops + sop_steps.
import * as sopsSchema from "./schema/sops";
// Slice FS-1 (2026-05-26) — workspace path registry: workspace_fs_roots.
import * as workspaceFsRootsSchema from "./schema/workspace_fs_roots";
// Flow Studio P1 (2026-05-27) — flow_templates + flow_steps + flow_runs.
import * as flowTemplatesSchema from "./schema/flow_templates";
import * as flowStepsSchema from "./schema/flow_steps";
import * as flowRunsSchema from "./schema/flow_runs";
// Self-Learning / WHY-Engine Stream A (2026-05-27) — workspace_beliefs +
// decision_outcomes (workspace ReasoningBank + post-process reconciliation).
import * as workspaceBeliefsSchema from "./schema/workspace_beliefs";
// Sub-Chats (2026-06-02, Gathering-Intelligence-Goal) — group chats per
// workspace (external/internal) whose knowledge flows into the RAG.
import * as subchatsSchema from "./schema/subchats";
// Sub-Chats read marker (2026-06-02, P2) — per (sub-chat, user) last-read cutoff
// for the unread badge in the main chat.
import * as subchatReadMarkersSchema from "./schema/subchat_read_markers";
// Server-pre-generated proactive operator suggestions (2026-06-02, Proactivity-Goal).
import * as proactiveSuggestionsSchema from "./schema/proactive_suggestions";
// User defaults (2026-05-28, Owner-Fix) — system-wide default
// for permission mode (and future cross-workspace settings).
import * as userPreferencesSchema from "./schema/user_preferences";
// Structured open-question answer store (2026-05-29, Phase 1
// Track AB · Finding B) — workspaceId/workstreamId/flowRunId/planId/
// questionSetId/questionId/sourceTurnId/surfaceId instead of just a
// „Frage:.../Antwort:..." text block.
import * as questionAnswersSchema from "./schema/question_answers";
// Phase 2 W2.1 · Lane G Governance (2026-05-29, Migration 0118) —
// consent_grants + source_traces + governance_audit. FUNDAMENTAL lane
// (Stage 1, Governance Gate Contract) — defines what EVERY other lane
// may/must do. Master-Briefing §13.2 + §7.2.
import * as consentGrantsSchema from "./schema/consent_grants";
// Phase 2 W2.2 · Lane A Communication Intake (2026-05-29, Migration 0119) —
// intake_events. Verbatim substrate for WhatsApp/Telegram/Voice/Meeting
// communication; no-auto-run FSM (§7.2). Master-Briefing §25.1 + §7.3.
import * as intakeEventsSchema from "./schema/intake_events";
// Phase 2 W2.2 · Lane B Expertise Compiler (2026-05-29, Migration 0120) —
// knowledge_forms (the 12 knowledge forms, §8.2). Approved knowledge_forms
// are mirrored via lib/lanes/expertise-compiler/mirror-to-beliefs.ts into
// workspace_beliefs (0113) (N4: no separate belief writer).
import * as knowledgeFormsSchema from "./schema/knowledge_forms";
// Phase IN · Lane D Innovation Mode (2026-05-29, Migration 0121) —
// innovation_artifacts (assumption map · reframe set · cross-domain analogies ·
// contrarian roast · concept graph, §10.4). Append-only evidence (N8/N10).
import * as innovationArtifactsSchema from "./schema/innovation_artifacts";
// Phase 2 W2.3 · Lanes C/E/F Engines (2026-05-29, Migration 0122) —
// lane_artifacts (ONE table, kind discriminator). Lane C Role Reverse
// Engineering · Lane E Toolstack Replacement · Lane F Mobile Human-in-the-Loop
// (Lane F builds on lib/push/*, N4). Append-only evidence (N8/N10).
import * as laneArtifactsSchema from "./schema/lane_artifacts";

export const schema = {
  ...eventsSchema,
  ...segmentsSchema,
  ...workspacesSchema,
  ...heartbeatsSchema,
  ...routinesSchema,
  ...workProductsSchema,
  ...workstreamsSchema,
  ...schemaVersionSchema,
  ...cloudSchema,
  // Phase ORG SP-1 (2026-04-27):
  ...usersSchema,
  ...membershipsSchema,
  ...magicTokensSchema,
  ...auditLogSchema,
  // Phase ORG+1 (2026-04-28) — encryption:
  ...workspaceKeysSchema,
  // Phase ORG+2 (2026-04-28) — share tokens:
  ...shareTokensSchema,
  // Pattern 5 Traceability (2026-05-01) — reasoning audit:
  ...reasoningAuditSchema,
  // Pattern 6a telemetry (2026-05-01) — push rule overrides:
  ...pushRuleOverridesSchema,
  // Pattern 4 Foundation (2026-05-01) — workflow runs:
  ...workflowRunsSchema,
  // P14 real Pattern 9 "Unlearning" (2026-05-01) — failed experiments:
  ...failedExperimentsSchema,
  // GitHub integration backport (2026-05-23, Agent 3/8) — Lazing-V2.
  ...githubSchema,
  // Org-level GitHub integration (2026-05-24, Slice A) — Migration 0096.
  ...orgGithubSchema,
  // BACKPORT-01 (2026-05-23, Agent 1/8) — chat_ledger N1-verbatim foundation.
  ...chatLedgerSchema,
  // BACKPORT-03 (2026-05-23, Agent 3/8) — recursive plans + critic-loop FSM.
  ...workstreamPlanStepsSchema,
  ...workstreamPlanCriticsSchema,
  // SAR-2 (2026-05-24) — SOP framework: sops + sop_steps.
  ...sopsSchema,
  // Slice FS-1 (2026-05-26) — workspace path registry: workspace_fs_roots.
  ...workspaceFsRootsSchema,
  // Flow Studio P1 (2026-05-27) — flow_templates + flow_steps + flow_runs.
  ...flowTemplatesSchema,
  ...flowStepsSchema,
  ...flowRunsSchema,
  // Self-Learning / WHY-Engine Stream A (2026-05-27) — workspace_beliefs +
  // decision_outcomes (workspace ReasoningBank + post-process reconciliation).
  ...workspaceBeliefsSchema,
  // Sub-Chats (2026-06-02, Gathering-Intelligence-Goal).
  ...subchatsSchema,
  // Sub-Chats read marker (2026-06-02, P2).
  ...subchatReadMarkersSchema,
  // Proactive suggestions (2026-06-02, Proactivity-Goal).
  ...proactiveSuggestionsSchema,
  // User defaults (2026-05-28, Owner-Fix) — system-wide default
  // for permission mode etc.
  ...userPreferencesSchema,
  // Structured open-question answer store (2026-05-29, Phase 1
  // Track AB · Finding B).
  ...questionAnswersSchema,
  // Phase 2 W2.1 · Lane G Governance (2026-05-29, Migration 0118) —
  // consent_grants + source_traces + governance_audit. FUNDAMENTAL lane
  // (Stage 1, Governance Gate Contract).
  ...consentGrantsSchema,
  // Phase 2 W2.2 · Lane A Communication Intake (2026-05-29, Migration 0119) —
  // intake_events (verbatim substrate, no-auto-run FSM).
  ...intakeEventsSchema,
  // Phase 2 W2.2 · Lane B Expertise Compiler (2026-05-29, Migration 0120) —
  // knowledge_forms (the 12 knowledge forms); belief mirroring via
  // lib/lanes/expertise-compiler/mirror-to-beliefs.ts (N4).
  ...knowledgeFormsSchema,
  // Phase IN · Lane D Innovation Mode (2026-05-29, Migration 0121) —
  // innovation_artifacts (§10.4 artifacts before build). Append-only (N8/N10).
  ...innovationArtifactsSchema,
  // Phase 2 W2.3 · Lanes C/E/F Engines (2026-05-29, Migration 0122) —
  // lane_artifacts (Role Reverse Engineering · Toolstack Replacement ·
  // Mobile Human-in-the-Loop). Append-only evidence (N8/N10).
  ...laneArtifactsSchema,
};

export type LazyDb = BetterSQLite3Database<typeof schema> & {
  $raw: Database.Database;
};

function resolveDbPath(): string {
  const override = process.env.LAZYOS_DB_PATH;
  if (override && override.length > 0) return override;
  if (process.env.VERCEL === "1") return "/tmp/lazyos-events.db";
  // Prefer the home-dir data dir (survives cwd changes of the dev server).
  const systemPath = path.join(os.homedir(), ".lazyos", "lazyos.db");
  const systemParent = path.dirname(systemPath);
  if (existsSync(systemParent) || canCreate(systemParent)) return systemPath;
  // Last-ditch fallback — repo-local `./data/lazyos.db` (NOT lazyos-events.db).
  // Split-brain fix (2026-05-25): the old fallback `lazyos-events.db` differed
  // from server/db.ts's `data/lazyos.db`, so any process started WITHOUT
  // LAZYOS_DB_PATH (stray scripts, mis-launched server) silently read/wrote a
  // PHANTOM stale DB while the real data lived in lazyos.db → orphaned writes.
  // Now both default to the SAME file (single-source-of-truth invariant). The
  // running app always sets LAZYOS_DB_PATH and never reaches here; this only
  // protects ad-hoc tooling. Warn loudly so a missing env is observable.
  // eslint-disable-next-line no-console
  console.warn(
    "[db/client] LAZYOS_DB_PATH not set — falling back to ./data/lazyos.db. " +
      "Set LAZYOS_DB_PATH for the single-source-of-truth invariant.",
  );
  return path.join(process.cwd(), "data", "lazyos.db");
}

function canCreate(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

const DB_PATH = resolveDbPath();

const MIGRATIONS = [
  path.join(process.cwd(), "db", "migrations", "0001_initial.sql"),
  path.join(process.cwd(), "db", "migrations", "0002_workspaces.sql"),
  path.join(process.cwd(), "db", "migrations", "0003_heartbeats.sql"),
  path.join(process.cwd(), "db", "migrations", "0004_routines.sql"),
  path.join(process.cwd(), "db", "migrations", "0005_work_products.sql"),
  path.join(process.cwd(), "db", "migrations", "0006_claude_sessions.sql"),
  path.join(process.cwd(), "db", "migrations", "0007_workflow_state.sql"),
  path.join(process.cwd(), "db", "migrations", "0008_organizations.sql"),
  path.join(process.cwd(), "db", "migrations", "0009_workstreams.sql"),
  // 0010 is deliberately kept free for the self-calibration index
  // (Phase C). See db/migrations/MIGRATION-NOTES.md.
  path.join(process.cwd(), "db", "migrations", "0011_skills.sql"),
  path.join(process.cwd(), "db", "migrations", "0012_cloud.sql"),
  path.join(process.cwd(), "db", "migrations", "0013_workspace_notes.sql"),
  path.join(process.cwd(), "db", "migrations", "0014_workspace_credentials.sql"),
  path.join(process.cwd(), "db", "migrations", "0015_workspace_brand.sql"),
  path.join(process.cwd(), "db", "migrations", "0017_client_visibility.sql"),
  path.join(process.cwd(), "db", "migrations", "0018_streaming_snapshots.sql"),
  // 0019, 0020 are reserved for Phase H+I (sub-ticket spawner /
  // tier orchestrator). Phase Vers therefore hangs off 0021 — see
  // MIGRATION-NOTES.md.
  path.join(process.cwd(), "db", "migrations", "0021_schema_version.sql"),
  // Phase ORG SP-1 (2026-04-27):
  path.join(process.cwd(), "db", "migrations", "0022_phase_org_users.sql"),
  path.join(process.cwd(), "db", "migrations", "0023_phase_org_memberships.sql"),
  path.join(process.cwd(), "db", "migrations", "0024_phase_org_magic_tokens.sql"),
  path.join(process.cwd(), "db", "migrations", "0025_phase_org_org_brand.sql"),
  path.join(process.cwd(), "db", "migrations", "0026_phase_org_audit_log.sql"),
  // Phase ORG+1 (2026-04-28):
  path.join(process.cwd(), "db", "migrations", "0028_workspace_keys.sql"),
  // Phase ORG+2 (2026-04-28):
  path.join(process.cwd(), "db", "migrations", "0029_share_tokens.sql"),
  // Phase QA (2026-04-28): TPM budget manager
  path.join(process.cwd(), "db", "migrations", "0030_tpm_tracker.sql"),
  // Phase MU.1 (2026-04-28): multi-user MAX-plan tokens
  path.join(process.cwd(), "db", "migrations", "0031_phase_mu_user_creds.sql"),
  // Phase MU.4 (2026-04-28): TPM tracking per user
  path.join(process.cwd(), "db", "migrations", "0032_tpm_user_id.sql"),
  // 2026-04-28: org legal fields for legal outbound docs
  path.join(process.cwd(), "db", "migrations", "0033_org_legal_fields.sql"),
  // Phase IA.4 (2026-04-29): org-root chats — one virtual WS per org
  // with ID `__org_root__:<orgId>` for scoped chat context.
  path.join(process.cwd(), "db", "migrations", "0034_org_root_chats.sql"),
  // Phase IA consolidation (2026-04-29): workspace_type + re-map of all
  // own/customer workspaces under Example Company.
  path.join(process.cwd(), "db", "migrations", "0035_workspace_type_and_consolidation.sql"),
  // Phase IA consolidation re-fix (2026-04-29): restore the sub-org
  // hierarchy. Demo PV (CRM+Web) as a sub-org of PA-LLC, etc.
  path.join(process.cwd(), "db", "migrations", "0036_suborgs_restore.sql"),
  // Phase IA consolidation type-fix (2026-04-29): Example App + example-tool as product
  // (were accidentally classified as client/tool).
  path.join(process.cwd(), "db", "migrations", "0037_fix_org_types.sql"),
  // Phase Sub-WS (Sprint C, 2026-04-29): sub-workstreams as first-class.
  // parent_workstream_id + role + tmux_session_id + tokens_in/out + cost.
  path.join(process.cwd(), "db", "migrations", "0040_sub_workstreams.sql"),
  // Phase Tier-Lock (2026-04-30): workstream mode + iterate config +
  // dispatch lock. mode + iterate_config_json + dispatch_lock_token +
  // dispatch_lock_ts. Sub-Plan A + G from master plan 2026-04-30.
  path.join(process.cwd(), "db", "migrations", "0041_workstream_mode.sql"),
  // Sprint 2 RAG foundation (2026-04-30): rag_chunks + rag_indexer_state.
  path.join(process.cwd(), "db", "migrations", "0042_rag_index.sql"),
  // Sprint 3 (2026-04-30): user 2FA TOTP + recovery codes + pending sessions.
  path.join(process.cwd(), "db", "migrations", "0043_user_2fa.sql"),
  // Pattern 5 Traceability (2026-05-01): reasoning_audit for hallucination
  // detection. Persist inputs+outputs+hashes per LLM call (tier spawn /
  // synthesis / sniper). Addresses critic finding "audit log only auth, no
  // reasoning trail" + Stanford study 1/6 hallucination rate.
  path.join(process.cwd(), "db", "migrations", "0044_reasoning_audit.sql"),
  // Pattern 6a telemetry (2026-05-01): push_rule_overrides for adaptive
  // decay logic. Phase 6b (decay.ts) follows after 7d of telemetry lead time.
  path.join(process.cwd(), "db", "migrations", "0045_push_rule_overrides.sql"),
  // Pattern 5 Welle 3 (2026-05-01): optional plaintext prompts for drift-
  // verification re-spawn. ALTER TABLE ADD COLUMN — duplicate-column fallback
  // below kicks in on the second run.
  path.join(process.cwd(), "db", "migrations", "0046_add_prompt_text_columns.sql"),
  // Pattern 4 Foundation (2026-05-01): workflow_runs — codified domain
  // workflows (dev-sprint, field-measurement, legal-brief, ...).
  // Addresses Critic-VETO-3 + Anne (Legaly-AI): methodology as deterministic
  // FSM code instead of a Markdown prompt wall.
  path.join(process.cwd(), "db", "migrations", "0050_workflow_runs.sql"),
  // P14 (2026-05-01): real Pattern 9 "Unlearning" — failed_experiments.
  // Correction from user feedback: Anne means a personal working attitude (discard
  // assumptions + experiment), NOT file cleanup. The weekly retry sniper
  // re-attempts unresolved experiments after 14d with the current model.
  path.join(process.cwd(), "db", "migrations", "0047_experiment_tracker.sql"),
  // P16 (2026-05-01): sandbox mode per workspace — constraint-as-enabler
  // (Anne: „Spielfeld klar abgesteckt, dann Entscheidungen frei zulassen").
  // Auto-approve in sandbox + push suppression for routine events.
  // Safety: only enableable when sensitivity='low'. Loop guard stays active.
  path.join(process.cwd(), "db", "migrations", "0048_workspace_sandbox_mode.sql"),
  // 2026-05-01 — workstream intent classification. Makes idea/bug-fix/
  // implementation visually distinguishable (user finding "difference between
  // implementation and ideas not yet clear"). Column intent + index.
  path.join(process.cwd(), "db", "migrations", "0051_workstream_intent.sql"),
  // 2026-04-30 — workspace-isolated RAG (GDPR/DPA § 28 tenant separation).
  // Defense-in-depth: trigger FK on rag_chunks.workspace_id, read-only view
  // v_rag_chunks_workspace, audit table for cross-workspace reads.
  // Plan: docs/plans/2026-04-30_workspace-rag-isolation.md
  path.join(process.cwd(), "db", "migrations", "0052_workspace_rag_isolation.sql"),
  // 2026-05-03 — workspace context group for user-driven sub-segmentation
  // within an org (e.g. Demo PV: CRM + Web as 2 WS under
  // one sub-header). User finding 2026-05-03. Plan:
  // docs/plans/2026-05-03_workspace-create-ui.md
  path.join(process.cwd(), "db", "migrations", "0053_workspace_context_group.sql"),
  // 2026-05-23 — OSS onboarding state (Phase OSS-WIZ.1). Its own 5-step
  // wizard journey (engine/workspace/GitHub/push) parallel to the cloud
  // onboarding journey. User finding 2026-05-23: "wäre ja hier wichtig, dass es ein OSS
  // Onboarding gibt, wie z.B. bei lazing es das gab".
  path.join(process.cwd(), "db", "migrations", "0054_oss_onboarding_state.sql"),
  // 2026-05-23 — GitHub integration backport from Lazing-V2 (Agent 3/8).
  // github_credentials (PAT-primary, OAuth-secondary, AES-256-GCM encrypted)
  // + workspace_github_repos (N:1 repo→workspace mapping). Source:
  // lazing-wt/realtime-orchestrator-v2 packages/runtime/src/store/
  // migrations/012-github-substrate.ts.
  path.join(process.cwd(), "db", "migrations", "0092_workspace_github_repos.sql"),
  // 2026-05-23 — BACKPORT-01 (chat_ledger) from Lazing-V2 (Agent 1/8). N1-verbatim
  // chat-ledger as the foundation for conversation memory + N10 tamper-evidence.
  // Source: lazing-wt/realtime-orchestrator-v2 packages/runtime/src/store/
  // migrations/014-chat-ledger.ts.
  path.join(process.cwd(), "db", "migrations", "0093_chat_ledger.sql"),
  // 2026-05-23 — BACKPORT-03 (recursive-plans + critic-loop) from Lazing-V2
  // (Agent 3/8). workstream_plan_steps + workstream_plan_critics. Source:
  // lazing-wt/realtime-orchestrator-v2 packages/runtime/src/store/
  // migrations/011-recursive-plans.ts. Lazyos-stable delta: creates
  // workstream_plan_steps anew (V2 only extends the depth column).
  path.join(process.cwd(), "db", "migrations", "0094_recursive_plans.sql"),
  // 2026-05-23 — BACKPORT-01 augmented (Agent 1/8). Extends workstreams with
  // snapshot_json/at/content_hash + manifestation_payload/kind. Source:
  // lazing-wt/realtime-orchestrator-v2 packages/runtime/src/store/migrations/
  // 015-streaming-snapshots.ts (Slice DB + SURFACE-PERSIST).
  path.join(process.cwd(), "db", "migrations", "0095_workstream_snapshots_v2.sql"),
  // 2026-05-24 — org-level GitHub integration (Slice A). New table
  // `org_github_credentials` (org-scoped, UNIQUE(org_id), AES-256-GCM).
  // Isolation: each org has at most 1 GitHub connection; the API checks
  // assertOrgRole + WHERE org_id = ?. Schema: db/schema/org_github.ts.
  path.join(process.cwd(), "db", "migrations", "0096_org_github_credentials.sql"),
  // 2026-05-24 — lexical RAG FTS5 (N7: lexical before vector). FTS5 virtual
  // table `rag_chunks_fts` over rag_chunks.text with content-table link (rowid).
  // Three triggers (AFTER INSERT/UPDATE/DELETE) keep the FTS in sync.
  // Backfill via FTS5 'rebuild' command. Retriever: lexical-first BM25 → optionally
  // cosine rerank → fallback to the pure cosine path when FTS returns 0 hits.
  path.join(process.cwd(), "db", "migrations", "0097_rag_fts.sql"),
  // 2026-05-24 — permission foundation Wave 1 (ADR-0004 / POS-1 / Batch 4).
  // New tables: lazyos_permission_modes (workspace/org-scoped mode) +
  // lazyos_permission_audit (append-only op-decision log, N8/N10 content_hash).
  // Phase-1 default: 'freerein-with-audit' (audit-only, never blocking).
  // Enforcement via LAZYOS_PERMISSION_ENFORCEMENT ENV (default 'audit').
  path.join(process.cwd(), "db", "migrations", "0098_permission.sql"),
  // 2026-05-24 — SAR-2: SOP framework (Standard Operating Procedures).
  // New tables: sops (plan-skeleton templates, global/workspace-scoped) +
  // sop_steps (ordered steps, N1-full-prompt, N10-content_hash).
  // Binding columns on routines: sop_id, goal_prompt, skill_bindings_json,
  // mcp_tool_allowlist_json, action_kind DEFAULT 'shell' (backward-compat).
  path.join(process.cwd(), "db", "migrations", "0099_sops.sql"),
  // 2026-05-24 — API Connector Layer (ACL).
  // 0100: api_credentials (generic vault, org+workspace scope, provider) +
  //       credential_access_log (N8). 0101: connector_catalog + connector_
  //       capabilities (platform-global, non-sensitive, ADR-0006/N2 demarcation).
  //       0102: workspaces.credential_isolation ('inherit'|'isolated', D2).
  path.join(process.cwd(), "db", "migrations", "0100_api_credentials.sql"),
  path.join(process.cwd(), "db", "migrations", "0101_connector_catalog.sql"),
  path.join(process.cwd(), "db", "migrations", "0102_workspace_credential_isolation.sql"),
  // 0103: connector onboarding SOP (ACL-4) — built-in SOP referenced by the
  // auto-connect „Profil fehlt" path. (Checkup 2026-05-24: was accidentally
  // never registered → only 3 instead of 4 SOPs in the DB.)
  path.join(process.cwd(), "db", "migrations", "0103_connector_onboarding_sop.sql"),
  // 0104: connector_catalog_audit (N8 trace for catalog writes, best-effort).
  path.join(process.cwd(), "db", "migrations", "0104_connector_catalog_audit.sql"),
  // 0105: ACL-5 connector_call_approvals (trust ask|auto, default ask=fail-closed)
  //       + connector_call_audit (N8/N10, payload_hash statt payload).
  path.join(process.cwd(), "db", "migrations", "0105_connector_calls.sql"),
  // 0106: org_github_token_use_audit (N8 trace on org token use, best-effort).
  path.join(process.cwd(), "db", "migrations", "0106_org_github_token_use_audit.sql"),
  // 0107: R2 gate enforced — allowed_tools per plan step (nullable JSON array).
  //       NULL → conservative default ["Read","Grep"] in plan-executor.ts.
  //       Filled by SOP step dispatch (mcp_tool_allowlist_json) or free
  //       plan nodes with allowedTools. Idempotent via duplicate-column fallback.
  path.join(process.cwd(), "db", "migrations", "0107_plan_step_allowed_tools.sql"),
  // 0108: app-store/MCP lifecycle (Batch 7d) — app_manifests + app_installs +
  // app_install_audit. Foundation; real activate/OAuth-connect is R3-gated.
  path.join(process.cwd(), "db", "migrations", "0108_app_manifests.sql"),
  // N8 fix (Checkup 2026-05-25, found by the e2e): 0069 + 0071 were NEVER
  // registered → workstream_evidence/workstream_decisions were missing → trace-repo
  // writeEvidence/writeDecision silently no-op'ed (N8 trace dark). Self-contained
  // (FK only on workstreams/0009), idempotent, append-only. Pulled in here.
  path.join(process.cwd(), "db", "migrations", "0069_workstream_evidence.sql"),
  path.join(process.cwd(), "db", "migrations", "0071_workstream_decisions.sql"),
  // 0109: Security-Critic CRITICAL #1 follow-up. Downgrades an already-seeded
  // owner-default permission row from 'freerein-with-audit' to 'ask' (defense-
  // in-depth). The real fail-open fix is in readWorkspacePermissionMode (no
  // owner-default fallback). Idempotent UPDATE guarded by set_by + old-mode.
  path.join(process.cwd(), "db", "migrations", "0109_permission_owner_default_ask.sql"),
  // 0110: subplan orchestration metadata — workstream_plan_steps.depends_on
  // (JSON step-ids) + group_id (affiliation). Idempotent ADD COLUMN (duplicate-
  // column tolerated). Feeds the parallel ready-queue executor (EXEC/UX-3).
  path.join(process.cwd(), "db", "migrations", "0110_plan_step_deps_group.sql"),
  // 0111: workspace path registry (Slice FS-1, 2026-05-26). New table
  // workspace_fs_roots — one workspace = 1..n local FS roots (CRM-Git +
  // Website-Git = ONE workspace). Closes the core gap in the workspace
  // isolation model (docs/plans/2026-05-26_workspace-isolation-model.md §4.1).
  // workspaces.path stays mirrored as the role='primary' root (backward-compat).
  path.join(process.cwd(), "db", "migrations", "0111_workspace_fs_roots.sql"),
  // 0112: Flow Studio P1 (2026-05-27). New tables flow_templates +
  // flow_steps + flow_runs (docs/plans/2026-05-27_flow-studio-architecture.md
  // §1). Purely additive: one flow_run produces ONE workstreams run
  // (flow_runs.workstream_id = bridge to the tier orchestrator), the steps are
  // mapped to plan steps via lib/flow/compile.ts. sop_id is a soft FK
  // (flow ≠ necessarily SOP, owner decision §7.4). IF NOT EXISTS, idempotent.
  path.join(process.cwd(), "db", "migrations", "0112_flow_studio.sql"),
  // 0113: Self-Learning / WHY-Engine Stream A (2026-05-27). New tables
  // workspace_beliefs (learning store: one active belief per topic per
  // workspace; superseded beliefs remain as history via supersedes_id) +
  // decision_outcomes (additively links decisions/workstreams with their
  // outcome — workstream_decisions is append-only). Makes the previously
  // write-only decision trail (0071) readable/learnable. Purely additive, IF NOT
  // EXISTS, idempotent. Source: GOAL-lazyos-self-learning-why-engine +
  // docs/plans/2026-05-27_self-learning-and-flow-completion-plan.md (Stream A).
  path.join(process.cwd(), "db", "migrations", "0113_workspace_beliefs.sql"),
  // 0114: user defaults (Owner-Fix live test 2026-05-28). A small
  // additive table `user_preferences` with `default_permission_mode`.
  // Holds the user toggle „Vollzugriff" system-wide, so that a newly
  // created workspace IMMEDIATELY carries the user default (yesterday it fell
  // back silently to 'ask', the owner had to re-toggle). Writer:
  // lib/users/preferences-repo.ts; read by POST /api/workspaces (seed of
  // the lazyos_permission_modes row) + GET /api/user/preferences (UI fallback
  // in AllAccessToggle). IF NOT EXISTS, idempotent.
  path.join(process.cwd(), "db", "migrations", "0114_user_preferences.sql"),
  // 0115 (2026-05-28): legacy-compat tickets table. The owner live test showed
  // 19 repeated `SqliteError: no such table: tickets` from 3 legacy routes
  // (cross-roast, inject, pause-status). Tickets are event-sourced in the
  // laz.ing model (db/schema/work_products.ts:10 verbatim) — the 3 routes were
  // not migrated. This migration creates an empty compat table so that
  // the routes return valid empty results instead of 500. A real refactor to
  // event-sourcing follows as its own slice.
  path.join(process.cwd(), "db", "migrations", "0115_tickets_legacy_compat.sql"),
  // 0116 (2026-05-29): Track-D repro persistence. Additive columns on
  // flow_runs — req_id (request correlation UI ↔ server log ↔ DB),
  // error_message + error_code (N8: trace is evidence). This lets
  // composeAndRun write a pending stub IMMEDIATELY after a successful compose
  // — also in the needs-coupling/needs-style-choice/compose-error
  // path. Closes master-context §10 finding 2 (Owner: "Innerhalb des
  // kurzen Waits kam keine klare Flow-Antwort/Surface zurück. Es wurde
  // im kurzen Check kein neuer flow_run und kein neuer workstream
  // sichtbar.").
  path.join(
    process.cwd(),
    "db",
    "migrations",
    "0116_flow_runs_repro_persistence.sql",
  ),
  // 0117 (2026-05-29): question_answers — structured answer store
  // for open-questions (Phase 1 Track AB · Finding B). Today the
  // envelope (workspaceId/workstreamId/flowRunId/planId/questionSetId/
  // questionId/sourceTurnId/surfaceId) is lost in the „Frage:.../Antwort:..." text
  // block. This table persists it structured, idempotent via
  // UNIQUE(content_hash) + UNIQUE(source_turn_id, question_id). Writer:
  // app/api/chat/answer/route.ts; hydration: GET the same route.
  path.join(process.cwd(), "db", "migrations", "0117_question_answers.sql"),
  // 0118 (2026-05-29): Phase 2 W2.1 · Lane G Governance — FUNDAMENTAL lane
  // (Stage 1, Governance Gate Contract). Three additive tables:
  //   consent_grants    — §13.2 opt-in / pause-stop / review obligation.
  //                       Append-only via trigger; revoked_at-only update.
  //                       reason_text VERBATIM (N1), content_hash (N10).
  //   source_traces     — raw/derived provenance chain per workspace.
  //   governance_audit  — N8 trace-as-evidence; append-only trigger.
  // It defines what EVERY other lane may/must do (plan-execute, connector
  // invoke, spawn, persist-belief, …). Read/write layer:
  // lib/governance/{consent,no-auto-run,source-trace,audit,retention}.ts.
  path.join(process.cwd(), "db", "migrations", "0118_governance_consent.sql"),
  // 0119 (2026-05-29): Phase 2 W2.2 · Lane A Communication Intake.
  //   intake_events — verbatim substrate (N1) for incoming communication
  //   (WhatsApp/Telegram/Voice/Meeting/...). source_kind = DataSource (1:1
  //   lib/governance/consent.ts). No-auto-run FSM (§7.2): fsm_state
  //   staged → classified → ready-for-compile, plus blocked. nudge_class
  //   (urgent|decision-needed|info-only|noise) from step 3 on. content_hash
  //   (N10) → idempotency. Append-only-light trigger (N8): no DELETE, no
  //   core mutation; UPDATE only on nudge_class/fsm_state/speaker_local_id/
  //   updated_at. Lane B (0120) reads from it later — human-gated, no
  //   auto-run. Schema: db/schema/intake_events.ts. Master-Briefing §25.1 +
  //   §7.2 + §7.3. Purely additive, IF NOT EXISTS, idempotent.
  path.join(process.cwd(), "db", "migrations", "0119_intake_events.sql"),
  // 0120 (2026-05-29): Phase 2 W2.2 · Lane B Expertise Compiler.
  //   knowledge_forms — one table with a kind column for the 12 knowledge forms
  //   (§8.2: glossary | principle | if-then-rule | exception | tactic |
  //   role-judgment | handoff-dependency | quality-criterion | simulation-case
  //   | eval-question | sop-step | open-unknown). statement/rationale/term/
  //   example_cases_json/counter_cases_json VERBATIM (N1). review_state
  //   (pending-review|approved|rejected|superseded). Approved knowledge_forms
  //   are mirrored AFTER human review via upsertBelief (lib/reasoning/beliefs-repo.ts)
  //   into workspace_beliefs (0113) — back-FK in source_json.beliefId
  //   (N4: no separate belief writer, no blind duplicate storage). Append-only-
  //   light trigger (N8). content_hash (N10). Schema: db/schema/knowledge_forms.ts.
  //   Master-Briefing §8 + integration plan §4 Lane B outputs. Purely additive,
  //   IF NOT EXISTS, idempotent.
  path.join(process.cwd(), "db", "migrations", "0120_expertise_knowledge_forms.sql"),
  // 0121 (2026-05-29): Phase IN · Lane D Innovation Mode.
  //   innovation_artifacts — one table with a kind column for the Innovation-
  //   Mode outputs (§10.4: assumption | reframe | cross-domain-analogy |
  //   contrarian-roast | concept-node | concept-edge). content/source_json
  //   VERBATIM (N1). Append-only — trigger blocks every UPDATE + DELETE (N8);
  //   a correction is a new row with supersedes_id. content_hash (N10).
  //   The contrarian roast reuses the existing counter-evidence
  //   surface logic (lib/reasoning/reconcile.ts, N4). Schema:
  //   db/schema/innovation_artifacts.ts. Master-Briefing §10. Purely additive,
  //   IF NOT EXISTS, idempotent.
  path.join(process.cwd(), "db", "migrations", "0121_innovation_artifacts.sql"),
  // Phase 2 W2.3 · Lanes C/E/F Engines (2026-05-29) — lane_artifacts (ONE
  // table, kind discriminator). Lane C Role Reverse Engineering · Lane E
  // Toolstack Replacement · Lane F Mobile Human-in-the-Loop (on lib/push, N4).
  //   Engines: lib/lanes/{role-reverse,toolstack,mobile-hitl}/. Append-only
  //   (N8/N10). Schema: db/schema/lane_artifacts.ts. Purely additive, IF NOT
  //   EXISTS, idempotent.
  path.join(process.cwd(), "db", "migrations", "0122_lane_artifacts.sql"),
  // Sub-Chats (2026-06-02, Gathering-Intelligence-Goal) — group chats per
  // workspace + append-only messages, knowledge flows into the RAG.
  path.join(process.cwd(), "db", "migrations", "0123_subchats.sql"),
  path.join(process.cwd(), "db", "migrations", "0124_subchat_attachments.sql"),
  // Sub-Chats read marker (2026-06-02, P2) — basis for the unread badge.
  path.join(process.cwd(), "db", "migrations", "0125_subchat_read_markers.sql"),
  // Proactive suggestions (2026-06-02) — server-pre-generated operator suggestion
  // per EXTERNAL sub-chat message (claude-gated, best-effort).
  path.join(process.cwd(), "db", "migrations", "0126_proactive_suggestions.sql"),
  // 0127 (2026-06-03) — claude_sessions rotation bookkeeping (degrade→handoff→
  // rotate). Registered here too, so a Next-first boot creates the columns
  // (idempotent; the agent-server runner has them as well).
  path.join(process.cwd(), "db", "migrations", "0127_session_rotation.sql"),
  // 0128 (2026-06-03) — question-spinning in sub-/group chats: spun-up
  // questions + extendable options + answers per participant (append-only,
  // workspace-scoped). Sequentially prominent pill like in the main chat.
  path.join(process.cwd(), "db", "migrations", "0128_subchat_questions.sql"),
  // 0129 (2026-06-03) — „Mitarbeiter" profiles: named, reusable
  // role + allow-listed capability bundle (skills/MCP/SOPs/APIs +
  // ManifestCoord), ad-hoc spawnable (no permanent agent user).
  path.join(process.cwd(), "db", "migrations", "0129_agent_profiles.sql"),
  // 0130 (2026-06-03) — flow parametrization: params_json (template) + io_json
  // (step) for {{param.*}} interpolation → workflows become reusable instead of
  // merely reproducible. Additive, NULL = today's behavior.
  path.join(process.cwd(), "db", "migrations", "0130_flow_params.sql"),
  path.join(process.cwd(), "db", "migrations", "0131_pii_vault.sql"),
];

let cached: LazyDb | null = null;

export function getDb(): LazyDb {
  if (cached) return cached;

  // 1. Ensure parent dir exists (locally) — /tmp always exists.
  const parent = path.dirname(DB_PATH);
  mkdirSync(parent, { recursive: true });

  // 2. Open connection.
  const raw = new Database(DB_PATH);
  raw.pragma("journal_mode = WAL");
  // Test hook (Pattern 5 Welle 3, 2026-05-01): in tests the DB is
  // initially empty, and migration 0036 (suborgs_restore) references parent
  // org IDs that exist in the real setup but not in tests. We
  // allow tests to disable FK checks — the production path stays ON.
  if (process.env.LAZYOS_TEST_DISABLE_FK === "1") {
    raw.pragma("foreign_keys = OFF");
  } else {
    raw.pragma("foreign_keys = ON");
  }
  raw.pragma("busy_timeout = 5000");

  // 3. Run migrations (idempotent, in order).
  //
  // Strategy (TD-2 fix 2026-04-26): better-sqlite3's `Database.exec()` parses
  // and runs multi-statement SQL natively — including multi-line statements
  // like `CREATE UNIQUE INDEX ... WHERE entity_type='chat_message' AND ...`,
  // where the WHERE clause spans lines and a regex split on `;\s*$/m` would
  // wrongly chop the statement. Try the whole file at once first.
  //
  // Fallback: SQLite `ALTER TABLE ADD COLUMN` is not idempotent → it
  // throws "duplicate column name" on the second run, and `exec()` aborts the
  // whole file on the first error. When we see the error, we fall back to
  // statement-by-statement and swallow ONLY the duplicate-column
  // error. Other errors are re-thrown.
  //
  // FK-during-migration (2026-05-24): migrations are trusted
  // schema changes. A DDL statement (e.g. ALTER TABLE … ADD COLUMN) triggers
  // under `foreign_keys=ON` an FK revalidation that fails on PRE-EXISTING
  // orphan rows (this DB has e.g. a `workspaces` row pointing to a
  // deleted `organizations` row — fkid 0). That made getDb() crash at
  // migration 0099 with "FOREIGN KEY constraint failed". Standard
  // practice (Rails/Django/SQLite docs): disable FK enforcement DURING the
  // migration, then restore it. Creates no new violations — the
  // orphan row was already there and is tolerated at runtime.
  const fkRestore = process.env.LAZYOS_TEST_DISABLE_FK === "1" ? "OFF" : "ON";
  raw.pragma("foreign_keys = OFF");
  for (const migrationPath of MIGRATIONS) {
    if (!existsSync(migrationPath)) continue;
    const migrationSql = readFileSync(migrationPath, "utf8");
    try {
      raw.exec(migrationSql);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name/i.test(msg)) throw err;
      // Per-statement fallback for idempotent re-runs of ALTER TABLE ADD COLUMN.
      const statements = migrationSql
        .split(/;\s*$/m)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.match(/^\s*--/));
      for (const stmt of statements) {
        try {
          raw.exec(stmt);
        } catch (e: unknown) {
          const m = e instanceof Error ? e.message : String(e);
          if (/duplicate column name/i.test(m)) continue;
          throw e;
        }
      }
    }

    // Phase Vers: append-only insert into `schema_version` per applied
    // migration. Idempotent via INSERT OR IGNORE on the numeric PK
    // — a re-boot with the same migration does not overwrite the row.
    // We place this after the actual migration apply, so that the
    // table only exists after 0021_schema_version.sql. If it is not yet
    // there (earlier migration file), swallow the error silently.
    try {
      const filename = path.basename(migrationPath);
      const versionMatch = /^(\d+)_/.exec(filename);
      if (versionMatch) {
        const version = Number.parseInt(versionMatch[1], 10);
        raw
          .prepare(
            `INSERT OR IGNORE INTO schema_version (version, filename, schema_hash, applied_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(version, filename, '', Date.now());
      }
    } catch (e: unknown) {
      // The table only exists from migration 0021 — earlier the insert stays silent.
      const m = e instanceof Error ? e.message : String(e);
      if (!/no such table/i.test(m)) throw e;
    }
  }
  // Restore the configured FK-enforcement state for all runtime queries.
  raw.pragma(`foreign_keys = ${fkRestore}`);

  // 4. Build drizzle wrapper + attach raw handle for low-level queries.
  const db = Object.assign(drizzle(raw, { schema }), { $raw: raw }) as LazyDb;

  // 5. Phase AU.2.2 — first-boot detection. Once per boot we check whether
  // the instance is still empty (no users) and print a clear banner.
  // No auto-run — informational only. Self-hosters should run
  // `lazyos-setup.ts` or use the operator bootstrap path on /login.
  try {
    const userCount = raw
      .prepare("SELECT COUNT(*) AS c FROM users WHERE status = 'active'")
      .get() as { c?: number } | undefined;
    if ((userCount?.c ?? 0) === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        [
          "",
          "  ┌─────────────────────────────────────────────────────────────┐",
          "  │  lazyOS: database has no active users yet.                   │",
          "  │                                                             │",
          "  │  → run `pnpm tsx scripts/lazyos-setup.ts`,                  │",
          "  │    or log in on /login with the operator bootstrap          │",
          "  │    code (LAZYOS_ACCESS_CODE).                               │",
          "  └─────────────────────────────────────────────────────────────┘",
          "",
        ].join("\n"),
      );
    }
  } catch {
    // The users table may not exist yet (very early boot). Ignore.
  }

  cached = db;

  // Sub-Plan 01c (2026-04-29) — boot stuck-check + interval loop. Detects
  // workstreams that were in an `await sleep(...)` pause
  // window after a service restart and have been inactive since, but DB state
  // still says `active`. Marks them as `stuck`. The UI offers resume.
  try {
    // Async import to avoid the circular-dep risk (stuck-detector
    // needs getDb itself).
    void import('../lib/workstreams/stuck-detector').then((m) => {
      try {
        const result = m.runBootStuckCheck();
        if (result.marked.length > 0) {
          // eslint-disable-next-line no-console
          console.warn(
            `[stuck-detector] boot scan marked ${result.marked.length} workstream(s) as stuck:`,
            result.marked.join(', '),
          );
        }
      } catch (err) {
        console.warn('[stuck-detector] boot scan failed:', err);
      }
      try {
        m.startStuckDetectorLoop(60_000);
      } catch (err) {
        console.warn('[stuck-detector] loop-start failed:', err);
      }
    });
  } catch (err) {
    console.warn('[stuck-detector] init failed:', err);
  }

  return db;
}

export function getDbPath(): string {
  return DB_PATH;
}

/**
 * Test/debug escape hatch — drops the cached connection so the next call
 * re-opens. Used in tests, never in production code paths.
 */
export function __resetDbCacheForTests(): void {
  if (cached) {
    try {
      cached.$raw.close();
    } catch {
      // ignore
    }
  }
  cached = null;
}
