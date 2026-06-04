/**
 * Multi-Engine Orchestrator — Parallel Race + Single-Engine Modes.
 *
 * Scope-Decision (2026-05-23, Direktive "Engine darf parallel alle sein"):
 *
 * The User-Directive removes the "pick one default" mental model. lazyos
 * connects ALL available engines after onboarding, and every chat turn either:
 *
 *   - `mode: 'parallel-all'` — fan out to every available engine, return the
 *     fastest non-error response. Other in-flight engines are aborted via
 *     AbortController. (Default mode.)
 *   - `mode: 'claude-cli' | 'codex-cli' | 'ollama'` — single-engine. No
 *     fallback (use `chatWithFallback` from ./engines if you want fallback).
 *
 * Returns a {@link OrchestratorResult} that includes per-engine race-stats so
 * the UI can render "via Codex (1.2s) – Claude+Ollama abgebrochen".
 *
 * Resource-Budget (N11 from CLAUDE.md):
 *   - max 2 heavy local jobs (Ollama deepseek-r1:14b counts as heavy).
 *   - We do NOT enforce that here — that's the Subagent-Pool's job. The
 *     orchestrator only fans out to the 3-4 engine adapters defined in
 *     ./engines, none of which spawn local heavy models by default.
 *
 * Telemetry:
 *   - Each call returns `attempts: Array<{ engine, latencyMs, error?, won?}>`.
 *     Caller can log this to detail_ledger / audit / UI.
 */

import { detectEngines, getEngine } from './engines/selector';
import type {
  EngineChatRequest,
  EngineChatResponse,
  EngineId,
} from './engines/types';
import { piiVaultEnabled, tokenizeMessages, rehydrate } from '@/lib/privacy/protect';

// Additive (2026-06-02): 'ultracoding' is a NEW literal alongside the union.
// It delegates to the multi-agent worktree orchestrator (see orchestrate()).
// Widening only — every existing branch is untouched.
export type EngineMode = 'parallel-all' | 'ultracoding' | EngineId;

export interface OrchestratorRequest extends EngineChatRequest {
  /**
   * 'parallel-all' = race all available engines (fastest wins, others
   * aborted). Any specific EngineId = single-engine, no fallback.
   * 'ultracoding' = delegate to the multi-agent (worktree-isolated) module.
   */
  mode: EngineMode;
  /**
   * Soft cap on the parallel race. If the winner doesn't reply within
   * `parallelTimeoutMs`, the orchestrator aborts everyone and throws. Default
   * 30s. Per-engine timeouts still apply.
   */
  parallelTimeoutMs?: number;
  /** Only consumed by mode:'ultracoding'. Ignored by every other branch. */
  ultracodingWorkspaceId?: string;
  /**
   * PII-vault scope (N9). When set, orchestrate() tokenizes the inbound messages
   * before they reach the (cloud) engines and rehydrates the winning text — the
   * single chokepoint for every orchestrate() caller. Pass-through when the vault
   * is off / this is empty. The main chat path pre-tokenizes with the NER layer
   * and does NOT set this, so it is unaffected (no double processing).
   */
  workspaceId?: string;
}

export interface OrchestratorAttempt {
  engine: EngineId;
  latencyMs: number;
  /** true = this attempt's response was returned to the caller. */
  won: boolean;
  /** Filled if the attempt errored / was aborted. */
  error?: string;
}

export interface OrchestratorResult extends EngineChatResponse {
  /** `parallel-all` or the single engine that ran. */
  mode: EngineMode;
  /** One entry per engine that was started. */
  attempts: OrchestratorAttempt[];
}

const DEFAULT_PARALLEL_TIMEOUT_MS = 30_000;

/**
 * Single entry point. Caller passes mode + messages; we figure out the rest.
 *
 * Behaviour:
 *   - mode = single engine → detect, fail if engine not available, run.
 *   - mode = 'parallel-all' → detect, race all available engines, return
 *     the fastest non-error. If all fail, throw with the collected errors.
 */
export async function orchestrate(
  req: OrchestratorRequest,
): Promise<OrchestratorResult> {
  // ── NEW (additive, 2026-06-02): ultracoding delegates to the multi-agent ──
  // module. Gated on claude-cli availability; clean throw if unavailable
  // (never crash). This branch sits BEFORE every existing branch and leaves
  // them byte-identical.
  if (req.mode === 'ultracoding') {
    const selection = await detectEngines();
    const claudeOk = selection.available.some(
      (a) => a.engine === 'claude-cli' && a.available,
    );
    if (!claudeOk) {
      const reason =
        selection.available.find((a) => a.engine === 'claude-cli')?.reason ??
        'unknown';
      throw new Error(
        `orchestrator: ultracoding requires claude-cli (${reason})`,
      );
    }
    const { runUltracoding } = await import(
      '@/server/agents/ultracoding-orchestrator'
    );
    // Non-HTTP callers get the aggregated result; lane events are dropped
    // (onLaneEvent omitted → no-op).
    return runUltracoding({
      messages: req.messages,
      workspaceId: req.ultracodingWorkspaceId ?? '__adhoc__',
      signal: req.signal,
    });
  }
  // ── PII vault: single chokepoint for every non-ultracoding orchestrate()
  // caller. When a workspace scope is supplied, tokenize the inbound messages
  // before any engine (cloud racer / single engine / consensus synthesis) sees
  // them, and rehydrate the winning text on the way out. Pass-through for
  // vault-off / no scope. (ultracoding above has its own tokenization path.)
  const piiWs = req.workspaceId ?? '';
  const piiOn = piiWs.length > 0 && piiVaultEnabled();
  if (piiOn) {
    // Mutate messages in place (not `req = {...req}`) so TypeScript keeps the
    // `mode !== 'ultracoding'` narrowing from the early return above; req is a
    // fresh per-call argument object, so mutating it has no external effect.
    req.messages = tokenizeMessages(piiWs, req.messages);
  }
  const finalize = (r: OrchestratorResult): OrchestratorResult =>
    piiOn ? { ...r, text: rehydrate(piiWs, r.text) } : r;

  // ── existing code below UNCHANGED from here. ──
  const selection = await detectEngines();
  const availableIds = selection.available
    .filter((p) => p.available)
    .map((p) => p.engine);

  if (req.mode !== 'parallel-all') {
    // Single-engine path.
    if (!availableIds.includes(req.mode)) {
      const reason =
        selection.available.find((a) => a.engine === req.mode)?.reason ??
        'unknown';
      throw new Error(
        `orchestrator: engine ${req.mode} not available (${reason})`,
      );
    }
    const t0 = Date.now();
    try {
      // Engine-übergreifende Skills (2026-06-03): claude/codex laden SKILL.md
      // NATIV aus ihren Skill-Verzeichnissen. Engines OHNE Skill-System (ollama)
      // bekommen die Skill-Metadaten als System-Block in den Prompt injiziert,
      // damit auch ein nacktes Modell die Playbooks kennt. Best-effort.
      let chatReq = req;
      if (req.mode === 'ollama') {
        try {
          const { buildOllamaSkillBlock } = await import('@/lib/skills/sync');
          const block = buildOllamaSkillBlock();
          if (block) {
            chatReq = { ...req, messages: [{ role: 'system', content: block }, ...req.messages] };
          }
        } catch {
          /* skills optional */
        }
      }
      const res = await getEngine(req.mode).chat(chatReq);
      return finalize({
        ...res,
        mode: req.mode,
        attempts: [
          { engine: req.mode, latencyMs: Date.now() - t0, won: true },
        ],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`orchestrator: ${req.mode} failed: ${msg}`);
    }
  }

  // Parallel race.
  if (availableIds.length === 0) {
    throw new Error('orchestrator: no engines available for parallel mode');
  }

  const parallelTimeoutMs = req.parallelTimeoutMs ?? DEFAULT_PARALLEL_TIMEOUT_MS;
  const overall = new AbortController();
  const overallTimeout = setTimeout(() => overall.abort(), parallelTimeoutMs);

  // If the caller already passed a signal, link both.
  if (req.signal) {
    if (req.signal.aborted) overall.abort();
    else req.signal.addEventListener('abort', () => overall.abort(), { once: true });
  }

  // Per-engine controllers so the winner can cancel the losers explicitly.
  const perEngineCtrls = new Map<EngineId, AbortController>();
  const startedAt = new Map<EngineId, number>();
  const attempts = new Map<EngineId, OrchestratorAttempt>();

  const racers: Array<Promise<{ id: EngineId; res: EngineChatResponse }>> = [];

  for (const id of availableIds) {
    const ctrl = new AbortController();
    perEngineCtrls.set(id, ctrl);
    // Link overall abort → per-engine abort.
    overall.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    const t0 = Date.now();
    startedAt.set(id, t0);

    // SAFETY: parallel-race NEVER runs write-codex. Force codexMode='read' for
    // every engine slot in the race. For non-codex engines the field is a no-op.
    const safeReq: EngineChatRequest = {
      ...req,
      signal: ctrl.signal,
      codexMode: 'read',
    };

    racers.push(
      getEngine(id)
        .chat(safeReq)
        .then((res) => ({ id, res }))
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          attempts.set(id, {
            engine: id,
            latencyMs: Date.now() - t0,
            won: false,
            error: msg,
          });
          throw err;
        }),
    );
  }

  try {
    // 2026-06-03 (Owner-Direktive): KONSENS statt fastest-wins. ALLE Engines
    // laufen durch, wir sammeln ALLE Erfolge und synthetisieren daraus EINE
    // Konsens-Antwort (überlagern statt "der Schnellste gewinnt").
    const settled = await Promise.allSettled(racers);
    clearTimeout(overallTimeout);

    const fulfilled: Array<{ id: EngineId; res: EngineChatResponse }> = [];
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        fulfilled.push(s.value);
        const wT0 = startedAt.get(s.value.id) ?? Date.now();
        attempts.set(s.value.id, {
          engine: s.value.id,
          latencyMs: Date.now() - wT0,
          won: true,
        });
      }
    }
    // Stubs für Engines ohne (Erfolgs-/Fehler-)Eintrag.
    for (const id of availableIds) {
      if (!attempts.has(id)) {
        const lT0 = startedAt.get(id) ?? Date.now();
        attempts.set(id, {
          engine: id,
          latencyMs: Date.now() - lT0,
          won: false,
          error: 'no-response',
        });
      }
    }

    if (fulfilled.length === 0) {
      const reasons = [...attempts.values()]
        .map((a) => `${a.engine}: ${a.error ?? 'unknown'}`)
        .join('; ');
      throw new Error(
        `orchestrator: parallel-all all engines failed → ${reasons}`,
      );
    }

    // Genau eine Engine erfolgreich → kein Konsens nötig, direkt zurück.
    if (fulfilled.length === 1) {
      return finalize({
        ...fulfilled[0].res,
        mode: 'parallel-all',
        attempts: [...attempts.values()],
      });
    }

    // ≥2 Engines → überlagern + Konsens synthetisieren (claude-cli, N11).
    // Fail-soft: scheitert die Synthese (z.B. claude-cli nicht verfügbar),
    // fällt auf die informativste Einzelantwort zurück statt zu crashen.
    try {
      const { synthesizeConsensus } = await import('./chat-consensus');
      const consensus = await synthesizeConsensus({
        messages: req.messages,
        responses: fulfilled.map((f) => ({ engine: f.id, text: f.res.text })),
        signal: req.signal,
      });
      return finalize({
        ...fulfilled[0].res,
        text: consensus.text,
        model: `consensus · ${consensus.engines.join('+')}`,
        mode: 'parallel-all',
        attempts: [...attempts.values()],
      });
    } catch {
      const best = fulfilled
        .slice()
        .sort((a, b) => b.res.text.length - a.res.text.length)[0];
      return finalize({
        ...best.res,
        mode: 'parallel-all',
        attempts: [...attempts.values()],
      });
    }
  } catch (err) {
    clearTimeout(overallTimeout);
    // All engines failed (Promise.any → AggregateError) OR overall timeout
    // fired. Either way, surface a unified error with per-engine reasons.
    for (const id of availableIds) {
      if (!attempts.has(id)) {
        const lT0 = startedAt.get(id) ?? Date.now();
        attempts.set(id, {
          engine: id,
          latencyMs: Date.now() - lT0,
          won: false,
          error: 'aborted (timeout)',
        });
      }
    }
    const reasons = [...attempts.values()]
      .map((a) => `${a.engine}: ${a.error ?? 'unknown'}`)
      .join('; ');
    throw new Error(`orchestrator: parallel-all all engines failed → ${reasons}`);
  }
}

/**
 * Convenience: detect once, expose what parallel-all would actually fan out
 * to. Useful for UI ("3 engines connected, parallel mode active").
 */
export async function parallelTargets(): Promise<EngineId[]> {
  const sel = await detectEngines();
  return sel.available.filter((a) => a.available).map((a) => a.engine);
}
