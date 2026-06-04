/**
 * TMUX-resilient Tier-Spawn (Akut-Bug-Fix 2026-04-25).
 *
 * Instead of a direct child_process.spawn (which dies on a lazyos-web restart)
 * we start the Claude CLI in a tmux session via:
 *   tmux new-session -d -s <name> 'bash -c "..."'
 *
 * The wrapper writes stdout into a log file and touches a
 * `.done` flag when finished. We poll the flag.
 *
 * Guarantees:
 *   - PWA close: tmux runs. ✓
 *   - lazyos-web service restart: tmux runs (own session). ✓
 *   - VPS reboot: tmux gone, all spawns gone. ❌
 *     (tmux-server persistence after a reboot would be a systemd-tmux unit;
 *     acceptable for now, a reboot is rare + manual)
 *
 * Cleanup: after a successful read the log+done+exit files are deleted
 * AND the tmux session is killed.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { homedir, tmpdir, userInfo } from 'node:os';

import { calcCostCents, type TierModel } from '../../lib/agents/pricing';
import { recordTokens, waitForBudget } from '../../lib/agents/tpm-budget';
// P2-#8: K1 deny patterns — shared zero-dep single source of truth.
// server/tsconfig.json has no @/-paths, so we use a relative path.
import { K1_MCP_QUALIFIED_DENY_PATTERNS } from '../../lib/security/k1-deny-patterns';
// Slice FS-3 (2026-05-26): optional OS sandbox wrapper (sandbox-exec/seatbelt)
// around the inner agent command. Relative path (no @/ alias in server/).
import { wrapWithSandbox, type FsSandboxSpec } from '../../lib/security/fs-sandbox';
import {
  setSubWorkstreamStatus,
  updateTokenUsage,
} from '../../lib/workstreams/service';
// Permission-Foundation Wave 1 / Batch 4 / ADR-0004.
// enforcePermissionFromSingleton is best-effort + non-fatal: in audit mode
// (LAZYOS_PERMISSION_ENFORCEMENT default='audit') it NEVER blocks — it only
// writes one lazyos_permission_audit row per spawn so Phase-2 allowlist
// derivation has data.  No existing behavior changes.
import {
  enforcePermissionFromSingleton,
  getEnforcementMode,
} from '../../lib/security/permission-mode';

export interface SpawnArgs {
  workspaceId: string;
  workspacePath: string;
  workstreamId: string;
  tier: TierModel;
  agentIdx: number;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  timeoutMs: number;
  /**
   * Max turns for the Claude CLI call.
   *
   * Default 30 (2026-04-27 — previously 1). On the MAX plan max-turns is not
   * a cost guard but a pure loop guard against runaway agents in
   * tool loops. 30 is enough for any realistic plan/roast/
   * implementation spawn — if an agent needs 30 turns without a clear end,
   * something is broken and the wallclock timeout kicks in anyway.
   * The pre-Phase-IT default of 1 choked lead spawns with tool use.
   */
  maxTurns?: number;
  /**
   * Sub-workstream ID (Sprint C, 2026-04-29). When set, we write
   * token/cost updates to this sub-row + set status running -> done/failed.
   * Stays undefined for legacy callers.
   */
  subWorkstreamId?: string;
  /**
   * Tool whitelist for the sub-spawn (Sub-Plan B build mode, 2026-04-30).
   *
   * When set, the spawner activates the claude CLI with:
   *   --allowedTools <list> --permission-mode acceptEdits
   *
   * This lets the sub-agent make REAL file edits/Bash calls instead of just
   * writing markdown. When `undefined` (legacy / plan mode), the
   * behavior stays pure text (no tool use).
   *
   * Allowed values: "Read", "Write", "Edit", "Bash", "Grep", "Glob".
   * Other values are ignored by the CLI / could undermine the permission
   * model — the list is deliberately hardcoded to safe tools here.
   */
  allowedTools?: ReadonlyArray<string>;
  /**
   * FS sandbox spec (Slice FS-3, 2026-05-26). When set, the inner
   * agent command is additionally wrapped in a `sandbox-exec` shell: rw only in
   * the worktree, ro on allowed roots, default-deny for the rest of the FS (secrets,
   * live DB, other projects). `undefined` = today's behavior (only env -i +
   * K1, NO FS boundary). env -i scrub + K1 are preserved additively on the outside.
   */
  sandboxSpec?: FsSandboxSpec;
}

export interface SpawnResult {
  text: string;
  tokens: { input: number; output: number; cacheRead: number };
  costCents: number;
  durationMs: number;
  exitCode: number;
  rateLimited: boolean;
  timedOut: boolean;
}

function tmuxSessionName(args: SpawnArgs): string {
  // Unique + tmux-safe (no dots, no parentheses)
  return `lazyos-spawn-${args.workstreamId.replace(/[^A-Za-z0-9-]/g, '')}-${args.tier}-${args.agentIdx}`;
}

function tmpPath(name: string, kind: 'prompt' | 'system' | 'log'): string {
  return `/tmp/lazyos-${kind}-${name}.txt`;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * 2026-05-29 (Opus 4.8) — robust extraction of the FIRST balanced JSON object
 * from a mixed output. NEEDED because `claude --print --output-format json`
 * writes its JSON to stdout, but the log is `2>&1`: a trailing
 * SessionEnd-hook error (`.claude/helpers/hook-handler.cjs not found` in the
 * worktree) appends a stacktrace AFTER the JSON. `JSON.parse(wholeBlob)`
 * then throws → the old fallback dumped the RAW blob (JSON+stacktrace) into the
 * chat (owner finding "weird codes instead of surfaces"). Brace counting finds
 * the clean JSON object regardless of the trailing junk. String-aware (ignores
 * `{`/`}` inside JSON strings).
 */
function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Starts a spawn in a detached tmux session and polls until it is
 * finished (or times out). Robust against a lazyos-web restart.
 */
export async function spawnInTmux(args: SpawnArgs): Promise<SpawnResult> {
  // Phase QA (2026-04-28): PRE-spawn TPM budget check.
  // Sleeps adaptively when the MAX-plan TPM bucket is already highly utilized.
  // Prevents parallel spawns from bursting the bucket → 'rate_limit' errors.
  await waitForBudget(`tier-${args.tier}#${args.agentIdx}`);

  // Permission-Foundation (Wave 1 / Batch 4 / ADR-0004 Phase 1).
  // Audit-only by default: LAZYOS_PERMISSION_ENFORCEMENT default='audit' →
  // allow:true always. Writes one lazyos_permission_audit row for Phase-2
  // allowlist derivation. Wrapped in try/catch so DB unavailability never
  // breaks the spawn path (best-effort, non-fatal).
  //
  // The result is captured (not discarded — Security-Critic Finding 1) and the
  // enforce-gate is wired but guarded behind getEnforcementMode()==='enforce'
  // so it stays dormant in Phase-1 audit mode and is NOT lost when the flag is
  // flipped. Even the gate-throw stays inside this try/catch — a spawn must
  // only ever be blocked when enforcement is *deliberately* enabled.
  try {
    const permResult = enforcePermissionFromSingleton({
      scope: { workspaceId: args.workspaceId },
      toolClass: 'claude-cli-subspawn',
      toolName: 'tmux-spawn',
      op: `tmux-spawn:workstream=${args.workstreamId}:tier=${args.tier}:agent=${args.agentIdx}`,
    });
    // TODO(Phase-2): when LAZYOS_PERMISSION_ENFORCEMENT='enforce' goes live and
    // per-workspace allowlists are seeded, this gate denies spawns that the
    // resolver rejects. Until then it is inert (audit mode → allow always).
    if (permResult.allow === false && getEnforcementMode() === 'enforce') {
      throw new Error(
        `permission-denied (enforce): tmux-spawn for workspace=${args.workspaceId} — ${permResult.reason}`,
      );
    }
  } catch (err) {
    // In audit mode this never blocks (allow is always true → no throw above).
    // In enforce mode the thrown deny propagates as a spawn failure further down
    // the SpawnResult path is not reached; we surface it via failureResult so the
    // caller sees a clean failed spawn instead of an unhandled rejection.
    if (getEnforcementMode() === 'enforce') {
      if (args.subWorkstreamId) {
        try {
          await setSubWorkstreamStatus(args.subWorkstreamId, 'failed');
        } catch {
          /* non-fatal */
        }
      }
      return failureResult(
        args,
        Date.now(),
        `permission_denied: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    /* audit mode: non-fatal — permission audit failure must never block a spawn */
  }

  // Sprint C (2026-04-29): set the sub-WS to 'running' (idempotent).
  if (args.subWorkstreamId) {
    try {
      await setSubWorkstreamStatus(args.subWorkstreamId, 'running');
    } catch {
      /* non-fatal */
    }
  }

  const startedAt = Date.now();
  const name = tmuxSessionName(args);
  const promptFile = tmpPath(name, 'prompt');
  const systemFile = tmpPath(name, 'system');
  const logFile = tmpPath(name, 'log');
  const doneFlag = `${logFile}.done`;
  const exitFile = `${logFile}.exit`;

  // PII vault chokepoint: every CLI spawn (tier-orchestrator / ultracoding /
  // bug-swarm / auto-dispatch) flows through spawnInTmux, so tokenize the system
  // + user prompt before they are written/sent, and rehydrate the captured result
  // below. Deterministic (N6), workspace-scoped (N9); fail-soft → identity.
  let spawnDetok = (t: string): string => t;
  let userPromptOut = args.userPrompt;
  let systemPromptOut = args.systemPrompt;
  try {
    const { piiVaultEnabled } = await import('../../lib/privacy/protect');
    if (piiVaultEnabled()) {
      const { tokenizeText, detokenizeText } = await import('../../lib/privacy/pii-vault');
      const { getAgentDb } = await import('../db');
      const piiRaw = getAgentDb();
      userPromptOut = args.userPrompt
        ? tokenizeText(piiRaw, args.workspaceId, args.userPrompt).text
        : args.userPrompt;
      systemPromptOut = args.systemPrompt
        ? tokenizeText(piiRaw, args.workspaceId, args.systemPrompt).text
        : args.systemPrompt;
      spawnDetok = (t: string): string =>
        t ? detokenizeText(piiRaw, args.workspaceId, t).text : t;
    }
  } catch {
    /* keep originals + identity detok */
  }

  // 1. Write prompt + system prompt to temp files (tokenized when the vault is on)
  writeFileSync(promptFile, userPromptOut, 'utf8');
  writeFileSync(systemFile, systemPromptOut, 'utf8');

  // 2. Build the inline bash command — executed in the tmux session.
  //    cd into the workspace, strip ANTHROPIC_API_KEY so the MAX plan takes effect,
  //    claude CLI with JSON output, append-system-prompt from file via cat.
  const maxTurns = args.maxTurns ?? 30;
  // Sub-Plan B (2026-04-30): if allowedTools is set, enable tool use.
  // Sanitize the whitelist — only let safe tools through, no pass-through of
  // arbitrary strings to the CLI (defense in depth).
  const SAFE_TOOLS = new Set([
    'Read',
    'Write',
    'Edit',
    'Bash',
    'Grep',
    'Glob',
  ]);
  const sanitizedTools = (args.allowedTools ?? []).filter((t) =>
    SAFE_TOOLS.has(t),
  );
  const toolFlags: string[] =
    sanitizedTools.length > 0
      ? [
          '--allowedTools',
          sanitizedTools.join(','),
          '--permission-mode',
          'acceptEdits',
        ]
      : [];

  // K1 MCP-RAG block (N2/POS-7, 2026-05-24, P2-#8 2026-05-25):
  // deny-list for all MCP-RAG tool prefixes — imported from the zero-dep
  // shared module lib/security/k1-deny-patterns.ts (single source of truth).
  // `--disallowedTools` takes ONE space-separated value. Critic-MEDIUM-1 fix
  // (2026-05-24): the value MUST be shell-quoted (see below), otherwise (a) the shell
  // expands the glob `*` against the cwd and (b) splits the list into several
  // tokens — both would make the K1 hard block (POS-8) leaky.
  // (BUG-FIX-1 from lib-v1/mcp/tool-registry-filter.ts — no --disable-mcp-tool.)
  const K1_DISALLOWED_RAG_TOOLS = K1_MCP_QUALIFIED_DENY_PATTERNS;

  const claudeArgs = [
    '--print',
    '--model',
    args.model,
    '--max-turns',
    String(maxTurns),
    '--output-format',
    'json',
    ...toolFlags,
    '--disallowedTools',
    // shellQuote → a single value, no glob expand, no token split (MEDIUM-1).
    shellQuote(K1_DISALLOWED_RAG_TOOLS.join(' ')),
    '--append-system-prompt',
    `"$(cat ${shellQuote(systemFile)})"`,
  ].join(' ');

  // tmux sessions inherit the PATH of the web-service process, which does NOT
  // include claude (~/.local/bin is missing). Extend PATH explicitly so
  // `claude` resolves. Plus an env override.
  // The default is derived from the home dir rather than a hardcoded path, so
  // it resolves the real `~/.local/bin/claude` on any host. LAZYOS_CLAUDE_BIN
  // always wins.
  const claudeBin =
    process.env.LAZYOS_CLAUDE_BIN ??
    `${process.env.HOME ?? homedir()}/.local/bin/claude`;

  // ── ENV scrub (Security-Critic HIGH #2, 2026-05-25) ──────────────────────
  //
  // PROBLEM: a FreeRein agent with Bash could run `env` / `cat /proc/self/environ`
  // and read ALL parent-process secrets (LAZYOS_CREDENTIAL_KEY,
  // LAZYOS_MASTER_KEK, LAZYOS_DB_PATH, OAuth/session keys, OPENAI_API_KEY, …).
  // Just `unset ANTHROPIC_API_KEY` was NOT enough — all other ENV vars were
  // inherited by the tmux session.
  //
  // FIX: `env -i` starts the CLI with an EMPTY environment; only an explicit
  // ALLOWLIST is passed through. This is safer than a deny list (new
  // secrets do not have to be added — they are gone by default).
  //
  // Allowlist rationale:
  //   - PATH  : must find claude + git (we set a fixed PATH).
  //   - HOME  : claude MAX-plan auth lives under $HOME/.claude (file/keychain
  //             reference, NOT in the ANTHROPIC_API_KEY env). Without HOME the
  //             CLI cannot find its OAuth session → MAX auth breaks. HOME itself
  //             contains NO secret (only a path).
  //   - LANG/LC_ALL : UTF-8 locale, otherwise poor Unicode handling in the CLI.
  //   - TERM        : tmux/CLI expect a terminal label.
  //   - LAZYOS_TIER_DEPTH / _WORKSTREAM_ID / _WORKSPACE_ID : context the
  //     sub-agent needs for self-identification; NO secrets (IDs + depth).
  //
  // DELIBERATELY NOT passed through (= stay scrubbed):
  //   ANTHROPIC_API_KEY (MAX plan takes effect via $HOME/.claude, not via the key),
  //   LAZYOS_CREDENTIAL_KEY, LAZYOS_MASTER_KEK, LAZYOS_CHAT_KEY, LAZYOS_CLI_KEY,
  //   LAZYOS_AUTH_SECRET, LAZYOS_PUSH_SECRET, LAZYOS_VPS_BRIDGE_SECRET,
  //   LAZYOS_DB_PATH, DATABASE_URL, OPENAI_API_KEY, VAPID_PRIVATE_KEY,
  //   LAZYOS_GITHUB_CLIENT_SECRET, LAZYOS_RESEND_API_KEY, … and EVERYTHING else.
  //
  // HOME is inherited from the parent (only if set) — the sub-shell PATH
  // is set fixed, not derived from the (now empty) parent PATH.
  const parentHome = process.env.HOME ?? '/root';
  const fixedPath = `${parentHome}/.local/bin:/root/.local/bin:/usr/local/bin:/usr/bin:/bin`;

  // env -i <K=V ...> bash -c '<inner>' — each K=V value is shell-quoted,
  // so no value can undermine the allowlist or create injection.
  const envAllowlist: string[] = [
    `PATH=${shellQuote(fixedPath)}`,
    `HOME=${shellQuote(parentHome)}`,
    `LANG=${shellQuote(process.env.LANG ?? 'en_US.UTF-8')}`,
    `LC_ALL=${shellQuote(process.env.LC_ALL ?? process.env.LANG ?? 'en_US.UTF-8')}`,
    `TERM=${shellQuote(process.env.TERM ?? 'xterm-256color')}`,
    `LAZYOS_TIER_DEPTH=1`,
    `LAZYOS_WORKSTREAM_ID=${shellQuote(args.workstreamId)}`,
    `LAZYOS_WORKSPACE_ID=${shellQuote(args.workspaceId)}`,
  ];
  // macOS MAX-plan auth fix (2026-05-26, empirical; hardened 2026-05-30): claude
  // reports "Not logged in · Please run /login" under `env -i` when these
  // NON-secret vars are missing — the keychain/OAuth resolution needs
  // USER/LOGNAME/TMPDIR/CF text encoding. ROOT FINDING 2026-05-30 (E2E smoke):
  // if the :4200 service runs as a launchd orphan (ppid=1), these vars are missing in the
  // parent env → the earlier `if (v)` did NOT pass them through → EVERY tier/
  // swarm spawn died with exit=1 in ~1.5s (0 tokens), the build/iterate path dead,
  // although the chat path (full process.env) worked. Fix: deterministic
  // fallbacks from os.userInfo()/os.tmpdir() → the spawn is INDEPENDENT of the
  // start context (launchd, systemd, login shell). All non-secret; the scrub
  // of the real secrets stays untouched.
  const sysUser = (() => {
    try {
      return userInfo();
    } catch {
      return null;
    }
  })();
  const fallbackUser = process.env.USER || sysUser?.username || 'dev';
  const uidHex =
    sysUser && typeof sysUser.uid === 'number' && sysUser.uid >= 0
      ? `0x${sysUser.uid.toString(16).toUpperCase()}`
      : '0x0';
  const macosAuthEnv: Record<string, string> = {
    USER: process.env.USER || fallbackUser,
    LOGNAME: process.env.LOGNAME || fallbackUser,
    TMPDIR: process.env.TMPDIR || tmpdir(),
    // Format: <uid-hex>:0:0 (text-encoding token, no secret).
    __CF_USER_TEXT_ENCODING: process.env.__CF_USER_TEXT_ENCODING || `${uidHex}:0:0`,
  };
  for (const [k, v] of Object.entries(macosAuthEnv)) {
    if (v) envAllowlist.push(`${k}=${shellQuote(v)}`);
  }

  // Inner command runs under the scrubbed env. We still `cd` into the workspace.
  // No `export` / `unset` of secrets needed — env -i already gave us a clean slate.
  // IMPORTANT (2026-05-26): `cd && claude` via `&&` (claude runs only if cd is OK),
  // but after that `;` instead of `&&` — otherwise on claude EXIT≠0 neither the exitFile nor
  // the doneFlag is written → the poller runs into the full timeout (exit=-1) and
  // obscures the real error. With `;` the real exit code is always
  // recorded + the doneFlag always set → fast, honest error reporting.
  const innerCmd =
    `cd ${shellQuote(args.workspacePath)} && ` +
    `${shellQuote(claudeBin)} ${claudeArgs} < ${shellQuote(promptFile)} > ${shellQuote(logFile)} 2>&1 ; ` +
    `echo $? > ${shellQuote(exitFile)} ; ` +
    `touch ${shellQuote(doneFlag)}`;

  // Slice FS-3 (2026-05-26): optional sandbox-exec wrapper around the inner command.
  // Takes effect ONLY when args.sandboxSpec is set (the executor decides that,
  // gated). wrapWithSandbox internally respects LAZYOS_FS_SANDBOX=off (emergency exit).
  // Order: env -i (outside) → bash → sandbox-exec → bash (inside, agent).
  // env -i + K1 are thus preserved additively (defense in depth).
  let sandboxProfileCleanup: (() => void) | null = null;
  let effectiveInnerCmd = innerCmd;
  if (args.sandboxSpec) {
    const wrap = wrapWithSandbox(innerCmd, args.sandboxSpec);
    effectiveInnerCmd = wrap.command;
    sandboxProfileCleanup = wrap.cleanup;
  }

  // `env -i K=V … bash -c '<innerCmd>'` — the bash that runs the agent sees
  // ONLY the allowlisted vars. `env` itself is resolved via the parent shell's
  // PATH (it lives in /usr/bin), so we call it by bare name.
  const inlineCmd = `env -i ${envAllowlist.join(' ')} bash -c ${shellQuote(effectiveInnerCmd)}`;

  // 3. Start the tmux session (detached, own lifecycle).
  try {
    execSync(`tmux new-session -d -s ${shellQuote(name)} ${shellQuote(`bash -c ${shellQuote(inlineCmd)}`)}`, {
      stdio: 'pipe',
    });
  } catch (err) {
    // Slice FS-3: also clean up the sandbox profile tempfile on the early error path.
    if (sandboxProfileCleanup) {
      try { sandboxProfileCleanup(); } catch { /* ignore */ }
    }
    if (args.subWorkstreamId) {
      try {
        await setSubWorkstreamStatus(args.subWorkstreamId, 'failed');
      } catch {
        /* non-fatal */
      }
    }
    return failureResult(args, startedAt, `tmux_create_failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The sub-WS gets the tmux session name for the UI (click -> /sessions/<name>).
  if (args.subWorkstreamId) {
    try {
      await updateTokenUsage(args.subWorkstreamId, { tmuxSessionId: name });
    } catch {
      /* non-fatal */
    }
  }

  // 4. Poll for the done flag
  const pollIntervalMs = 1500;
  let timedOut = false;
  while (!existsSync(doneFlag)) {
    const elapsed = Date.now() - startedAt;
    if (elapsed > args.timeoutMs) {
      timedOut = true;
      try {
        execSync(`tmux kill-session -t ${shellQuote(name)}`, { stdio: 'pipe' });
      } catch {
        /* already gone */
      }
      break;
    }
    await sleep(pollIntervalMs);
  }

  // 5. Read the output
  let stdout = '';
  let exitCode = -1;
  try {
    if (existsSync(logFile)) stdout = readFileSync(logFile, 'utf8');
  } catch {
    /* ignore */
  }
  try {
    if (existsSync(exitFile)) exitCode = parseInt(readFileSync(exitFile, 'utf8').trim(), 10);
  } catch {
    /* ignore */
  }

  const rateLimited =
    /usage_limit|rate.limit|429|too many requests/i.test(stdout);

  // 6. Parse the Claude CLI JSON
  let text = '';
  let tokens = { input: 0, output: 0, cacheRead: 0 };
  if (stdout) {
    // Robust: first isolate the clean JSON object (ignore the trailing-hook
    // stacktrace), then parse. Falls back to the whole string if no
    // brace is found.
    const jsonStr = extractFirstJsonObject(stdout) ?? stdout;
    try {
      const parsed = JSON.parse(jsonStr) as {
        result?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
        };
      };
      text = String(parsed.result ?? '').trim();
      const u = parsed.usage ?? {};
      tokens = {
        input: typeof u.input_tokens === 'number' ? u.input_tokens : 0,
        output: typeof u.output_tokens === 'number' ? u.output_tokens : 0,
        cacheRead:
          typeof u.cache_read_input_tokens === 'number'
            ? u.cache_read_input_tokens
            : 0,
      };
    } catch {
      // No parseable JSON — do NOT dump a raw blob into the chat (owner finding).
      // A short, clean note; the full log stays on-disk for debugging
      // (until the tmp cleanup) resp. traceable via reqId.
      const firstLine = stdout.split('\n').find((l) => l.trim().length > 0) ?? '';
      text =
        `(Spawn-Ausgabe nicht als JSON parsebar — ` +
        `erste Zeile: ${firstLine.slice(0, 200)})`;
    }
  }

  if (!text && (timedOut || exitCode !== 0)) {
    text = `(Tier-Spawn ${args.tier}#${args.agentIdx} fehlgeschlagen: exit=${exitCode}${timedOut ? ', timeout' : ''}${rateLimited ? ', rate-limited' : ''})`;
  }

  // 7. Cleanup tmp files
  for (const f of [promptFile, systemFile, logFile, doneFlag, exitFile]) {
    try {
      if (existsSync(f)) unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  // Slice FS-3: clean up the sandbox-exec profile tempfile (if wrapped).
  if (sandboxProfileCleanup) {
    try { sandboxProfileCleanup(); } catch { /* ignore */ }
  }
  // The tmux session should have ended itself (the command was exec'd, not
  // interactive). If still there, kill it.
  try {
    execSync(`tmux has-session -t ${shellQuote(name)} 2>/dev/null && tmux kill-session -t ${shellQuote(name)}`, {
      stdio: 'pipe',
    });
  } catch {
    /* OK */
  }

  const durationMs = Date.now() - startedAt;
  const costCents = calcCostCents(args.tier, tokens);
  // Phase QA: persist token consumption in the rolling window.
  recordTokens(
    `tier-${args.tier}`,
    args.workspaceId,
    tokens,
    durationMs,
  );

  // Sprint C: sub-workstream token update + final status.
  if (args.subWorkstreamId) {
    try {
      await updateTokenUsage(args.subWorkstreamId, {
        tokensIn: tokens.input,
        tokensOut: tokens.output,
        costCents,
      });
      const finalStatus =
        rateLimited
          ? 'rate_limited'
          : timedOut || exitCode !== 0
            ? 'failed'
            : 'done';
      await setSubWorkstreamStatus(args.subWorkstreamId, finalStatus);
    } catch {
      /* non-fatal */
    }
  }

  return {
    // PII vault: rehydrate the cloud's reply (it echoed our tokens back) so the
    // caller persists/streams REAL values. Identity when the vault is off.
    text: spawnDetok(text),
    tokens,
    costCents,
    durationMs,
    exitCode,
    rateLimited,
    timedOut,
  };
}

function failureResult(
  args: SpawnArgs,
  startedAt: number,
  reason: string,
): SpawnResult {
  return {
    text: `(Tier-Spawn ${args.tier}#${args.agentIdx} konnte nicht starten: ${reason})`,
    tokens: { input: 0, output: 0, cacheRead: 0 },
    costCents: 0,
    durationMs: Date.now() - startedAt,
    exitCode: -1,
    rateLimited: false,
    timedOut: false,
  };
}
