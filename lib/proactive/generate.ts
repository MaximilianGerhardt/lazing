/**
 * lib/proactive/generate.ts — server-side proactive suggestion generator
 * (Proactivity goal, 2026-06-02).
 *
 * Called fire-and-forget by the watcher hook in lib/subchats/service.postMessage
 * as soon as an EXTERNAL sub-chat message arrives. Generates ONE
 * concrete operator-facing next step — enriched with workspace-
 * isolated RAG knowledge (N2) — and stores it via storeProactiveSuggestion.
 *
 * CLAUDE-GATED + BEST-EFFORT: orchestrate({mode:'claude-cli'}) throws "engine
 * not available" if the claude-CLI is missing locally → caught → NOTHING stored.
 * Any other error (RAG, parse, empty output) → likewise nothing stored.
 * This function NEVER throws. NEVER auto-sends: it only stores a suggestion.
 *
 * Reuse source: app/api/chat/proactive/subchat-suggestion/route.ts (P3 logic).
 */

import { getSubchat, listMessages, storeProactiveSuggestion } from '@/lib/subchats/service';
import { retrieve, formatForPrompt } from '@/lib/rag/retriever';

export async function generateAndStore(
  subchatId: string,
  workspaceId: string,
): Promise<void> {
  try {
    // Defense-in-depth: subchat exists + belongs to the claimed workspace (N2).
    const sc = getSubchat(subchatId);
    if (!sc || sc.workspaceId !== workspaceId) return;
    if (!workspaceId || workspaceId.trim().length === 0) return; // N2 required

    // Last ~15 messages. Empty ⇒ nothing to suggest.
    const msgs = listMessages(subchatId, 15);
    if (msgs.length === 0) return;

    const lastCustomerMessage =
      [...msgs].reverse().find((m) => m.authorKind === 'external')?.content?.trim() ||
      msgs[msgs.length - 1].content.trim();

    const transcript = msgs
      .map((m) => `${m.authorKind === 'external' ? (m.authorName || 'Kunde') : 'Team'}: ${m.content}`)
      .join('\n')
      .slice(-4000);

    // N2: retrieve() asserts workspaceId + reads the workspace-isolated view.
    // RAG errors must NEVER block the suggestion.
    let ragBlock = '';
    try {
      const rag = await retrieve({ workspaceId, query: lastCustomerMessage, topK: 6 });
      ragBlock = formatForPrompt(rag);
    } catch {
      ragBlock = '';
    }

    const prompt = [
      'Du bist der OS-Assistent des Operators (Ein-Mann-Agentur). Der Operator betreut',
      `den Kunden-Workspace "${sc.title}". Im Kundenchat ist gerade Neues von extern angekommen.`,
      '',
      'Bisheriger Kundenchat-Verlauf:',
      '---',
      transcript,
      '---',
      ragBlock ? `Relevantes Workspace-Wissen (RAG, workspace-isoliert):\n${ragBlock}\n` : '',
      'Aufgabe: Schlage dem Operator EINEN konkreten nächsten Schritt / eine Fortsetzung /',
      'einen kurzen Plan-Vorschlag vor, wie er auf die letzte Kundennachricht reagieren bzw.',
      'die Arbeit am Workspace voranbringen sollte. Berücksichtige technische Komplikationen,',
      'die der Operator möglicherweise NICHT auf dem Schirm hat. Schreibe Deutsch, Du-Form,',
      'direkt und umsetzbar (3-6 Sätze, kein Vorgeplänkel). Dies ist ein VORSCHLAG an den',
      'Operator — KEINE Nachricht an den Kunden. Antworte AUSSCHLIESSLICH mit dem Vorschlagstext.',
    ]
      .filter(Boolean)
      .join('\n');

    // CLAUDE-GATED: mode 'claude-cli'. Throws if claude is missing locally → catch → nothing.
    const { orchestrate } = await import('@/lib/llm/orchestrator');
    const result = await orchestrate({
      mode: 'claude-cli',
      messages: [{ role: 'user', content: prompt }],
      parallelTimeoutMs: 30_000,
    });
    const suggestion = (result.text ?? '').trim();
    if (!suggestion) return; // empty output → store nothing

    storeProactiveSuggestion({ subchatId, workspaceId, suggestion });
  } catch (err) {
    // BEST-EFFORT: any error (engine not available, RAG, DB, parse) → store
    // nothing, no crash. The watcher stays invisible on engine failure.
    console.warn(
      '[proactive/generate] non-fatal:',
      err instanceof Error ? err.message : String(err),
    );
  }
}
