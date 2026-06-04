/**
 * Deterministischer, fail-soft JSON-Parse fuer LLM-Antworten (N6).
 *
 * WARUM (Master-Briefing §10.1 + N6): Innovation Mode darf „kontrollierte
 * Regelverletzung" sein — aber der DATENPFAD bleibt deterministisch. Eine
 * malformte LLM-Antwort darf den Run NIE werfen; sie liefert ein leeres
 * Ergebnis (fail-soft), kein Crash, kein halluziniertes Teilergebnis.
 *
 * Strategie (analog robusten LLM-JSON-Extraktoren im Repo):
 *   1. Markdown-Code-Fence (```json … ```) abstreifen, falls vorhanden.
 *   2. Auf das erste balancierte Top-Level-JSON-Array/-Objekt zuschneiden.
 *   3. JSON.parse in try/catch. Fehlschlag → null (fail-soft).
 *
 * REIN: kein DB, kein I/O, kein Seiteneffekt. N6: identischer Input → identische
 * Ausgabe.
 */

/** Streift eine umschliessende Markdown-Code-Fence ab (```json … ``` o.ae.). */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  return fence ? fence[1].trim() : trimmed;
}

/**
 * Schneidet auf das erste balancierte Top-Level-Array/-Objekt zu. Findet das
 * erste `[` oder `{` und das dazu balancierte schliessende Zeichen (String-
 * Literale + Escapes werden korrekt uebersprungen, damits an Klammern IN
 * Strings nicht zerbricht). Gibt null, wenn kein balanciertes Konstrukt da ist.
 */
function extractBalanced(text: string): string | null {
  const startIdx = (() => {
    const a = text.indexOf("[");
    const o = text.indexOf("{");
    if (a === -1) return o;
    if (o === -1) return a;
    return Math.min(a, o);
  })();
  if (startIdx === -1) return null;

  const open = text[startIdx];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null; // unbalanciert
}

/**
 * Parst die LLM-Antwort fail-soft zu `unknown`. Gibt null zurueck, wenn nichts
 * Valides extrahierbar ist. Wirft NIE.
 */
export function parseJsonSoft(raw: string): unknown {
  if (typeof raw !== "string") return null;
  const cleaned = stripCodeFence(raw);
  const candidate = extractBalanced(cleaned) ?? cleaned;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/**
 * Parst eine LLM-Antwort, die ein Array von Strings (oder Objekten mit einem
 * Text-Feld) sein soll, zu einer deterministischen `string[]`-Liste.
 *
 * Akzeptiert tolerant:
 *   - `["a", "b"]`
 *   - `[{ "text": "a" }, { "statement": "b" }, { "assumption": "c" }]`
 *   - `{ "items": [...] }` / `{ "assumptions": [...] }` / `{ "reframes": [...] }`
 *
 * VERBATIM (N1): die extrahierten Strings werden NICHT gekuerzt/normalisiert
 * (nur getrimmt + leere verworfen). Reihenfolge bleibt erhalten. Fail-soft → [].
 */
export function parseStringList(raw: string, fieldHints: string[] = []): string[] {
  const parsed = parseJsonSoft(raw);
  if (parsed === null) return [];

  // { items: [...] } / { <hint>: [...] } auf das Array reduzieren.
  let arr: unknown = parsed;
  if (!Array.isArray(parsed) && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const keys = ["items", "list", "results", ...fieldHints];
    for (const k of keys) {
      if (Array.isArray(obj[k])) {
        arr = obj[k];
        break;
      }
    }
  }
  if (!Array.isArray(arr)) return [];

  const out: string[] = [];
  for (const el of arr) {
    if (typeof el === "string") {
      const s = el.trim();
      if (s.length > 0) out.push(s);
      continue;
    }
    if (el && typeof el === "object") {
      const obj = el as Record<string, unknown>;
      const textKeys = [
        "text",
        "statement",
        "assumption",
        "reframe",
        "analogy",
        "content",
        ...fieldHints,
      ];
      for (const k of textKeys) {
        if (typeof obj[k] === "string" && (obj[k] as string).trim().length > 0) {
          out.push((obj[k] as string).trim());
          break;
        }
      }
    }
  }
  return out;
}
