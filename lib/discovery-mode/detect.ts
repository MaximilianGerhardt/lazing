/**
 * lib/discovery-mode/detect.ts
 * ----------------------------------------------------------------------------
 * 2026-05-29 — Discovery-mode detection (10 modes) — Opus 4.8.
 *
 * Source: Innovation/Expertise-Compiler master brief §20 ("Systemverhalten:
 * Intent und Mode Detection") + §6 ("Beobachteter LLM-Fehler") + §20.3
 * ("Continuity Check"). Verbatim the core rule §20.1:
 *
 *   > „Nicht jede Nachricht ist ein Planungsauftrag."
 *
 * The §20.2 model demands TEN internal modes:
 *   brainstorm · clarify · extract_expertise · role_reverse_engineer ·
 *   simulate · innovate · plan_graph · build · review · reconcile
 *
 * Relationship to the old model (N4 — recovery before reinvention):
 *   - `lib/workstreams/intent-classifier.ts` classifies on the axis
 *     "WHAT-KIND-OF-WORK" into {idea|implementation|bug-fix|question|
 *     discussion}. That is an OLDER, coarser model (5 intents).
 *   - `lib/chat/intent-flow-classifier.ts` classifies on the axis
 *     "IS-IT-A-FLOW" (flow|unknown) — a binary router.
 *   - THIS module is a THIRD, finer axis ("IN-WHICH-DISCOVERY-
 *     MODE-IS-THE-USER"). It REPLACES NEITHER of the two — it is additive
 *     and gives the main agent the missing §20 mode.
 *
 * Constraints (lazing/lazyOS N constants):
 *   - N6: deterministic before symbolic. Pure regex+token heuristic. No
 *     LLM, no embedding, no I/O. Synchronous, pure, directly unit-testable.
 *   - N7: lexical before vector. DE+EN keyword families with weighting.
 *   - N1: detail preservation. We do NOT touch the user text; NO
 *     `.slice`/`.substring`. We only read, classify, justify.
 *   - §20.1 fail-soft: on ambiguity default `clarify` — NOT `build`. When in
 *     doubt clarify, do not build. That is the central protection against the
 *     "jumps to implementation too early" error described in §6.
 *
 * Languages: German (primary) + English. Politeness-tolerant analogous to the
 * flow classifier (leading politeness/salutation prefixes are stripped).
 */

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

/**
 * The 10 discovery modes from §20.2 — the order corresponds to the typical
 * discovery flow (open → concrete → executing → reviewing).
 */
export type DiscoveryMode =
  | 'brainstorm' // open idea field, no task
  | 'clarify' // clarify terms/context/questions (= fail-soft default)
  | 'extract_expertise' // store expert knowledge / rules / SOPs
  | 'role_reverse_engineer' // infer the role from behavior/output
  | 'simulate' // play through a scenario ("what would X do")
  | 'innovate' // targeted novelty / reframe / differentiation
  | 'plan_graph' // planning: steps/dependencies/graph
  | 'build' // implementation / execution
  | 'review' // checking / critique / quality of an output
  | 'reconcile'; // reconcile result ↔ vision/rules/expectation

/** All modes as a runtime list (tests + UI). */
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

/** The fail-soft default per §20.1 — when in doubt clarify, never build. */
export const DEFAULT_DISCOVERY_MODE: DiscoveryMode = 'clarify';

export interface DiscoverySignal {
  /** Which mode this signal counts towards. */
  mode: DiscoveryMode;
  /** Human-readable label of the matched pattern (debug + N8 audit). */
  label: string;
  /** Score contribution of this hit. */
  weight: number;
}

export interface DiscoveryModeResult {
  /** Detected mode. On ambiguity `clarify` (§20.1 fail-soft). */
  mode: DiscoveryMode;
  /** 0..1 heuristic. <0.35 = uncertain → mode is clamped to `clarify`. */
  confidence: number;
  /** Which patterns fired — verbatim, for explainability (N8). */
  signals: DiscoverySignal[];
}

export interface DiscoveryModeOptions {
  /**
   * Minimum word count below which EVERYTHING counts as `clarify` with confidence 0.
   * Default 3 — „bau das" (2 words) is too short/ambiguous for a
   * safe mode; §20.1 requires `clarify` when in doubt.
   */
  minWords?: number;
  /**
   * Threshold below which a detected mode falls back to `clarify`.
   * §20.1: default 0.35 — a single weak hit is NOT enough to
   * jump to e.g. `build`.
   */
  confidenceFloor?: number;
}

// ---------------------------------------------------------------------------
// Pattern library (DE + EN), one family per mode with a weight
// ---------------------------------------------------------------------------
//
// Design principle: stronger disambiguators get a higher weight. „bau"
// (build) is deliberately NOT over-weighted, because §20.1 requires that a
// single build verb in an otherwise exploring sentence does NOT lead directly to
// `build`. Brainstorm/clarify markers win on a tie.

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

/** Public for tests (FN coverage across all pattern families). */
export const DISCOVERY_MODE_PATTERNS = MODE_FAMILIES;

// ---------------------------------------------------------------------------
// Strip politeness / salutation (analogous to the flow classifier, standalone)
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
 * Confidence heuristic analogous to intent-classifier.ts: monotonic in the number
 * of hits of the winner family, attenuated by "unambiguousness"
 * (share of the top score in all scores). Several competing families →
 * lower confidence → rather `clarify`.
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
  // Penalty coefficient 0.15: lowers confidence with competing families,
  // but not so strongly that a clearly leading single-hit mode (e.g.
  // brainstorm 1.3 vs. build 1.0) falls below the floor. The protection against
  // a lone-build signal runs separately via BUILD_FLOOR.
  const ambiguityPenalty = (1 - topShare) * 0.15;
  const adjusted = Math.max(0, Math.min(1, base - ambiguityPenalty));
  return Math.round(adjusted * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// detectDiscoveryMode — main entry
// ---------------------------------------------------------------------------

/**
 * Classifies a free user input into one of the 10 §20 modes.
 *
 * Algorithm (deterministic, N6):
 *   1. Trim + sanity. Empty/non-string input → clarify, confidence 0.
 *   2. Strip politeness, check word count (`minWords`, default 3).
 *      Too short → clarify, confidence 0 (§20.1: clarify when in doubt).
 *   3. Score all pattern families (hits × family weight).
 *   4. Winner = highest score. On a tie: exploring modes win
 *      over executing ones (brainstorm/clarify > … > build) — §20.1.
 *   4b. Build demotion: if the winner is `build`, but an exploring mode
 *      also fired → the exploration wins (§20.1).
 *   5. Confidence from hit count + unambiguousness. `build` needs the
 *      higher BUILD_FLOOR (0.5 ≈ ≥2 signals), otherwise → clarify.
 *   6. If the confidence is below `confidenceFloor` (default 0.35), the
 *      mode is reset to `clarify` — NEVER to `build`.
 *
 * @returns mode (with fail-soft clamp), confidence, signals[] (verbatim).
 */
export function detectDiscoveryMode(
  text: string,
  opts: DiscoveryModeOptions = {},
): DiscoveryModeResult {
  const minWords = opts.minWords ?? 3;
  const floor = opts.confidenceFloor ?? 0.35;
  // §20.1 — `build` needs a HIGHER threshold than other modes: a
  // single build verb in an otherwise exploring/hedging sentence must
  // NOT lead to `build`. 0.5 corresponds to "at least 2 build signals".
  const BUILD_FLOOR = 0.5;

  // 1. Sanity.
  if (typeof text !== 'string') {
    return { mode: DEFAULT_DISCOVERY_MODE, confidence: 0, signals: [] };
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { mode: DEFAULT_DISCOVERY_MODE, confidence: 0, signals: [] };
  }

  // 2. Politeness + length.
  const stripped = stripPoliteness(trimmed);
  const wordCount = stripped.split(/\s+/).filter(Boolean).length;
  if (wordCount < minWords) {
    return { mode: DEFAULT_DISCOVERY_MODE, confidence: 0, signals: [] };
  }

  // 3. Scoring across all families.
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

  // No hit → clarify (fail-soft, §20.1).
  if (totalScore === 0) {
    return { mode: DEFAULT_DISCOVERY_MODE, confidence: 0, signals: [] };
  }

  // 4. Determine the winner. Tie-break: exploring > executing.
  // Priority of "when-in-doubt-don't-build": brainstorm/clarify beat build.
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
    'build', // build is DELIBERATELY the last tie-break winner
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

  // 4b. §20.1 build demotion: if the winner is `build`, but AT THE SAME TIME
  // an exploring mode (brainstorm/clarify/extract_expertise/innovate)
  // fired, the exploration wins. „Lass uns brainstormen, ob wir eine
  // App bauen sollten" → brainstorm, not build. We pick the exploring
  // mode with the highest score (tie-break via TIE_ORDER).
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

  // 5. Build-specific floor: a single build signal is not enough.
  if (winner === 'build' && confidence < BUILD_FLOOR) {
    return { mode: DEFAULT_DISCOVERY_MODE, confidence, signals };
  }

  // 6. Fail-soft clamp: too uncertain → clarify, NEVER build.
  if (confidence < floor) {
    return { mode: DEFAULT_DISCOVERY_MODE, confidence, signals };
  }

  return { mode: winner, confidence, signals };
}

// ---------------------------------------------------------------------------
// Mode metadata + planning gate
// ---------------------------------------------------------------------------

export interface DiscoveryModeMeta {
  mode: DiscoveryMode;
  label: string;
  /** May one plan/build DIRECTLY in this mode? §20.1. */
  mayPlanDirectly: boolean;
  /** Short description of the expected system behavior. */
  behavior: string;
}

/**
 * Modes in which direct planning/building is NOT allowed (§20.1 + task 3):
 * brainstorm · clarify · extract_expertise · innovate. Here the system first
 * collects knowledge / clarifies / opens the space, instead of generating a plan.
 */
export const NO_DIRECT_PLAN_MODES: readonly DiscoveryMode[] = [
  'brainstorm',
  'clarify',
  'extract_expertise',
  'innovate',
];

/** True if the main agent should stop BEFORE proposePlan. */
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
