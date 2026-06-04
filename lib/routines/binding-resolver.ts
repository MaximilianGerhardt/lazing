// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// lib/routines/binding-resolver — Routine/SOP Tool-Binding-Resolver (SAR-4).
//
// ──────────────────────────────────────────────────────────────────────────────
// SECURITY CONTRACT (read before touching this file)
// ──────────────────────────────────────────────────────────────────────────────
//
// This module is a PURE RESOLVER — it computes WHICH tools a bound subagent is
// *permitted* to use. It does NOT invoke any tool, spawn any process, or call
// any MCP-server. All I/O with external systems is explicitly R3-gated and lives
// in server/agents/tmux-spawn.ts (or its successor). Nothing in this file has
// side-effects beyond an optional best-effort N8 audit hook.
//
// Security properties preserved by design:
//
//  K1-Hard-Block (N2/POS-8):
//    `matchesK1Deny()` is the only gate for MCP-RAG-tool rejection. It is
//    evaluated BEFORE the discovered-tool-intersection — an explicit allowlist
//    entry CANNOT override a K1 denial. The K1 patterns are now IMPORTED from
//    lib-v1/mcp/tool-registry-filter.ts (K1_MCP_QUALIFIED_DENY_PATTERNS) —
//    that module is the single source of truth. server/agents/tmux-spawn.ts
//    cannot import via @/ alias (server/tsconfig.json has no paths entry), so
//    it keeps an inline copy guarded by a drift-test
//    (lib/routines/__tests__/k1-drift.test.ts) that asserts byte-equality.
//
//  Fail-safe defaults (N6):
//    - Unknown/missing role → conservative minimal tool set (Read + Grep + Glob).
//    - Empty / missing mcpToolAllowlist → mcpTools: [] (no MCP tools by default).
//    - Tool not in discoveredTools → denied (unknown ≠ safe).
//
//  Defense-in-Depth:
//    File/bash tools are additionally intersected with SAFE_TOOLS (same set as
//    tmux-spawn.ts) so no string in `skills` can smuggle an unsafe tool name
//    through role-skill-map resolution.
//
//  N8 / Trace:
//    `auditBindingResolution()` is the N8 hook surface. The actual DB write is
//    intentionally NOT wired here — SAR-3 (Routine→Plan-Bridge) owns the DB
//    handle at decision time and MUST call auditBindingResolution() after
//    resolveBinding(). See the function-level JSDoc for the expected schema.
//
// ──────────────────────────────────────────────────────────────────────────────

import type { SubagentRole } from '../agents/spawner-types';
import { ROLE_SKILL_MAP } from '../agents/role-skill-map';
// P2-#8: import from zero-dep shared source (lib/security/k1-deny-patterns.ts).
// tool-registry-filter.ts re-exports the same frozen reference.
// server/agents/tmux-spawn.ts imports via relative path (no @/-alias in server/).
// Drift-test: lib/routines/__tests__/k1-drift.test.ts.
import { K1_MCP_QUALIFIED_DENY_PATTERNS } from '@/lib/security/k1-deny-patterns';

// ──────────────────────────────────────────────────────────────────────────────
// Public Types (SAR-3 reads DB columns and passes a typed object — no hard
// column-coupling here)
// ──────────────────────────────────────────────────────────────────────────────

export interface RoutineBinding {
  /** e.g. 'researcher' | 'coder' | 'security' | ... */
  subagentRole?: string;
  /** Free-form skill-hints (informational only — used to derive file/bash tools). */
  skills?: ReadonlyArray<string>;
  /** Requested MCP-tools in canonical form `mcp__<server>__<tool>`. */
  mcpToolAllowlist?: ReadonlyArray<string>;
}

export interface ResolvedBinding {
  /** Permitted file/bash tools — intersection of role skills with SAFE_TOOLS. */
  allowedTools: string[];
  /** Permitted MCP-tools after K1-deny filter + discovered-tool intersection. */
  mcpTools: string[];
  /**
   * MCP-tools that were requested but blocked:
   *   - K1-denied tools (RAG pattern match), AND
   *   - tools absent from discoveredTools (unknown → denied).
   */
  deniedMcpTools: string[];
  /** Resolved role (validated SubagentRole or 'unknown'). */
  role: string;
}

export interface ResolveBindingOptions {
  /**
   * Set of MCP tool names currently discovered / announced by running MCP
   * servers. If omitted, no MCP tools are permitted (fail-safe).
   *
   * Pass the flat list of canonical names, e.g.:
   *   ['mcp__heygen__render', 'mcp__github__list_repos', ...]
   */
  discoveredTools?: ReadonlyArray<string>;
}

// ──────────────────────────────────────────────────────────────────────────────
// SAFE_TOOLS — identical to the hardcoded set in server/agents/tmux-spawn.ts.
// Defense-in-depth: only these names can ever appear in allowedTools.
// ──────────────────────────────────────────────────────────────────────────────

const SAFE_TOOLS = new Set<string>([
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Grep',
  'Glob',
]);

// ──────────────────────────────────────────────────────────────────────────────
// K1 RAG Deny Patterns — single-source of truth
//
// Imported from lib-v1/mcp/tool-registry-filter.ts K1_MCP_QUALIFIED_DENY_PATTERNS.
// That module is the CANONICAL source; this resolver delegates to it.
//
// server/agents/tmux-spawn.ts maintains its own inline copy (server/ has no
// @/-alias for lib-v1/) — the drift-test at
// lib/routines/__tests__/k1-drift.test.ts asserts byte-equality between the
// two copies to prevent silent divergence.
//
// IMPORTANT: Do NOT add prefix-wildcards (e.g. `*-rag`) — they can match
// legitimate tools. Explicit patterns + suffix-wildcards in canonical form only.
// ──────────────────────────────────────────────────────────────────────────────

// Alias for the local match function and security comment below.
const K1_RAG_DENY_PATTERNS = K1_MCP_QUALIFIED_DENY_PATTERNS;

// Integrity guard: K1_MCP_QUALIFIED_DENY_PATTERNS is frozen at its definition
// site in tool-registry-filter.ts. The guard here ensures the module-level
// freeze survived the import (e.g. no vi.mock stripping the freeze).
if (!Object.isFrozen(K1_RAG_DENY_PATTERNS)) {
  throw new Error(
    'SECURITY: K1_RAG_DENY_PATTERNS (imported K1_MCP_QUALIFIED_DENY_PATTERNS) is not frozen. ' +
      'Likely vi.mock/jest.mock applied to tool-registry-filter. Bypass blocked.',
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// K1 glob-match logic
//
// Rules (same logic as matchDenyPattern in lib-v1/mcp/tool-registry-filter.ts):
//   1. Exact match.
//   2. Suffix-wildcard `*-suffix`: tool.endsWith(suffix).
//   3. Prefix-wildcard `prefix*`: tool.startsWith(prefix).
//   4. Embedded-wildcard `head*middle*tail…`: split on `*`, check head+middle+tail.
//
// NOTE on correctness: we use split-based matching, NOT RegExp with `.`/`.*`,
// so there is no `.*`-RegExp-hole. A `*` in a pattern is treated as a literal
// "any sequence of characters in a single segment", not as a meta-character that
// matches dots or path separators specially — that is appropriate because MCP
// canonical names use `__` as the only meaningful delimiter, not `/`.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if `toolName` matches any K1 RAG deny pattern.
 *
 * K1 is a HARD BLOCK — it is called before any allowlist is consulted, and
 * its result is not overridable by the caller.
 */
export function matchesK1Deny(toolName: string): boolean {
  for (const pattern of K1_RAG_DENY_PATTERNS) {
    if (matchGlobPattern(toolName, pattern)) return true;
  }
  return false;
}

/**
 * Minimal, safe glob-match:
 *   - No RegExp usage — avoids `.*` holes and ReDoS risk.
 *   - `*` matches any sequence of characters (greedy, single-pass split).
 *   - No `?` support (not needed by K1 patterns).
 */
function matchGlobPattern(name: string, pattern: string): boolean {
  // Exact match (fast path, no wildcards needed)
  if (!pattern.includes('*')) {
    return name === pattern;
  }

  // Pattern is entirely `*` → matches everything (shouldn't appear in K1 but safe)
  if (pattern === '*') return true;

  // Split pattern on `*` to get literal segments
  const segments = pattern.split('*');
  // segments[0]  = required prefix (may be '')
  // segments[N-1] = required suffix (may be '')
  // segments[1..N-2] = required interior substrings (in order)

  const prefix = segments[0] ?? '';
  const suffix = segments[segments.length - 1] ?? '';

  if (prefix && !name.startsWith(prefix)) return false;
  if (suffix && !name.endsWith(suffix)) return false;

  // Walk interior segments in order, consuming from the name left-to-right.
  // We start after the consumed prefix, and leave room for the suffix.
  let cursor = prefix.length;
  const nameEnd = name.length - suffix.length;

  for (let i = 1; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (!seg) continue; // empty segment between consecutive `*` → skip
    const idx = name.indexOf(seg, cursor);
    if (idx === -1 || idx > nameEnd) return false;
    cursor = idx + seg.length;
  }

  return true;
}

// ──────────────────────────────────────────────────────────────────────────────
// Conservative default tool-set for unknown / unrecognised roles
// ──────────────────────────────────────────────────────────────────────────────

/** Minimal read-only tools granted to unknown roles (fail-safe). */
const CONSERVATIVE_TOOLS: readonly string[] = Object.freeze(['Read', 'Grep', 'Glob']);

// ──────────────────────────────────────────────────────────────────────────────
// Role validation
// ──────────────────────────────────────────────────────────────────────────────

function isKnownRole(role: string): role is SubagentRole {
  return role in ROLE_SKILL_MAP;
}

// ──────────────────────────────────────────────────────────────────────────────
// resolveBinding — main entry point
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a RoutineBinding to its concrete, security-checked tool set.
 *
 * Security guarantees (see file header for full rationale):
 *   1. K1 RAG deny is checked first and cannot be overridden.
 *   2. MCP tools not present in opts.discoveredTools are denied.
 *   3. File/bash tools are restricted to SAFE_TOOLS (defense-in-depth).
 *   4. All defaults are fail-safe: unknown role → minimal tools; missing
 *      allowlist → no MCP tools.
 *
 * The caller (SAR-3) MUST call `auditBindingResolution()` with the result
 * immediately after, while still holding the DB transaction, to satisfy N8.
 */
export function resolveBinding(
  binding: RoutineBinding,
  opts: ResolveBindingOptions = {},
): ResolvedBinding {
  // ── 1. Role resolution ────────────────────────────────────────────────────
  const rawRole = (binding.subagentRole ?? '').trim();
  const role = rawRole && isKnownRole(rawRole) ? rawRole : 'unknown';

  // ── 2. File/bash tool resolution ──────────────────────────────────────────
  // Source: ROLE_SKILL_MAP for known roles; conservative defaults for unknown.
  // Then intersect with SAFE_TOOLS (defense-in-depth, mirrors tmux-spawn.ts).
  //
  // Normalisation: role-skill-map stores lowercase canonical names ('read',
  // 'bash', …) while claude-CLI and SAFE_TOOLS use capitalised names ('Read',
  // 'Bash', …). We capitalise the first character before the SAFE_TOOLS check
  // so the intersection is correct regardless of source casing.
  let candidateTools: readonly string[];
  if (role !== 'unknown') {
    candidateTools = ROLE_SKILL_MAP[role as SubagentRole];
  } else {
    candidateTools = CONSERVATIVE_TOOLS;
  }
  const allowedTools = candidateTools
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
    .filter((t) => SAFE_TOOLS.has(t));

  // ── 3. MCP-tool resolution ────────────────────────────────────────────────
  const requested = binding.mcpToolAllowlist ?? [];

  // Fail-safe: if no allowlist supplied, no MCP tools are granted.
  if (requested.length === 0) {
    return {
      allowedTools,
      mcpTools: [],
      deniedMcpTools: [],
      role,
    };
  }

  // Build a fast-lookup set of discovered tools (if provided).
  // Fail-safe: if no discoveredTools array is provided at all, no MCP tool is
  // allowed — the resolver cannot confirm the tool exists.
  const discoveredSet = opts.discoveredTools !== undefined
    ? new Set<string>(opts.discoveredTools)
    : null; // null = "no discovery info available" → deny all

  const mcpTools: string[] = [];
  const deniedMcpTools: string[] = [];

  for (const tool of requested) {
    // K1 Hard-Block — evaluated first, not overridable by allowlist.
    if (matchesK1Deny(tool)) {
      deniedMcpTools.push(tool);
      continue;
    }

    // Unknown-tool block: deny if:
    //   - no discovery info was provided (discoveredSet === null), OR
    //   - tool is absent from the discovered set.
    // Unknown ≠ safe (fail-safe principle N6).
    if (discoveredSet === null || !discoveredSet.has(tool)) {
      deniedMcpTools.push(tool);
      continue;
    }

    // Tool passed K1 filter and is confirmed discovered.
    mcpTools.push(tool);
  }

  return { allowedTools, mcpTools, deniedMcpTools, role };
}

// ──────────────────────────────────────────────────────────────────────────────
// N8 Audit Hook (best-effort stub)
//
// SAR-3 (Routine→Plan-Bridge) is the module that holds the DB handle at
// resolution time and MUST call this function to satisfy N8. The function
// signature is intentionally DB-agnostic so SAR-3 can forward the payload to
// whatever audit writer is active (writeFilterAudit / writeAuditRow / etc.).
//
// Schema for the audit row (table: lazyos_binding_resolution_audit — migration
// owned by SAR-3):
//   routine_id      TEXT NOT NULL
//   workspace_id    TEXT NOT NULL
//   resolved_role   TEXT NOT NULL
//   allowed_tools   TEXT NOT NULL  -- JSON array
//   mcp_tools       TEXT NOT NULL  -- JSON array
//   denied_mcp_tools TEXT NOT NULL -- JSON array
//   binding_json    TEXT NOT NULL  -- JSON of input RoutineBinding
//   content_hash    TEXT NOT NULL  -- sha256 of canonical row (N10)
//   ts              INTEGER NOT NULL DEFAULT (unixepoch())
//
// N10: content_hash must be computed over the canonical-JSON of all fields
//   except ts and content_hash itself (use lib-v1/audit/canonical-json.ts).
// ──────────────────────────────────────────────────────────────────────────────

export interface BindingAuditPayload {
  routineId: string;
  workspaceId: string;
  binding: RoutineBinding;
  resolved: ResolvedBinding;
  /** Unix millis at decision time (for content-hash determinism). */
  decidedAt: number;
}

/**
 * N8 audit hook — best-effort, intentionally has no side-effects here.
 *
 * SAR-3 MUST provide an `onAudit` callback that writes the payload to
 * `lazyos_binding_resolution_audit` in the SAME DB transaction as the
 * routine-execution row. Fail-closed: if the audit write fails, the
 * execution MUST also roll back (same transaction).
 *
 * This function itself is a pure pass-through so that tests can verify
 * the audit payload shape without requiring a DB handle.
 */
export function auditBindingResolution(
  payload: BindingAuditPayload,
  onAudit: (payload: BindingAuditPayload) => void,
): void {
  // Best-effort: if the callback throws, we surface the error but do NOT
  // swallow it — the caller (SAR-3) must handle it (roll back transaction).
  onAudit(payload);
}
