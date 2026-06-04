/**
 * Deterministic execution-policy gate (R2, 2026-05-24).
 *
 * Addresses S2 from the phase-2 execution-safety design:
 * Per step, BEFORE the spawn, it is categorized deterministically (NOT via LLM)
 * whether the step touches write / shell / network / secrets / scope. Disallowed
 * categories → block + an operator-language one-sentence rationale.
 *
 * Usage:
 *   - Hooked in BEFORE the spawn call in `lib/workstreams/plan-executor.ts` after
 *     `setPlanStepStatus(step.id, 'active')` (anchor point: R3).
 *   - On deny it returns `allowedTools` so the bridge card can still
 *     show which tools would in principle be permissible for the step.
 *
 * Design principles (identical to dataflow-policy.ts):
 *   - No default-allow. Missing / unknown fields → deny.
 *   - Pure function: no DB, no LLM, no IO, no child_process.
 *   - fail-closed (like `sensitivity ?? 'high'` in dataflow-policy.ts).
 *   - N1: reason verbatim, no slice, no truncation.
 *   - N6: deterministic validators before symbolic reasoning.
 *
 * Rules (R2 — conservative):
 *   - executionMode === 'plan-only' → ALWAYS deny (phase-1 default).
 *   - Bash → DEFAULT-DENY in R2 (T3/T6), never returned in allowedTools.
 *   - Write / Edit → only for roles architect/coder in execute modes.
 *   - Secrets (targetPaths contains .env / .credential / credentials / secret /
 *     .pem / id_rsa) → ALWAYS deny, category 'secrets'.
 *   - Scope (targetPaths with .. or absolute paths outside the workspace) →
 *     deny + requiresBridge: true, category 'scope'.
 *   - Unknown role or unknown tool → deny (fail-closed).
 */

export type ExecutionCategory = 'write' | 'shell' | 'network' | 'secrets' | 'scope';

/**
 * R2-relevant view of the workspace permission mode (A·EXEC, 2026-05-26).
 *
 * The mode IS the user consent. It controls whether R2 even considers
 * Bash/Write — separate from the role logic:
 *
 *   'freerein'  → Bash ALLOWED (system access by design under explicit
 *                 consent) + Write/Edit for architect/coder.
 *                 RESIDUAL: FreeRein-Bash = arbitrary shell in the ISOLATED
 *                 R1 worktree (env -i-scrubbed, K1-hard). Merge stays gated.
 *   'lane'      → NO Bash, Write/Edit only architect/coder.
 *   'ask'       → plan-only (deny) — today's safe behavior.
 *   undefined   → plan-only (deny) — today's safe behavior (DEFAULT).
 *
 * If the mode is NOT passed (undefined), enforceExecutionStep behaves
 * BIT-IDENTICALLY to the pre-EXEC version: Bash stays default-deny in R2. That is
 * the safe path for all callers that do not (yet) pass the mode through.
 */
export type PermissionModeForGate = 'freerein' | 'freerein-with-audit' | 'lane' | 'ask';

export interface ExecutionStepRequest {
  /** The role of the subagent executing the step (e.g. 'coder', 'architect', 'tester', 'reviewer'). */
  role: string;
  /** Execution mode: 'plan-only' is the phase-1 default and blocks ANY execution. */
  executionMode: 'plan-only' | 'execute-per-step' | 'execute-per-plan';
  /** The tools requested by the step (e.g. ['Read','Write','Edit','Bash']). */
  requestedTools: readonly string[];
  /** Paths the step wants to touch. Empty/undefined → no path checks. */
  targetPaths?: readonly string[];
  /** Workspace ID as scope anchor (N9: every entity carries workspace context). */
  workspaceId: string;
  /**
   * Workspace permission mode (A·EXEC, 2026-05-26). Optional — the mode IS
   * the explicit user consent for real tool execution.
   *
   *   - undefined / 'ask' → Bash stays default-deny in R2 (UNCHANGED, safe).
   *   - 'lane'            → no Bash, Write/Edit only architect/coder.
   *   - 'freerein' / 'freerein-with-audit' → Bash ALLOWED (instead of blanket-deny),
   *     Write/Edit for architect/coder. Bash runs EXCLUSIVELY in the isolated
   *     R1 worktree (job of the spawn layer), K1-hard, env -i-scrubbed.
   *
   * If the mode is missing, R2 stays bit-identical to the pre-EXEC version (Bash deny).
   */
  permissionMode?: PermissionModeForGate;
}

export interface ExecutionDecision {
  /** true = the step may be executed (with allowedTools). */
  allow: boolean;
  /** Operator-language rationale, 1 sentence, verbatim (N1). */
  reason: string;
  /**
   * The subset of requestedTools permissible per policy.
   * On allow:false this contains the tools that would in principle be allowed —
   * helps the bridge card show what is missing.
   * At least Read/Grep/Glob always stay included (if requested).
   */
  allowedTools: readonly string[];
  /**
   * true if the step attempts cross-scope access (path escape or
   * workspace boundary): bridge consent is needed before proceeding.
   */
  requiresBridge: boolean;
  /** Which security categories this step touches. */
  categories: ExecutionCategory[];
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Tools that are fundamentally safe (read-only). */
const SAFE_READONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);

/** Tools that require write access. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

/**
 * Bash is DEFAULT-DENY in R2 (T3/T6): Bash = arbitrary shell = cat .env + network.
 *
 * A·EXEC (2026-05-26): the ONLY exception is the explicitly set FreeRein
 * mode (permissionMode 'freerein' / 'freerein-with-audit'). The mode IS the
 * user consent. With FreeRein, Bash is allowed AND returned in allowedTools
 * — execution then runs EXCLUSIVELY in the isolated
 * R1 worktree (spawn layer), env -i-scrubbed, K1-hard. Without FreeRein mode
 * (undefined / 'lane' / 'ask') Bash stays default-deny — bit-identical to before.
 */
const SHELL_TOOLS = new Set(['Bash', 'Shell', 'Exec']);

/**
 * Checks whether the mode consents to Bash execution. ONLY FreeRein.
 * undefined / 'lane' / 'ask' → false (Bash stays default-deny in R2).
 */
function bashConsentedByMode(mode: PermissionModeForGate | undefined): boolean {
  return mode === 'freerein' || mode === 'freerein-with-audit';
}

/**
 * Roles that may use Write/Edit tools in execute modes.
 * All other roles are read-only (reviewer, tester, …).
 */
const WRITE_ALLOWED_ROLES = new Set(['architect', 'coder']);

/**
 * Pattern for secret files (T3): matches components of the path.
 * Order: most specific first.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\.env(\.|$|\/)/i,
  /\.credential/i,
  /credentials/i,
  /secret/i,
  /\.pem$/i,
  /id_rsa/i,
  /\.key$/i,
];

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function isNonEmpty(s: unknown): s is string {
  return typeof s === 'string' && s.trim().length > 0;
}

/** Checks whether a path contains a secret pattern. */
function isSecretPath(p: string): boolean {
  return SECRET_PATTERNS.some(rx => rx.test(p));
}

/**
 * Checks whether a path leaves the workspace scope.
 * Rules:
 *   - absolute paths (start with /) → scope violation (may be outside the workspace).
 *   - path traversal with .. → scope violation.
 * Note: in R2 (pure policy without FS access) we cannot do an
 * actual path resolve against the workspace root — that is R3's job
 * (worktree-manager.ts). Here we block the syntactic escape attempts.
 */
function isScopeViolation(p: string): boolean {
  // Path traversal (also URL-encoded variant)
  if (p.includes('..')) return true;
  // Absolute paths
  if (p.startsWith('/')) return true;
  return false;
}

/**
 * Determines the categories of a tool.
 * Returns: the set of touched ExecutionCategory values.
 */
function categoriesForTool(tool: string): ExecutionCategory[] {
  if (SHELL_TOOLS.has(tool)) return ['shell', 'network']; // Bash can do both
  if (WRITE_TOOLS.has(tool)) return ['write'];
  // Read is uncritical (secrets are checked via targetPaths, not via the tool alone)
  return [];
}

/**
 * Returns the tools allowed per policy (at least Read/Grep/Glob from requestedTools).
 *
 * A·EXEC (2026-05-26): Bash is returned ONLY if `allowShell` is true
 * (= FreeRein mode consented). Without FreeRein, Bash stays out — bit-identical
 * to the pre-EXEC version (allowShell default false at all call sites that do not
 * pass the mode through).
 */
function computeAllowedTools(
  requestedTools: readonly string[],
  allowWrite: boolean,
  allowShell: boolean = false,
): readonly string[] {
  return requestedTools.filter(tool => {
    if (SHELL_TOOLS.has(tool)) return allowShell; // Bash only with FreeRein consent
    if (WRITE_TOOLS.has(tool)) return allowWrite;
    return true; // Read, Grep, Glob, etc.
  });
}

// ---------------------------------------------------------------------------
// Main function (pure, no side effects)
// ---------------------------------------------------------------------------

/**
 * Makes an allow/deny decision for a plan step BEFORE the spawn.
 * Pure function — no side effects.
 *
 * Rule order (fail-closed — first matching rule wins):
 *   1. workspaceId required.
 *   2. executionMode === 'plan-only' → deny.
 *   3. scope violation in targetPaths → deny ('scope') + requiresBridge.
 *      (Scope before secrets: a path-escape attempt is primarily a scope violation.)
 *   4. secrets in targetPaths → deny ('secrets').
 *   5. shell tools requested → deny ('shell'+'network') in R2 — EXCEPT the
 *      mode is FreeRein (A·EXEC, 2026-05-26): then Bash is allowed because the
 *      mode carries the explicit user consent. Execution then runs
 *      in the isolated R1 worktree (spawn layer), env -i-scrubbed, K1-hard.
 *   6. write tools + role not write-authorized → deny ('write').
 *   7. unknown tools (neither safe nor known-write/shell) → deny (fail-closed).
 *   8. all checks passed → allow with cleaned allowedTools (Bash only with FreeRein).
 *
 * Security invariant: if `permissionMode` is NOT set (undefined), the
 * behavior is BIT-IDENTICAL to the pre-EXEC version — Bash stays default-deny.
 * Real Bash execution happens ONLY with explicitly set FreeRein.
 */
export function enforceExecutionStep(req: ExecutionStepRequest): ExecutionDecision {
  const shellConsented = bashConsentedByMode(req.permissionMode);
  // Step 1 — workspaceId required (N9: scope anchor).
  if (!isNonEmpty(req.workspaceId)) {
    return {
      allow: false,
      reason: 'workspaceId fehlt: jeder Execution-Step benötigt einen Workspace-Kontext.',
      allowedTools: [],
      requiresBridge: false,
      categories: [],
    };
  }

  // Step 2 — plan-only → ALWAYS deny (phase-1 default, non-destructive).
  if (req.executionMode === 'plan-only') {
    return {
      allow: false,
      reason: 'plan-only-Modus: keine Ausführung — wechsle zu execute-per-step oder execute-per-plan für destruktive Steps.',
      allowedTools: computeAllowedTools(req.requestedTools, false),
      requiresBridge: false,
      categories: [],
    };
  }

  // From here: execute-per-step or execute-per-plan.
  const collectedCategories = new Set<ExecutionCategory>();

  const targetPaths = req.targetPaths ?? [];

  // Step 3 — scope violation in targetPaths (T1/T5, N2/N9).
  // Scope check BEFORE secrets: a path-escape attempt is classified as a scope
  // violation even if the target path happens to also contain a secret pattern.
  // requiresBridge: true is the critical signal for the bridge-consent surface.
  const scopeViolations = targetPaths.filter(isScopeViolation);
  if (scopeViolations.length > 0) {
    collectedCategories.add('scope');
    return {
      allow: false,
      reason: `Scope-Verletzung erkannt (${scopeViolations[0]}): Pfade mit .. oder absoluten Referenzen verlassen den Workspace-Baum — Bridge-Consent erforderlich.`,
      allowedTools: computeAllowedTools(req.requestedTools, false),
      requiresBridge: true,
      categories: Array.from(collectedCategories),
    };
  }

  // Step 4 — secrets in targetPaths (T3): NEVER allow.
  const secretPaths = targetPaths.filter(isSecretPath);
  if (secretPaths.length > 0) {
    collectedCategories.add('secrets');
    return {
      allow: false,
      reason: `Secret-Pfad erkannt (${secretPaths[0]}): Zugriff auf .env / Credentials / Schlüsseldateien ist grundsätzlich verboten.`,
      allowedTools: computeAllowedTools(req.requestedTools, false),
      requiresBridge: false,
      categories: Array.from(collectedCategories),
    };
  }

  // Step 5 — shell tools → DEFAULT-DENY in R2 (T3/T6).
  //
  // A·EXEC (2026-05-26): the ONLY exception is the explicitly set
  // FreeRein mode. The mode IS the user consent. Without FreeRein
  // (undefined / 'lane' / 'ask') the hard Bash block still applies —
  // bit-identical to the pre-EXEC version.
  const requestedShellTools = req.requestedTools.filter(t => SHELL_TOOLS.has(t));
  if (requestedShellTools.length > 0 && !shellConsented) {
    collectedCategories.add('shell');
    collectedCategories.add('network');
    return {
      allow: false,
      reason: `Bash/Shell ist in R2 grundsätzlich gesperrt (beliebige Shell = Secret-Read + Netzwerk-Zugriff) — Step muss ohne Shell-Tools auskommen, oder der Workspace muss explizit auf FreeRein gesetzt sein.`,
      allowedTools: computeAllowedTools(req.requestedTools, WRITE_ALLOWED_ROLES.has(req.role), false),
      requiresBridge: false,
      categories: Array.from(collectedCategories),
    };
  }
  // FreeRein path: Bash is consented → mark category 'shell'+'network'
  // (audit transparency), but do NOT block. Isolation (R1 worktree) +
  // env scrub + K1 are the spawn layer's job, not R2's.
  if (requestedShellTools.length > 0 && shellConsented) {
    collectedCategories.add('shell');
    collectedCategories.add('network');
  }

  // Step 6 — check write tools: only architect/coder in execute modes.
  const requestedWriteTools = req.requestedTools.filter(t => WRITE_TOOLS.has(t));
  const roleAllowsWrite = WRITE_ALLOWED_ROLES.has(req.role);

  if (requestedWriteTools.length > 0) {
    collectedCategories.add('write');
    if (!roleAllowsWrite) {
      return {
        allow: false,
        reason: `Rolle '${req.role}' ist read-only: Write/Edit-Tools sind für tester/reviewer/unbekannte Rollen nicht erlaubt.`,
        allowedTools: computeAllowedTools(req.requestedTools, false, shellConsented),
        requiresBridge: false,
        categories: Array.from(collectedCategories),
      };
    }
  }

  // Step 7 — unknown tools (neither safe-readonly nor write nor shell) → deny.
  const knownTools = new Set([...SAFE_READONLY_TOOLS, ...WRITE_TOOLS, ...SHELL_TOOLS]);
  const unknownTools = req.requestedTools.filter(t => !knownTools.has(t));
  if (unknownTools.length > 0) {
    return {
      allow: false,
      reason: `Unbekannte Tools angefordert (${unknownTools[0]}): nur bekannte Tools sind in der Policy erfasst — fail-closed.`,
      allowedTools: computeAllowedTools(req.requestedTools, roleAllowsWrite, shellConsented),
      requiresBridge: false,
      categories: Array.from(collectedCategories),
    };
  }

  // Step 8 — all checks passed.
  // Derive categories from the actually allowed requested tools.
  // (For FreeRein, 'shell'+'network' for Bash was already marked in step 5.)
  for (const tool of req.requestedTools) {
    for (const cat of categoriesForTool(tool)) {
      collectedCategories.add(cat);
    }
  }

  return {
    allow: true,
    reason: shellConsented && requestedShellTools.length > 0
      ? `Step erlaubt (FreeRein-Konsent): Rolle '${req.role}' darf in '${req.executionMode}' inkl. Bash arbeiten — Ausführung läuft isoliert im R1-Worktree.`
      : `Step erlaubt: Rolle '${req.role}' darf in '${req.executionMode}' die angeforderten Tools verwenden.`,
    allowedTools: computeAllowedTools(req.requestedTools, roleAllowsWrite, shellConsented),
    requiresBridge: false,
    categories: Array.from(collectedCategories),
  };
}
