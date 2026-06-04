/**
 * lib/discovery-mode/detect.ts
 * ----------------------------------------------------------------------------
 * 2026-05-29 — Discovery-Mode-Detection (10 Modi) — Opus 4.8.
 *
 * Quelle: Innovation/Expertise-Compiler Master-Brief §20 ("Systemverhalten:
 * Intent und Mode Detection") + §6 ("Beobachteter LLM-Fehler") + §20.3
 * ("Continuity Check"). Verbatim die Kernregel §20.1:
 *
 *   > „Nicht jede Nachricht ist ein Planungsauftrag."
 *
 * Das §20.2-Modell verlangt ZEHN interne Modi:
 *   brainstorm · clarify · extract_expertise · role_reverse_engineer ·
 *   simulate · innovate · plan_graph · build · review · reconcile
 *
 * Verhältnis zum Alt-Modell (N4 — recovery before reinvention):
 *   - `lib/workstreams/intent-classifier.ts` klassifiziert auf der Achse
 *     „WAS-FÜR-EINE-ARBEIT" in {idea|implementation|bug-fix|question|
 *     discussion}. Das ist ein ÄLTERES, gröberes Modell (5 Intents).
 *   - `lib/chat/intent-flow-classifier.ts` klassifiziert auf der Achse
 *     „IST-ES-EIN-FLOW" (flow|unknown) — ein Binär-Router.
 *   - DIESES Modul ist eine DRITTE, feinere Achse („IN-WELCHEM-DISCOVERY-
 *     MODUS-IST-DER-NUTZER"). Es ERSETZT KEINES der beiden — es ist additiv
 *     und liefert dem Haupt-Agenten den fehlenden §20-Modus.
 *
 * Constraints (lazing/lazyOS N-Konstanten):
 *   - N6: deterministisch vor symbolisch. Reine Regex+Token-Heuristik. Kein
 *     LLM, kein Embedding, kein I/O. Synchron, pure, direkt unit-testbar.
 *   - N7: lexical vor vector. DE+EN-Keyword-Familien mit Gewichtung.
 *   - N1: detail preservation. Wir tasten den User-Text NICHT an; KEIN
 *     `.slice`/`.substring`. Wir lesen nur, klassifizieren, begründen.
 *   - §20.1 Fail-soft: bei Unklarheit Default `clarify` — NICHT `build`. Im
 *     Zweifel klären, nicht bauen. Das ist der zentrale Schutz gegen den in
 *     §6 beschriebenen „springt zu früh zur Umsetzung"-Fehler.
 *
 * Sprachen: Deutsch (primär) + Englisch. Politeness-tolerant analog zum
 * Flow-Classifier (führende Höflichkeits-/Anrede-Präfixe werden gestrippt).
 */

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

/**
 * Die 10 Discovery-Modi aus §20.2 — Reihenfolge entspricht dem typischen
 * Discovery-Fluss (offen → konkret → ausführend → prüfend).
 */
export type DiscoveryMode =
  | 'brainstorm' // offenes Ideenfeld, kein Auftrag
  | 'clarify' // Begriffe/Kontext/Fragen klären (= Fail-soft-Default)
  | 'extract_expertise' // Expertenwissen / Regeln / SOPs ablegen
  | 'role_reverse_engineer' // aus Verhalten/Output auf Rolle schließen
  | 'simulate' // Szenario durchspielen ("was würde X tun")
  | 'innovate' // gezielte Neuerung / Reframe / Differenzierung
  | 'plan_graph' // Planung: Schritte/Abhängigkeiten/Graph
  | 'build' // Umsetzung / Ausführung
  | 'review' // Prüfung / Kritik / Qualität eines Outputs
  | 'reconcile'; // Abgleich Ergebnis ↔ Vision/Regeln/Erwartung

/** Alle Modi als Laufzeit-Liste (Tests + UI). */
export const DISCOVERY_MODES: readonly DiscoveryMode[] = [
  'brainstorm',
  'clarify',
  'extract_expertise',
  'role_reverse_engineer',
  'simulate',
  'innovate',
  'plan_graph',
  'build',
  'review',
  'reconcile',
] as const;

/** Der Fail-soft-Default nach §20.1 — im Zweifel klären, nie bauen. */
export const DEFAULT_DISCOVERY_MODE: DiscoveryMode = 'clarify';

export interface DiscoverySignal {
  /** In welchen Modus dieses Signal zählt. */
  mode: DiscoveryMode;
  /** Menschenlesbares Label des getroffenen Musters (Debug + N8-Audit). */
  label: string;
  /** Score-Beitrag dieses Treffers. */
  weight: number;
}

export interface DiscoveryModeResult {
  /** Erkannter Modus. Bei Unklarheit `clarify` (§20.1 Fail-soft). */
  mode: DiscoveryMode;
  /** 0..1 heuristisch. <0.35 = unsicher → mode ist auf `clarify` geclamped. */
  confidence: number;
  /** Welche Muster gefeuert haben — verbatim, für Erklärbarkeit (N8). */
  signals: DiscoverySignal[];
}

export interface DiscoveryModeOptions {
  /**
   * Minimale Wortzahl, unter der ALLES als `clarify` mit confidence 0 gilt.
   * Default 3 — „bau das" (2 Wörter) ist zu kurz/mehrdeutig für einen
   * sicheren Modus; §20.1 verlangt im Zweifel `clarify`.
   */
  minWords?: number;
  /**
   * Schwelle, unter der ein erkannter Modus auf `clarify` zurückfällt.
   * §20.1: Default 0.35 — ein einzelner schwacher Treffer reicht NICHT, um
   * z. B. nach `build` zu springen.
   */
  confidenceFloor?: number;
}

// ---------------------------------------------------------------------------
// Pattern-Bibliothek (DE + EN), pro Modus eine Familie mit Gewicht
// ---------------------------------------------------------------------------
//
// Designprinzip: stärkere Disambiguatoren bekommen höheres Gewicht. „bau"
// (build) ist absichtlich NICHT übergewichtet, weil §20.1 verlangt, dass ein
// einzelnes Build-Verb in einem ansonsten erkundenden Satz NICHT direkt zu
// `build` führt. Brainstorm-/Clarify-Marker gewinnen bei Gleichstand.

interface ModeFamily {
  mode: DiscoveryMode;
  weight: number;
  patterns: ReadonlyArray<{ label: string; rx: RegExp }>;
}

const MODE_FAMILIES: readonly ModeFamily[] = [
  {
    mode: 'brainstorm',
    weight: 1.3,
    patterns: [
      { label: 'brainstorm', rx: /\bbrainstorm(ing|en)?\b/i },
      { label: 'ideen-sammeln', rx: /\bideen?\s+(sammeln|finden|spinnen|werfen)\b/i },
      { label: 'spinnen-wir', rx: /\bspinn(en|t)?\s+wir\b/i },
      { label: 'lass-uns-denken', rx: /\blass(t)?\s+uns\s+(mal\s+)?(denken|spinnen|überlegen|ideen)\b/i },
      { label: 'was-wäre-wenn', rx: /\bwas\s+wäre,?\s+wenn\b/i },
      { label: 'what-if', rx: /\bwhat\s+if\b/i },
      { label: 'mögliche-ideen', rx: /\bwelche\s+(ideen|möglichkeiten|optionen)\b/i },
      { label: 'denk-laut', rx: /\b(denk|denken)\s+wir\s+(mal\s+)?laut\b/i },
      { label: 'freies-denken', rx: /\b(blue[- ]sky|moonshot|brainstorm|frei\s+denken)\b/i },
      { label: 'just-thinking', rx: /\b(just\s+(thinking|brainstorming)|throw\s+ideas)\b/i },
      { label: 'mal-überlegen', rx: /\blass(t)?\s+uns\s+mal\s+überlegen\b/i },
    ],
  },
  {
    mode: 'clarify',
    weight: 1.1,
    patterns: [
      { label: 'was-bedeutet', rx: /\bwas\s+(bedeutet|heißt|meinst\s+du\s+mit)\b/i },
      { label: 'begriff-klären', rx: /\b(begriff|term|definition)\s+(klären|definieren)\b/i },
      { label: 'was-ist', rx: /\bwas\s+ist\b/i },
      { label: 'kannst-du-erklären', rx: /\bkannst\s+du\s+(mir\s+)?erklären\b/i },
      { label: 'verstehe-nicht', rx: /\b(verstehe|kapier(e)?)\s+(ich\s+)?nicht\b/i },
      { label: 'unklar', rx: /\b(unklar|nicht\s+klar|verwirrend)\b/i },
      { label: 'what-does-mean', rx: /\bwhat\s+(does|do)\b.{0,30}\bmean\b/i },
      { label: 'clarify-en', rx: /\b(clarify|what\s+do\s+you\s+mean|explain\s+what)\b/i },
      { label: 'erkläre-mir', rx: /\berkläre?\s+mir\b/i },
      { label: 'frage-wie', rx: /\bwie\s+(genau\s+)?(meinst|definierst)\b/i },
    ],
  },
  {
    mode: 'extract_expertise',
    weight: 1.4,
    patterns: [
      { label: 'so-mache-ich', rx: /\b(so|folgendermaßen)\s+(mache|machen|läuft)\b.{0,30}\b(ich|wir|das)\b/i },
      { label: 'unsere-regel', rx: /\b(unsere?|meine?)\s+(regel|prinzip|prozess|sop|standard|vorgehen|workflow)\b/i },
      { label: 'erfahrung', rx: /\b(aus\s+erfahrung|erfahrungsgemäß|in\s+der\s+praxis)\b/i },
      { label: 'best-practice', rx: /\b(best\s+practice|faustregel|daumenregel|rule\s+of\s+thumb)\b/i },
      { label: 'expertenwissen', rx: /\b(experten?wissen|fachwissen|domänenwissen|know[- ]?how)\b/i },
      { label: 'wir-machen-immer', rx: /\b(wir|ich)\s+(machen?|tun|tue)\s+(immer|normalerweise|grundsätzlich)\b/i },
      { label: 'wichtig-ist', rx: /\bwichtig\s+(ist|dabei\s+ist)\s+(dass|immer)\b/i },
      { label: 'man-muss', rx: /\bman\s+muss\s+(immer|grundsätzlich|darauf\s+achten)\b/i },
      { label: 'document-how', rx: /\b(here'?s\s+how\s+(we|i)\s+do|our\s+(process|sop|playbook|standard))\b/i },
      { label: 'sop-festhalten', rx: /\b(als\s+(sop|prozess|standard)\s+(speichern|festhalten)|capture\s+(this|the)\s+(process|knowledge))\b/i },
    ],
  },
  {
    mode: 'role_reverse_engineer',
    weight: 1.4,
    patterns: [
      { label: 'welche-rolle', rx: /\bwelche\s+rolle\b/i },
      { label: 'wer-macht-das', rx: /\bwer\s+(macht|würde|sollte)\s+(das|sowas|so\s+etwas)\b/i },
      { label: 'rolle-ableiten', rx: /\b(rolle|persona)\s+(ableiten|rekonstruieren|erkennen|bestimmen)\b/i },
      { label: 'was-für-ein-experte', rx: /\bwas\s+für\s+ein(e)?\s+(experte|rolle|profil|persona)\b/i },
      { label: 'reverse-engineer-role', rx: /\b(reverse[- ]?engineer|rekonstruier)\b.{0,30}\b(rolle|role|persona|skill)\b/i },
      { label: 'which-role', rx: /\bwhich\s+(role|persona|expert)\b/i },
      { label: 'who-would', rx: /\bwho\s+would\s+(do|handle|own)\b/i },
      { label: 'welche-skills', rx: /\bwelche\s+(skills|fähigkeiten|kompetenzen)\s+braucht\b/i },
      { label: 'profil-hinter', rx: /\b(profil|rolle|persona)\s+hinter\b/i },
    ],
  },
  {
    mode: 'simulate',
    weight: 1.3,
    patterns: [
      { label: 'stell-dir-vor', rx: /\bstell(e)?\s+dir\s+vor\b/i },
      { label: 'angenommen', rx: /\bangenommen,?\b/i },
      { label: 'durchspielen', rx: /\b(szenario|fall|case)\s+(durchspielen|simulieren|durchgehen)\b/i },
      { label: 'was-würde-tun', rx: /\bwas\s+würde\s+\w+\s+(tun|machen|entscheiden)\b/i },
      { label: 'simuliere', rx: /\bsimulier(e|en)?\b/i },
      { label: 'spiel-durch', rx: /\bspiel(e|en)?\s+(mal\s+)?durch\b/i },
      { label: 'imagine', rx: /\bimagine\b/i },
      { label: 'suppose', rx: /\b(suppose|let'?s\s+say|what\s+would\s+happen\s+if)\b/i },
      { label: 'rollenspiel', rx: /\b(rollenspiel|role[- ]?play|durchspielen)\b/i },
      { label: 'wenn-fall-x', rx: /\bwenn\s+(fall|szenario)\s+\w+\s+eintritt\b/i },
    ],
  },
  {
    mode: 'innovate',
    weight: 1.3,
    patterns: [
      { label: 'innovieren', rx: /\b(innovier(e|en)?|innovation|innovativ)\b/i },
      { label: 'neu-erfinden', rx: /\b(neu\s+(erfinden|denken)|reframe|umdenken)\b/i },
      { label: 'differenzieren', rx: /\b(differenzier(en|ung)|abheben|einzigartig\s+machen|usp)\b/i },
      { label: 'disrupt', rx: /\b(disrupt(ion|iv|en)?|game[- ]?changer|durchbruch)\b/i },
      { label: 'besser-als', rx: /\b(besser\s+als|10x|grundlegend\s+anders)\b/i },
      { label: 'innovate-en', rx: /\b(innovate|rethink|reimagine|breakthrough)\b/i },
      { label: 'neuartig', rx: /\b(neuartig|bahnbrechend|noch\s+nie\s+dagewesen)\b/i },
      { label: 'moat', rx: /\b(moat|unfair\s+advantage|wettbewerbsvorteil)\b/i },
    ],
  },
  {
    mode: 'plan_graph',
    weight: 1.2,
    patterns: [
      { label: 'plane', rx: /\b(plane?|planen|planung|verplan)\b/i },
      { label: 'plan-machen', rx: /\b(erstelle|mach(e)?)\s+(mir\s+)?(einen|ein)\s+plan\b/i },
      { label: 'schritte', rx: /\b(schritte|steps|teilschritte|arbeitsschritte)\b/i },
      { label: 'abhängigkeiten', rx: /\b(abhängigkeit(en)?|dependencies|reihenfolge)\b/i },
      { label: 'roadmap', rx: /\b(roadmap|fahrplan|meilenstein(e)?|milestone(s)?)\b/i },
      { label: 'wie-gehen-wir-vor', rx: /\bwie\s+gehen\s+wir\s+(am\s+besten\s+)?vor\b/i },
      { label: 'zerlege', rx: /\b(zerlege|aufteilen|breakdown|break\s+down|gliedere)\b/i },
      { label: 'plan-en', rx: /\b(make|create|draft)\s+a\s+plan\b/i },
      { label: 'vorgehensweise', rx: /\b(vorgehensweise|vorgehen|game\s+plan)\b/i },
    ],
  },
  {
    mode: 'build',
    weight: 1.0,
    patterns: [
      { label: 'implementier', rx: /\bimplementier(e|en|t)?\b/i },
      { label: 'baue', rx: /\bbau(e|en|st|t)?\b/i },
      { label: 'build-imperativ', rx: /\bbuild\b\s+(mir|den|die|das|me|the|it|a|an)\b/i },
      { label: 'umsetzen', rx: /\bumsetz(en|ung|t|e)?\b/i },
      { label: 'setze-um', rx: /\bsetze?\b.{0,40}\bum\b/i },
      { label: 'deploy', rx: /\bdeploy(e|t|en|ed|ing)?\b/i },
      { label: 'schreib-code', rx: /\bschreib(e|en|t)?\b.{0,30}\bcode\b/i },
      { label: 'generiere', rx: /\bgenerier(e|en|t)?\b/i },
      { label: 'erstelle-die', rx: /\berstell(e|en)?\s+(die|den|das|eine|einen|ein)\b/i },
      { label: 'create-en', rx: /\b(create|generate|implement|develop)\b/i },
      { label: 'leg-los', rx: /\b(leg\s+los|los\s+gehts|lass\s+(es\s+)?laufen|fang\s+an)\b/i },
    ],
  },
  {
    mode: 'review',
    weight: 1.2,
    patterns: [
      { label: 'review', rx: /\b(review(e|en|ed)?|prüf(e|en|ung)?|begutachte)\b/i },
      { label: 'kritik', rx: /\b(kritisier(e|en)?|kritik|feedback|roast)\b/i },
      { label: 'was-falsch', rx: /\bwas\s+(ist\s+)?(falsch|schlecht|verbesserungswürdig)\b/i },
      { label: 'check-quality', rx: /\b(qualität\s+(prüfen|checken)|check\s+the\s+quality)\b/i },
      { label: 'schau-drüber', rx: /\bschau(e)?\s+(mal\s+)?(drüber|über)\b/i },
      { label: 'bewerte', rx: /\b(bewerte?|beurteile|evaluate|assess)\b/i },
      { label: 'find-issues', rx: /\b(find(e)?\s+(fehler|probleme|issues|bugs)|spot\s+(problems|issues))\b/i },
      { label: 'review-en', rx: /\b(review|critique|audit\s+(this|the)|give\s+feedback)\b/i },
      { label: 'ist-das-gut', rx: /\bist\s+das\s+(gut|okay|in\s+ordnung|richtig\s+so)\b/i },
    ],
  },
  {
    mode: 'reconcile',
    weight: 1.3,
    patterns: [
      { label: 'abgleichen', rx: /\b(abgleich(en|ung)?|abstimmen|in\s+einklang\s+bringen)\b/i },
      { label: 'passt-zur-vision', rx: /\bpasst\s+(das\s+)?(zur|zu\s+der)\s+(vision|strategie|erwartung|regel)\b/i },
      { label: 'vergleich-vision', rx: /\b(vergleich(e|en)?|abgleich)\b.{0,30}\b(vision|ziel|erwartung|regel|anforderung)\b/i },
      { label: 'erfüllt-anforderung', rx: /\b(erfüllt\s+(das\s+)?(die\s+)?anforderung|meets?\s+the\s+(requirements?|vision))\b/i },
      { label: 'konsistenz', rx: /\b(konsistent|widerspruch|inkonsistenz|konflikt)\s+(mit|zu|zwischen)\b/i },
      { label: 'reconcile-en', rx: /\b(reconcile|align\s+with|consistency\s+check|does\s+it\s+match)\b/i },
      { label: 'stimmt-mit-überein', rx: /\bstimmt\s+(das\s+)?mit\b.{0,30}\büberein\b/i },
      { label: 'soll-ist', rx: /\b(soll[- ]?ist|ist[- ]?soll)[- ]?(vergleich|abgleich)\b/i },
    ],
  },
];

/** Öffentlich für Tests (FN-Coverage über alle Pattern-Familien). */
export const DISCOVERY_MODE_PATTERNS = MODE_FAMILIES;

// ---------------------------------------------------------------------------
// Höflichkeit / Anrede strippen (analog Flow-Classifier, eigenständig)
// ---------------------------------------------------------------------------

const POLITENESS_CUTS: readonly RegExp[] = [
  /^bitte\s+/i,
  /^kannst\s+du\s+(bitte\s+)?/i,
  /^könntest\s+du\s+(bitte\s+)?/i,
  /^hey\s*[,:]?\s*/i,
  /^hi\s*[,:]?\s*/i,
  /^hallo\s*[,:]?\s*/i,
  /^ok(ay)?\s*[,:]?\s*/i,
  /^please\s+/i,
  /^could\s+you\s+(please\s+)?/i,
  /^can\s+you\s+(please\s+)?/i,
];

function stripPoliteness(text: string): string {
  let current = text.trim();
  for (let i = 0; i < 4; i++) {
    let cut = false;
    for (const rx of POLITENESS_CUTS) {
      if (rx.test(current)) {
        current = current.replace(rx, '').trim();
        cut = true;
      }
    }
    if (!cut) break;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Confidence-Heuristik analog intent-classifier.ts: monoton in der Anzahl
 * der Treffer der Gewinner-Familie, abgeschwächt durch „Eindeutigkeit"
 * (Anteil des Top-Scores an allen Scores). Mehrere konkurrierende Familien →
 * niedrigere Confidence → eher `clarify`.
 */
function computeConfidence(topMatchCount: number, topScore: number, totalScore: number): number {
  if (topMatchCount === 0) return 0;
  let base: number;
  if (topMatchCount === 1) base = 0.42;
  else if (topMatchCount === 2) base = 0.68;
  else if (topMatchCount === 3) base = 0.84;
  else if (topMatchCount === 4) base = 0.9;
  else base = 0.95;

  const topShare = totalScore > 0 ? topScore / totalScore : 1;
  // Penalty-Koeffizient 0.15: senkt Confidence bei konkurrierenden Familien,
  // aber nicht so stark, dass ein klar führender Single-Hit-Modus (z. B.
  // brainstorm 1.3 vs. build 1.0) unter den Floor fällt. Der Schutz gegen
  // ein lone-build-Signal läuft separat über BUILD_FLOOR.
  const ambiguityPenalty = (1 - topShare) * 0.15;
  const adjusted = Math.max(0, Math.min(1, base - ambiguityPenalty));
  return Math.round(adjusted * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// detectDiscoveryMode — Haupt-Entry
// ---------------------------------------------------------------------------

/**
 * Klassifiziert eine freie User-Eingabe in einen der 10 §20-Modi.
 *
 * Algorithmus (deterministisch, N6):
 *   1. Trim + Sanity. Leere/Nicht-String-Eingabe → clarify, confidence 0.
 *   2. Höflichkeit strippen, Wortzahl prüfen (`minWords`, default 3).
 *      Zu kurz → clarify, confidence 0 (§20.1: im Zweifel klären).
 *   3. Alle Pattern-Familien scoren (Treffer × Familien-Gewicht).
 *   4. Gewinner = höchster Score. Bei Gleichstand: erkundende Modi gewinnen
 *      über ausführende (brainstorm/clarify > … > build) — §20.1.
 *   4b. Build-Demotion: ist der Gewinner `build`, aber ein erkundender Modus
 *      hat ebenfalls gefeuert → die Erkundung gewinnt (§20.1).
 *   5. Confidence aus Trefferzahl + Eindeutigkeit. `build` braucht den
 *      höheren BUILD_FLOOR (0.5 ≈ ≥2 Signale), sonst → clarify.
 *   6. Liegt die Confidence unter `confidenceFloor` (default 0.35), wird der
 *      Modus auf `clarify` zurückgesetzt — NIEMALS auf `build`.
 *
 * @returns mode (mit Fail-soft-Clamp), confidence, signals[] (verbatim).
 */
export function detectDiscoveryMode(
  text: string,
  opts: DiscoveryModeOptions = {},
): DiscoveryModeResult {
  const minWords = opts.minWords ?? 3;
  const floor = opts.confidenceFloor ?? 0.35;
  // §20.1 — `build` braucht eine HÖHERE Schwelle als andere Modi: ein
  // einzelnes Build-Verb in einem ansonsten erkundenden/hedgenden Satz darf
  // NICHT zu `build` führen. 0.5 entspricht „mindestens 2 Build-Signale".
  const BUILD_FLOOR = 0.5;

  // 1. Sanity.
  if (typeof text !== 'string') {
    return { mode: DEFAULT_DISCOVERY_MODE, confidence: 0, signals: [] };
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { mode: DEFAULT_DISCOVERY_MODE, confidence: 0, signals: [] };
  }

  // 2. Höflichkeit + Länge.
  const stripped = stripPoliteness(trimmed);
  const wordCount = stripped.split(/\s+/).filter(Boolean).length;
  if (wordCount < minWords) {
    return { mode: DEFAULT_DISCOVERY_MODE, confidence: 0, signals: [] };
  }

  // 3. Scoring über alle Familien.
  const signals: DiscoverySignal[] = [];
  const score = new Map<DiscoveryMode, { score: number; matchCount: number }>();
  for (const m of DISCOVERY_MODES) score.set(m, { score: 0, matchCount: 0 });

  for (const fam of MODE_FAMILIES) {
    for (const p of fam.patterns) {
      if (p.rx.test(stripped)) {
        const acc = score.get(fam.mode)!;
        acc.matchCount += 1;
        acc.score += fam.weight;
        signals.push({ mode: fam.mode, label: p.label, weight: fam.weight });
      }
    }
  }

  const totalScore = [...score.values()].reduce((s, v) => s + v.score, 0);

  // Kein Treffer → clarify (Fail-soft, §20.1).
  if (totalScore === 0) {
    return { mode: DEFAULT_DISCOVERY_MODE, confidence: 0, signals: [] };
  }

  // 4. Gewinner ermitteln. Tie-Break: erkundend > ausführend.
  // Priorität von "im-Zweifel-nicht-bauen": brainstorm/clarify schlagen build.
  const TIE_ORDER: readonly DiscoveryMode[] = [
    'brainstorm',
    'clarify',
    'extract_expertise',
    'role_reverse_engineer',
    'simulate',
    'innovate',
    'reconcile',
    'review',
    'plan_graph',
    'build', // build ist BEWUSST letzter Tie-Break-Gewinner
  ];

  let topScore = -1;
  for (const v of score.values()) if (v.score > topScore) topScore = v.score;

  const tiedModes = [...score.entries()]
    .filter(([, v]) => v.score === topScore && v.score > 0)
    .map(([mode]) => mode);

  let winner: DiscoveryMode = tiedModes[0];
  if (tiedModes.length > 1) {
    for (const cand of TIE_ORDER) {
      if (tiedModes.includes(cand)) {
        winner = cand;
        break;
      }
    }
  }

  // 4b. §20.1 Build-Demotion: wenn der Gewinner `build` ist, aber GLEICHZEITIG
  // ein erkundender Modus (brainstorm/clarify/extract_expertise/innovate)
  // gefeuert hat, gewinnt die Erkundung. „Lass uns brainstormen, ob wir eine
  // App bauen sollten" → brainstorm, nicht build. Wir wählen den erkundenden
  // Modus mit dem höchsten Score (Tie-Break über TIE_ORDER).
  if (winner === 'build') {
    const exploratory = NO_DIRECT_PLAN_MODES
      .map((m) => ({ mode: m, acc: score.get(m)! }))
      .filter((e) => e.acc.matchCount > 0);
    if (exploratory.length > 0) {
      let best = exploratory[0];
      for (const e of exploratory) {
        if (
          e.acc.score > best.acc.score ||
          (e.acc.score === best.acc.score &&
            TIE_ORDER.indexOf(e.mode) < TIE_ORDER.indexOf(best.mode))
        ) {
          best = e;
        }
      }
      winner = best.mode;
    }
  }

  const winnerAcc = score.get(winner)!;
  const confidence = computeConfidence(winnerAcc.matchCount, winnerAcc.score, totalScore);

  // 5. Build-spezifischer Floor: ein einzelnes Build-Signal reicht nicht.
  if (winner === 'build' && confidence < BUILD_FLOOR) {
    return { mode: DEFAULT_DISCOVERY_MODE, confidence, signals };
  }

  // 6. Fail-soft-Clamp: zu unsicher → clarify, NIE build.
  if (confidence < floor) {
    return { mode: DEFAULT_DISCOVERY_MODE, confidence, signals };
  }

  return { mode: winner, confidence, signals };
}

// ---------------------------------------------------------------------------
// Mode-Metadaten + Planungs-Gate
// ---------------------------------------------------------------------------

export interface DiscoveryModeMeta {
  mode: DiscoveryMode;
  label: string;
  /** Darf in diesem Modus DIREKT geplant/gebaut werden? §20.1. */
  mayPlanDirectly: boolean;
  /** Kurzbeschreibung des erwarteten Systemverhaltens. */
  behavior: string;
}

/**
 * Modi, in denen NICHT direkt geplant/gebaut werden darf (§20.1 + Aufgabe 3):
 * brainstorm · clarify · extract_expertise · innovate. Hier sammelt das System
 * erst Wissen / klärt / öffnet den Raum, statt einen Plan zu erzeugen.
 */
export const NO_DIRECT_PLAN_MODES: readonly DiscoveryMode[] = [
  'brainstorm',
  'clarify',
  'extract_expertise',
  'innovate',
];

/** True, wenn der Haupt-Agent VOR proposePlan stoppen soll. */
export function shouldBlockDirectPlan(mode: DiscoveryMode): boolean {
  return NO_DIRECT_PLAN_MODES.includes(mode);
}

export function getDiscoveryModeMeta(mode: DiscoveryMode): DiscoveryModeMeta {
  const block = shouldBlockDirectPlan(mode);
  const M: Record<DiscoveryMode, { label: string; behavior: string }> = {
    brainstorm: {
      label: 'Brainstorm',
      behavior: 'Ideenraum offen halten. Themen/Optionen sammeln, NICHT planen.',
    },
    clarify: {
      label: 'Klären',
      behavior: 'Begriffe/Kontext/offene Fragen klären. Kleine Klär-Surfaces, kein Plan.',
    },
    extract_expertise: {
      label: 'Expertenwissen erfassen',
      behavior: 'Regeln/SOPs/Prinzipien verbatim (N1) ablegen. Kein Auto-Build.',
    },
    role_reverse_engineer: {
      label: 'Rolle rekonstruieren',
      behavior: 'Aus Verhalten/Output auf Rolle/Persona/Skills schließen.',
    },
    simulate: {
      label: 'Simulieren',
      behavior: 'Szenario durchspielen ("was würde Rolle X tun, warum").',
    },
    innovate: {
      label: 'Innovieren',
      behavior: 'Gezielter Reframe/Differenzierung. Erst Optionen, dann ggf. Plan.',
    },
    plan_graph: {
      label: 'Plan-Graph',
      behavior: 'Schritte/Abhängigkeiten als Plan-Graph erzeugen. Planen erlaubt.',
    },
    build: {
      label: 'Bauen',
      behavior: 'Umsetzung/Ausführung. Planen+Bauen erlaubt (nach Gates).',
    },
    review: {
      label: 'Review',
      behavior: 'Output prüfen/kritisieren (Roast/Critic). Kein Neubau.',
    },
    reconcile: {
      label: 'Abgleich',
      behavior: 'Ergebnis ↔ Vision/Regeln/Erwartung abgleichen (Soll/Ist).',
    },
  };
  return { mode, label: M[mode].label, mayPlanDirectly: !block, behavior: M[mode].behavior };
}
