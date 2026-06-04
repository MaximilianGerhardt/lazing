/**
 * Connector invoke-policy gate (S4, ACL-5-C — 2026-05-24).
 *
 * Deterministic, fail-closed tool hardening for connector calls.
 * Addresses S4 from the ACL-5 auto-connect plan:
 *   "baut hardened allowedTools strikt aus Connector-Capabilities ∩ binding-resolver
 *    ∩ K1-Deny; verbietet bash/file/andere-Provider"
 *
 * Complementary to lib/security/execution-policy.ts (R2 for plan steps):
 *   - execution-policy.ts: plan steps with roles, file/bash tools, workspaceId.
 *   - invoke-policy.ts:    connector calls with provider, capabilities, MCP tools.
 *   Both are pure functions (no I/O, no LLM, no DB, no child_process).
 *
 * Design principles (identical to execution-policy.ts + binding-resolver.ts):
 *   - No default allow. Missing / unknown fields → deny.
 *   - Pure functions: no DB, no LLM, no IO.
 *   - fail-closed: when in doubt, FEWER tools.
 *   - K1-Deny is hard — not overridable by the allowlist.
 *   - N6: deterministic validators before symbolic reasoning.
 *   - N1: reason verbatim, no slice, no truncation.
 *
 * Security constraints (S4):
 *   - allowedMcpTools = mcp_tool_names of the capabilities ∩ requestedCaps, MINUS K1-Deny.
 *   - NO File/Bash/Edit/Write/Read tools — connector calls are MCP-only.
 *   - NO tools of other providers: a tool must start with 'mcp__<provider>__'
 *     (provider namespacing) or must be explicitly in the provider's capability profile.
 *   - Unknown capability (not in the catalog profile) → assertCallAllowed throws.
 *
 * K1-RAG-Deny patterns:
 *   Identical to binding-resolver.ts K1_RAG_DENY_PATTERNS (inlined for audit clarity).
 *   A K1 match blocks insurmountably — the allowlist cannot override K1.
 */

import { matchesK1Deny } from "../routines/binding-resolver";

// ─────────────────────────────────────────────────────────────────────────────
// Public Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A connector capability profile, as assembled from listCapabilities() +
 * getConnectorProfile(). Only the fields relevant for S4.
 */
export interface ConnectorCapabilityProfile {
  /** Capability name, e.g. 'render_video'. */
  name: string;
  /**
   * MCP tool name in canonical form 'mcp__<server>__<tool>'.
   * NULL = the capability has no MCP counterpart (REST-only).
   */
  mcpToolName: string | null;
}

/**
 * The connector profile passed to buildHardenedToolset.
 * Corresponds to the subset of ConnectorCatalogRow + ConnectorCapabilityRow[].
 */
export interface ConnectorProfile {
  /** Provider slug from connector_catalog, e.g. 'heygen'. */
  provider: string;
  /** All known capabilities of this connector. */
  capabilities: ConnectorCapabilityProfile[];
}

/**
 * Result of buildHardenedToolset.
 *
 * allowedMcpTools: STRICTLY the MCP tool names from the provider's capabilities
 *   that (a) are contained in requestedCaps AND (b) do not match K1-Deny.
 * deniedMcpTools: capabilities that were K1-blocked or have no mcpToolName.
 * capabilityToTool: explicit resolution capability-name → concrete allowed
 *   MCP tool name. ONLY allowed (not denied) capabilities appear here.
 *   This is the authoritative source for assertCallAllowed — it is robust
 *   against divergence between capability name and tool name (Finding 3a:
 *   real connectors have cap 'list_avatars' → tool 'mcp__heygen__avatars_list').
 * allowedFileTools: always [] — connector calls need no local file tools.
 * rationale: explanation (N1), verbatim.
 */
export interface HardenedToolset {
  allowedMcpTools: string[];
  deniedMcpTools: string[];
  /**
   * Mapping allowed capability → concrete allowed MCP tool name.
   * An entry exists exactly when the capability has passed all gates (profile,
   * mcpToolName, K1, provider namespace). assertCallAllowed checks
   * `capability in capabilityToTool` (fail-closed: not contained → throws).
   */
  capabilityToTool: Record<string, string>;
  allowedFileTools: readonly never[];
  rationale: string;
}

/**
 * Input for assertCallAllowed.
 */
export interface CallAllowedArgs {
  /** Provider slug, e.g. 'heygen'. */
  provider: string;
  /** Capability name to be called, e.g. 'render_video'. */
  capability: string;
  /** The hardened toolset from buildHardenedToolset. */
  hardened: HardenedToolset;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal constants (S4 hardening)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * File/Bash tools that are NEVER allowed for connector calls.
 * Connector calls are MCP calls against external APIs — they need no
 * local filesystem or shell access. Such a tool in a request
 * is either a programming error or an attack.
 *
 * This is defense-in-depth on top of execution-policy.ts (which also
 * blocks Bash), because invoke-policy.ts has a completely different context:
 * here there are no "allowed write roles" — there are no file tools at all.
 */
const FORBIDDEN_FILE_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Bash",
  "Shell",
  "Exec",
  "Grep",
  "Glob",
  "LS",
]);

// ─────────────────────────────────────────────────────────────────────────────
// buildHardenedToolset — pure, fail-closed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the strictly hardened tool list for a connector call.
 *
 * Algorithm (fail-closed, in this order):
 *   1. provider must be non-empty.
 *   2. For each requestedCap (capability name):
 *      a. Look up the capability in the profile → not found → denied (unknown → out).
 *      b. mcpToolName present? Otherwise → denied (REST-only capability without an MCP tool).
 *      c. K1-Deny check (hard, not overridable) → K1 match → denied.
 *      d. Provider-namespace check: mcpToolName must start with 'mcp__'
 *         AND have 'mcp__<provider>__' as a prefix → otherwise denied (wrong provider).
 *      e. All checks passed → allowed.
 *   3. File/Bash tools are structurally never contained in allowedMcpTools
 *      (they never come in via Capability.mcpToolName).
 *
 * Pure function: no side effects, no DB, no LLM, no IO.
 *
 * @param provider       Provider slug, e.g. 'heygen'.
 * @param profile        Connector profile with capabilities.
 * @param requestedCaps  Capability names the caller wants.
 * @returns              HardenedToolset (always, never throws — assertCallAllowed throws).
 */
export function buildHardenedToolset(
  provider: string,
  profile: ConnectorProfile,
  requestedCaps: readonly string[],
): HardenedToolset {
  // Step 1: provider is required.
  if (!provider || provider.trim().length === 0) {
    return {
      allowedMcpTools: [],
      deniedMcpTools: [],
      capabilityToTool: {},
      allowedFileTools: [],
      rationale:
        "Provider-Slug fehlt: Tool-Hardening erfordert einen Connector-Provider-Namen.",
    };
  }

  const trimmedProvider = provider.trim();

  // Step 2: requestedCaps empty → empty toolset (not denied, simply empty).
  if (requestedCaps.length === 0) {
    return {
      allowedMcpTools: [],
      deniedMcpTools: [],
      capabilityToTool: {},
      allowedFileTools: [],
      rationale: `Keine Capabilities angefordert für Provider '${trimmedProvider}'.`,
    };
  }

  // Capability lookup: name → capability
  const capabilityMap = new Map<string, ConnectorCapabilityProfile>();
  for (const cap of profile.capabilities) {
    capabilityMap.set(cap.name, cap);
  }

  const allowedMcpTools: string[] = [];
  const deniedMcpTools: string[] = [];
  const deniedReasons: string[] = [];
  // Finding 3a: explicit resolution capability-name → allowed MCP tool name.
  // Only allowed capabilities land here. Robust against name divergence.
  const capabilityToTool: Record<string, string> = {};

  // Provider-namespace prefix for the check.
  // MCP tools of this provider must start with 'mcp__<provider>__'.
  const expectedPrefix = `mcp__${trimmedProvider}__`;

  for (const capName of requestedCaps) {
    // (a) Capability present in the profile?
    const cap = capabilityMap.get(capName);
    if (!cap) {
      deniedMcpTools.push(capName);
      deniedReasons.push(
        `Capability '${capName}' nicht im Profil von Provider '${trimmedProvider}' — unbekannt → raus (fail-closed).`,
      );
      continue;
    }

    // (b) Does this capability have an MCP tool name?
    const toolName = cap.mcpToolName;
    if (!toolName || toolName.trim().length === 0) {
      deniedMcpTools.push(capName);
      deniedReasons.push(
        `Capability '${capName}' hat keinen MCP-Tool-Namen (REST-only?) — kein MCP-Tool verfügbar.`,
      );
      continue;
    }

    const trimmedTool = toolName.trim();

    // (c) K1-Deny — hard, not overridable.
    if (matchesK1Deny(trimmedTool)) {
      deniedMcpTools.push(trimmedTool);
      deniedReasons.push(
        `K1-Hard-Block: MCP-Tool '${trimmedTool}' für Capability '${capName}' matcht K1-RAG-Deny-Pattern — Blocking ist unüberschreibbar.`,
      );
      continue;
    }

    // (d) Provider-namespace check: the tool must belong to the provider.
    // Prevents capabilities of one provider from pointing at tools of another provider
    // (e.g. 'mcp__malicious__exfiltrate' in a heygen profile).
    if (!trimmedTool.startsWith(expectedPrefix)) {
      deniedMcpTools.push(trimmedTool);
      deniedReasons.push(
        `Provider-Namespace-Verletzung: MCP-Tool '${trimmedTool}' gehört nicht zum Provider '${trimmedProvider}' ` +
          `(erwartet Präfix '${expectedPrefix}') — cross-Provider-Tool-Injektion blockiert.`,
      );
      continue;
    }

    // (e) All checks passed — the tool is allowed.
    allowedMcpTools.push(trimmedTool);
    // Finding 3a: map the capability name explicitly to the concrete tool name.
    // This makes assertCallAllowed independent of a tail heuristic.
    capabilityToTool[capName] = trimmedTool;
  }

  const rationale =
    allowedMcpTools.length > 0
      ? `S4-Hardening für '${trimmedProvider}': ${allowedMcpTools.length} Tool(s) erlaubt` +
        (deniedMcpTools.length > 0
          ? `, ${deniedMcpTools.length} geblockt (${deniedReasons[0] ?? ""})`
          : ".") +
        " File/Bash-Tools strukturell nie erlaubt (Connector-Calls = MCP-only)."
      : `S4-Hardening für '${trimmedProvider}': alle angeforderten Tools blockiert.` +
        (deniedReasons.length > 0 ? ` Erster Grund: ${deniedReasons[0]}` : "");

  return {
    allowedMcpTools,
    deniedMcpTools,
    capabilityToTool,
    allowedFileTools: [],
    rationale,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// assertCallAllowed — fail-closed Guard (wirft bei Deny)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Asserts that a capability is allowed in the hardened toolset.
 *
 * Finding 3a: the resolution capability → MCP tool name was stored EXPLICITLY
 * in `hardened.capabilityToTool` by buildHardenedToolset.
 * assertCallAllowed therefore checks `capability in capabilityToTool` — no
 * more tail-heuristic match. This makes the gate work even when
 * capability name and tool name diverge (e.g. cap 'list_avatars' →
 * tool 'mcp__heygen__avatars_list').
 *
 * Additionally (defense-in-depth) it verifies that the resolved tool name
 * actually appears in allowedMcpTools and belongs to the provider — so a
 * manipulated map cannot weaken the gate.
 *
 * Fail-closed: throws on any ambiguity.
 *
 * @throws {CallDeniedError} if the capability is not allowed.
 */
export function assertCallAllowed(
  provider: string,
  capability: string,
  hardened: HardenedToolset,
): void {
  const trimmedProvider = (provider ?? "").trim();
  const trimmedCap = (capability ?? "").trim();

  if (!trimmedProvider || !trimmedCap) {
    throw new CallDeniedError(
      `assertCallAllowed: Provider-Slug und Capability-Name dürfen nicht leer sein.`,
      "missing-args",
    );
  }

  // Defensive: capabilityToTool may be missing on a malformed toolset
  // (e.g. older callers). Fail-closed: without the map → no resolution possible.
  const capabilityToTool = hardened.capabilityToTool ?? {};

  if (hardened.allowedMcpTools.length === 0) {
    throw new CallDeniedError(
      `assertCallAllowed: Keine erlaubten MCP-Tools im gehärteten Toolset für Provider '${trimmedProvider}'. ` +
        `Capability '${trimmedCap}' ist nicht erlaubt. Grund: ${hardened.rationale}`,
      "no-allowed-tools",
    );
  }

  // Provider consistency: the hardened toolset must contain tools for this
  // provider at all. Prevents a toolset for provider A from waving through a call
  // for provider B.
  const expectedPrefix = `mcp__${trimmedProvider}__`;
  const relevantAllowed = hardened.allowedMcpTools.filter((t) =>
    t.startsWith(expectedPrefix),
  );

  if (relevantAllowed.length === 0) {
    throw new CallDeniedError(
      `assertCallAllowed: Keine erlaubten MCP-Tools für Provider '${trimmedProvider}' ` +
        `in gehärtetem Toolset. Capability '${trimmedCap}' ist nicht erlaubt. ` +
        `Gesamtes gehärtetes Toolset: [${hardened.allowedMcpTools.join(", ")}]. ` +
        `Rationale: ${hardened.rationale}`,
      "provider-not-in-hardened",
    );
  }

  // Authoritative resolution (Finding 3a): is the capability resolved as allowed?
  // Check an own property (no prototype walk), then re-verify the resolved tool name
  // against allowedMcpTools + provider namespace (defense-in-depth
  // against a manipulated map).
  const resolvedTool = Object.prototype.hasOwnProperty.call(capabilityToTool, trimmedCap)
    ? capabilityToTool[trimmedCap]
    : undefined;

  if (
    !resolvedTool ||
    !relevantAllowed.includes(resolvedTool) ||
    !resolvedTool.startsWith(expectedPrefix)
  ) {
    throw new CallDeniedError(
      `assertCallAllowed: Capability '${trimmedCap}' für Provider '${trimmedProvider}' ` +
        `ist nicht im gehärteten Toolset aufgelöst. ` +
        `Erlaubte Capabilities: [${Object.keys(capabilityToTool).join(", ")}]. ` +
        `Bitte buildHardenedToolset mit Capability '${trimmedCap}' in requestedCaps aufrufen. ` +
        `Fail-closed: kein Call ohne explizite Capability-Auflösung.`,
      "capability-not-resolved",
    );
  }

  // Capability → tool is explicitly resolved, the tool is in allowedMcpTools
  // and belongs to the provider namespace → allowed.
}

// ─────────────────────────────────────────────────────────────────────────────
// CallDeniedError — specific error type for fail-closed denials
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown by assertCallAllowed when a connector call is blocked.
 *
 * The code field lets the caller (trust.ts, ACL5-D executor) distinguish the
 * deny cause for N8 audit purposes without having to parse the error text.
 */
export class CallDeniedError extends Error {
  readonly code:
    | "missing-args"
    | "no-allowed-tools"
    | "provider-not-in-hardened"
    | "capability-not-resolved";

  constructor(
    message: string,
    code: CallDeniedError["code"],
  ) {
    super(message);
    this.name = "CallDeniedError";
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// hasFileToolInRequest — pure helper for tests + defense line
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks whether a list of tool names contains a File/Bash tool.
 * Used by tests to ensure that buildHardenedToolset never
 * returns a File/Bash tool in allowedMcpTools.
 *
 * Pure helper function.
 */
export function hasFileTool(tools: readonly string[]): boolean {
  return tools.some((t) => FORBIDDEN_FILE_TOOLS.has(t));
}
