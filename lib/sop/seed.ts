/**
 * SOP seed helper — SAR-2 · 2026-05-24.
 *
 * The 3 built-in SOPs are already seeded via INSERT OR IGNORE in Migration
 * 0099_sops.sql. This module provides a programmatic alternative for
 * environments that run the migration (e.g. Vercel ephemeral /tmp DB) but
 * need the built-in SOPs to be re-seeded after a fresh cold-start without
 * re-running the full migration file.
 *
 * Usage:
 *   import { ensureBuiltInSops } from '@/lib/sop/seed';
 *   ensureBuiltInSops(); // idempotent — skips if rows exist
 *
 * All 3 SOPs are declared in BUILTIN_SOPS below. They are also the canonical
 * source-of-truth for the step prompts (the SQL migration mirrors these
 * verbatim to keep the two in sync).
 */

import { getDb } from "@/db/client";
import { sops, sopSteps } from "@/db/schema/sops";
import { hashSop } from "./registry";
import { eq } from "drizzle-orm";

export type BuiltInSopDef = {
  id: string;
  name: string;
  description: string;
  steps: Array<{
    id: string;
    stepIndex: number;
    title: string;
    stepPromptTemplate: string;
    subagentRole: string | null;
    requiredSkillsJson: string | null;
    mcpToolAllowlistJson: string | null;
    optional: boolean;
  }>;
};

// ---------------------------------------------------------------------------
// Built-in SOP definitions
// ---------------------------------------------------------------------------

export const BUILTIN_SOPS: readonly BuiltInSopDef[] = [
  // ── 1. Research → Synthesize → Draft → Review ───────────────────────────
  {
    id: "SOP-BUILTIN-RESEARCH-SYNTH-01",
    name: "Research → Synthesize → Draft → Review",
    description:
      "Generic 4-step research pipeline. Researcher collects sources, Scribe synthesizes into a draft, Reviewer critiques, final revision pass. Suitable for any research-heavy deliverable.",
    steps: [
      {
        id: "SOPS-RS-01",
        stepIndex: 0,
        title: "Research: Collect sources and evidence",
        // N1: full template, never truncated
        stepPromptTemplate:
          "You are a Researcher agent. Your goal is: {{goal_prompt}}\n\nCollect all relevant sources, data points, prior art and evidence related to the goal. Output a structured list of findings with source references. Do NOT summarise prematurely — preserve full detail (N1). If any source is inaccessible, note it explicitly rather than omitting it.",
        subagentRole: "researcher",
        requiredSkillsJson: '["skill:researcher"]',
        mcpToolAllowlistJson: null,
        optional: false,
      },
      {
        id: "SOPS-RS-02",
        stepIndex: 1,
        title: "Synthesize: Distil findings into a coherent structure",
        stepPromptTemplate:
          "You are a Scribe agent. Your input is the research findings from the previous step.\n\nGoal context: {{goal_prompt}}\n\nSynthesize the raw findings into a coherent, logically ordered structure. Preserve verbatim quotes and data points (N1). Produce a structured outline or document that the Reviewer can evaluate. Do NOT condense or paraphrase source data — keep all detail.",
        subagentRole: "scribe",
        requiredSkillsJson: '["skill:scribe"]',
        mcpToolAllowlistJson: null,
        optional: false,
      },
      {
        id: "SOPS-RS-03",
        stepIndex: 2,
        title: "Draft: Produce the deliverable document",
        stepPromptTemplate:
          "You are a Coder/Writer agent. Your input is the synthesized structure from the previous step.\n\nGoal context: {{goal_prompt}}\n\nProduce the final draft deliverable. Write in the appropriate format for the goal (report, spec, code, analysis). Every claim must reference a source from the research step. No fabrication.",
        subagentRole: "coder",
        requiredSkillsJson: null,
        mcpToolAllowlistJson: null,
        optional: false,
      },
      {
        id: "SOPS-RS-04",
        stepIndex: 3,
        title: "Review: Critique and identify gaps",
        stepPromptTemplate:
          "You are a Reviewer agent. Your input is the draft from the previous step.\n\nGoal context: {{goal_prompt}}\n\nApply a structured critique: (1) factual accuracy, (2) completeness vs. research findings, (3) logical consistency, (4) missing evidence. Output a numbered list of findings, severity (MAJOR/MINOR/NOTE), and for each MAJOR finding a concrete remediation suggestion.",
        subagentRole: "reviewer",
        requiredSkillsJson: null,
        mcpToolAllowlistJson: null,
        optional: false,
      },
    ],
  },

  // ── 2. Content Pipeline (Generic) ───────────────────────────────────────
  {
    id: "SOP-BUILTIN-CONTENT-PIPE-01",
    name: "Content Pipeline (Generic)",
    description:
      "Generic 4-step content production pipeline: Research → Script/Outline Draft → Editorial Review → Production Plan. Applicable to any content type (article, report, briefing, video script). Not tied to any specific platform.",
    steps: [
      {
        id: "SOPS-CP-01",
        stepIndex: 0,
        title: "Research: Gather topic background and reference material",
        stepPromptTemplate:
          "You are a Researcher agent. Goal: {{goal_prompt}}\n\nGather all relevant background information for this content piece: existing treatments of the topic, key facts, statistics, expert positions, and audience context. Output a structured brief with: (a) key messages to communicate, (b) supporting evidence, (c) tone/audience notes. Full detail preserved (N1).",
        subagentRole: "researcher",
        requiredSkillsJson: '["skill:researcher"]',
        mcpToolAllowlistJson: null,
        optional: false,
      },
      {
        id: "SOPS-CP-02",
        stepIndex: 1,
        title: "Draft: Write the script or content outline",
        stepPromptTemplate:
          "You are a Coder/Writer agent. Your input is the research brief from the previous step.\n\nGoal: {{goal_prompt}}\n\nProduce the full content draft or script. Structure it clearly with headers/sections. Every factual claim maps to a source from the research brief. Preserve specificity — no vague generalisations where concrete facts are available.",
        subagentRole: "coder",
        requiredSkillsJson: null,
        mcpToolAllowlistJson: null,
        optional: false,
      },
      {
        id: "SOPS-CP-03",
        stepIndex: 2,
        title: "Review: Editorial check for accuracy, clarity and completeness",
        stepPromptTemplate:
          "You are a Reviewer agent. Your input is the draft from the previous step.\n\nGoal: {{goal_prompt}}\n\nPerform an editorial review: (1) factual accuracy vs. research brief, (2) structural clarity and logical flow, (3) tone alignment with audience, (4) any missing key messages identified in research. Output a prioritised list of edits (REQUIRED / SUGGESTED / OPTIONAL).",
        subagentRole: "reviewer",
        requiredSkillsJson: null,
        mcpToolAllowlistJson: null,
        optional: false,
      },
      {
        id: "SOPS-CP-04",
        stepIndex: 3,
        title: "Production Plan: Specify assets, schedule and distribution steps",
        stepPromptTemplate:
          "You are an Architect agent. Your input is the approved draft and editorial notes.\n\nGoal: {{goal_prompt}}\n\nProduce a concrete production plan: (1) list of assets required (text, visuals, audio, etc.), (2) suggested production sequence with dependencies, (3) distribution channel checklist, (4) any technical requirements per channel. Keep generic — do NOT assume specific tooling unless stated in goal_prompt.",
        subagentRole: "architect",
        requiredSkillsJson: null,
        mcpToolAllowlistJson: null,
        optional: true,
      },
      {
        id: "SOPS-CP-05",
        stepIndex: 4,
        title: "Final Cut: Integrate edits and produce final version",
        stepPromptTemplate:
          "You are a Coder/Writer agent. Your inputs are the original draft and the editorial review from the previous steps.\n\nGoal: {{goal_prompt}}\n\nIntegrate all REQUIRED edits from the review. Apply SUGGESTED edits where they improve the piece without contradicting the goal. Produce the final, publication-ready version. Mark each change with the review finding it addresses.",
        subagentRole: "coder",
        requiredSkillsJson: null,
        mcpToolAllowlistJson: null,
        optional: true,
      },
    ],
  },

  // ── 3. Bug-Fix Triage Pipeline ───────────────────────────────────────────
  {
    id: "SOP-BUILTIN-BUGFIX-TRIAGE-01",
    name: "Bug-Fix Triage Pipeline",
    description:
      "Generic 4-step bug-fix workflow: Researcher triages and reproduces, Coder implements fix, Tester verifies, Reviewer approves. Maps directly onto the plan-first bug-fix template steps.",
    steps: [
      {
        id: "SOPS-BF-01",
        stepIndex: 0,
        title: "Triage: Reproduce and locate the defect",
        stepPromptTemplate:
          "You are a Researcher agent. Bug report / goal: {{goal_prompt}}\n\nTriage the reported defect: (1) reproduce it with a minimal test case or repro steps, (2) locate the root-cause code path (file + line), (3) classify severity (P0–P3) and impact surface, (4) rule out environmental issues vs. code defects. Output a structured triage report with all findings verbatim (N1). Do NOT attempt a fix yet.",
        subagentRole: "researcher",
        requiredSkillsJson: '["skill:researcher"]',
        mcpToolAllowlistJson: null,
        optional: false,
      },
      {
        id: "SOPS-BF-02",
        stepIndex: 1,
        title: "Fix: Implement the minimal targeted code change",
        stepPromptTemplate:
          "You are a Coder agent. Your input is the triage report from the previous step.\n\nGoal: {{goal_prompt}}\n\nImplement the minimal code change that resolves the root cause identified in triage. Prefer surgical fixes over refactors (unless the triage report recommends a broader change). Output the diff with an explanation of each change keyed to the triage findings.",
        subagentRole: "coder",
        requiredSkillsJson: null,
        mcpToolAllowlistJson: null,
        optional: false,
      },
      {
        id: "SOPS-BF-03",
        stepIndex: 2,
        title: "Test: Verify the fix and check for regressions",
        stepPromptTemplate:
          "You are a Tester agent. Your inputs are the triage report and the fix diff from previous steps.\n\nGoal: {{goal_prompt}}\n\nVerify the fix: (1) run or describe the reproduction test case — does it now pass? (2) run the relevant test suite and confirm no regressions, (3) for each change in the diff, identify the closest existing test that covers it (or note the coverage gap). Output a test report with pass/fail for each check.",
        subagentRole: "tester",
        requiredSkillsJson: null,
        mcpToolAllowlistJson: null,
        optional: false,
      },
      {
        id: "SOPS-BF-04",
        stepIndex: 3,
        title: "Review: Approve fix or raise concerns",
        stepPromptTemplate:
          "You are a Reviewer agent. Your inputs are the triage report, fix diff and test report from previous steps.\n\nGoal: {{goal_prompt}}\n\nPerform a final code review: (1) does the fix address the root cause without introducing new risk? (2) is the change minimal and readable? (3) are there any edge cases the triage or tests missed? Output APPROVED or BLOCKED with specific, actionable findings. BLOCKED requires a concrete remediation for each blocker.",
        subagentRole: "reviewer",
        requiredSkillsJson: null,
        mcpToolAllowlistJson: null,
        optional: false,
      },
    ],
  },

  // ── 4. Connector Onboarding (API Research Team) ──────────────────────────
  {
    id: "SOP-BUILTIN-CONNECTOR-ONBOARD-01",
    name: "Connector Onboarding (API Research Team)",
    description:
      "Generic 3-step connector onboarding pipeline. Researcher discovers all capabilities of a target API (preferring MCP-server inputSchema discovery, falling back to doc-URL or public reference). Scribe distils the raw discovery into a normalised ConnectorProfile. Validator applies the deterministic Coverage Validator (N6) to verify schema completeness before any write. Non-destructive: produces a connector profile for persistence — no external API call.",
    steps: [
      {
        id: "SOPS-CO-01",
        stepIndex: 0,
        title: "Discover: Enumerate all capabilities of the target API",
        // N1: full template, never truncated
        stepPromptTemplate:
          "You are a Researcher agent tasked with building a complete capability inventory for an external API provider.\n\nTarget provider: {{target_provider}}\nGoal context: {{goal_prompt}}\n\nYour task is to enumerate EVERY capability (endpoint, tool, or operation) exposed by this API. Follow this discovery protocol in priority order:\n\nPRIORITY 1 — MCP-server discovery (preferred, highest precision):\n  If an MCP server is configured for this provider, call enumerateMcpTools() and extract each McpTool entry. For every tool, capture:\n    - Canonical tool name (format: mcp__<serverName>__<toolName>)\n    - Tool description (verbatim from inputSchema.description)\n    - Full inputSchema JSON (preserve all nested properties, required[], additionalProperties)\n    - Any outputSchema or response-shape hints available\n\nPRIORITY 2 — Documentation URL / public reference (fallback when no MCP server):\n  Retrieve the official API reference documentation for the provider. Parse and enumerate all public endpoints / operations. For each, capture:\n    - HTTP method + path (e.g. POST /v2/video/generate)\n    - Short operation name (snake_case, usable as a capability name)\n    - Operation description (verbatim)\n    - Request body / parameter schema (field names, types, required flags, constraints)\n    - Response schema (shape of success response, key fields)\n    - Error codes and their semantics\n    - Rate-limit constraints (requests/minute, requests/day, quota model)\n    - Authentication kind (api_key | oauth | pat | none | custom)\n    - Base URL and current API version (semver or date string)\n\nOUTPUT FORMAT — produce a structured Capability List. Preserve ALL detail (N1 — do NOT summarise or omit fields). Use this structure for each capability:\n\n  ---\n  capability_name: <snake_case name>\n  source: mcp-discovery | doc-research\n  mcp_tool_name: <mcp__server__tool> or null\n  description: <verbatim description>\n  endpoint: <HTTP method + path> or null for MCP-only tools\n  auth_kind: api_key | oauth | pat | none | custom\n  base_url: <https://...>\n  api_version: <semver or date string>\n  input_schema_json: <full JSON Schema as string>\n  output_schema_json: <full JSON Schema or response shape as string, or null>\n  error_codes: [<code: description>, ...]\n  rate_limits: <requests/min, requests/day, quota model, or \"unknown\">\n  required: true | false  (true = API is non-functional without this capability)\n  ---\n\nIf discovery is incomplete or a source is inaccessible, note it explicitly — do NOT omit or fabricate. Explicit gaps are preferable to silent omissions.",
        subagentRole: "researcher",
        requiredSkillsJson: '["skill:researcher"]',
        mcpToolAllowlistJson: null,
        optional: false,
      },
      {
        id: "SOPS-CO-02",
        stepIndex: 1,
        title: "Distil: Normalise raw discovery output into a ConnectorProfile",
        // N1: full template, never truncated
        stepPromptTemplate:
          "You are a Scribe agent. Your input is the raw Capability List produced by the Researcher in the previous step.\n\nTarget provider: {{target_provider}}\nGoal context: {{goal_prompt}}\n\nYour task is to distil the raw discovery output into a normalised ConnectorProfileInput structure that can be persisted to the platform-global connector catalog via upsertConnectorProfile().\n\nNORMALISATION RULES:\n1. provider          — machine-readable slug, lowercase, hyphens (e.g. \"heygen\", \"stripe\", \"openai\"). Derived from target_provider.\n2. displayName       — human-readable name from discovery (verbatim).\n3. description       — one-sentence summary of what the API does (from discovery description, verbatim if concise).\n4. authKind          — exactly one of: \"api_key\" | \"oauth\" | \"pat\" | \"none\" | \"custom\". Inferred from discovery.\n5. baseUrl           — canonical HTTPS base URL from discovery (no trailing slash).\n6. apiVersion        — exact version string from discovery (semver or date, e.g. \"v2\" or \"2024-01-01\").\n7. docsUrl           — official documentation URL from discovery or null.\n8. source            — \"mcp-discovery\" if step 0 used MCP-server, \"doc-research\" if fallback.\n9. capabilities      — array of CapabilityInput objects, one per discovered capability:\n     name             — snake_case capability name (from capability_name in discovery)\n     description      — verbatim description from discovery (N1 — do NOT shorten)\n     inputSchemaJson  — JSON Schema as string (verbatim from discovery, do NOT reformat)\n     outputSchemaJson — JSON Schema or response shape as string, or null\n     mcpToolName      — canonical mcp__<server>__<tool> or null\n     required         — true | false from discovery\n\nCRITICAL CONSTRAINTS (PII Hard-Guard — assertNonSensitiveProfile will throw on violation):\n  - Do NOT include any of: workspace_id, org_id, user_id, email, token, secret,\n    api_key (as a value, not as authKind), credential, credentials, password,\n    private_key, access_token, refresh_token, client_secret in any field.\n  - authKind records the KIND of authentication, never an actual credential value.\n  - The connector catalog is platform-global — no user, workspace, or org identifiers.\n\nOUTPUT FORMAT — produce a valid ConnectorProfileInput JSON object. Preserve ALL capability detail verbatim (N1). If any discovery field is missing, represent it as null — do NOT fabricate.",
        subagentRole: "scribe",
        requiredSkillsJson: '["skill:scribe"]',
        mcpToolAllowlistJson: null,
        optional: false,
      },
      {
        id: "SOPS-CO-03",
        stepIndex: 2,
        title: "Validate: Deterministic schema check + completeness against discovery list",
        // N1: full template, never truncated
        stepPromptTemplate:
          "You are a Validator agent. Your inputs are:\n  (A) the raw Capability List from Step 0 (Researcher).\n  (B) the normalised ConnectorProfileInput JSON from Step 1 (Scribe).\n\nTarget provider: {{target_provider}}\nGoal context: {{goal_prompt}}\n\nYour task is to apply TWO layers of validation in strict order. Layer 1 (deterministic, N6) runs FIRST — before any symbolic reasoning or LLM judgement.\n\n────────────────────────────────────────────────────────────────\nLAYER 1 — DETERMINISTIC SCHEMA VALIDATION (N6, fail-closed)\n────────────────────────────────────────────────────────────────\nApply the following checks mechanically. For each check, output PASS or FAIL with the exact offending value.\n\nSchema checks on ConnectorProfileInput (input B):\n  [S1]  provider        — non-empty string, lowercase, no spaces, hyphens only.\n  [S2]  displayName     — non-empty string.\n  [S3]  authKind        — exactly one of: \"api_key\", \"oauth\", \"pat\", \"none\", \"custom\".\n  [S4]  source          — exactly one of: \"mcp-discovery\", \"doc-research\", \"manual\".\n  [S5]  capabilities    — array, length ≥ 1.\n  [S6]  forbidden keys  — NONE of the following keys appear anywhere in the JSON:\n                          workspace_id, workspaceId, org_id, orgId, user_id, userId,\n                          email, token, secret, api_key (as key), apiKey, credential,\n                          credentials, password, private_key, privateKey, access_token,\n                          accessToken, refresh_token, refreshToken, client_secret, clientSecret.\n  [S7]  per-capability  — each capability has: name (non-empty string), required (boolean).\n  [S8]  inputSchemaJson — where present, must be a valid JSON string (parseable).\n\nCoverage check (required capabilities ⊆ profile capabilities):\n  [C1]  Every capability marked required:true in the discovery list (input A)\n        MUST appear by name in the capabilities array of the ConnectorProfileInput.\n        Missing required capability → FAIL (fail-closed).\n  [C2]  If baseUrl from profile is null but discovery found a base URL → FAIL.\n  [C3]  If apiVersion from profile is null but discovery found a version → FAIL (version drift risk).\n\nIf ANY check in Layer 1 fails → output REJECTED with a numbered list of failures.\nDo NOT proceed to Layer 2 if Layer 1 has failures. The caller must fix the profile and re-run.\n\n────────────────────────────────────────────────────────────────\nLAYER 2 — COMPLETENESS REVIEW (symbolic reasoning, only after Layer 1 PASS)\n────────────────────────────────────────────────────────────────\n  [R1]  Are all capabilities from the discovery list represented in the profile?\n        List any that are in the discovery list but absent from the profile.\n  [R2]  Are descriptions sufficiently informative for a developer to understand each capability?\n        Flag any that are empty, single-word, or copy-pasted field names.\n  [R3]  Does the API version in the profile match the discovery source exactly?\n        Flag any discrepancy as a potential version-drift risk.\n  [R4]  Are there discovery-noted error codes or rate-limit constraints missing from the\n        capability inputSchemaJson? Note gaps (not a hard failure, but recorded for trace).\n\nOUTPUT FORMAT:\n  Layer 1 result: PASS | REJECTED (with failure list)\n  Layer 2 result (only if Layer 1 PASS): a numbered list of findings (MAJOR | MINOR | NOTE).\n  Final verdict: APPROVED | APPROVED_WITH_NOTES | REJECTED.\n  If APPROVED or APPROVED_WITH_NOTES: include the validated ConnectorProfileInput JSON\n    (unchanged from input B — the Validator does NOT modify the profile, it approves or rejects).\n\nRationale for fail-closed on Layer 1:\n  Deterministic validators run before LLM reasoning (N6) because symbolic checks catch\n  structural errors that probabilistic reasoning may overlook or rationalise away.\n  A missing required capability means the connector is non-functional for its declared purpose.\n  Fail-closed is correct: the caller must fix and re-run rather than persist an incomplete profile.",
        subagentRole: "reviewer",
        requiredSkillsJson: null,
        mcpToolAllowlistJson: null,
        optional: false,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// ensureBuiltInSops — idempotent upsert
// ---------------------------------------------------------------------------

/**
 * Ensure all 4 built-in SOPs exist in the database.
 *
 * Uses INSERT OR IGNORE on both sops and sop_steps — safe to call
 * multiple times (e.g. after a Vercel cold-start with ephemeral DB).
 *
 * Does NOT update existing rows — built-in SOPs are immutable via the
 * registry (archiveSop returns false for builtIn=1).
 */
export function ensureBuiltInSops(): void {
  const db = getDb();

  for (const def of BUILTIN_SOPS) {
    // Check if already exists (fast path to avoid INSERT OR IGNORE overhead
    // when seeding is not needed).
    const existing = db
      .select({ id: sops.id })
      .from(sops)
      .where(eq(sops.id, def.id))
      .limit(1)
      .all()[0];

    if (existing) continue; // Already seeded — skip.

    const now = Date.now();
    const hash = hashSop({
      id: def.id,
      name: def.name,
      description: def.description,
      workspaceId: null,
      version: 1,
      builtIn: true,
      createdAt: now,
    });

    db.transaction(() => {
      db.insert(sops)
        .values({
          id: def.id,
          name: def.name,
          description: def.description,
          workspaceId: null,
          version: 1,
          builtIn: true,
          archivedAt: null,
          contentHash: hash,
          createdAt: now,
        })
        .onConflictDoNothing()
        .run();

      for (const step of def.steps) {
        db.insert(sopSteps)
          .values({
            id: step.id,
            sopId: def.id,
            stepIndex: step.stepIndex,
            title: step.title,
            // N1: verbatim — never truncated
            stepPromptTemplate: step.stepPromptTemplate,
            subagentRole: step.subagentRole,
            requiredSkillsJson: step.requiredSkillsJson,
            mcpToolAllowlistJson: step.mcpToolAllowlistJson,
            optional: step.optional,
          })
          .onConflictDoNothing()
          .run();
      }
    });
  }
}
