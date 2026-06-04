// N6-Entry-Gate — deterministisches Pre-Screen für Plan-Zerlegung.
//
// BACKPORT-03 (2026-05-23 · Agent Phase C-1).
//
// Diese Funktion ist der N6-Pre-Screen, der VOR dem teuren
// `proposeRecursivePlan`-LLM-Call entscheidet, ob ein User-Intent in
// einen Plan zerlegt werden soll.
//
// Disziplin:
//   - N6: ausschließlich deterministisch — kein LLM, kein I/O, kein async.
//         Gleicher Input → immer gleicher Output.
//   - N1: `reason` ist verbatim, keine Kürzung der Signal-Beschreibungen.
//   - Bilingual: alle Regex-Signale decken Deutsche und Englische Prompts ab.
//   - Konservativ: bei Zweifeln lieber false-negative (kein Decompose),
//     um unnötige LLM-Kosten zu vermeiden.
//
// Decompose-Schwelle: Gesamt-Score ≥ 2.
//
// Brand: laz.ing · Stack: TypeScript · Node ≥ 20

// ---------------------------------------------------------------------------
// Öffentliche Typen
// ---------------------------------------------------------------------------

/**
 * Ein einzelnes erkanntes Signal das für oder gegen Decompose spricht.
 *
 * - `name`    : Signal-ID (z. B. "S1 multi-step-verb-de").
 * - `matched` : die konkrete Fundstelle im Prompt (für Debugging).
 * - `weight`  : Beitrag zum Gesamt-Score (negativ = Veto-/Guard-Signal).
 */
export interface DecomposeSignal {
  readonly name: string;
  readonly matched: string;
  readonly weight: number;
}

/**
 * Rückgabetyp von `shouldDecompose`.
 *
 * - `decompose` : true wenn der Score die Schwelle ≥ 2 erreicht.
 * - `score`     : nummerischer Gesamt-Score.
 * - `reason`    : menschenlesbare Begründung mit den Top-Signalen.
 * - `signals`   : alle erkannten Einzel-Signale (inkl. Veto/Guards).
 */
export interface ShouldDecomposeResult {
  readonly decompose: boolean;
  readonly score: number;
  readonly reason: string;
  readonly signals: DecomposeSignal[];
}

// ---------------------------------------------------------------------------
// Schwelle
// ---------------------------------------------------------------------------

/**
 * Mindest-Score für decompose = true.
 *
 * Angehoben 2→3 (2026-06-02, Codex-Parität): bei 2 reichte EIN nacktes
 * Step-Verb ("Erstelle …", "Refactor", "Deploy") um eine Plan-Karte in den
 * Chat zu poppen — un-Codex (Codex/Claude Code beantworten/erledigen einfache
 * Anfragen direkt, statt für jede „erstelle"-Bitte zu planen). Ab 3 braucht es
 * ein Verb PLUS ein korroborierendes Komplexitäts-Signal (Projekt-Keyword,
 * Liste, „und"-Chaining, Länge, mehrere Sätze) — d.h. ein echtes mehrstufiges
 * Vorhaben. Plan-Dispatch bleibt als Ablauf erhalten, feuert aber nur noch
 * bei genuiner Komplexität statt bei jeder Aktion.
 */
const DECOMPOSE_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Hilfsfunktion: Regex-Treffer zählen
// ---------------------------------------------------------------------------

/**
 * Gibt alle nicht-überlappenden Treffer eines Patterns im Prompt zurück.
 * Flags werden ignoriert — intern wird immer `gi` verwendet.
 */
function allMatches(pattern: RegExp, text: string): RegExpMatchArray[] {
  // Neues RegExp-Objekt, damit lastIndex immer frisch ist.
  const re = new RegExp(pattern.source, 'gi');
  const results: RegExpMatchArray[] = [];
  let m: RegExpMatchArray | null;
  while ((m = re.exec(text)) !== null) {
    results.push(m);
    // Safety: bei Zero-Length-Matches lastIndex manuell vorrücken.
    if (m[0].length === 0) re.lastIndex++;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Haupt-Funktion
// ---------------------------------------------------------------------------

/**
 * Entscheidet deterministisch, ob ein User-Prompt in einen mehrstufigen Plan
 * zerlegt werden soll (N6-Gate).
 *
 * Kein LLM, kein I/O, kein async — reine Regex + Arithmetik.
 *
 * @param prompt - Der rohe User-Intent-Text (beliebige Länge).
 * @returns      ShouldDecomposeResult mit `decompose`, `score`, `reason`, `signals`.
 *
 * @example
 * const r = shouldDecompose('Implementiere einen Auth-Service mit JWT');
 * if (r.decompose) proposeRecursivePlan(prompt);
 */
export function shouldDecompose(prompt: string): ShouldDecomposeResult {
  const collected: DecomposeSignal[] = [];

  // -----------------------------------------------------------------------
  // S12 — Negation-Guard (Gewicht −1)
  //
  // "Schreib mir kurz …", "nur …", "einfach nur …" etc. in den ersten 40
  // Zeichen deuten auf eine Simple-Request hin, kein Plan notwendig.
  // Nur VORNE im Prompt relevant — danach kann "nur" legitimerweise als
  // Kontext auftreten ("deploy nur auf Staging").
  // -----------------------------------------------------------------------
  {
    const prefix = prompt.slice(0, 40);
    const re = /\b(nur|only|just|lediglich|einfach\s+nur|kurz)\b/i;
    const m = re.exec(prefix);
    if (m !== null) {
      collected.push({
        name: 'S12 negation-guard',
        matched: m[0],
        weight: -1,
      });
    }
  }

  // -----------------------------------------------------------------------
  // S1 — Multi-Step-Verb Deutsch (Gewicht +2)
  //
  // Starke Handlungsverben die typischerweise mehrere Schritte implizieren.
  // Einmaliges Auftreten reicht — das Verb allein signalisiert Komplexität.
  // -----------------------------------------------------------------------
  {
    const re =
      /\b(implementiere|erstelle|baue|migriere|refactor|refaktoriere|deploy|portiere|konvertiere|scaffolde)\b/i;
    const m = re.exec(prompt);
    if (m !== null) {
      collected.push({
        name: 'S1 multi-step-verb-de',
        matched: m[0],
        weight: 2,
      });
    }
  }

  // -----------------------------------------------------------------------
  // S2 — Multi-Step-Verb Englisch (Gewicht +2)
  //
  // Englische Entsprechungen zu S1. Wortgrenzen nötig, damit "porting" oder
  // "deployment" nicht als eigenständige Verben durchgehen.
  // -----------------------------------------------------------------------
  {
    const re =
      /\b(implement|create|build|migrate|refactor|deploy|port|convert|scaffold|bootstrap)\b/i;
    const m = re.exec(prompt);
    if (m !== null) {
      collected.push({
        name: 'S2 multi-step-verb-en',
        matched: m[0],
        weight: 2,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Prüfen ob S1 ODER S2 gematcht haben (für S10-Veto-Bedingung nötig).
  // -----------------------------------------------------------------------
  const hasStepVerb = collected.some(
    (s) => s.name === 'S1 multi-step-verb-de' || s.name === 'S2 multi-step-verb-en',
  );

  // -----------------------------------------------------------------------
  // S10 — Pure-Question VETO (Gewicht −3)
  //
  // Prompt endet mit `?`. Veto greift, wenn ENTWEDER kein Multi-Step-Verb
  // gefunden wurde ODER der Prompt mit einem Frage-Wort beginnt
  // (wie/was/how/what/…). Letzteres schlägt das Step-Verb: "Wie implementiere
  // ich ein Feature?" ist eine Wissensfrage, kein Auftrag — ohne diese
  // Verschärfung würde jede How-to-Frage fälschlich den vollen (teuren)
  // Decompose-Fan-out auslösen statt einer Antwort (Critic-Fix M2, 2026-05-23).
  // -----------------------------------------------------------------------
  {
    const trimmed = prompt.trim();
    const endsWithQuestion = /\?\s*$/.test(trimmed);
    const startsWithQuestionWord =
      /^(wie|was|warum|wieso|weshalb|wann|wo|wer|welche[rs]?|how|what|why|when|where|who|which)\b/i.test(
        trimmed,
      );
    if (endsWithQuestion && (!hasStepVerb || startsWithQuestionWord)) {
      collected.push({
        name: 'S10 pure-question-veto',
        matched: startsWithQuestionWord ? '?+question-word' : '?',
        weight: -3,
      });
    }
  }

  // -----------------------------------------------------------------------
  // S3 — Enum-Connector Deutsch (Gewicht +1)
  //
  // Aufzählungs- und Sequenz-Wörter auf Deutsch.
  // -----------------------------------------------------------------------
  {
    const re =
      /\b(dann|danach|anschließend|außerdem|zusätzlich|sowie|zuerst|zuletzt)\b/i;
    const m = re.exec(prompt);
    if (m !== null) {
      collected.push({
        name: 'S3 enum-connector-de',
        matched: m[0],
        weight: 1,
      });
    }
  }

  // -----------------------------------------------------------------------
  // S4 — Enum-Connector Englisch (Gewicht +1)
  //
  // "then", "next", "after that" etc. signalisieren explizite Sequenz.
  // "after that" wird als Sonderfall direkt mitgetestet.
  // -----------------------------------------------------------------------
  {
    const re =
      /\b(then|next|afterwards|additionally|also|first|finally|lastly)\b|after\s+that/i;
    const m = re.exec(prompt);
    if (m !== null) {
      collected.push({
        name: 'S4 enum-connector-en',
        matched: m[0],
        weight: 1,
      });
    }
  }

  // -----------------------------------------------------------------------
  // S5 — List-Marker (Gewicht +2)
  //
  // Nummerierte Listen (`1.`, `2.` …) ODER Bullet-Listen (`- item`, `* item`)
  // ab ≥ 2 Vorkommen. Zwei oder mehr Listenpunkte = klare Mehrstufigkeit.
  // -----------------------------------------------------------------------
  {
    // Nummerierte Elemente: \b\d+\. (Word-Boundary vor Ziffer).
    const numberedMatches = allMatches(/\b\d+\./g, prompt);
    // Bullet-Elemente: Zeilenanfang (oder Newline) + optionale Leerzeichen + [-*] + Leerzeichen.
    const bulletMatches = allMatches(/(^|\n)\s*[-*]\s/g, prompt);
    const total = numberedMatches.length + bulletMatches.length;
    if (total >= 2) {
      const sample = [...numberedMatches, ...bulletMatches]
        .slice(0, 2)
        .map((m) => m[0].trim())
        .join(', ');
      collected.push({
        name: 'S5 list-marker',
        matched: sample,
        weight: 2,
      });
    }
  }

  // -----------------------------------------------------------------------
  // S6 — And-Chaining (Gewicht +1)
  //
  // "und" oder "and" ≥ 2 Vorkommen deutet auf Aufzählung hin (nicht nur
  // eine binäre Verknüpfung). Leerzeichen-Flanken verhindern Treffer in
  // zusammengesetzten Wörtern wie "fundamental".
  // -----------------------------------------------------------------------
  {
    // Deutsches "und" mit Leerzeichen-Flanken.
    const deMatches = allMatches(/\s+und\s+/g, prompt);
    // Englisches "and" mit Leerzeichen-Flanken.
    const enMatches = allMatches(/\s+and\s+/g, prompt);
    const total = deMatches.length + enMatches.length;
    if (total >= 2) {
      const sample = [...deMatches, ...enMatches]
        .slice(0, 2)
        .map((m) => m[0].trim())
        .join(', ');
      collected.push({
        name: 'S6 and-chaining',
        matched: sample,
        weight: 1,
      });
    }
  }

  // -----------------------------------------------------------------------
  // S7 — Project-Keyword Deutsch (Gewicht +1)
  //
  // Domänen-Nomen die auf ein Projekt-/Architektur-Vorhaben hinweisen.
  // -----------------------------------------------------------------------
  {
    const re =
      /\b(Projekt|Feature|System|Service|Modul|Architektur|Komponente|Pipeline|Datenbank|Schema|API|Backend|Frontend)\b/i;
    const m = re.exec(prompt);
    if (m !== null) {
      collected.push({
        name: 'S7 project-keyword-de',
        matched: m[0],
        weight: 1,
      });
    }
  }

  // -----------------------------------------------------------------------
  // S8 — Project-Keyword Englisch (Gewicht +1)
  //
  // Englische Entsprechungen zu S7. case-insensitive wegen Groß/Klein-Mix
  // in technischen Texten ("the API", "a schema", "the backend").
  // -----------------------------------------------------------------------
  {
    const re =
      /\b(project|feature|system|service|module|architecture|component|pipeline|database|schema|api|backend|frontend)\b/i;
    const m = re.exec(prompt);
    if (m !== null) {
      collected.push({
        name: 'S8 project-keyword-en',
        matched: m[0],
        weight: 1,
      });
    }
  }

  // -----------------------------------------------------------------------
  // S9 — Länge (Gewicht +1)
  //
  // Lange Prompts (> 200 Zeichen nach trim) beschreiben in aller Regel
  // komplexe Anforderungen — kein einzelner einfacher Befehl.
  // -----------------------------------------------------------------------
  {
    if (prompt.trim().length > 200) {
      collected.push({
        name: 'S9 length',
        matched: `${prompt.trim().length} chars`,
        weight: 1,
      });
    }
  }

  // -----------------------------------------------------------------------
  // S11 — Multiple Sentences (Gewicht +1)
  //
  // Satzenden (. ! ?) gefolgt von Leerzeichen + Großbuchstabe (inkl. Umlaute).
  // ≥ 3 solcher Übergänge = mehrere eigenständige Anforderungssätze.
  // -----------------------------------------------------------------------
  {
    const transitionMatches = allMatches(/[.!?]\s+[A-ZÜÄÖ]/g, prompt);
    if (transitionMatches.length >= 3) {
      collected.push({
        name: 'S11 multiple-sentences',
        matched: `${transitionMatches.length} transitions`,
        weight: 1,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Score berechnen und Entscheidung treffen
  // -----------------------------------------------------------------------

  // Step-Verb zählt EINMAL (2026-06-02-Fix): die DE- (S1) und EN-Liste (S2)
  // überlappen bei "refactor"/"deploy"/"migrate"/"port"/"convert" → ein nacktes
  // "Deploy" feuerte beide und kam so auf +4 (statt +2), was bare Verben fälsch-
  // lich über den Threshold hob. Wir zählen das Verb-Signal genau einmal; die
  // einzelnen S1/S2-Signale bleiben in `collected` (für Name-Assertions/reason).
  let score = 0;
  let stepVerbCounted = false;
  for (const s of collected) {
    const isStepVerb =
      s.name === 'S1 multi-step-verb-de' || s.name === 'S2 multi-step-verb-en';
    if (isStepVerb) {
      if (stepVerbCounted) continue; // zweites Verb-Signal trägt 0 zum Score bei
      stepVerbCounted = true;
    }
    score += s.weight;
  }
  const decompose = score >= DECOMPOSE_THRESHOLD;

  // -----------------------------------------------------------------------
  // reason: menschenlesbare Top-Signal-Beschreibung
  //
  // Positive Signale zuerst, dann Vetos/Guards.
  // Maximal die 3 stärksten Signale werden genannt — mehr würde unlesbar.
  // -----------------------------------------------------------------------
  const positive = collected
    .filter((s) => s.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3);
  const negative = collected.filter((s) => s.weight < 0);

  let reason: string;
  if (decompose) {
    const parts = positive.map((s) => `${s.name} (matched: "${s.matched}")`);
    reason = `Decompose: score ${score} ≥ ${DECOMPOSE_THRESHOLD}. Top signals: ${parts.join('; ')}.`;
  } else if (negative.length > 0) {
    const vetoParts = negative.map((s) => `${s.name} (weight ${s.weight})`);
    reason = `No decompose: score ${score} < ${DECOMPOSE_THRESHOLD}. Veto/guard signals: ${vetoParts.join('; ')}.`;
  } else {
    reason = `No decompose: score ${score} < ${DECOMPOSE_THRESHOLD}. Insufficient complexity signals.`;
  }

  return { decompose, score, reason, signals: collected };
}
