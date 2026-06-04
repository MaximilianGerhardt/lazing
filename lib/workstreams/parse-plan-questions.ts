/**
 * Sub-Plan 02 — Plan-Markdown Question-Extractor.
 *
 * Findet im V_n-Plan-Output die `## Offene Fragen` (oder `## Open Questions`)
 * Section + extrahiert die einzelnen Bullet-Punkte. Akzeptiert verschiedene
 * Varianten:
 *   - `- [?] <frage>`
 *   - `- <frage>`
 *   - `* <frage>`
 *   - Plus den DACH-üblichen „[?]"-Marker am Anfang.
 *
 * Stop-Marker: nächste `##` Section, end of string, oder Code-Fence ```.
 */

export interface PlanQuestion {
  text: string;
  /** Optional: kürzer Hash für stable IDs (für Surface-Tracking). */
  id: string;
  /**
   * Sub-Plan D (2026-04-30) — QuickChoice-Buttons.
   * Wenn die Frage im Plan-Markdown im Format
   *   `- [?] <Frage> | OPTIONS: A | B | C`
   * geschrieben wurde, enthält dieses Array die getrimmten Options
   * (max 5). Der Renderer zeigt dann Klick-Buttons statt Textarea.
   * Leeres Array oder undefined → Free-Text-Fallback.
   */
  options?: string[];
}

const SECTION_HEADERS = [
  /^##\s+Offene\s+Fragen\b/im,
  /^##\s+Open\s+Questions\b/im,
  /^##\s+Fragen\b/im,
  /^##\s+Questions\b/im,
];

function hashString(s: string): string {
  // FNV-1a 32-bit, deterministisch + simpel
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * De-Dupe (2026-05-26, Bug-Report Max): Die Build-/Schwarm-TIEFE wird bereits
 * vom dedizierten Depth-Picker erfragt (SubplanCard „PLAN ERKANNT — wie tief?",
 * Schnell/Standard/Tief). Wenn das Plan-LLM dieselbe Entscheidung ZUSÄTZLICH als
 * offene Frage schreibt („Build-Tiefe?", „Wie viele Agenten?"), entstehen zwei
 * Surfaces für EINE Entscheidung → verwirrend + widersprüchlich. Solche Fragen
 * werden hier verworfen; der Picker bleibt die einzige Tiefe-/Spawn-Quelle.
 * Inhaltliche Fragen (Tech-Stack, Copy-vs-Design, …) bleiben unberührt.
 */
function isDepthOrSpawnQuestion(text: string): boolean {
  const t = text.toLowerCase().trim();
  return (
    /\b(build-?tiefe|schwarm-?tiefe)\b/.test(t) ||
    /^tiefe\s*\??$/.test(t) ||
    /\bwie\s+tief\b/.test(t) ||
    /\bwie\s+viele\s+agent/.test(t) ||
    /\b(anzahl|agentenzahl)\b.{0,16}agent/.test(t) ||
    /\b(swarm[-\s]?)?depth\b/.test(t)
  );
}

export function parsePlanQuestions(planText: string): PlanQuestion[] {
  if (!planText || planText.trim().length === 0) return [];

  // Section-Header-Match finden
  let startIndex = -1;
  for (const re of SECTION_HEADERS) {
    const m = re.exec(planText);
    if (m && m.index !== undefined) {
      startIndex = m.index + m[0].length;
      break;
    }
  }
  if (startIndex < 0) return [];

  // Bis zum nächsten ## oder Ende lesen
  const rest = planText.slice(startIndex);
  const stopMatch = /\n##\s+/m.exec(rest);
  const sectionEnd = stopMatch ? stopMatch.index : rest.length;
  const block = rest.slice(0, sectionEnd);

  // Bullet-Lines extrahieren
  const lines = block.split('\n');
  const questions: PlanQuestion[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    // Match `- ` or `* ` or `1.` oder optional `[?]` Marker davor
    const m = /^[-*]\s+(?:\[\?\]\s+)?(.*)$/i.exec(line);
    if (!m) continue;
    const rawText = m[1].trim();
    if (rawText.length < 3) continue; // Lärm-Filter
    // Code-Fence öffnet/schließt? Ignorieren wenn drin
    if (rawText.startsWith('```')) continue;

    // Sub-Plan D (2026-04-30): OPTIONS:-Suffix abspalten.
    //
    // C1 (2026-05-29, Bug-Report Max + Owner-Direktive Handoff §9, N1):
    // Komma als Options-Trenner ENTFERNT. Beobachtete Daten aus
    // example-website-project zeigten, dass "Copy zuerst (SOP-Logik,
    // empfohlen)" in zwei kaputte Optionen ("Copy zuerst (SOP-Logik" +
    // "empfohlen)") zerfiel, weil das interne Komma als Trenner griff. Pipe `|`
    // ist ab jetzt der EINZIGE kanonische Trenner — der LLM-Prompt verlangt
    // bereits Pipe (siehe buildRepromptHint Z.201), also kein Regress für
    // korrekt formatierte Pläne.
    //
    // C2: Zusätzlich akzeptieren wir einen strukturierten JSON-Pfad
    //   "<frage> | OPTIONS_JSON: [\"A\",\"B (mit, Komma)\",\"C\"]"
    // für künftige Prompts, die Optionen sauber als JSON-Array emittieren —
    // ohne Markdown-Parsing-Tricks.
    //
    // Akzeptierte Formate:
    //   "<frage> | OPTIONS: A | B | C"
    //   "<frage> | OPTIONS_JSON: [\"A\",\"B\",\"C\"]"
    let text = rawText;
    let options: string[] | undefined;

    // C2 — JSON-First-Path (additiv, hat Vorrang vor Pipe-Parsing).
    const jsonMatch = /^(.*?)\s*[|]\s*OPTIONS_JSON\s*:\s*(\[[\s\S]*\])\s*$/i.exec(
      rawText,
    );
    if (jsonMatch) {
      const head = jsonMatch[1].trim();
      const tail = jsonMatch[2].trim();
      if (head.length >= 3) {
        try {
          const raw = JSON.parse(tail) as unknown;
          if (Array.isArray(raw)) {
            const parts = raw
              .filter((s): s is string => typeof s === 'string')
              .map((s) => s.trim()) // C3 — Whitespace-Normalisierung
              .filter((s) => s.length > 0) // C3 — leere verwerfen
              .slice(0, 5);
            if (parts.length > 0) {
              text = head;
              options = parts;
            }
          }
        } catch {
          // Ungültiges JSON → wir lassen Pipe-Fallback nicht greifen, weil der
          // User OPTIONS_JSON: explizit gewählt hat; die Frage rutscht als
          // Free-Text durch (sicher, nicht zerstörend).
        }
      }
    }

    if (!options) {
      // Pipe-only-Fallback (C1).
      const optMatch = /^(.*?)\s*[|]\s*OPTIONS\s*:\s*(.+)$/i.exec(rawText);
      if (optMatch) {
        const head = optMatch[1].trim();
        const tail = optMatch[2].trim();
        if (head.length >= 3 && tail.length > 0) {
          const parts = tail
            .split(/\s*\|\s*/) // C1 — Pipe ist ab jetzt der EINZIGE Trenner.
            .map((s) => s.trim()) // C3 — Whitespace-Normalisierung
            .filter((s) => s.length > 0) // C3 — leere verwerfen
            .slice(0, 5);
          if (parts.length > 0) {
            text = head;
            options = parts;
          }
        }
      }
    }

    // De-Dupe: Tiefe-/Spawn-Fragen gehören dem Depth-Picker, nicht der
    // Open-Questions-Karte (sonst zwei Surfaces für eine Entscheidung).
    if (isDepthOrSpawnQuestion(text)) continue;

    questions.push({
      text,
      id: hashString(text),
      ...(options ? { options } : {}),
    });
  }
  return questions;
}

/**
 * Sub-Plan 03 — Pattern 1 (Symbolic Guards, 2026-04-30).
 *
 * Quota-Check für die OPTIONS-Pflicht. Liefert ein Verdict, das
 * runIterate/runSynthesis/runIterateResume nutzen, um bei Verstoß
 * EINEN automatischen Reprompt auszulösen.
 *
 * Regeln (aus V_final-Synthesis):
 * 1. Mindest-Coverage: ≥80% der Fragen haben options[].
 * 2. Mindest-Distinct: jede options-Liste hat ≥2 distinct Einträge
 *    (Format-Gaming-Schutz: „A | A | A" rutscht sonst durch).
 * 3. Bei <2 Fragen total: Quota-Check skipped (zu wenig Daten).
 */
export interface OptionsQuotaVerdict {
  ok: boolean;
  total: number;
  withOptions: number;
  coverage: number;
  reasons: string[];
}

export function checkOptionsQuota(
  questions: PlanQuestion[],
  minCoverage = 0.8,
): OptionsQuotaVerdict {
  const total = questions.length;
  const reasons: string[] = [];

  if (total < 2) {
    return { ok: true, total, withOptions: 0, coverage: 1, reasons: ['too-few-questions-skip'] };
  }

  let withOptions = 0;
  for (const q of questions) {
    if (!q.options || q.options.length === 0) continue;
    const distinct = new Set(q.options.map((o) => o.trim().toLowerCase()));
    if (distinct.size < 2) {
      reasons.push(`q-${q.id}-non-distinct-options`);
      continue;
    }
    withOptions += 1;
  }

  const coverage = total === 0 ? 1 : withOptions / total;
  const ok = coverage >= minCoverage;
  if (!ok) {
    reasons.push(`coverage-${(coverage * 100).toFixed(0)}pct-below-${(minCoverage * 100).toFixed(0)}`);
  }
  return { ok, total, withOptions, coverage, reasons };
}

/**
 * Reprompt-System-Hint für Symbolic-Guard-Trigger.
 * Wird in den nächsten Lead-Prompt eingehängt wenn Quota verfehlt.
 */
export function buildRepromptHint(verdict: OptionsQuotaVerdict): string {
  return [
    '**SYMBOLIC-GUARD AUSGELÖST — Reprompt erzwungen.**',
    `Vorheriger Plan hatte nur ${verdict.withOptions}/${verdict.total}` +
      ` Fragen mit OPTIONS (Coverage ${(verdict.coverage * 100).toFixed(0)}%, Soll ≥80%).`,
    `Reasons: ${verdict.reasons.join(', ')}`,
    '',
    'PFLICHT für diesen Reprompt:',
    '- ALLE offenen Fragen MÜSSEN das Format `- [?] <Frage> | OPTIONS: <A> | <B> | <C>` haben.',
    '- Jede OPTIONS-Liste braucht ≥2 distinct Einträge (kein „A | A").',
    '- Wenn die Frage wirklich frei ist: weglassen statt Free-Text-Question liefern.',
    '- Ziel: User klickt, tippt nicht.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Legacy-Repair (2026-05-29, C4)
// ---------------------------------------------------------------------------
//
// C4 — Backward-Compat-Guard. Vor dem C1-Fix (Komma als generischer
// Options-Trenner) wurden Optionen mit eingebettetem Komma wie
// "Copy zuerst (SOP-Logik, empfohlen)" in zwei kaputte Optionen zerschnitten:
//   ["Copy zuerst (SOP-Logik", "empfohlen)", "Design zuerst", "Beides parallel"]
//
// Solche bereits PERSISTIERTEN defekten Options-Arrays werden NICHT mehr durch
// neue Parser-Aufrufe verschlimmert (der neue Parser sieht die DB-Daten nie),
// aber sie sind auch nicht selbstheilend. Dieser Helper joined heuristisch alle
// Fragmente, die offene `(`-Klammern ohne `)`-Schluss haben, mit dem
// Folge-Fragment wieder zusammen. Bewusst KEIN Auto-Aufruf — der Owner kann
// das später via Maintenance-Script auf alte Records anwenden.
//
// Garantien:
//   - Reine `A | B | C`-Arrays bleiben unverändert (Roundtrip-stabil).
//   - Bei unmatched `(`: das nächste Fragment wird mit ", " angeschlossen.
//   - Maximal 5 Optionen am Ende (gleiche Cap wie der Parser).

/**
 * Heuristic-only Legacy-Repair für bereits persistierte defekte options[].
 * Owner kann das als opt-in Maintenance-Script auf alte Workstream-Records
 * anwenden. Wird vom Parser NICHT automatisch aufgerufen.
 */
export function repairLegacyOptions(opts: readonly string[]): string[] {
  if (!Array.isArray(opts) || opts.length === 0) return [];
  const out: string[] = [];
  let buffer: string | null = null;
  for (const raw of opts) {
    const part = typeof raw === 'string' ? raw.trim() : '';
    if (part.length === 0) continue;
    if (buffer !== null) {
      // Wir hatten ein offenes "(" — diesen Teil dranhängen.
      buffer = `${buffer}, ${part}`;
    } else {
      buffer = part;
    }
    // Match: ist die Klammer noch offen?
    const opens = (buffer.match(/\(/g) ?? []).length;
    const closes = (buffer.match(/\)/g) ?? []).length;
    if (opens > closes) {
      // weiter sammeln
      continue;
    }
    out.push(buffer);
    buffer = null;
  }
  // Falls am Ende noch ein offener Buffer existiert (z.B. nie geschlossen):
  // trotzdem mitnehmen, sonst verlieren wir Daten.
  if (buffer !== null) out.push(buffer);
  return out.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Chat-Inline-Split (2026-05-23)
// ---------------------------------------------------------------------------
// Bug-Report (Max): Die `## Offene Fragen`-Section in freien Chat-Antworten
// war NICHT klickbar — sie wurde als tote Markdown-Bullets gerendert. Die
// Klick-Mechanik existierte nur für `<surface:open-questions>` mit aktivem
// Workstream (POST /inject). Im freien Chat (ohne Workstream) fehlte jeder
// Renderer-Pfad.
//
// Dieser Helper findet die Section in beliebigem Markdown und splittet sie in
// `before` / `questions` / `after`, sodass der Chat-Text-Renderer den
// Mittelteil als interaktive QuickChoice-Card rendern kann.

/**
 * Matcht eine Open-Questions-Heading-Zeile (`## Offene Fragen`,
 * `## Open Questions`, `## Fragen`, `## Questions`) — bewusst dieselben
 * Varianten wie SECTION_HEADERS, aber als EINE Regex mit Index-Capture.
 */
const ANY_OQ_HEADER =
  /^##[ \t]+(?:Offene[ \t]+Fragen|Open[ \t]+Questions|Fragen|Questions)\b[^\n]*$/im;

export interface OpenQuestionsSplit {
  /** Markdown vor der Heading-Zeile (inkl. evtl. `## User-Sicht` o.ä.). */
  before: string;
  /** Geparste Fragen der Section (mit optionalen `options[]`). */
  questions: PlanQuestion[];
  /** Markdown ab der nächsten `##`-Section nach den Fragen (oder ''). */
  after: string;
}

/**
 * Findet die erste Open-Questions-Section in `text` und splittet drumherum.
 * Liefert null wenn keine Section existiert, keine Fragen parsebar sind, oder
 * die Heading-Zeile in einem ```-Code-Fence steckt (Format-Erklärung statt
 * echter Section → kein Quasi-Render).
 */
export function splitOpenQuestionsSection(
  text: string,
): OpenQuestionsSplit | null {
  if (!text || text.indexOf('#') < 0) return null;

  const m = ANY_OQ_HEADER.exec(text);
  if (!m || m.index === undefined) return null;
  const headingStart = m.index;

  // Code-Fence-Guard: ungerade Anzahl ``` vor der Heading → wir sind INNERHALB
  // eines Fences (z.B. der Agent erklärt das Format), nicht in einer Section.
  const fencesBefore = (text.slice(0, headingStart).match(/```/g) ?? []).length;
  if (fencesBefore % 2 === 1) return null;

  const headingEnd = headingStart + m[0].length;
  const rest = text.slice(headingEnd);
  const stop = /\n##[ \t]+/m.exec(rest);
  const after = stop ? rest.slice(stop.index).replace(/^\n+/, '') : '';

  // parsePlanQuestions findet den Header in der Slice wieder + liest bis zur
  // nächsten `##` — liefert also exakt die Fragen DIESER Section.
  const questions = parsePlanQuestions(text.slice(headingStart));
  if (questions.length === 0) return null;

  return { before: text.slice(0, headingStart), questions, after };
}
