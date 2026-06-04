// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Maximilian Gerhardt
//
// M-PERM-07 — Tool-Class-Granularität (Tool-Name → ToolClass Mapping)
// Authority: modules/W1/M-PERM-07/TOOL-CLASS-MAP-SPEC.md (verbatim)
//
// Single source of truth for the translation between three vocabularies:
//   - Tool-Name (Bash, Read, mcp__*) → ToolClass (RUNTIME_TOOL_CLASS_MAP)
//   - Audit-Class (M9 §1) → ToolClass (POLICY_TOOL_CLASS_MAP)

/**
 * The 8 Policy-Tool-Classes (subplans/05 §4 + M-PERM-01 §2 CHECK).
 * Frozen const-tuple — Drift-protection analogous to M6 FLOOR_CLASSES.
 */
export const TOOL_CLASSES = Object.freeze([
  'fs-read',
  'fs-write',
  'network',
  'shell',
  'git',
  'ollama',
  'claude-cli-subspawn',
  'db',
] as const);

export type ToolClass = (typeof TOOL_CLASSES)[number];

/**
 * Audit-Class vocabulary (M9 §1 lazyos_tool_audit.tool_class).
 */
export type AuditToolClass =
  | 'Bash'
  | 'Read'
  | 'Grep'
  | 'Glob'
  | 'Write'
  | 'Edit'
  | 'Network'
  | 'Spawn'
  | 'DB'
  | 'MCP'
  | 'Skill'
  | 'CLI';

export interface RuntimeMap {
  EXACT_NAME: Readonly<Record<string, ToolClass>>;
  PATTERN_PREFIX: ReadonlyArray<{ prefix: string; class: ToolClass }>;
  PATTERN_GLOB: ReadonlyArray<{ glob: string; class: ToolClass }>;
}

/**
 * RUNTIME-Map: Tool-Name → ToolClass.
 */
export const RUNTIME_TOOL_CLASS_MAP: RuntimeMap = {
  EXACT_NAME: Object.freeze({
    // FS-Read
    Read: 'fs-read',
    Grep: 'fs-read',
    Glob: 'fs-read',
    // FS-Write
    Write: 'fs-write',
    Edit: 'fs-write',
    MultiEdit: 'fs-write',
    NotebookEdit: 'fs-write',
    // Shell
    Bash: 'shell',
    BashOutput: 'shell',
    KillShell: 'shell',
    SlashCommand: 'shell',
    EnterWorktree: 'shell',
    ExitWorktree: 'shell',
    // Network
    WebFetch: 'network',
    WebSearch: 'network',
    // Subspawn
    Task: 'claude-cli-subspawn',
    TaskStop: 'claude-cli-subspawn',
    Monitor: 'claude-cli-subspawn',
    Skill: 'claude-cli-subspawn',
  }) as Readonly<Record<string, ToolClass>>,

  PATTERN_PREFIX: Object.freeze([
    { prefix: 'mcp__local-rag__', class: 'db' as ToolClass },
    { prefix: 'mcp__standards-rag__', class: 'db' as ToolClass },
    { prefix: 'mcp__lazyos-rag__', class: 'db' as ToolClass },
    { prefix: 'mcp__ruv-swarm__', class: 'claude-cli-subspawn' as ToolClass },
    { prefix: 'mcp__flow-nexus__', class: 'claude-cli-subspawn' as ToolClass },
    { prefix: 'mcp__ruflo__', class: 'db' as ToolClass },
    { prefix: 'mcp__claude-flow__', class: 'db' as ToolClass },
    { prefix: 'mcp__plugin_vercel_vercel__', class: 'network' as ToolClass },
    { prefix: 'mcp__claude_ai_Google_Drive__', class: 'network' as ToolClass },
    { prefix: 'mcp__outputai__', class: 'network' as ToolClass },
    { prefix: 'mcp__sandbox', class: 'claude-cli-subspawn' as ToolClass },
    { prefix: 'mcp__storage', class: 'network' as ToolClass },
    { prefix: 'mcp__neural', class: 'claude-cli-subspawn' as ToolClass },
    { prefix: 'mcp__workflow', class: 'network' as ToolClass },
  ]),

  PATTERN_GLOB: Object.freeze([
    { glob: 'mcp__*-rag-*', class: 'db' as ToolClass },
    { glob: 'mcp__*-global-*', class: 'network' as ToolClass },
    { glob: '*_fetch', class: 'network' as ToolClass },
    { glob: '*_authenticate', class: 'network' as ToolClass },
    { glob: '*_chat', class: 'network' as ToolClass },
    { glob: '*_predict', class: 'network' as ToolClass },
  ]),
} as const;

/**
 * POLICY-Map: lazyos_tool_audit.tool_class → policy tool_class.
 */
export const POLICY_TOOL_CLASS_MAP: Readonly<Record<AuditToolClass, ToolClass>> =
  Object.freeze({
    Bash: 'shell',
    Read: 'fs-read',
    Grep: 'fs-read',
    Glob: 'fs-read',
    Write: 'fs-write',
    Edit: 'fs-write',
    Network: 'network',
    Spawn: 'claude-cli-subspawn',
    DB: 'db',
    MCP: 'db',
    Skill: 'claude-cli-subspawn',
    CLI: 'shell',
  });

/**
 * Tools that are ALWAYS allowed without policy resolution.
 * These have no side-effects and are UI/discovery helpers.
 */
export const ALWAYS_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'TodoWrite',
  'ToolSearch',
]);

/**
 * Bash-Subkommando-Patterns. First-match-wins ordering (spec §3).
 */
export const BASH_SUBCLASS_PATTERNS: ReadonlyArray<{
  regex: RegExp;
  class: ToolClass;
}> = Object.freeze([
  // 1. Network-Egress
  { regex: /^(curl|wget|nc|ncat|httpie|http)\b/, class: 'network' as ToolClass },
  { regex: /^fetch\s+http/, class: 'network' as ToolClass },
  // 2. Git
  { regex: /^git\b/, class: 'git' as ToolClass },
  // 3. Ollama
  { regex: /^ollama\s+(run|pull|create)\b/, class: 'ollama' as ToolClass },
  // 4. DB-CLI
  { regex: /^(sqlite3|psql|mysql|mongosh)\b/, class: 'db' as ToolClass },
  // 5. Claude-CLI rekursion
  {
    regex: /\bclaude\s+(--print|--model|--max-turns)\b/,
    class: 'claude-cli-subspawn' as ToolClass,
  },
]);

export class InvalidToolNameError extends Error {
  constructor(name: string, reason: string) {
    super(`InvalidToolNameError: "${name}" — ${reason}`);
    this.name = 'InvalidToolNameError';
  }
}

export class UnknownToolNameError extends Error {
  constructor(toolName: string) {
    super(
      `UnknownToolNameError: "${toolName}" not mapped in RUNTIME_TOOL_CLASS_MAP. ` +
        `Every tool name MUST be explicitly mapped or it bypasses policy.`,
    );
    this.name = 'UnknownToolNameError';
  }
}

/** Simple glob match (* matches any sequence, including empty). */
function globMatch(pattern: string, str: string): boolean {
  // Convert glob to regex
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*') +
      '$',
  );
  return re.test(str);
}

/**
 * Bash-Sub-Klassifizierung. Returns refined class.
 */
export function bashSubClass(bashPattern: string): ToolClass {
  // Strip `Bash(` prefix and `)` suffix if present
  let cmd = bashPattern;
  const m = /^Bash\((.*)\)$/s.exec(bashPattern);
  if (m) cmd = m[1];
  cmd = cmd.trim();

  for (const { regex, class: cls } of BASH_SUBCLASS_PATTERNS) {
    if (regex.test(cmd)) return cls;
  }
  return 'shell';
}

/**
 * Resolver-Funktion: Tool-Name → ToolClass | null.
 * fail-closed: null = "unknown" → Caller MUST fail-closed-deny.
 *
 * Match-order:
 *   1. ALWAYS_ALLOWED_TOOLS (returns null — caller must check this set first)
 *   2. EXACT_NAME[toolName]
 *   3. PATTERN_PREFIX
 *   4. PATTERN_GLOB
 *   5. null
 */
export function toolNameToClass(toolName: string): ToolClass | null {
  if (typeof toolName !== 'string' || toolName === '') {
    throw new InvalidToolNameError(toolName, 'empty or non-string');
  }
  if (/[\\/]\.\./.test(toolName) || toolName.includes('../')) {
    throw new InvalidToolNameError(toolName, 'contains path traversal');
  }

  // Always-allowed tools have no class (caller checks ALWAYS_ALLOWED_TOOLS separately).
  if (ALWAYS_ALLOWED_TOOLS.has(toolName)) return null;

  const exact = RUNTIME_TOOL_CLASS_MAP.EXACT_NAME[toolName];
  if (exact !== undefined) return exact;

  for (const { prefix, class: cls } of RUNTIME_TOOL_CLASS_MAP.PATTERN_PREFIX) {
    if (toolName.startsWith(prefix)) return cls;
  }

  // Glob — longest-pattern-first ordering implicit in array.
  const globs = [...RUNTIME_TOOL_CLASS_MAP.PATTERN_GLOB].sort(
    (a, b) => b.glob.length - a.glob.length,
  );
  for (const { glob, class: cls } of globs) {
    if (globMatch(glob, toolName)) return cls;
  }

  return null;
}

export interface ClassifyResult {
  mapped: Map<string, ToolClass>;
  unknown: string[];
}

/**
 * Batch-Resolver for tool-name lists.
 */
export function mapToolNamesToClasses(
  toolNames: ReadonlyArray<string>,
): ClassifyResult {
  const mapped = new Map<string, ToolClass>();
  const unknown: string[] = [];
  for (const t of toolNames) {
    const cls = toolNameToClass(t);
    if (cls === null) {
      if (!ALWAYS_ALLOWED_TOOLS.has(t)) unknown.push(t);
      continue;
    }
    mapped.set(t, cls);
  }
  return { mapped, unknown };
}
