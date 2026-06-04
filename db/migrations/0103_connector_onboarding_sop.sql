-- ============================================================
-- 0103_connector_onboarding_sop.sql — Built-in SOP: connector-onboarding
--
-- Datum:  2026-05-24
-- Autor:  Claude Code (ACL-4 connector-onboarding SOP + Coverage Validator)
--
-- Purpose:
--   Seeds the generic "Connector Onboarding" built-in SOP (3 steps):
--     Step 0  Researcher "Discover"  — enumerate API capabilities via
--             enumerateMcpTools() inputSchema when an MCP server exists,
--             otherwise via doc-URL / public reference. Output: structured
--             Capability-List (endpoint, auth kind, params, response, errors,
--             rate-limits) — full detail (N1).
--     Step 1  Scribe "Distil"        — normalise raw discovery output into a
--             ConnectorProfileInput shape (provider, auth_kind, base_url,
--             api_version, capabilities[]).
--     Step 2  Reviewer "Validate"    — deterministic schema check via
--             lib/connectors/coverage.ts validateCoverage() BEFORE any
--             LLM reasoning (N6), plus completeness check vs. discovery list.
--             Fail-closed: missing required capability → reject.
--
-- Design:
--   - built_in=1, workspace_id NULL → global, visible to all workspaces.
--   - NOT hardcoded to HeyGen or any specific provider. {{target_provider}}
--     and {{goal_prompt}} template vars are resolved at dispatch time.
--   - content_hash = bootstrap sentinel; application layer (lib/sop/seed.ts)
--     overwrites it on first in-process mutation (same pattern as 0099).
--   - Idempotent: INSERT OR IGNORE everywhere.
--   - N1: step_prompt_template text is verbatim, never truncated.
--   - N6: Step 2 explicitly invokes the deterministic validator FIRST,
--         before any symbolic or LLM reasoning on the profile.
--   - R3: the SOP produces profile data only — NO external API call is
--         made by the SOP itself. Real invocation remains GATED (ACL-5).
--
-- DO NOT register this migration in db/client.ts / server/db.ts.
-- The owner adds it to the migration list manually.
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- SOP: connector-onboarding
-- ─────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO sops
  (id, name, description, workspace_id, version, built_in, content_hash, created_at)
VALUES (
  'SOP-BUILTIN-CONNECTOR-ONBOARD-01',
  'Connector Onboarding (API Research Team)',
  'Generic 3-step connector onboarding pipeline. Researcher discovers all capabilities of a target API (preferring MCP-server inputSchema discovery, falling back to doc-URL or public reference). Scribe distils the raw discovery into a normalised ConnectorProfile. Validator applies the deterministic Coverage Validator (N6) to verify schema completeness before any write. Non-destructive: produces a connector profile for persistence — no external API call.',
  NULL,
  1,
  1,
  'bootstrap:0103:SOP-BUILTIN-CONNECTOR-ONBOARD-01',
  strftime('%s', 'now') * 1000
);

INSERT OR IGNORE INTO sop_steps
  (id, sop_id, step_index, title, step_prompt_template, subagent_role, required_skills_json, mcp_tool_allowlist_json, optional)
VALUES

  -- ── Step 0: Researcher "Discover" ─────────────────────────────────────────
  (
    'SOPS-CO-01',
    'SOP-BUILTIN-CONNECTOR-ONBOARD-01',
    0,
    'Discover: Enumerate all capabilities of the target API',
    'You are a Researcher agent tasked with building a complete capability inventory for an external API provider.

Target provider: {{target_provider}}
Goal context: {{goal_prompt}}

Your task is to enumerate EVERY capability (endpoint, tool, or operation) exposed by this API. Follow this discovery protocol in priority order:

PRIORITY 1 — MCP-server discovery (preferred, highest precision):
  If an MCP server is configured for this provider, call enumerateMcpTools() and extract each McpTool entry. For every tool, capture:
    - Canonical tool name (format: mcp__<serverName>__<toolName>)
    - Tool description (verbatim from inputSchema.description)
    - Full inputSchema JSON (preserve all nested properties, required[], additionalProperties)
    - Any outputSchema or response-shape hints available

PRIORITY 2 — Documentation URL / public reference (fallback when no MCP server):
  Retrieve the official API reference documentation for the provider. Parse and enumerate all public endpoints / operations. For each, capture:
    - HTTP method + path (e.g. POST /v2/video/generate)
    - Short operation name (snake_case, usable as a capability name)
    - Operation description (verbatim)
    - Request body / parameter schema (field names, types, required flags, constraints)
    - Response schema (shape of success response, key fields)
    - Error codes and their semantics
    - Rate-limit constraints (requests/minute, requests/day, quota model)
    - Authentication kind (api_key | oauth | pat | none | custom)
    - Base URL and current API version (semver or date string)

OUTPUT FORMAT — produce a structured Capability List. Preserve ALL detail (N1 — do NOT summarise or omit fields). Use this structure for each capability:

  ---
  capability_name: <snake_case name>
  source: mcp-discovery | doc-research
  mcp_tool_name: <mcp__server__tool> or null
  description: <verbatim description>
  endpoint: <HTTP method + path> or null for MCP-only tools
  auth_kind: api_key | oauth | pat | none | custom
  base_url: <https://...>
  api_version: <semver or date string>
  input_schema_json: <full JSON Schema as string>
  output_schema_json: <full JSON Schema or response shape as string, or null>
  error_codes: [<code: description>, ...]
  rate_limits: <requests/min, requests/day, quota model, or "unknown">
  required: true | false  (true = API is non-functional without this capability)
  ---

If discovery is incomplete or a source is inaccessible, note it explicitly — do NOT omit or fabricate. Explicit gaps are preferable to silent omissions.',
    'researcher',
    '["skill:researcher"]',
    NULL,
    0
  ),

  -- ── Step 1: Scribe "Distil" ───────────────────────────────────────────────
  (
    'SOPS-CO-02',
    'SOP-BUILTIN-CONNECTOR-ONBOARD-01',
    1,
    'Distil: Normalise raw discovery output into a ConnectorProfile',
    'You are a Scribe agent. Your input is the raw Capability List produced by the Researcher in the previous step.

Target provider: {{target_provider}}
Goal context: {{goal_prompt}}

Your task is to distil the raw discovery output into a normalised ConnectorProfileInput structure that can be persisted to the platform-global connector catalog via upsertConnectorProfile().

NORMALISATION RULES:
1. provider          — machine-readable slug, lowercase, hyphens (e.g. "heygen", "stripe", "openai"). Derived from target_provider.
2. displayName       — human-readable name from discovery (verbatim).
3. description       — one-sentence summary of what the API does (from discovery description, verbatim if concise).
4. authKind          — exactly one of: "api_key" | "oauth" | "pat" | "none" | "custom". Inferred from discovery.
5. baseUrl           — canonical HTTPS base URL from discovery (no trailing slash).
6. apiVersion        — exact version string from discovery (semver or date, e.g. "v2" or "2024-01-01").
7. docsUrl           — official documentation URL from discovery or null.
8. source            — "mcp-discovery" if step 0 used MCP-server, "doc-research" if fallback.
9. capabilities      — array of CapabilityInput objects, one per discovered capability:
     name             — snake_case capability name (from capability_name in discovery)
     description      — verbatim description from discovery (N1 — do NOT shorten)
     inputSchemaJson  — JSON Schema as string (verbatim from discovery, do NOT reformat)
     outputSchemaJson — JSON Schema or response shape as string, or null
     mcpToolName      — canonical mcp__<server>__<tool> or null
     required         — true | false from discovery

CRITICAL CONSTRAINTS (PII Hard-Guard — assertNonSensitiveProfile will throw on violation):
  - Do NOT include any of: workspace_id, org_id, user_id, email, token, secret,
    api_key (as a value, not as authKind), credential, credentials, password,
    private_key, access_token, refresh_token, client_secret in any field.
  - authKind records the KIND of authentication, never an actual credential value.
  - The connector catalog is platform-global — no user, workspace, or org identifiers.

OUTPUT FORMAT — produce a valid ConnectorProfileInput JSON object:

{
  "provider": "<slug>",
  "displayName": "<name>",
  "description": "<description>",
  "authKind": "<api_key|oauth|pat|none|custom>",
  "baseUrl": "<https://...>",
  "apiVersion": "<version>",
  "docsUrl": "<url or null>",
  "source": "<mcp-discovery|doc-research>",
  "capabilities": [
    {
      "name": "<snake_case>",
      "description": "<verbatim>",
      "inputSchemaJson": "<json string>",
      "outputSchemaJson": "<json string or null>",
      "mcpToolName": "<mcp__server__tool or null>",
      "required": true
    },
    ...
  ]
}

Preserve ALL capability detail verbatim (N1). If any discovery field is missing, represent it as null — do NOT fabricate.',
    'scribe',
    '["skill:scribe"]',
    NULL,
    0
  ),

  -- ── Step 2: Reviewer/Validator "Validate" ─────────────────────────────────
  (
    'SOPS-CO-03',
    'SOP-BUILTIN-CONNECTOR-ONBOARD-01',
    2,
    'Validate: Deterministic schema check + completeness against discovery list',
    'You are a Validator agent. Your inputs are:
  (A) the raw Capability List from Step 0 (Researcher).
  (B) the normalised ConnectorProfileInput JSON from Step 1 (Scribe).

Target provider: {{target_provider}}
Goal context: {{goal_prompt}}

Your task is to apply TWO layers of validation in strict order. Layer 1 (deterministic, N6) runs FIRST — before any symbolic reasoning or LLM judgement.

────────────────────────────────────────────────────────────────
LAYER 1 — DETERMINISTIC SCHEMA VALIDATION (N6, fail-closed)
────────────────────────────────────────────────────────────────
Apply the following checks mechanically. For each check, output PASS or FAIL with the exact offending value.

Schema checks on ConnectorProfileInput (input B):
  [S1]  provider        — non-empty string, lowercase, no spaces, hyphens only.
  [S2]  displayName     — non-empty string.
  [S3]  authKind        — exactly one of: "api_key", "oauth", "pat", "none", "custom".
  [S4]  source          — exactly one of: "mcp-discovery", "doc-research", "manual".
  [S5]  capabilities    — array, length ≥ 1.
  [S6]  forbidden keys  — NONE of the following keys appear anywhere in the JSON:
                          workspace_id, workspaceId, org_id, orgId, user_id, userId,
                          email, token, secret, api_key (as key), apiKey, credential,
                          credentials, password, private_key, privateKey, access_token,
                          accessToken, refresh_token, refreshToken, client_secret, clientSecret.
  [S7]  per-capability  — each capability has: name (non-empty string), required (boolean).
  [S8]  inputSchemaJson — where present, must be a valid JSON string (parseable).

Coverage check (required capabilities ⊆ profile capabilities):
  [C1]  Every capability marked required:true in the discovery list (input A)
        MUST appear by name in the capabilities array of the ConnectorProfileInput.
        Missing required capability → FAIL (fail-closed).
  [C2]  If baseUrl from profile is null but discovery found a base URL → FAIL.
  [C3]  If apiVersion from profile is null but discovery found a version → FAIL (version drift risk).

If ANY check in Layer 1 fails → output REJECTED with a numbered list of failures.
Do NOT proceed to Layer 2 if Layer 1 has failures. The caller must fix the profile and re-run.

────────────────────────────────────────────────────────────────
LAYER 2 — COMPLETENESS REVIEW (symbolic reasoning, only after Layer 1 PASS)
────────────────────────────────────────────────────────────────
  [R1]  Are all capabilities from the discovery list represented in the profile?
        List any that are in the discovery list but absent from the profile (extras vs. gaps).
  [R2]  Are descriptions sufficiently informative for a developer to understand each capability?
        Flag any that are empty, single-word, or copy-pasted field names.
  [R3]  Does the API version in the profile match the discovery source exactly?
        Flag any discrepancy as a potential version-drift risk.
  [R4]  Are there discovery-noted error codes or rate-limit constraints missing from the
        capability inputSchemaJson? Note gaps (not a hard failure, but recorded for trace).

OUTPUT FORMAT:
  Layer 1 result: PASS | REJECTED (with failure list)
  Layer 2 result (only if Layer 1 PASS): a numbered list of findings (MAJOR | MINOR | NOTE).
  Final verdict: APPROVED (Layer 1 PASS + no MAJOR findings) | APPROVED_WITH_NOTES | REJECTED.
  If APPROVED or APPROVED_WITH_NOTES: include the validated ConnectorProfileInput JSON
    (unchanged from input B — the Validator does NOT modify the profile, it approves or rejects).

Rationale for fail-closed on Layer 1:
  Deterministic validators run before LLM reasoning (N6) because symbolic checks catch
  structural errors that probabilistic reasoning may overlook or rationalise away.
  A missing required capability means the connector is non-functional for its declared purpose.
  Fail-closed is correct: the caller must fix and re-run rather than persist an incomplete profile.',
    'reviewer',
    NULL,
    NULL,
    0
  );
