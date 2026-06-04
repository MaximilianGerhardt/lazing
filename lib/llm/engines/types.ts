/**
 * Multi-Engine Chat Adapter — Common Types
 *
 * **Scope-Decision (2026-05-23)**: Diese Datei und ihre Geschwister
 * `claude-cli.ts`, `codex.ts`, `ollama.ts`, `selector.ts`, `index.ts` sind
 * **additive** — sie aendern NICHTS an dem produktiven Chat-Pfad
 * (`server/workspace-session.ts` → claude-CLI MAX-Plan-OAuth).
 *
 * Der bestehende Agent-Server (Port 4201) bleibt der einzige Chat-Pfad fuer
 * lazyos-stable. Die Engines hier sind ein neuer, paralleler "Plain Chat"-
 * Pfad, der NICHT in workspace-session eingebunden wird. Er ist fuer:
 *
 *   - System-Health-Check `/api/system/engines` (welche Engine ist
 *     verfuegbar?)
 *   - Future-Setting-UI ("Engine waehlen")
 *   - Smoke-Tests (siehe `scripts/smoke-multi-engine.ts`)
 *   - Direkter `chat()`-Call ohne workspace-session-Overhead
 *
 * **Fallback-Kette** (selector.ts) — Direktive 2026-05-23 "claude-api raus":
 *   1. claude-cli (when `<home>/.local/bin/claude` is installed + authed)
 *   2. codex-cli (wenn codex 0.130.0+ installiert + authed)
 *   3. ollama (wenn http://127.0.0.1:11434/api/tags antwortet)
 *
 * claude-api (direct Anthropic-Messages-API mit ANTHROPIC_API_KEY) wurde
 * 2026-05-23 entfernt — User-Frust "claude-api brauche ich gar nicht...
 * keine Ahnung was das soll und warum deshalb der nicht laeuft". Der
 * MAX-Plan-OAuth-Pfad ueber claude-cli covert den Use-Case zero-cost.
 */

export type EngineId = 'claude-cli' | 'codex-cli' | 'ollama';

export interface EngineMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface EngineChatRequest {
  messages: EngineMessage[];
  /** Optional model override. Each engine has a sensible default. */
  model?: string;
  /** Soft cap. Engines that don't support it just ignore. */
  maxTokens?: number;
  /** Per-engine timeout in ms. 0 = no timeout. */
  timeoutMs?: number;
  /** AbortSignal for early cancellation. */
  signal?: AbortSignal;
  /**
   * Codex execution safety mode.
   *
   *   'read'  (DEFAULT when absent): `-s read-only -a never` — OS-level sandbox,
   *           no file writes, no shell side-effects. Safe for Chat / Parallel-Race.
   *
   *   'write': `-s workspace-write -a never` — workspace writes allowed.
   *           ONLY takes effect when BOTH (a) codexMode === 'write' is set AND
   *           (b) env LAZYOS_CODEX_WRITE is set. If either is missing the engine
   *           falls back to 'read' and emits a console.warn. This prevents any
   *           caller from accidentally spawning a write-capable codex.
   *
   * Omitting this field is identical to 'read'.
   */
  codexMode?: 'read' | 'write';
  /**
   * Ultrathink (default OFF). When true AND the engine is claude-cli, the
   * adapter raises the CLI reasoning depth via `--effort`. Ignored by every
   * other engine (structural no-op — they don't read this field).
   */
  thinking?: boolean;
  /**
   * Optional effort level when thinking is set. claude-cli maps this to
   * `--effort <level>`; default 'high' when thinking:true and this is absent.
   * Levels: 'low'|'medium'|'high'|'xhigh'|'max' (verified from `claude --help`).
   *
   * Naming note: the field is `thinkingBudget` per the owner spec; its values
   * are the CLI's `--effort` levels (the claude CLI has no numeric thinking-
   * token budget flag — `--effort` IS the lever).
   */
  thinkingBudget?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface EngineChatResponse {
  engine: EngineId;
  model: string;
  text: string;
  /** Wall-clock ms from request-start to last-byte-received. */
  latencyMs: number;
  /** Best-effort token-counts. Some engines don't report — then 0. */
  usage?: { promptTokens: number; completionTokens: number };
}

export interface EngineAvailability {
  engine: EngineId;
  available: boolean;
  reason: string;
  /** Engine-specific extras (binary path, model list, auth hint, ...). */
  details?: Record<string, unknown>;
  /** ms it took to probe. */
  probeMs: number;
}

export interface EngineChatStream {
  /** AsyncIterable that yields text-deltas. Final iteration yields `done`. */
  stream: AsyncIterable<{ type: 'token' | 'done' | 'error'; text?: string; error?: string }>;
  /** Final response promise (resolves when stream is exhausted). */
  result: Promise<EngineChatResponse>;
}

/**
 * Common engine surface. NOT a class hierarchy — pure functions per engine
 * with this shape. Selector picks one at runtime.
 */
export interface ChatEngine {
  id: EngineId;
  /** Probe: is the engine usable RIGHT NOW? */
  detect(): Promise<EngineAvailability>;
  /** Single round-trip, non-streaming. */
  chat(req: EngineChatRequest): Promise<EngineChatResponse>;
}

/**
 * Selector output. Order from highest preference to lowest. Caller picks the
 * first `available: true` entry; fallback through the rest on failure.
 */
export interface EngineSelection {
  preferred: EngineId | null;
  available: EngineAvailability[];
  detectedAt: number;
}
