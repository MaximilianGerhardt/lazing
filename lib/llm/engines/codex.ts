/**
 * Codex-CLI Engine (`codex exec` — codex-cli 0.130.0).
 *
 * SAFETY ARCHITECTURE (C7 — Engine-Layer, 2026-05-25)
 * =====================================================
 * Two modes — NEVER swap them accidentally:
 *
 *   READ (safe, DEFAULT):
 *     Flags: `-s read-only -a never`
 *     The `-s read-only` flag activates the OS-level Codex sandbox which
 *     blocks all filesystem writes and shell side-effects. `-a never` disables
 *     interactive approval prompts so the engine runs non-interactively.
 *     Empirically verified from `codex --help` / `codex exec --help`
 *     (2026-05-25, codex-cli 0.130.0):
 *       -s, --sandbox <SANDBOX_MODE>  [possible values: read-only, workspace-write, danger-full-access]
 *       -a, --ask-for-approval <APPROVAL_POLICY>
 *     THIS IS THE DEFAULT for ALL callers that do not explicitly opt-in to write.
 *     Used by: Chat path, Parallel-Race in orchestrator.ts, system-health checks.
 *
 *   WRITE (gated, explicit opt-in only):
 *     Flags: `-s workspace-write -a never`
 *     Allows writes inside the workspace directory. ONLY activates when BOTH:
 *       (a) request.codexMode === 'write'  AND
 *       (b) process.env.LAZYOS_CODEX_WRITE is set (non-empty)
 *     If either gate is missing → falls back to read-only + console.warn.
 *     Used by: gated Executor (R1-Worktree + R2 + human Approve step).
 *
 * The old `approval_policy="never"` `-c` override is REMOVED as the default.
 * It only disabled approvals but did NOT sandbox writes.
 */

import { spawn, spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import type {
  ChatEngine,
  EngineAvailability,
  EngineChatRequest,
  EngineChatResponse,
} from './types';

const CODEX_BIN = process.env.LAZYOS_CODEX_BIN ?? 'codex';
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Resolve the sandbox flags for a given codexMode.
 *
 * Double-gate for write mode: codexMode === 'write' AND LAZYOS_CODEX_WRITE env.
 * Any other combination → read-only (fail-closed).
 *
 * Exported for unit testing. Callers outside this module should use codexCli.chat().
 *
 * Returns the array of flags to splice into the `codex exec` argv.
 */
export function resolveSandboxFlags(
  codexMode: 'read' | 'write' | undefined,
): { flags: string[]; effectiveMode: 'read' | 'write' } {
  const wantWrite = codexMode === 'write';
  const envGateSet = (process.env.LAZYOS_CODEX_WRITE ?? '').trim() !== '';

  if (wantWrite && !envGateSet) {
    console.warn(
      '[codex-engine] codexMode="write" requested but LAZYOS_CODEX_WRITE env is not set — ' +
        'falling back to read-only sandbox. Set LAZYOS_CODEX_WRITE=1 in the gated Executor to enable writes.',
    );
  }

  const effectiveMode: 'read' | 'write' =
    wantWrite && envGateSet ? 'write' : 'read';

  const sandboxFlag =
    effectiveMode === 'write' ? 'workspace-write' : 'read-only';

  // -s <sandbox-mode>  controls OS-level file/shell sandbox (verified: codex --help)
  // -a never           disables interactive approval prompts (non-interactive exec)
  return {
    flags: ['-s', sandboxFlag, '-a', 'never'],
    effectiveMode,
  };
}

function detectCodexAuth(): 'ok' | 'not-logged-in' | 'unknown' {
  const home = process.env.HOME ?? homedir();
  // ~/.codex/auth.json is what `codex login` writes (verified 2026-05-23 on
  // codex-cli 0.130.0 — file may be missing on a fresh install).
  const candidates = [`${home}/.codex/auth.json`, `${home}/.codex/credentials.json`];
  for (const p of candidates) {
    try {
      if (statSync(p).isFile()) return 'ok';
    } catch {
      /* not present */
    }
  }
  // If no credential file is found, codex MAY still work via
  // OPENAI_API_KEY — heuristic only.
  if ((process.env.OPENAI_API_KEY ?? '').length > 10) return 'ok';
  return 'not-logged-in';
}

export const codexCli: ChatEngine = {
  id: 'codex-cli',

  async detect(): Promise<EngineAvailability> {
    const t0 = Date.now();
    let installed = false;
    let version: string | null = null;
    try {
      const r = spawnSync(CODEX_BIN, ['--version'], { encoding: 'utf8', timeout: 3000 });
      if (r.status === 0) {
        installed = true;
        version = r.stdout.trim() || null;
      }
    } catch {
      installed = false;
    }
    const auth = installed ? detectCodexAuth() : 'not-logged-in';
    const ok = installed && auth === 'ok';
    return {
      engine: 'codex-cli',
      available: ok,
      reason: !installed
        ? `binary not found at ${CODEX_BIN}`
        : auth === 'not-logged-in'
          ? 'binary present but no ~/.codex/auth.json and no OPENAI_API_KEY'
          : 'ready',
      details: { binary: CODEX_BIN, version, auth },
      probeMs: Date.now() - t0,
    };
  },

  async chat(req: EngineChatRequest): Promise<EngineChatResponse> {
    const t0 = Date.now();
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Codex doesn't have a native "messages" array — flatten to single prompt.
    const prompt = req.messages
      .map((m) =>
        m.role === 'system'
          ? `[SYSTEM]\n${m.content}`
          : m.role === 'user'
            ? `[USER]\n${m.content}`
            : `[ASSISTANT]\n${m.content}`,
      )
      .join('\n\n');

    // `codex exec` is the non-interactive subcommand. `--skip-git-repo-check`
    // avoids the "you're not in a git repo" guard.
    // Sandbox flags are resolved by resolveSandboxFlags — read-only by default,
    // workspace-write only when both codexMode='write' AND LAZYOS_CODEX_WRITE env.
    const { flags: sandboxFlags, effectiveMode } = resolveSandboxFlags(req.codexMode);
    const args = [
      'exec',
      '--skip-git-repo-check',
      ...sandboxFlags,
    ];
    // 2026-06-03 (Owner): Codex als SCHNELLE Variante — gpt-5.5 + service_tier
    // "fast" (die „1,5×"-Schnellstufe). req.model gewinnt; env-überschreibbar.
    const codexModel = req.model || process.env.LAZYOS_CODEX_MODEL || 'gpt-5.5';
    args.push('-c', `model="${codexModel}"`);
    args.push('-c', 'service_tier="fast"');
    // Attach effective mode to the spawned process env so it shows up in
    // audit/trace if the caller captures process metadata.
    const childEnv = { ...process.env, LAZYOS_CODEX_EFFECTIVE_MODE: effectiveMode };
    // prompt comes from stdin (more robust than CLI-arg for long prompts).

    return new Promise<EngineChatResponse>((resolve, reject) => {
      const child = spawn(CODEX_BIN, args, { env: childEnv });
      let stdout = '';
      let stderr = '';
      const timeout =
        timeoutMs > 0
          ? setTimeout(() => {
              child.kill('SIGTERM');
              reject(new Error(`codex-cli timeout after ${timeoutMs}ms`));
            }, timeoutMs)
          : null;
      const onAbort = (): void => {
        child.kill('SIGTERM');
        reject(new Error('aborted'));
      };
      if (req.signal) {
        if (req.signal.aborted) onAbort();
        else req.signal.addEventListener('abort', onAbort, { once: true });
      }
      child.stdout.on('data', (d) => {
        stdout += d.toString('utf8');
      });
      child.stderr.on('data', (d) => {
        stderr += d.toString('utf8');
      });
      child.on('error', (err) => {
        if (timeout) clearTimeout(timeout);
        reject(err);
      });
      child.on('exit', (code) => {
        if (timeout) clearTimeout(timeout);
        if (req.signal) req.signal.removeEventListener('abort', onAbort);
        if (code !== 0) {
          reject(new Error(`codex-cli exit ${code}: ${stderr.slice(0, 500)}`));
          return;
        }
        // Codex exec emits human-readable output; we don't parse structured.
        // The last paragraph of stdout is the final answer in 0.130.0.
        const text = stdout.trim();
        resolve({
          engine: 'codex-cli',
          model: req.model ?? 'codex-default',
          text,
          latencyMs: Date.now() - t0,
        });
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  },
};
