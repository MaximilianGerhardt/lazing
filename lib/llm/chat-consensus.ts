/**
 * chat-consensus — Synthese mehrerer Engine-Antworten zu EINER Konsens-Antwort.
 *
 * Owner-Direktive (2026-06-03): „Parallel" soll NICHT fastest-wins sein, sondern
 * die Ergebnisse mehrerer Engines überlagern und einen Konsens daraus gewinnen.
 *
 * Dieser Helper nimmt die (≥2) erfolgreichen Engine-Antworten + die ursprüngliche
 * Nutzer-Anfrage und lässt EINEN Synthese-Pass (claude-cli, N11: Synthese-Rolle)
 * eine konsolidierte Antwort bilden. Kein Workstream-/Ticket-Plumbing (anders als
 * server/agents/tier-orchestrator.ts runSynthesis) — bewusst leichtgewichtig für
 * den Chat-Pfad.
 *
 * N11: Synthese via claude-cli (NICHT deepseek). Aufrufer begrenzt die Racer-Zahl.
 */

import { getEngine } from './engines/selector';
import type { EngineId, EngineMessage } from './engines/types';

export interface ConsensusInput {
  /** Die ursprüngliche Konversation (für die letzte Nutzer-Anfrage). */
  messages: EngineMessage[];
  /** Die erfolgreichen Engine-Antworten (≥2). */
  responses: Array<{ engine: EngineId; text: string }>;
  signal?: AbortSignal;
}

export interface ConsensusResult {
  text: string;
  /** Welche Engines in den Konsens eingeflossen sind. */
  engines: EngineId[];
}

function lastUserMessage(messages: EngineMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return messages[i].content;
  }
  return '';
}

/**
 * Überlagert die Engine-Antworten und synthetisiert eine Konsens-Antwort.
 * Wirft bei Fehler — der Aufrufer (orchestrator) fällt dann auf die erste
 * Einzelantwort zurück (nie hart crashen).
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
