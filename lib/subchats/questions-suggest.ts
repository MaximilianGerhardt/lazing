/**
 * lib/subchats/questions-suggest.ts — KI-auto-anspinnen, Slice (2026-06-03).
 *
 * Owner: „die KI muss diese Sachen auch für sich haben." Die KI schlägt — auf
 * Basis des Kundenchat-Verlaufs — 1–2 sinnvolle RÜCKFRAGEN vor, die das Team dem
 * Kunden stellen sollte (mit optionalen Antwort-Optionen). NIEMALS Auto-Send:
 * die Vorschläge werden nur ZURÜCKGEGEBEN; der Operator spinnt sie per Klick an
 * (dann als author_kind:'ai' markiert, „die KI fragt").
 *
 * CLAUDE-GATED + best-effort (orchestrate mode:'claude-cli'); fehlt die Engine
 * → leeres Array, kein Crash. N2: nur der Subchat-eigene Verlauf, workspace-scoped.
 */

import { getSubchat, listMessages } from '@/lib/subchats/service';

export interface SuggestedQuestion {
  text: string;
  options: string[];
}

/** JSON-Array robust aus dem LLM-Text extrahieren (defensiv). */
function parseSuggestions(text: string): SuggestedQuestion[] {
  const raw = text.trim();
  // Finde das erste [...]-Array.
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: SuggestedQuestion[] = [];
  for (const it of arr.slice(0, 3)) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const t = typeof o.text === 'string' ? o.text.trim() : typeof o.q === 'string' ? (o.q as string).trim() : '';
    if (t.length < 3) continue;
    const options = Array.isArray(o.options)
      ? o.options.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, 5)
      : [];
    out.push({ text: t, options });
  }
  return out.slice(0, 2);
}

/**
 * Generiert (nicht spinnt!) 1–2 Rückfrage-Vorschläge für einen Sub-Chat.
 * Best-effort: bei Engine-Ausfall / leerem Verlauf → [].
 */
export async function suggestQuestionsForSubchat(
  subchatId: string,
  workspaceId: string,
): Promise<SuggestedQuestion[]> {
  try {
    const sc = getSubchat(subchatId);
    if (!sc || sc.workspaceId !== workspaceId) return [];
    const msgs = listMessages(subchatId, 15);
    if (msgs.length === 0) return [];
    const transcript = msgs
      .map((m) => `${m.authorKind === 'external' ? m.authorName || 'Kunde' : 'Team'}: ${m.content}`)
      .join('\n')
      .slice(-4000);

    const prompt = [
      `Du hilfst dem Team, das den Kunden-Workspace "${sc.title}" betreut. Unten der bisherige`,
      'Kundenchat-Verlauf. Überlege, welche 1–2 RÜCKFRAGEN das Team dem Kunden JETZT stellen',
      'sollte, um die offenen Punkte zu klären (z. B. Format, Deadline, Budget, Freigabe, Stil).',
      '',
      'Kundenchat-Verlauf:',
      '---',
      transcript,
      '---',
      'Antworte AUSSCHLIESSLICH mit einem JSON-Array (kein Fließtext drumherum), Form:',
      '[{"text":"<die Frage>","options":["<Option A>","<Option B>"]}]',
      'options ist optional (leeres Array wenn Freitext-Frage). Max 2 Fragen. Deutsch.',
    ].join('\n');

    const { orchestrate } = await import('@/lib/llm/orchestrator');
    const result = await orchestrate({
      mode: 'claude-cli',
      messages: [{ role: 'user', content: prompt }],
      parallelTimeoutMs: 30_000,
      // PII vault: the prompt embeds the verbatim customer transcript.
      workspaceId,
    });
    return parseSuggestions(result.text ?? '');
  } catch (err) {
    console.warn(
      '[questions-suggest] non-fatal:',
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}
