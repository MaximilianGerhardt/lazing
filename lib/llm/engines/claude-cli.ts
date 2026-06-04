/**
 * Claude-CLI Engine (`<home>/.local/bin/claude --print --output-format=json`).
 *
 * Uses the same CLI binary that `server/workspace-session.ts` uses for the
 * production chat path, but **without** session-resume and **without**
 * workspace bindings — pure stateless single-turn. That keeps this engine
 * adapter safe to call from `/api/system/engines` and smoke-tests without
 * polluting workspace session state.
 *
 * Auth-detection logic mirrors `server/agent-server.ts:292-319` (preflight
 * snapshot): MAX-Plan if `~/.claude/.credentials.json` or
 * `~/.config/claude-code/auth.json` exists; else `api-key` if
 * `ANTHROPIC_API_KEY` is set; else `not-authenticated`.
 */

import { spawn, spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatEngine,
  EngineAvailability,
  EngineChatRequest,
  EngineChatResponse,
} from './types';

const CLAUDE_BIN =
  process.env.LAZYOS_CLAUDE_BIN ?? join(homedir(), '.local', 'bin', 'claude');
// Default model: latest Opus (quality over cost). Override via request.model.
const DEFAULT_MODEL = 'claude-opus-4-8';
const DEFAULT_TIMEOUT_MS = 60_000;

function detectAuthHint(): 'max-plan' | 'api-key' | 'not-authenticated' {
  const home = process.env.HOME ?? homedir();
  const credCandidates = [
    `${home}/.claude/.credentials.json`,
    `${home}/.config/claude-code/auth.json`,
    `${home}/.claude/auth.json`,
  ];
  for (const p of credCandidates) {
    try {
      if (statSync(p).isFile()) return 'max-plan';
    } catch {
      /* not present */
    }
  }
  // macOS: claude-code stores creds in the login keychain under
  // "Claude Code-credentials" rather than ~/.claude/.credentials.json.
  // Probe the keychain via spawnSync `security find-generic-password`.
  if (process.platform === 'darwin') {
    try {
      const r = spawnSync(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials'],
        { encoding: 'utf8', timeout: 1500 },
      );
      if (r.status === 0 && r.stdout.includes('Claude Code-credentials')) {
        return 'max-plan';
      }
    } catch {
      /* keychain probe failed — fall through */
    }
  }
  if ((process.env.ANTHROPIC_API_KEY ?? '').trim().length > 10) return 'api-key';
  return 'not-authenticated';
}

export const claudeCli: ChatEngine = {
  id: 'claude-cli',

  async detect(): Promise<EngineAvailability> {
    const t0 = Date.now();
    let installed = false;
    let version: string | null = null;
    try {
      const r = spawnSync(CLAUDE_BIN, ['--version'], { encoding: 'utf8', timeout: 3000 });
      if (r.status === 0) {
        installed = true;
        version = r.stdout.trim() || null;
      }
    } catch {
      installed = false;
    }
    const authHint = installed ? detectAuthHint() : 'not-authenticated';
    const ok = installed && authHint !== 'not-authenticated';
    return {
      engine: 'claude-cli',
      available: ok,
      reason: !installed
        ? `binary not found at ${CLAUDE_BIN}`
        : authHint === 'not-authenticated'
          ? 'binary present but no MAX-Plan creds and no ANTHROPIC_API_KEY'
          : `ready (${authHint})`,
      details: { binary: CLAUDE_BIN, version, authHint },
      probeMs: Date.now() - t0,
    };
  },

  async chat(req: EngineChatRequest): Promise<EngineChatResponse> {
    const t0 = Date.now();
    const model = req.model ?? DEFAULT_MODEL;
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Flatten messages: claude --print accepts a single prompt on stdin.
    // System messages become an --append-system-prompt; user/assistant turns
    // get rendered as plain text with role-prefixes. This is a SHALLOW
    // adapter — real multi-turn should use --input-format=stream-json.
    const systemMsgs = req.messages.filter((m) => m.role === 'system').map((m) => m.content);
    const convo = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => (m.role === 'user' ? `Human: ${m.content}` : `Assistant: ${m.content}`))
      .join('\n\n');

    const args = [
      '--print',
      '--output-format=json',
      '--no-session-persistence',
      '--model',
      model,
      // NOTE: we deliberately do NOT pass `--bare`. The help text says
      //   "Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via
      //    --settings (OAuth and keychain are never read)"
      // i.e. --bare disables MAX-Plan keychain auth → "Not logged in"
      // result with is_error=true. For lazyOS we want the full keychain-
      // backed MAX-Plan path. Hooks/LSP/plugins are mildly wasteful here
      // but they don't block the response; the overhead is ~200ms which is
      // dwarfed by the API round-trip.
    ];
    // Ultrathink (default OFF). Only claude-cli supports this; this IS claude-cli.
    // `--effort` is the native reasoning-depth lever (verified: `claude --help` →
    // "Effort level (low, medium, high, xhigh, max)"). No `--thinking` flag exists,
    // so a system-prompt-preamble fallback is unnecessary — `--effort` is the
    // native mechanism. When `req.thinking` is absent/false the args array is
    // byte-identical to the pre-ultrathink path.
    if (req.thinking === true) {
      args.push('--effort', req.thinkingBudget ?? 'high');
    }
    if (systemMsgs.length > 0) {
      args.push('--append-system-prompt', systemMsgs.join('\n\n'));
    }

    // Spawn-Env: strip ANTHROPIC_API_KEY if MAX-Plan creds exist (mirror of
    // workspace-session.ts behaviour — see agent-server.ts:287-291 comment).
    const childEnv = { ...process.env };
    const authHint = detectAuthHint();
    if (authHint === 'max-plan' && process.env.LAZYOS_FORCE_API_KEY !== '1') {
      delete childEnv.ANTHROPIC_API_KEY;
    }

    return new Promise<EngineChatResponse>((resolve, reject) => {
      const child = spawn(CLAUDE_BIN, args, { env: childEnv });
      let stdout = '';
      let stderr = '';
      const timeout =
        timeoutMs > 0
          ? setTimeout(() => {
              child.kill('SIGTERM');
              reject(new Error(`claude-cli timeout after ${timeoutMs}ms`));
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
          reject(new Error(`claude-cli exit ${code}: ${stderr.slice(0, 500)}`));
          return;
        }
        try {
          // --output-format=json returns a single envelope per turn.
          const parsed = JSON.parse(stdout) as {
            result?: string;
            text?: string;
            is_error?: boolean;
            usage?: { input_tokens?: number; output_tokens?: number };
          };
          // claude-cli emits is_error=true with exit-code 0 for things like
          // "Not logged in" — surface that as a thrown error so the selector
          // can fall through to the next engine.
          if (parsed.is_error === true) {
            const errMsg = parsed.result ?? parsed.text ?? 'claude-cli reported is_error=true';
            reject(new Error(`claude-cli: ${errMsg}`));
            return;
          }
          const text = parsed.result ?? parsed.text ?? '';
          resolve({
            engine: 'claude-cli',
            model,
            text,
            latencyMs: Date.now() - t0,
            usage: {
              promptTokens: parsed.usage?.input_tokens ?? 0,
              completionTokens: parsed.usage?.output_tokens ?? 0,
            },
          });
        } catch (e) {
          // Fall back: treat stdout as plain text.
          resolve({
            engine: 'claude-cli',
            model,
            text: stdout.trim(),
            latencyMs: Date.now() - t0,
          });
        }
      });
      // Pipe the convo to stdin.
      child.stdin.write(convo);
      child.stdin.end();
    });
  },
};
