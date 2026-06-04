/**
 * open-questions-lifecycle — Workstream 4b (2026-05-27).
 *
 * Pure (kein React, kein DOM) Lifecycle-Logik für die gepinnte Open-Questions-
 * Pill (`ChatOpenQuestionsPill` über dem Composer in `ChatShell`).
 *
 * OWNER-SYMPTOM (verbatim): „Im Chat erscheint eine Frage-Surface, dann laufen
 * Bash-Befehle + ‚server 200' — die Frage scrollt weg, obwohl der Run im
 * ask-but-proceed-Modus parallel weiterlief. Wenn parallel gearbeitet wird,
 * muss die Frage trotzdem unten gepinnt sein, beantwortbar."
 *
 * ROOT-CAUSE (verifiziert im Code, 2026-05-27):
 *  1. Die Pill-Population (`ChatShell` Effect ~:941) zog Fragen NUR aus der
 *     `## Offene Fragen`-Markdown-Section des JÜNGSTEN Assistant-Items via
 *     `splitOpenQuestionsSection`. Fragen die als `<surface:open-questions>`-
 *     Tag emittiert wurden (der eigentliche Run-Surface-Pfad) landeten NUR in
 *     der In-Stream-`ChatInlineOpenQuestions`-Karte und füllten die gepinnte
 *     Pill NIE → sie scrollten mit dem Stream weg.
 *  2. Der Effect hatte `if (isStreaming) return;` → während ein ask-but-proceed-
 *     Run weiterläuft (Bash, „server 200", neue Token), wurde GAR NICHT
 *     populiert; und sobald ein späteres Assistant-Item ohne Frage das jüngste
 *     wurde, fand der „latest-only"-Scan die Frage nicht mehr.
 *
 * FIX-STRATEGIE (additiv):
 *  - `collectOpenQuestionsFromHistory` scannt ALLE Assistant-Items (jüngstes
 *    zuerst) und akzeptiert BEIDE Quellen (Markdown-Section UND Surface-Tag).
 *  - Population läuft auch WÄHREND `isStreaming` (ask-but-proceed) — die Frage
 *    bleibt unten gepinnt, beantwortbar, während parallel gearbeitet wird.
 *  - Gecleart wird NUR wenn (i) das Q-Set beantwortet/abgesendet wurde
 *    (signatur-getrackt) oder (ii) der Workstream terminal ist
 *    (done/failed/cancelled). NICHT beim Step-Done / Wellen-Wechsel.
 */

import {
  splitOpenQuestionsSection,
  type PlanQuestion,
} from '../workstreams/parse-plan-questions';

// ---------------------------------------------------------------------------
// Surface-Extractor — `<surface:open-questions>{json}</surface:open-questions>`
// ---------------------------------------------------------------------------

const OQ_SURFACE_RE =
  /<surface:open-questions>([\s\S]*?)<\/surface:open-questions>/gi;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * 2026-05-28 — Open-Questions-Expand-Felder (additiv, Backwards-Compat).
 *
 * Owner-Befund: „dann lieber die Offenen Fragen mit der Möglichkeit auf mehr
 * Details ausklappen lassen, dass da zu jeder Frage ggf. Kontext, Pro/Kontra
 * usw. vorhanden ist". Wenn das System eine REICHERE Empfehlung zur selben
 * Frage emittiert (heute eine zweite Surface → Doppelung), tragen wir die
 * Anreicherung auf der bestehenden Pill-Karte nach statt eine zweite Karte
 * aufzumachen.
 *
 * Alle Felder sind optional. Alt-Payloads (nur `id` + `q`/`text` + `options`)
 * rendern unverändert wie bisher.
 */
export interface OpenQuestionEnrichment {
  /** Kurzer Kontext-Absatz — warum stellt sich die Frage gerade? */
  context?: string;
  /** Pro-Argumente einer (impliziten oder explizit empfohlenen) Antwort. */
  pros?: string[];
  /** Contra-Argumente. */
  cons?: string[];
  /** Konkrete Empfehlung (eine Zeile, idealerweise = einer der options[]). */
  recommendation?: string;
  /** Belege/Quellen (Markdown-Links oder Plain-Strings — Pill rendert plain). */
  evidence?: string[];
  /** ISO-Timestamp wann die Frage erstmals gestellt wurde (für Alters-Verfall). */
  askedAt?: string;
}

/**
 * Parst die Fragen aus EINEM `<surface:open-questions>`-JSON-Body. Spiegelt die
 * Feld-Toleranz von `SurfaceRenderer.renderOpenQuestions` (`q.q ?? q.text`,
 * `options[]` getrimmt + auf max 5 begrenzt) — dieselbe Quelle, dieselbe Shape.
 *
 * 2026-05-28 (additiv): zieht zusätzlich die optionalen Expand-Felder
 * (context/pros/cons/recommendation/evidence/askedAt) auf das PlanQuestion-Objekt.
 * Werden für alte Payloads weggelassen (undefined → backward-compat).
 */
function parseSurfaceQuestions(
  jsonBody: string,
): Array<PlanQuestion & OpenQuestionEnrichment> {
  let data: unknown;
  try {
    data = JSON.parse(jsonBody);
  } catch {
    return [];
  }
  if (!isObject(data)) return [];
  const rawQs = Array.isArray(data.questions) ? data.questions : null;
  if (!rawQs) return [];
  const out: Array<PlanQuestion & OpenQuestionEnrichment> = [];
  for (const q of rawQs) {
    if (!isObject(q)) continue;
    const id = asString(q.id) ?? '';
    const text = asString(q.q) ?? asString(q.text) ?? '';
    if (id.length === 0 || text.length === 0) continue;
    const options = Array.isArray(q.options)
      ? q.options
          .filter((o): o is string => typeof o === 'string')
          .map((o) => o.trim())
          .filter((o) => o.length > 0)
          .slice(0, 5)
      : undefined;

    // Additive Enrichment-Felder. Strings werden getrimmt; leere Strings/Arrays
    // landen NICHT im Output (undef = „nicht da" als Renderer-Signal).
    const enrichment: OpenQuestionEnrichment = {};
    const context = asString(q.context)?.trim();
    if (context && context.length > 0) enrichment.context = context;
    const pros = sanitizeStringArray(q.pros);
    if (pros && pros.length > 0) enrichment.pros = pros;
    const cons = sanitizeStringArray(q.cons);
    if (cons && cons.length > 0) enrichment.cons = cons;
    const recommendation = asString(q.recommendation)?.trim();
    if (recommendation && recommendation.length > 0) {
      enrichment.recommendation = recommendation;
    }
    const evidence = sanitizeStringArray(q.evidence);
    if (evidence && evidence.length > 0) enrichment.evidence = evidence;
    const askedAt = asString(q.askedAt)?.trim();
    if (askedAt && askedAt.length > 0) enrichment.askedAt = askedAt;

    out.push({
      id,
      text,
      ...(options && options.length > 0 ? { options } : {}),
      ...enrichment,
    });
  }
  return out;
}

/**
 * Hilfs-Reiniger für die Enrichment-String-Arrays (pros/cons/evidence).
 * - filtert auf strings,
 * - trimmt,
 * - wirft leere weg,
 * - kappt bei max 8 (UI-Schutz; ein riesiger Bullet-Block bricht die Pill auf
 *   schmalen iPhone-Viewports).
 */
function sanitizeStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const cleaned = v
    .filter((o): o is string => typeof o === 'string')
    .map((o) => o.trim())
    .filter((o) => o.length > 0)
    .slice(0, 8);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Erweiterter PlanQuestion-Typ inkl. der optionalen Expand-Felder
 * (2026-05-28). Backwards-Compat: jede `PlanQuestion` ist eine valide
 * `OpenQuestion` (die Enrichment-Felder sind alle optional).
 */
export type OpenQuestion = PlanQuestion & OpenQuestionEnrichment;

/**
 * Zieht ALLE offenen Fragen aus EINEM Assistant-Content — aus beiden Quellen:
 *   1. `<surface:open-questions>`-Tag(s)  (Run-/Sub-Agent-Surface-Pfad)
 *   2. `## Offene Fragen`-Markdown-Section (freier-Chat-Pfad)
 *
 * Reihenfolge: Surface-Tags zuerst (sie sind die strukturierte Quelle, und
 * NUR sie können die Enrichment-Felder context/pros/cons/recommendation/
 * evidence/askedAt tragen — Markdown-Bullets sind notwendig flach), dann
 * die Markdown-Section. De-Duplikation passiert über die ID im Aufrufer
 * (`collectOpenQuestionsFromHistory`).
 */
export function extractOpenQuestionsFromContent(
  content: string,
): OpenQuestion[] {
  if (typeof content !== 'string' || content.length === 0) return [];
  const out: OpenQuestion[] = [];

  OQ_SURFACE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OQ_SURFACE_RE.exec(content)) !== null) {
    out.push(...parseSurfaceQuestions(m[1] ?? ''));
  }

  const split = splitOpenQuestionsSection(content);
  if (split && split.questions.length > 0) {
    // Markdown-Fragen tragen keine Enrichment-Felder. PlanQuestion → OpenQuestion
    // ist strukturell konform (alle Enrichment-Felder optional).
    out.push(...split.questions);
  }

  return out;
}

/** Minimal-Shape eines History-Items, das dieser Modul liest (entkoppelt vom
 *  vollen ChatShell-`HistoryItem`, damit der Reducer pur testbar bleibt). */
export interface OpenQuestionsSourceItem {
  role: 'user' | 'assistant';
  content: unknown;
}

/**
 * Scannt die GESAMTE History (jüngstes Assistant-Item zuerst) und liefert die
 * offenen Fragen des jüngsten Assistant-Turns, der überhaupt welche enthält.
 *
 * WARUM jüngstes-zuerst statt „alle mergen": ein neues Frage-Set ersetzt das
 * alte (der Agent hat re-gefragt); zwei Sets gleichzeitig zu pinnen wäre
 * verwirrend. Innerhalb DESSELBEN Items werden beide Quellen gemerged + per ID
 * dedupliziert.
 *
 * 2026-05-28 — Anti-Doppelung (Owner-Befund):
 *   „Wenn der mir eine neue Frage stellt, dann wieder im alten Muster/Surface
 *    mit Empfehlung usw. ist ganz cool, aber dadurch etwas doppelt und ggf.
 *    redundant."
 * Statt zwei Karten pro ID zu erzeugen, MERGEN wir alle Emissions DESSELBEN
 * Items mit gleicher id: das erste Vorkommen behält text/options, jedes spätere
 * Vorkommen reichert NUR die Enrichment-Felder an (context/pros/cons/
 * recommendation/evidence/askedAt — last-write-wins pro Feld). So wird eine
 * spätere Empfehlungs-Emission („recommendation:…") zur SELBEN Frage auf die
 * EINE bestehende Karte hinzugefügt, statt eine zweite Surface zu erzeugen.
 */
export function collectOpenQuestionsFromHistory(
  history: ReadonlyArray<OpenQuestionsSourceItem>,
): OpenQuestion[] {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const it = history[i];
    if (!it || it.role !== 'assistant' || typeof it.content !== 'string') {
      continue;
    }
    const found = extractOpenQuestionsFromContent(it.content);
    if (found.length === 0) continue;
    return mergeQuestionEnrichmentsById(found);
  }
  return [];
}

/**
 * Merget Mehrfach-Emissions DERSELBEN Frage-ID in EINE OpenQuestion-Karte.
 *
 * Reihenfolge-Garantien:
 *  - Erstes Vorkommen einer ID bestimmt `text` und `options` (Surface vor
 *    Markdown — siehe `extractOpenQuestionsFromContent`).
 *  - Jede spätere Emission MIT denselben enrichment-Feldern überschreibt das
 *    bisherige Feld (last-write-wins) — eine spätere, reichere Empfehlung
 *    gewinnt über die anfangs leere Pill-Karte.
 *  - Die Output-Reihenfolge entspricht dem ERSTEN Vorkommen jeder ID.
 *
 * Reine Funktion — kein React, kein DOM. Idempotent.
 */
export function mergeQuestionEnrichmentsById(
  questions: ReadonlyArray<OpenQuestion>,
): OpenQuestion[] {
  const order: string[] = [];
  const byId = new Map<string, OpenQuestion>();
  for (const q of questions) {
    const existing = byId.get(q.id);
    if (!existing) {
      byId.set(q.id, { ...q });
      order.push(q.id);
      continue;
    }
    // Enrichment-Felder: last-write-wins, aber nur wenn das neue Vorkommen das
    // Feld tatsächlich SETZT (sonst würde eine spätere leere Emission den
    // existing-Wert nullen).
    const merged: OpenQuestion = { ...existing };
    if (q.context !== undefined) merged.context = q.context;
    if (q.pros !== undefined) merged.pros = q.pros;
    if (q.cons !== undefined) merged.cons = q.cons;
    if (q.recommendation !== undefined) merged.recommendation = q.recommendation;
    if (q.evidence !== undefined) merged.evidence = q.evidence;
    if (q.askedAt !== undefined) merged.askedAt = q.askedAt;
    // text/options: erstes Vorkommen gewinnt → NICHT überschreiben (sonst
    // würde ein „nur-Enrichment"-Emit mit leerem options[] die Buttons killen).
    byId.set(q.id, merged);
  }
  return order.map((id) => byId.get(id)!);
}

// ---------------------------------------------------------------------------
// Pure Lifecycle-Reducer — für Test + als Referenz-Semantik
// ---------------------------------------------------------------------------

/** Der gepinnte Pill-State (minimal — nur was der Lifecycle bestimmt). */
export interface OpenQuestionsState {
  /** Aktuell gepinnte offene Fragen (leer = Pill versteckt).
   *  2026-05-28: Type aufgeweicht auf `OpenQuestion` (PlanQuestion +
   *  optionale Enrichment-Felder). Strukturell rückwärtskompatibel — ein
   *  PlanQuestion ohne Extras ist eine valide OpenQuestion. */
  questions: OpenQuestion[];
  /** Signatur des zuletzt geladenen Sets (Frage-IDs joined) — Re-Load-Schutz. */
  signature: string | null;
}

export const EMPTY_OPEN_QUESTIONS_STATE: OpenQuestionsState = {
  questions: [],
  signature: null,
};

/** Signatur eines Frage-Sets = Frage-IDs in Reihenfolge, pipe-getrennt. */
export function questionsSignature(
  questions: ReadonlyArray<{ id: string }>,
): string {
  return questions.map((q) => q.id).join('|');
}

/**
 * Lifecycle-Events, die den gepinnten Pill-State verändern dürfen.
 *
 *  - `questions-detected`: der History-Scan hat ein (evtl. neues) Frage-Set
 *    gefunden. Population — auch während ein ask-but-proceed-Run läuft.
 *  - `step-done`: ein einzelner Run-Schritt / eine Welle ist fertig. Der Pill
 *    bleibt UNVERÄNDERT (DAS war der Bug — vorher wurde hier gecleart).
 *  - `answered`: das aktive Frage-Set wurde beantwortet/abgesendet → clearen.
 *  - `workstream-terminal`: der ganze Run ist done/failed/cancelled → clearen.
 *  - `hard-reset`: Workspace-Switch / /clear → alles zurücksetzen inkl. Signatur.
 *  - `enriched` (2026-05-28): eine SPÄTERE Emission zur gleichen Frage-ID
 *    bringt Enrichment-Felder (context/pros/cons/recommendation/evidence) →
 *    Pill-Karte wird IN PLACE angereichert, keine zweite Surface emittieren.
 *  - `dismissed` (2026-05-28): User hat „×" / „beantwortet" für EINE Frage
 *    geklickt → diese eine Frage entfernen, Signatur an Rest anpassen.
 *  - `stale-resolved` (2026-05-28): Batch-Resolve aus
 *    `detectResolvedAndStaleQuestions` (Lexical-Match + Alters-Verfall) → die
 *    aufgelisteten IDs aus der Pill nehmen.
 */
export type OpenQuestionsEvent =
  | { type: 'questions-detected'; questions: OpenQuestion[] }
  | { type: 'step-done' }
  | { type: 'answered' }
  | { type: 'workstream-terminal' }
  | { type: 'hard-reset' }
  | { type: 'enriched'; questions: OpenQuestion[] }
  | { type: 'dismissed'; questionId: string }
  | { type: 'stale-resolved'; questionIds: string[] };

/**
 * Pure Reducer. Bestimmt den nächsten gepinnten Open-Questions-State aus dem
 * vorigen State + einem Lifecycle-Event.
 *
 * Invarianten (Test-Gate Workstream 4b):
 *  - run-emittierte Frage (`questions-detected`) → im State.
 *  - `step-done` → State BLEIBT (NICHT gecleart) — Kern des Fixes.
 *  - `answered` → Fragen raus (Signatur bleibt: derselbe Turn poppt nicht
 *    sofort wieder auf, bis ein NEUES Set mit anderer Signatur kommt).
 *  - `workstream-terminal` → geclearet (Run vorbei, Frage obsolet).
 */
export function nextOpenQuestionsState(
  prev: OpenQuestionsState,
  event: OpenQuestionsEvent,
): OpenQuestionsState {
  switch (event.type) {
    case 'questions-detected': {
      if (event.questions.length === 0) return prev;
      const signature = questionsSignature(event.questions);
      // Gleiche Signatur → kein Re-Load (würde gegebene Antworten resetten).
      if (signature === prev.signature) return prev;
      return { questions: event.questions, signature };
    }
    case 'step-done':
      // BEWUSST no-op: ein Step-/Wellen-Ende DARF die gepinnte Frage NICHT
      // clearen. (Vorher implizit via Run-Ende-Clear → Owner-Symptom.)
      return prev;
    case 'answered':
      if (prev.questions.length === 0) return prev;
      // Fragen weg, Signatur BLEIBT — schützt vor sofortigem Re-Pop desselben
      // Turns. Ein neues Set (andere Signatur) lädt normal nach.
      return { questions: [], signature: prev.signature };
    case 'workstream-terminal':
      if (prev.questions.length === 0 && prev.signature === null) return prev;
      // Run vorbei → Frage obsolet. Signatur AUCH löschen, damit ein neuer Run
      // mit (zufällig) gleicher Signatur wieder pinnen kann.
      return EMPTY_OPEN_QUESTIONS_STATE;
    case 'hard-reset':
      return EMPTY_OPEN_QUESTIONS_STATE;
    case 'enriched': {
      if (prev.questions.length === 0) return prev;
      const merged = mergeQuestionEnrichmentsById([
        ...prev.questions,
        ...event.questions,
      ]);
      // Pure-value-Vergleich: wenn das Merge GLEICHE Objekte produziert (keine
      // Felder geändert), unverändert zurückgeben — verhindert sinnlose
      // Re-Renders der Pill-Komponente bei wiederholtem Re-Emit.
      if (sameEnrichmentValues(prev.questions, merged)) return prev;
      return { questions: merged, signature: prev.signature };
    }
    case 'dismissed': {
      if (prev.questions.length === 0) return prev;
      const remaining = prev.questions.filter((q) => q.id !== event.questionId);
      if (remaining.length === prev.questions.length) return prev; // id nicht da
      if (remaining.length === 0) {
        // Letzte Frage weg → Pill weg, Signatur BLEIBT (kein Re-Pop desselben
        // Sets bis ein neues mit anderer Signatur kommt).
        return { questions: [], signature: prev.signature };
      }
      // Signatur an die verkürzte Liste anpassen, sonst guardet
      // `questions-detected` mit der ursprünglichen Signatur das Re-Load.
      return { questions: remaining, signature: questionsSignature(remaining) };
    }
    case 'stale-resolved': {
      if (prev.questions.length === 0) return prev;
      const ids = new Set(event.questionIds);
      if (ids.size === 0) return prev;
      const remaining = prev.questions.filter((q) => !ids.has(q.id));
      if (remaining.length === prev.questions.length) return prev;
      if (remaining.length === 0) {
        return { questions: [], signature: prev.signature };
      }
      return { questions: remaining, signature: questionsSignature(remaining) };
    }
    default: {
      // Exhaustiveness-Guard.
      const _never: never = event;
      return _never;
    }
  }
}

/** Vergleicht enrichment-relevante Felder ZWEIER same-id-sortierter Listen. */
function sameEnrichmentValues(
  a: ReadonlyArray<OpenQuestion>,
  b: ReadonlyArray<OpenQuestion>,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id) return false;
    if (x.context !== y.context) return false;
    if (x.recommendation !== y.recommendation) return false;
    if (x.askedAt !== y.askedAt) return false;
    if (!stringArrayEqual(x.pros, y.pros)) return false;
    if (!stringArrayEqual(x.cons, y.cons)) return false;
    if (!stringArrayEqual(x.evidence, y.evidence)) return false;
  }
  return true;
}

function stringArrayEqual(
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 2026-05-28 — Stale-Out + Auto-Resolve (deterministisch, N6/N7: lexical, kein LLM)
// ---------------------------------------------------------------------------
// OWNER-BEFUND (verbatim): „Im PA Chat ist immer noch Offene Fragen, obwohl die
// schon unfassbar alt sind und schon lange beantwortet." Konkretes Beispiel:
// „Erst Copy oder erst Design, obwohl schon längst gebaut wurde" steht noch in
// der Pill.
//
// Wir erkennen zwei deterministische Trigger:
//
//   (a) LEXICAL-RESOLVE: nach der Frage kommt eine USER-Message, deren
//       getrimmter Lower-Case-Inhalt mindestens N Content-Tokens der Frage
//       enthält. „Content-Tokens" = Tokens ≥ 3 Zeichen abzüglich der
//       eingebauten Stopwort-Liste (de+en, klein). Schwellwert: ≥1 falls die
//       Frage selbst nur 1 Content-Token hat, sonst ≥2 — beides ein bewusst
//       konservatives Minimum (lieber stehen lassen als falsch-positiv löschen).
//
//   (b) ALTERS-VERFALL: askedAt liegt vor dem konfigurierbaren Cutoff
//       (Default 24h ODER 20 user/assistant-Turns nach der Frage). Beides
//       muss kumulativ wahr sein, NICHT nur eines — Sicherheits-Marge gegen
//       falsch-positiven Wegfall direkt nach dem Emit.
//
// Nicht-Ziel: das Wissen, ob die Frage „tatsächlich beantwortet" wurde. Eine
// echte semantische Bewertung erfordert LLM-Lookup → eigener Slice, der den
// LIVE-Mode-Konsent + Cost-Budget bräuchte. Hier: deterministisch + idempotent.

const STOPWORDS = new Set<string>([
  // de
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'eines', 'einer',
  'einem', 'einen', 'und', 'oder', 'aber', 'als', 'auch', 'für', 'mit', 'ohne',
  'von', 'vom', 'zum', 'zur', 'auf', 'an', 'am', 'im', 'in', 'ist', 'sind',
  'war', 'waren', 'wird', 'werden', 'wurde', 'wurden', 'sein', 'haben', 'hat',
  'hatte', 'hatten', 'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'dass',
  'nicht', 'kein', 'keine', 'sich', 'man', 'wenn', 'dann', 'so', 'auch',
  'noch', 'schon', 'mehr', 'sehr', 'nur', 'wie', 'was', 'wer', 'wo', 'wann',
  'warum', 'welche', 'welcher', 'welches', 'welchen', 'welchem',
  // en
  'the', 'a', 'an', 'and', 'or', 'but', 'as', 'for', 'with', 'without', 'of',
  'to', 'on', 'in', 'at', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'not', 'no', 'i', 'you', 'he',
  'she', 'it', 'we', 'they', 'that', 'this', 'those', 'these', 'what', 'who',
  'where', 'when', 'why', 'how', 'which', 'should', 'would', 'could',
]);

/** Tokenisiert einen Text in Content-Tokens (≥3 Zeichen, kein Stop-Wort). */
function contentTokens(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  // Strip surface tags + markdown-bullets/headings damit der Match nicht von
  // strukturellen Resten dominiert wird.
  const stripped = text
    .replace(/<surface:[a-z][a-z0-9_-]*>[\s\S]*?<\/surface:[a-z][a-z0-9_-]*>/gi, ' ')
    .replace(/^[#>*\-\s]+/gm, ' ')
    .toLowerCase();
  const tokens = stripped.match(/[a-zäöüß0-9]+/g) ?? [];
  const out: string[] = [];
  for (const t of tokens) {
    if (t.length < 3) continue;
    if (STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

/** Berechnet wie viele Content-Tokens der Frage in `replyText` vorkommen. */
function lexicalOverlap(questionText: string, replyText: string): {
  matched: number;
  needed: number;
} {
  const qTokens = new Set(contentTokens(questionText));
  if (qTokens.size === 0) return { matched: 0, needed: 1 };
  // Bei sehr kurzen Fragen (1 Content-Token) reicht 1 Match — sonst ≥2.
  const needed = qTokens.size === 1 ? 1 : 2;
  const rTokens = new Set(contentTokens(replyText));
  let matched = 0;
  for (const t of qTokens) {
    if (rTokens.has(t)) matched += 1;
    if (matched >= needed) break;
  }
  return { matched, needed };
}

/**
 * Optionen für `detectResolvedAndStaleQuestions` — alles defaultet auf
 * konservative Werte, die in der Live-Pill greifen sollten.
 */
export interface StaleResolveOptions {
  /** „Jetzt" als ms-Timestamp (für Tests injizierbar). Default Date.now(). */
  nowMs?: number;
  /** Max-Alter einer Frage in ms (Alters-Verfall, default 24h). */
  maxAgeMs?: number;
  /** Max-Turns nach der Frage (user+assistant zusammen), default 20. */
  maxTurnsAfter?: number;
}

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_MAX_TURNS_AFTER = 20;

/**
 * Findet die IDs der Fragen, die NACH dem Stand der History als „resolved/stale"
 * gelten und aus der Pill verschwinden sollten.
 *
 * Inputs:
 *  - `questions`: aktuell in der Pill gepinntes Frage-Set.
 *  - `history`: vollständige Chat-History (für lexical-Match + Turn-Count).
 *  - `options`: Cutoffs (für Tests injizierbar).
 *
 * Output: Liste der zu entfernenden Frage-IDs (kann leer sein). Deterministisch,
 * idempotent, side-effect-frei. Eine zurückgelieferte ID heißt: „lexical
 * resolved" ODER „kumulativ alt UND viele Turns vergangen". Niemals beides
 * implizit voneinander.
 */
export function detectResolvedAndStaleQuestions(
  questions: ReadonlyArray<OpenQuestion>,
  history: ReadonlyArray<OpenQuestionsSourceItem>,
  options: StaleResolveOptions = {},
): string[] {
  if (questions.length === 0) return [];
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxTurnsAfter = options.maxTurnsAfter ?? DEFAULT_MAX_TURNS_AFTER;

  const toRemove: string[] = [];
  for (const q of questions) {
    // ---- (a) Lexical-Resolve: ANY user-Message NACH der Frage trifft die
    // Frage-Tokens. „Nach der Frage" = Index nach dem JÜNGSTEN Assistant-Item,
    // das diese Frage-ID emittiert hat. Wenn das Item nicht gefunden wird, gilt
    // die GANZE History als „nach".
    const askedAtIdx = findAskedAtIndex(history, q.id);
    const afterIdx = askedAtIdx >= 0 ? askedAtIdx + 1 : 0;
    let lexResolved = false;
    for (let i = afterIdx; i < history.length; i += 1) {
      const it = history[i];
      if (!it || it.role !== 'user') continue;
      if (typeof it.content !== 'string') continue;
      const { matched, needed } = lexicalOverlap(q.text, it.content);
      if (matched >= needed) {
        lexResolved = true;
        break;
      }
    }
    if (lexResolved) {
      toRemove.push(q.id);
      continue;
    }

    // ---- (b) Alters-Verfall: askedAt vorhanden UND > maxAge alt UND ≥maxTurns
    // user+assistant-Items nach der Frage. Kumulativ — beides nötig.
    if (typeof q.askedAt === 'string' && q.askedAt.length > 0) {
      const askedMs = Date.parse(q.askedAt);
      if (!Number.isNaN(askedMs)) {
        const ageOk = nowMs - askedMs > maxAgeMs;
        const turnsAfter = askedAtIdx >= 0 ? history.length - 1 - askedAtIdx : 0;
        const turnsOk = turnsAfter >= maxTurnsAfter;
        if (ageOk && turnsOk) {
          toRemove.push(q.id);
          continue;
        }
      }
    }
  }
  return toRemove;
}

/**
 * Findet den History-Index des JÜNGSTEN Assistant-Items, das die Frage `qId`
 * emittiert hat. -1 wenn nicht gefunden.
 */
function findAskedAtIndex(
  history: ReadonlyArray<OpenQuestionsSourceItem>,
  qId: string,
): number {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const it = history[i];
    if (!it || it.role !== 'assistant' || typeof it.content !== 'string') continue;
    const found = extractOpenQuestionsFromContent(it.content);
    if (found.some((f) => f.id === qId)) return i;
  }
  return -1;
}

/**
 * Maintenance-Helper (NICHT auto-aufgerufen — als Lib-Funktion verfügbar).
 *
 * Greift `raw` (ein Surface-Body-JSON) ab, scannt darin alle Open-Questions-
 * Surfaces, prüft sie gegen `history`/`now` mit `detectResolvedAndStaleQuestions`
 * und liefert die IDs zurück, die ein nachgeschalteter Worker als „resolved"
 * markieren würde. Tut SELBER nichts an der DB — der Aufrufer entscheidet, ob er
 * z.B. einen Belief setzt oder eine workstream_decisions-Row schreibt.
 *
 * Owner-Spec Punkt E: „falls heute alte Pill-Items irgendwo persistiert sind …
 * EINE additive Maintenance-Funktion, NICHT auto-aufgerufen — als Lib-Helper,
 * dokumentiert."
 */
export function markStaleOpenQuestionsResolved(
  raw: string,
  history: ReadonlyArray<OpenQuestionsSourceItem>,
  options: StaleResolveOptions = {},
): string[] {
  const questions = extractOpenQuestionsFromContent(raw);
  if (questions.length === 0) return [];
  const merged = mergeQuestionEnrichmentsById(questions);
  return detectResolvedAndStaleQuestions(merged, history, options);
}
