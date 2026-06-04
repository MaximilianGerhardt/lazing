/**
 * chat-consensus — synthesis of multiple engine answers into ONE consensus answer.
 *
 * Owner directive (2026-06-03): „Parallel" should NOT be fastest-wins, but rather
 * overlay the results of multiple engines and derive a consensus from them.
 *
 * This helper takes the (≥2) successful engine answers + the original
 * user request and lets ONE synthesis pass (claude-cli, N11: synthesis role)
 * form a consolidated answer. No workstream/ticket plumbing (unlike
 * server/agents/tier-orchestrator.ts runSynthesis) — deliberately lightweight for
 * the chat path.
 *
 * N11: synthesis via claude-cli (NOT deepseek). The caller limits the racer count.
 */

import { getEngine } from './engines/selector';
import type { EngineId, EngineMessage } from './engines/types';

export interface ConsensusInput {
  /** The original conversation (for the last user request). */
  messages: EngineMessage[];
  /** The successful engine answers (≥2). */
  responses: Array<{ engine: EngineId; text: string }>;
  signal?: AbortSignal;
}

export interface ConsensusResult {
  text: string;
  /** Which engines flowed into the consensus. */
  engines: EngineId[];
}

function lastUserMessage(messages: EngineMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return messages[i].content;
  }
  return '';
}

/**
 * Overlays the engine answers and synthesizes a consensus answer.
 * Throws on error — the caller (orchestrator) then falls back to the first
 * individual answer (never hard-crash).
 */
export async function synthesizeConsensus(
  input: ConsensusInput,
): Promise<ConsensusResult> {
  const question = lastUserMessage(input.messages);
  const blocks = input.responses
    .map((r, i) => `### Antwort ${i + 1} · Engine: ${r.engine}\n${r.text.trim()}`)
    .join('\n\n');

  const prompt = `Du bist ein Konsens-Synthese-Agent. Mehrere unabhängige KI-Engines haben dieselbe Nutzer-Anfrage beantwortet. Überlagere ihre Antworten und bilde EINE konsolidierte Konsens-Antwort:
- Übernimm, worin sich die Engines EINIG sind (das ist der belastbare Kern).
- Integriere die jeweils stärksten/zusätzlichen korrekten Punkte.
- Falls die Engines sich in einem wichtigen Punkt WIDERSPRECHEN, nenne das am Ende in einem kurzen Satz ("Uneinigkeit: …").
- Antworte DIREKT an den Nutzer in dessen Sprache. KEIN Meta-Kommentar über "Engine 1/2", keine Aufzählung der Quellen.

## Nutzer-Anfrage
${question}

## Engine-Antworten
${blocks}

## Konsolidierte Konsens-Antwort:`;

  const res = await getEngine('claude-cli').chat({
    messages: [{ role: 'user', content: prompt }],
    codexMode: 'read',
    signal: input.signal,
  });

  return {
    text: res.text.trim(),
    engines: input.responses.map((r) => r.engine),
  };
}
