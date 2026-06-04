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
// BACKPORT-01 (chat_ledger) + BACKPORT-03 (recursive-plans) Schemas:
import * as chatLedgerSchema from "./schema/chat_ledger";
import * as workstreamPlanStepsSchema from "./schema/workstream_plan_steps";
import * as workstreamPlanCriticsSchema from "./schema/workstream_plan_critics";
// SAR-2 (2026-05-24) — SOP-Framework: sops + sop_steps.
import * as sopsSchema from "./schema/sops";
// Slice FS-1 (2026-05-26) — Workspace-Path-Registry: workspace_fs_roots.
import * as workspaceFsRootsSchema from "./schema/workspace_fs_roots";
// Flow Studio P1 (2026-05-27) — flow_templates + flow_steps + flow_runs.
import * as flowTemplatesSchema from "./schema/flow_templates";
import * as flowStepsSchema from "./schema/flow_steps";
import * as flowRunsSchema from "./schema/flow_runs";
// Self-Learning / WARUM-Engine Stream A (2026-05-27) — workspace_beliefs +
// decision_outcomes (Workspace-ReasoningBank + Post-Prozess-Abgleich).
import * as workspaceBeliefsSchema from "./schema/workspace_beliefs";
// Sub-Chats (2026-06-02, Gathering-Intelligence-Goal) — Gruppenchats pro
// Workspace (extern/intern) deren Wissen in die RAG fließt.
import * as subchatsSchema from "./schema/subchats";
// Sub-Chats Read-Marker (2026-06-02, P2) — pro (Sub-Chat, User) Last-Read-Cutoff
// für den Unread-Badge im Hauptchat.
import * as subchatReadMarkersSchema from "./schema/subchat_read_markers";
// Server-pre-generierte proaktive Operator-Vorschläge (2026-06-02, Proactivity-Goal).
import * as proactiveSuggestionsSchema from "./schema/proactive_suggestions";
// User-Defaults (2026-05-28, Owner-Fix) — system-übergreifender Default
// für Permission-Mode (und künftige cross-workspace Settings).
import * as userPreferencesSchema from "./schema/user_preferences";
// Strukturierter Open-Question-Antwort-Speicher (2026-05-29, Phase 1
// Track AB · Befund B) — workspaceId/workstreamId/flowRunId/planId/
// questionSetId/questionId/sourceTurnId/surfaceId statt nur
// „Frage:.../Antwort:..."-Textblock.
import * as questionAnswersSchema from "./schema/question_answers";
// Phase 2 W2.1 · Lane G Governance (2026-05-29, Migration 0118) —
// consent_grants + source_traces + governance_audit. FUNDAMENTAL-Lane
// (Stage 1, Governance Gate Contract) — definiert was JEDE andere Lane
// darf/muss. Master-Briefing §13.2 + §7.2.
import * as consentGrantsSchema from "./schema/consent_grants";
// Phase 2 W2.2 · Lane A Communication Intake (2026-05-29, Migration 0119) —
// intake_events. Verbatim-Substrat fuer WhatsApp/Telegram/Voice/Meeting-
// Kommunikation; no-auto-run-FSM (§7.2). Master-Briefing §25.1 + §7.3.
import * as intakeEventsSchema from "./schema/intake_events";
// Phase 2 W2.2 · Lane B Expertise Compiler (2026-05-29, Migration 0120) —
// knowledge_forms (die 12 Wissensformen, §8.2). Approved knowledge_forms
// werden via lib/lanes/expertise-compiler/mirror-to-beliefs.ts in
// workspace_beliefs (0113) gespiegelt (N4: kein eigener Belief-Writer).
import * as knowledgeFormsSchema from "./schema/knowledge_forms";
// Phase IN · Lane D Innovation Mode (2026-05-29, Migration 0121) —
// innovation_artifacts (Assumption-Map · Reframe-Set · Cross-Domain-Analogien ·
// Contrarian-Roast · Concept-Graph, §10.4). Append-only Evidenz (N8/N10).
import * as innovationArtifactsSchema from "./schema/innovation_artifacts";
// Phase 2 W2.3 · Lanes C/E/F Engines (2026-05-29, Migration 0122) —
// lane_artifacts (EINE Tabelle, kind-Diskriminator). Lane C Role Reverse
// Engineering · Lane E Toolstack Replacement · Lane F Mobile Human-in-the-Loop
// (Lane F setzt auf lib/push/* auf, N4). Append-only Evidenz (N8/N10).
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
  // Phase ORG+1 (2026-04-28) — Encryption:
  ...workspaceKeysSchema,
  // Phase ORG+2 (2026-04-28) — Share-Tokens:
  ...shareTokensSchema,
  // Pattern 5 Traceability (2026-05-01) — Reasoning-Audit:
  ...reasoningAuditSchema,
  // Pattern 6a Telemetrie (2026-05-01) — Push-Rule-Overrides:
  ...pushRuleOverridesSchema,
  // Pattern 4 Foundation (2026-05-01) — Workflow-Runs:
  ...workflowRunsSchema,
  // P14 Echter Pattern 9 "Unlearning" (2026-05-01) — Failed-Experiments:
  ...failedExperimentsSchema,
  // GitHub-Integration Backport (2026-05-23, Agent 3/8) — Lazing-V2.
  ...githubSchema,
  // Org-Level GitHub-Integration (2026-05-24, Slice A) — Migration 0096.
  ...orgGithubSchema,
  // BACKPORT-01 (2026-05-23, Agent 1/8) — chat_ledger N1-verbatim Foundation.
  ...chatLedgerSchema,
  // BACKPORT-03 (2026-05-23, Agent 3/8) — Recursive Plans + Critic-Loop FSM.
  ...workstreamPlanStepsSchema,
  ...workstreamPlanCriticsSchema,
  // SAR-2 (2026-05-24) — SOP-Framework: sops + sop_steps.
  ...sopsSchema,
  // Slice FS-1 (2026-05-26) — Workspace-Path-Registry: workspace_fs_roots.
  ...workspaceFsRootsSchema,
  // Flow Studio P1 (2026-05-27) — flow_templates + flow_steps + flow_runs.
  ...flowTemplatesSchema,
  ...flowStepsSchema,
  ...flowRunsSchema,
  // Self-Learning / WARUM-Engine Stream A (2026-05-27) — workspace_beliefs +
  // decision_outcomes (Workspace-ReasoningBank + Post-Prozess-Abgleich).
  ...workspaceBeliefsSchema,
  // Sub-Chats (2026-06-02, Gathering-Intelligence-Goal).
  ...subchatsSchema,
  // Sub-Chats Read-Marker (2026-06-02, P2).
  ...subchatReadMarkersSchema,
  // Proaktive Vorschläge (2026-06-02, Proactivity-Goal).
  ...proactiveSuggestionsSchema,
  // User-Defaults (2026-05-28, Owner-Fix) — systemübergreifender Default
  // für Permission-Mode etc.
  ...userPreferencesSchema,
  // Strukturierter Open-Question-Antwort-Speicher (2026-05-29, Phase 1
  // Track AB · Befund B).
  ...questionAnswersSchema,
  // Phase 2 W2.1 · Lane G Governance (2026-05-29, Migration 0118) —
  // consent_grants + source_traces + governance_audit. FUNDAMENTAL-Lane
  // (Stage 1, Governance Gate Contract).
  ...consentGrantsSchema,
  // Phase 2 W2.2 · Lane A Communication Intake (2026-05-29, Migration 0119) —
  // intake_events (verbatim-Substrat, no-auto-run-FSM).
  ...intakeEventsSchema,
  // Phase 2 W2.2 · Lane B Expertise Compiler (2026-05-29, Migration 0120) —
  // knowledge_forms (die 12 Wissensformen); Belief-Spiegelung via
  // lib/lanes/expertise-compiler/mirror-to-beliefs.ts (N4).
  ...knowledgeFormsSchema,
  // Phase IN · Lane D Innovation Mode (2026-05-29, Migration 0121) —
  // innovation_artifacts (§10.4 Artefakte vor Build). Append-only (N8/N10).
  ...innovationArtifactsSchema,
  // Phase 2 W2.3 · Lanes C/E/F Engines (2026-05-29, Migration 0122) —
  // lane_artifacts (Role Reverse Engineering · Toolstack Replacement ·
  // Mobile Human-in-the-Loop). Append-only Evidenz (N8/N10).
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
  // 0010 ist bewusst freigehalten fuer den Self-Calibration-Index
  // (Phase C). Siehe db/migrations/MIGRATION-NOTES.md.
  path.join(process.cwd(), "db", "migrations", "0011_skills.sql"),
  path.join(process.cwd(), "db", "migrations", "0012_cloud.sql"),
  path.join(process.cwd(), "db", "migrations", "0013_workspace_notes.sql"),
  path.join(process.cwd(), "db", "migrations", "0014_workspace_credentials.sql"),
  path.join(process.cwd(), "db", "migrations", "0015_workspace_brand.sql"),
  path.join(process.cwd(), "db", "migrations", "0017_client_visibility.sql"),
  path.join(process.cwd(), "db", "migrations", "0018_streaming_snapshots.sql"),
  // 0019, 0020 sind reserviert fuer Phase H+I (Sub-Ticket-Spawner /
  // Tier-Orchestrator). Phase Vers haengt deshalb an 0021 an — siehe
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
  // Phase QA (2026-04-28): TPM-Budget-Manager
  path.join(process.cwd(), "db", "migrations", "0030_tpm_tracker.sql"),
  // Phase MU.1 (2026-04-28): Multi-User-MAX-Plan-Tokens
  path.join(process.cwd(), "db", "migrations", "0031_phase_mu_user_creds.sql"),
  // Phase MU.4 (2026-04-28): TPM-Tracking pro User
  path.join(process.cwd(), "db", "migrations", "0032_tpm_user_id.sql"),
  // 2026-04-28: Org-Legal-Felder für rechtliche Outbound-Docs
  path.join(process.cwd(), "db", "migrations", "0033_org_legal_fields.sql"),
  // Phase IA.4 (2026-04-29): Org-Root-Chats — pro Org ein virtueller WS
  // mit ID `__org_root__:<orgId>` für scoped Chat-Kontext.
  path.join(process.cwd(), "db", "migrations", "0034_org_root_chats.sql"),
  // Phase IA-Konsolidierung (2026-04-29): workspace_type + Re-Map aller
  // Eigen-/Kunden-Workspaces unter Example Company.
  path.join(process.cwd(), "db", "migrations", "0035_workspace_type_and_consolidation.sql"),
  // Phase IA-Konsolidierung Re-Fix (2026-04-29): Sub-Org-Hierarchie wieder
  // herstellen. Demo PV (CRM+Web) als Sub-Org von PA-LLC, etc.
  path.join(process.cwd(), "db", "migrations", "0036_suborgs_restore.sql"),
  // Phase IA-Konsolidierung Type-Fix (2026-04-29): Example App + example-tool als product
  // (waren versehentlich als client/tool klassifiziert).
  path.join(process.cwd(), "db", "migrations", "0037_fix_org_types.sql"),
  // Phase Sub-WS (Sprint C, 2026-04-29): Sub-Workstreams als first-class.
  // parent_workstream_id + role + tmux_session_id + tokens_in/out + cost.
  path.join(process.cwd(), "db", "migrations", "0040_sub_workstreams.sql"),
  // Phase Tier-Lock (2026-04-30): Workstream-Mode + Iterate-Config +
  // Dispatch-Lock. mode + iterate_config_json + dispatch_lock_token +
  // dispatch_lock_ts. Sub-Plan A + G aus Master-Plan 2026-04-30.
  path.join(process.cwd(), "db", "migrations", "0041_workstream_mode.sql"),
  // Sprint 2 RAG-Foundation (2026-04-30): rag_chunks + rag_indexer_state.
  path.join(process.cwd(), "db", "migrations", "0042_rag_index.sql"),
  // Sprint 3 (2026-04-30): User-2FA TOTP + Recovery-Codes + Pending-Sessions.
  path.join(process.cwd(), "db", "migrations", "0043_user_2fa.sql"),
  // Pattern 5 Traceability (2026-05-01): reasoning_audit für Hallucination-
  // Detection. Persist Inputs+Outputs+Hashes pro LLM-Call (Tier-Spawn /
  // Synthesis / Sniper). Adressiert Critic-Befund "Audit-Log nur Auth, kein
  // Reasoning-Trail" + Stanford-Studie 1/6 Halluzinations-Rate.
  path.join(process.cwd(), "db", "migrations", "0044_reasoning_audit.sql"),
  // Pattern 6a Telemetrie (2026-05-01): push_rule_overrides für adaptive
  // Decay-Logik. Phase 6b (decay.ts) folgt nach 7d Telemetrie-Vorlauf.
  path.join(process.cwd(), "db", "migrations", "0045_push_rule_overrides.sql"),
  // Pattern 5 Welle 3 (2026-05-01): optional Klartext-Prompts für Drift-
  // Verifikations-Re-Spawn. ALTER TABLE ADD COLUMN — duplicate-column-Fallback
  // unten greift bei zweitem Run.
  path.join(process.cwd(), "db", "migrations", "0046_add_prompt_text_columns.sql"),
  // Pattern 4 Foundation (2026-05-01): workflow_runs — kodifizierte Domain-
  // Workflows (dev-sprint, field-measurement, legal-brief, ...).
  // Adressiert Critic-VETO-3 + Anne (Legaly-AI): Methodik als deterministischer
  // FSM-Code statt Markdown-Prompt-Wall.
  path.join(process.cwd(), "db", "migrations", "0050_workflow_runs.sql"),
  // P14 (2026-05-01): Echter Pattern 9 "Unlearning" — failed_experiments.
  // Korrektur User-Feedback: Anne meint persönliche Arbeitshaltung (Annahmen
  // verwerfen + experimentieren), NICHT File-Cleanup. Weekly-Retry-Sniper
  // probiert unresolved Experiments nach 14d mit aktuellem Modell erneut.
  path.join(process.cwd(), "db", "migrations", "0047_experiment_tracker.sql"),
  // P16 (2026-05-01): Sandbox-Mode pro Workspace — Constraint-as-Enabler
  // (Anne: „Spielfeld klar abgesteckt, dann Entscheidungen frei zulassen").
  // Auto-Approve in Sandbox + Push-Suppression für Routine-Events.
  // Safety: NUR aktivierbar wenn sensitivity='low'. Loop-Guard bleibt aktiv.
  path.join(process.cwd(), "db", "migrations", "0048_workspace_sandbox_mode.sql"),
  // 2026-05-01 — Workstream-Intent-Classification. Macht Idee/Bug-Fix/
  // Implementation visuell unterscheidbar (User-Befund "Unterschied zwischen
  // Implementierung und Ideen noch nicht klar"). Spalte intent + Index.
  path.join(process.cwd(), "db", "migrations", "0051_workstream_intent.sql"),
  // 2026-04-30 — Workspace-isolierte RAG (DSGVO/AVV § 28 Mandantentrennung).
  // Defense-in-Depth: Trigger-FK auf rag_chunks.workspace_id, Read-only-View
  // v_rag_chunks_workspace, Audit-Tabelle fuer Cross-Workspace-Reads.
  // Plan: docs/plans/2026-04-30_workspace-rag-isolation.md
  path.join(process.cwd(), "db", "migrations", "0052_workspace_rag_isolation.sql"),
  // 2026-05-03 — Workspace-Context-Group für User-driven Sub-Segmentierung
  // innerhalb einer Org (z.B. Demo PV: CRM + Web als 2 WS unter
  // einem Sub-Header). User-Befund 2026-05-03. Plan:
  // docs/plans/2026-05-03_workspace-create-ui.md
  path.join(process.cwd(), "db", "migrations", "0053_workspace_context_group.sql"),
  // 2026-05-23 — OSS-Onboarding-State (Phase OSS-WIZ.1). Eigene 5-Step-
  // Wizard-Reise (Engine/Workspace/GitHub/Push) parallel zur Cloud-Onboarding-
  // Reise. User-Befund 2026-05-23: "wäre ja hier wichtig, dass es ein OSS
  // Onboarding gibt, wie z.B. bei lazing es das gab".
  path.join(process.cwd(), "db", "migrations", "0054_oss_onboarding_state.sql"),
  // 2026-05-23 — GitHub-Integration Backport von Lazing-V2 (Agent 3/8).
  // github_credentials (PAT-primary, OAuth-secondary, AES-256-GCM encrypted)
  // + workspace_github_repos (N:1 Repo→Workspace Mapping). Quelle:
  // lazing-wt/realtime-orchestrator-v2 packages/runtime/src/store/
  // migrations/012-github-substrate.ts.
  path.join(process.cwd(), "db", "migrations", "0092_workspace_github_repos.sql"),
  // 2026-05-23 — BACKPORT-01 (chat_ledger) von Lazing-V2 (Agent 1/8). N1-verbatim
  // chat-ledger als Foundation für Conversation-Memory + N10 tamper-evidence.
  // Quelle: lazing-wt/realtime-orchestrator-v2 packages/runtime/src/store/
  // migrations/014-chat-ledger.ts.
  path.join(process.cwd(), "db", "migrations", "0093_chat_ledger.sql"),
  // 2026-05-23 — BACKPORT-03 (recursive-plans + critic-loop) von Lazing-V2
  // (Agent 3/8). workstream_plan_steps + workstream_plan_critics. Quelle:
  // lazing-wt/realtime-orchestrator-v2 packages/runtime/src/store/
  // migrations/011-recursive-plans.ts. Lazyos-stable Delta: legt
  // workstream_plan_steps neu an (V2 erweitert nur die depth-Spalte).
  path.join(process.cwd(), "db", "migrations", "0094_recursive_plans.sql"),
  // 2026-05-23 — BACKPORT-01 ergänzt (Agent 1/8). Erweitert workstreams um
  // snapshot_json/at/content_hash + manifestation_payload/kind. Quelle:
  // lazing-wt/realtime-orchestrator-v2 packages/runtime/src/store/migrations/
  // 015-streaming-snapshots.ts (Slice DB + SURFACE-PERSIST).
  path.join(process.cwd(), "db", "migrations", "0095_workstream_snapshots_v2.sql"),
  // 2026-05-24 — Org-Level GitHub-Integration (Slice A). Neue Tabelle
  // `org_github_credentials` (Org-scoped, UNIQUE(org_id), AES-256-GCM).
  // Isolation: jede Org hat max. 1 GitHub-Connection; API prüft
  // assertOrgRole + WHERE org_id = ?. Schema: db/schema/org_github.ts.
  path.join(process.cwd(), "db", "migrations", "0096_org_github_credentials.sql"),
  // 2026-05-24 — Lexical-RAG FTS5 (N7: lexical before vector). FTS5-Virtual-
  // Table `rag_chunks_fts` über rag_chunks.text mit content-table-Link (rowid).
  // Drei Trigger (AFTER INSERT/UPDATE/DELETE) halten die FTS synchron.
  // Backfill via FTS5 'rebuild' command. Retriever: lexical-first BM25 → ggf.
  // Cosine-Rerank → Fallback auf reinen Cosine-Pfad wenn FTS 0 Treffer.
  path.join(process.cwd(), "db", "migrations", "0097_rag_fts.sql"),
  // 2026-05-24 — Permission-Foundation Wave 1 (ADR-0004 / POS-1 / Batch 4).
  // Neue Tabellen: lazyos_permission_modes (workspace/org-scoped mode) +
  // lazyos_permission_audit (append-only op-decision-log, N8/N10 content_hash).
  // Phase-1-Default: 'freerein-with-audit' (audit-only, nie blockierend).
  // Enforcement via LAZYOS_PERMISSION_ENFORCEMENT ENV (default 'audit').
  path.join(process.cwd(), "db", "migrations", "0098_permission.sql"),
  // 2026-05-24 — SAR-2: SOP-Framework (Standard Operating Procedures).
  // Neue Tabellen: sops (plan-skeleton templates, global/workspace-scoped) +
  // sop_steps (geordnete Steps, N1-full-prompt, N10-content_hash).
  // Binding-Spalten an routines: sop_id, goal_prompt, skill_bindings_json,
  // mcp_tool_allowlist_json, action_kind DEFAULT 'shell' (backward-compat).
  path.join(process.cwd(), "db", "migrations", "0099_sops.sql"),
  // 2026-05-24 — API Connector Layer (ACL).
  // 0100: api_credentials (generischer Vault, org+workspace scope, provider) +
  //       credential_access_log (N8). 0101: connector_catalog + connector_
  //       capabilities (platform-global, nicht-sensitiv, ADR-0006/N2-Abgrenzung).
  //       0102: workspaces.credential_isolation ('inherit'|'isolated', D2).
  path.join(process.cwd(), "db", "migrations", "0100_api_credentials.sql"),
  path.join(process.cwd(), "db", "migrations", "0101_connector_catalog.sql"),
  path.join(process.cwd(), "db", "migrations", "0102_workspace_credential_isolation.sql"),
  // 0103: connector-onboarding-SOP (ACL-4) — built-in SOP, die der Auto-Connect-
  // „Profil fehlt"-Pfad referenziert. (Checkup 2026-05-24: war versehentlich
  // nie registriert → nur 3 statt 4 SOPs in der DB.)
  path.join(process.cwd(), "db", "migrations", "0103_connector_onboarding_sop.sql"),
  // 0104: connector_catalog_audit (N8-Trace für Katalog-Writes, best-effort).
  path.join(process.cwd(), "db", "migrations", "0104_connector_catalog_audit.sql"),
  // 0105: ACL-5 connector_call_approvals (trust ask|auto, default ask=fail-closed)
  //       + connector_call_audit (N8/N10, payload_hash statt payload).
  path.join(process.cwd(), "db", "migrations", "0105_connector_calls.sql"),
  // 0106: org_github_token_use_audit (N8-Trace bei Org-Token-Nutzung, best-effort).
  path.join(process.cwd(), "db", "migrations", "0106_org_github_token_use_audit.sql"),
  // 0107: R2-Gate scharf — allowed_tools pro Plan-Step (nullable JSON-Array).
  //       NULL → konservativer Default ["Read","Grep"] in plan-executor.ts.
  //       Befüllt von SOP-Step-Dispatch (mcp_tool_allowlist_json) oder freien
  //       Plan-Nodes mit allowedTools. Idempotent via duplicate-column-Fallback.
  path.join(process.cwd(), "db", "migrations", "0107_plan_step_allowed_tools.sql"),
  // 0108: App-Store/MCP-Lifecycle (Batch 7d) — app_manifests + app_installs +
  // app_install_audit. Foundation; echter Activate/OAuth-Connect R3-gated.
  path.join(process.cwd(), "db", "migrations", "0108_app_manifests.sql"),
  // N8-Fix (Checkup 2026-05-25, vom e2e gefunden): 0069 + 0071 waren NIE
  // registriert → workstream_evidence/workstream_decisions fehlten → trace-repo
  // writeEvidence/writeDecision no-op'ten still (N8-Trace dunkel). Self-contained
  // (FK nur auf workstreams/0009), idempotent, append-only. Hier nachgezogen.
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
  // 0111: Workspace-Path-Registry (Slice FS-1, 2026-05-26). Neue Tabelle
  // workspace_fs_roots — ein Workspace = 1..n lokale FS-Roots (CRM-Git +
  // Website-Git = EIN Workspace). Schließt die Kern-Lücke aus dem Workspace-
  // Isolation-Modell (docs/plans/2026-05-26_workspace-isolation-model.md §4.1).
  // workspaces.path bleibt als role='primary'-Root gespiegelt (Rückwärtskompat).
  path.join(process.cwd(), "db", "migrations", "0111_workspace_fs_roots.sql"),
  // 0112: Flow Studio P1 (2026-05-27). Neue Tabellen flow_templates +
  // flow_steps + flow_runs (docs/plans/2026-05-27_flow-studio-architecture.md
  // §1). Rein additiv: ein flow_run erzeugt EINEN workstreams-Run
  // (flow_runs.workstream_id = Brücke zum tier-orchestrator), die Steps werden
  // via lib/flow/compile.ts auf Plan-Steps gemappt. sop_id ist ein Soft-FK
  // (Flow ≠ zwingend SOP, Owner-Entscheidung §7.4). IF NOT EXISTS, idempotent.
  path.join(process.cwd(), "db", "migrations", "0112_flow_studio.sql"),
  // 0113: Self-Learning / WARUM-Engine Stream A (2026-05-27). Neue Tabellen
  // workspace_beliefs (Lern-Store: je Topic je Workspace eine aktive
  // Überzeugung; abgelöste Beliefs bleiben via supersedes_id als Historie) +
  // decision_outcomes (verknüpft Entscheidungen/Workstreams additiv mit ihrem
  // Ergebnis — workstream_decisions ist append-only). Macht den bisher
  // write-only Decision-Trail (0071) lesbar/lernbar. Rein additiv, IF NOT
  // EXISTS, idempotent. Quelle: GOAL-lazyos-self-learning-why-engine +
  // docs/plans/2026-05-27_self-learning-and-flow-completion-plan.md (Stream A).
  path.join(process.cwd(), "db", "migrations", "0113_workspace_beliefs.sql"),
  // 0114: User-Defaults (Owner-Fix Live-Test 2026-05-28). Eine kleine
  // additive Tabelle `user_preferences` mit `default_permission_mode`.
  // Hält den User-Toggle „Vollzugriff" systemübergreifend, damit ein neu
  // erstellter Workspace SOFORT den User-Default trägt (gestern fiel er
  // stillschweigend auf 'ask' zurück, Owner musste neu toggeln). Schreiber:
  // lib/users/preferences-repo.ts; gelesen von POST /api/workspaces (Seed
  // der lazyos_permission_modes-Row) + GET /api/user/preferences (UI-Fallback
  // in AllAccessToggle). IF NOT EXISTS, idempotent.
  path.join(process.cwd(), "db", "migrations", "0114_user_preferences.sql"),
  // 0115 (2026-05-28): legacy-compat tickets-Tabelle. Owner-Live-Test zeigte
  // 19 wiederholte `SqliteError: no such table: tickets` aus 3 Legacy-Routen
  // (cross-roast, inject, pause-status). Tickets sind im laz.ing-Modell event-
  // sourced (db/schema/work_products.ts:10 verbatim) — die 3 Routes wurden
  // nicht migriert. Diese Migration legt eine leere Compat-Tabelle an, damit
  // die Routes valide leere Resultate liefern statt 500. Echter Refactor auf
  // event-sourcing folgt als eigener Slice.
  path.join(process.cwd(), "db", "migrations", "0115_tickets_legacy_compat.sql"),
  // 0116 (2026-05-29): Track-D Repro-Persistenz. Additive Spalten auf
  // flow_runs — req_id (Request-Korrelation UI ↔ Server-Log ↔ DB),
  // error_message + error_code (N8: Trace ist Evidence). Damit kann
  // composeAndRun SOFORT nach erfolgreichem Compose einen pending-Stub
  // schreiben — auch im needs-coupling/needs-style-choice/Compose-Fehler-
  // Pfad. Schließt Master-Kontext §10 Befund 2 (Owner: "Innerhalb des
  // kurzen Waits kam keine klare Flow-Antwort/Surface zurück. Es wurde
  // im kurzen Check kein neuer flow_run und kein neuer workstream
  // sichtbar.").
  path.join(
    process.cwd(),
    "db",
    "migrations",
    "0116_flow_runs_repro_persistence.sql",
  ),
  // 0117 (2026-05-29): question_answers — strukturierter Antwort-Speicher
  // für Open-Questions (Phase 1 Track AB · Befund B). Heute geht das
  // Envelope (workspaceId/workstreamId/flowRunId/planId/questionSetId/
  // questionId/sourceTurnId/surfaceId) im „Frage:.../Antwort:..."-Textblock
  // verloren. Diese Tabelle persistiert es strukturiert, idempotent via
  // UNIQUE(content_hash) + UNIQUE(source_turn_id, question_id). Schreiber:
  // app/api/chat/answer/route.ts; Hydration: GET dieselbe Route.
  path.join(process.cwd(), "db", "migrations", "0117_question_answers.sql"),
  // 0118 (2026-05-29): Phase 2 W2.1 · Lane G Governance — FUNDAMENTAL-Lane
  // (Stage 1, Governance Gate Contract). Drei additive Tabellen:
  //   consent_grants    — §13.2 Opt-in / Pause-Stop / Review-Pflicht.
  //                       Append-only via Trigger; revoked_at-only-Update.
  //                       reason_text VERBATIM (N1), content_hash (N10).
  //   source_traces     — Raw/Derived-Provenance-Kette pro Workspace.
  //   governance_audit  — N8 Trace-as-Evidence; append-only Trigger.
  // Sie definiert, was JEDE andere Lane darf/muss (Plan-Execute, Connector-
  // Invoke, Spawn, Persist-Belief, …). Lese-/Schreib-Schicht:
  // lib/governance/{consent,no-auto-run,source-trace,audit,retention}.ts.
  path.join(process.cwd(), "db", "migrations", "0118_governance_consent.sql"),
  // 0119 (2026-05-29): Phase 2 W2.2 · Lane A Communication Intake.
  //   intake_events — verbatim-Substrat (N1) fuer eingehende Kommunikation
  //   (WhatsApp/Telegram/Voice/Meeting/...). source_kind = DataSource (1:1
  //   lib/governance/consent.ts). No-auto-run-FSM (§7.2): fsm_state
  //   staged → classified → ready-for-compile, plus blocked. nudge_class
  //   (urgent|decision-needed|info-only|noise) ab Schritt 3. content_hash
  //   (N10) → Idempotenz. Append-only-Light-Trigger (N8): kein DELETE, keine
  //   Kern-Mutation; UPDATE nur auf nudge_class/fsm_state/speaker_local_id/
  //   updated_at. Lane B (0120) liest spaeter daraus — human-gated, kein
  //   auto-run. Schema: db/schema/intake_events.ts. Master-Briefing §25.1 +
  //   §7.2 + §7.3. Rein additiv, IF NOT EXISTS, idempotent.
  path.join(process.cwd(), "db", "migrations", "0119_intake_events.sql"),
  // 0120 (2026-05-29): Phase 2 W2.2 · Lane B Expertise Compiler.
  //   knowledge_forms — eine Tabelle mit kind-Spalte fuer die 12 Wissensformen
  //   (§8.2: glossary | principle | if-then-rule | exception | tactic |
  //   role-judgment | handoff-dependency | quality-criterion | simulation-case
  //   | eval-question | sop-step | open-unknown). statement/rationale/term/
  //   example_cases_json/counter_cases_json VERBATIM (N1). review_state
  //   (pending-review|approved|rejected|superseded). Approved knowledge_forms
  //   werden NACH human-review via upsertBelief (lib/reasoning/beliefs-repo.ts)
  //   in workspace_beliefs (0113) gespiegelt — Rueck-FK in source_json.beliefId
  //   (N4: kein eigener Belief-Writer, keine blinde Doppelhaltung). Append-only-
  //   Light-Trigger (N8). content_hash (N10). Schema: db/schema/knowledge_forms.ts.
  //   Master-Briefing §8 + Integration-Plan §4 Lane B Outputs. Rein additiv,
  //   IF NOT EXISTS, idempotent.
  path.join(process.cwd(), "db", "migrations", "0120_expertise_knowledge_forms.sql"),
  // 0121 (2026-05-29): Phase IN · Lane D Innovation Mode.
  //   innovation_artifacts — eine Tabelle mit kind-Spalte fuer die Innovation-
  //   Mode-Outputs (§10.4: assumption | reframe | cross-domain-analogy |
  //   contrarian-roast | concept-node | concept-edge). content/source_json
  //   VERBATIM (N1). Append-only — Trigger blockt jede UPDATE + DELETE (N8);
  //   eine Korrektur ist eine neue Row mit supersedes_id. content_hash (N10).
  //   Der Contrarian-Roast wiederverwendet die bestehende counter-evidence-
  //   Surface-Logik (lib/reasoning/reconcile.ts, N4). Schema:
  //   db/schema/innovation_artifacts.ts. Master-Briefing §10. Rein additiv,
  //   IF NOT EXISTS, idempotent.
  path.join(process.cwd(), "db", "migrations", "0121_innovation_artifacts.sql"),
  // Phase 2 W2.3 · Lanes C/E/F Engines (2026-05-29) — lane_artifacts (EINE
  // Tabelle, kind-Diskriminator). Lane C Role Reverse Engineering · Lane E
  // Toolstack Replacement · Lane F Mobile Human-in-the-Loop (auf lib/push, N4).
  //   Engines: lib/lanes/{role-reverse,toolstack,mobile-hitl}/. Append-only
  //   (N8/N10). Schema: db/schema/lane_artifacts.ts. Rein additiv, IF NOT
  //   EXISTS, idempotent.
  path.join(process.cwd(), "db", "migrations", "0122_lane_artifacts.sql"),
  // Sub-Chats (2026-06-02, Gathering-Intelligence-Goal) — Gruppenchats pro
  // Workspace + append-only Nachrichten, Wissen fließt in die RAG.
  path.join(process.cwd(), "db", "migrations", "0123_subchats.sql"),
  path.join(process.cwd(), "db", "migrations", "0124_subchat_attachments.sql"),
  // Sub-Chats Read-Marker (2026-06-02, P2) — Unread-Badge-Grundlage.
  path.join(process.cwd(), "db", "migrations", "0125_subchat_read_markers.sql"),
  // Proaktive Vorschläge (2026-06-02) — server-pre-generierter Operator-Vorschlag
  // pro EXTERNER Sub-Chat-Nachricht (claude-gated, best-effort).
  path.join(process.cwd(), "db", "migrations", "0126_proactive_suggestions.sql"),
  // 0127 (2026-06-03) — claude_sessions Rotation-Bookkeeping (degrade→handoff→
  // rotate). Auch hier registriert, damit ein Next-first-Boot die Spalten anlegt
  // (idempotent; der Agent-Server-Runner hat sie ebenfalls).
  path.join(process.cwd(), "db", "migrations", "0127_session_rotation.sql"),
  // 0128 (2026-06-03) — Question-Spinning in Sub-/Gruppen-Chats: angespinnte
  // Fragen + erweiterbare Optionen + Antworten pro Teilnehmer (append-only,
  // workspace-scoped). Sequentiell-prominente Pille wie im Hauptchat.
  path.join(process.cwd(), "db", "migrations", "0128_subchat_questions.sql"),
  // 0129 (2026-06-03) — „Mitarbeiter"-Profile: benannte, wiederverwendbare
  // Rolle + allow-gelistetes Capability-Bundle (Skills/MCP/SOPs/APIs +
  // ManifestCoord), ad-hoc spawnbar (kein Dauer-Agent-User).
  path.join(process.cwd(), "db", "migrations", "0129_agent_profiles.sql"),
  // 0130 (2026-06-03) — Flow-Parametrisierung: params_json (Template) + io_json
  // (Step) für {{param.*}}-Interpolation → Workflows wiederverwendbar statt nur
  // reproduzierbar. Additiv, NULL = heutiges Verhalten.
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
  // Test-Hook (Pattern 5 Welle 3, 2026-05-01): in Tests ist die DB
  // initial leer, und Migration 0036 (suborgs_restore) referenziert Parent-
  // Org-IDs die im echten Setup existieren, in Tests aber nicht. Wir
  // erlauben Tests, FK-Checks zu deaktivieren — Production-Path bleibt ON.
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
  // Fallback: SQLite `ALTER TABLE ADD COLUMN` ist nicht idempotent → es
  // wirft "duplicate column name" beim zweiten Run, und `exec()` abortet das
  // ganze File beim ersten Fehler. Wenn wir den Fehler sehen, fallen wir auf
  // statement-by-statement zurueck und schlucken NUR den duplicate-column-
  // Fehler. Andere Fehler werden re-thrown.
  //
  // FK-during-migration (2026-05-24): Migrationen sind vertrauenswürdige
  // Schema-Änderungen. Ein DDL-Statement (z.B. ALTER TABLE … ADD COLUMN) löst
  // unter `foreign_keys=ON` eine FK-Revalidierung aus, die an VORBESTEHENDEN
  // Orphan-Rows scheitert (diese DB hat z.B. eine `workspaces`-Row die auf eine
  // gelöschte `organizations`-Row zeigt — fkid 0). Das ließ getDb() bei
  // Migration 0099 mit "FOREIGN KEY constraint failed" abstürzen. Standard-
  // Praxis (Rails/Django/SQLite-Docs): FK-Enforcement WÄHREND der Migration
  // deaktivieren, danach wiederherstellen. Erzeugt keine neuen Verstöße — die
  // Orphan-Row war vorher schon da und wird zur Laufzeit toleriert.
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

    // Phase Vers: Append-Only-Insert in `schema_version` pro angewandter
    // Migration. Idempotent via INSERT OR IGNORE auf der numerischen PK
    // — Re-Boot mit gleicher Migration ueberschreibt die Row nicht.
    // Wir setzen das hinter den eigentlichen Migration-Apply, damit die
    // Tabelle erst nach 0021_schema_version.sql existiert. Falls sie noch
    // nicht da ist (frueheres Migration-File), schluck den Fehler still.
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
      // Tabelle gibts erst ab Migration 0021 — frueher schweigt der Insert.
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

  // Sub-Plan 01c (2026-04-29) — Boot-Stuck-Check + Interval-Loop. Erkennt
  // Workstreams die nach Service-Restart in einem `await sleep(...)`-Pause-
  // Window standen und seitdem inactive sind, aber DB-State noch `active`
  // sagt. Markiert sie als `stuck`. UI bietet Resume.
  try {
    // Async-import um Circular-Dep-Risk zu vermeiden (stuck-detector
    // braucht getDb selber).
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
