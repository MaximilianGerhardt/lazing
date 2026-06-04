/**
 * lib/chat/intent-flow-classifier.ts
 * -----------------------------------
 * 2026-05-28 — Deterministic flow-intent classifier.
 *
 * Owner directive verbatim (N1, 2026-05-28):
 *   „Außerdem müsste Flow doch aus dem Context und Intent erkannt werden
 *    und ausgeführt. Das wäre ja das Kernkonzept von dem lazing system."
 *
 * Today (before this module): only `/flow erstelle eine Webseite ...` as an
 * explicit slash command triggers composeAndRun → Flow Studio. A free
 * chat input without a slash lands in the naive LLM stream. That contradicts
 * the core promise.
 *
 * GOAL (this module): ChatShell calls `classifyFlowIntent(input)` before the
 * slash parser. If `kind === 'flow'`, the caller prefixes `"/flow " + input`
 * and the existing `/flow` handler takes over — one code path, no
 * duplicated backend.
 *
 * Constraints from the lazing/lazyOS constants:
 *   - N1: detail preservation. We do NOT touch the user text; the
 *     classifier only decides yes/no/why.
 *   - N6: deterministic before symbolic. Pure regex+token heuristic.
 *   - N7: lexical RAG before vector. No embedding, no LLM.
 *   - Prefer false-negative (user types `/flow` themselves) over false-positive
 *     (the LLM stream is unexpectedly replaced by Flow Studio).
 *
 * Languages: German + English. The owner writes primarily DE ("erstelle …").
 *
 * Pure, sync, no IO. Directly unit-testable.
 *
 * Non-goals:
 *   - Backend fallback in `app/api/chat/stream/route.ts` is DELIBERATELY not
 *     here — voice/agent API bypass ChatShell. Follow-up slice (see README).
 *   - No entanglement with `lib/workstreams/intent-classifier.ts` — that one
 *     classifies `bug-fix|implementation|idea|question|discussion`, which
 *     is a different axis (what-kind-of-work), not (is-it-a-flow).
 */

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

export type FlowIntentKind = 'flow' | 'unknown';

export interface FlowIntentResult {
  /** 'flow' → ChatShell should reroute to `/flow`. 'unknown' → unchanged. */
  kind: FlowIntentKind;
  /** Rationale in plain text (debug + audit-capable for N8). */
  reason: string;
  /** 0..1 heuristic — informational only, not for the routing decision. */
  confidence: number;
  /** Which verb matched (debug). null when kind='unknown'. */
  matchedVerb: string | null;
  /** Which object matched (debug). null when kind='unknown'. */
  matchedObject: string | null;
}

export interface FlowIntentOptions {
  /** Minimum word count below which we classify EVERYTHING as 'unknown'.
   *  Default 3 — "bau das" or "mach app" are too ambiguous. */
  minWords?: number;
}

// ---------------------------------------------------------------------------
// Pattern library (DE + EN)
// ---------------------------------------------------------------------------

/**
 * Verbs that signal a build/create intent. Captures typical owner
 * phrases like "erstelle eine Webseite", "bau mir eine Landingpage",
 * "generier eine Brand-Identity", "create a website".
 *
 * Regex strategy:
 *   - case-insensitive
 *   - word anchor at the start (^) — the classifier only fires on the
 *     IMPERATIVE form (verb at the start of the sentence). "Wie erstelle ich
 *     eine Webseite?" starts with "Wie" → no match → unknown. That is exactly
 *     the desired behavior (questions are not flows).
 *   - tolerant of whitespace + optional salutation ("Bitte erstelle ...",
 *     "Hey bau mir …" → we strip leading politeness first, see below).
 */
const FLOW_VERB_PATTERNS: ReadonlyArray<{ verb: string; rx: RegExp }> = [
  // Multi-word (more specificity — comes first so "bau mir" does not
  // already fall onto the generic "bau").
  { verb: 'baue mir', rx: /^(bau mir|baue mir)\b/i },
  { verb: 'erstelle mir', rx: /^(erstelle mir|erstell mir)\b/i },
  // German imperative + infinitive forms.
  { verb: 'erstelle', rx: /^(erstelle|erstell)\b/i },
  { verb: 'baue', rx: /^(bau|baue|bauen)\b/i },
  { verb: 'generiere', rx: /^(generier|generiere|generieren)\b/i },
  { verb: 'designe', rx: /^(design|designe|designen|gestalte|gestalten)\b/i },
  { verb: 'entwickle', rx: /^(entwickel|entwickle|entwickeln)\b/i },
  { verb: 'mache', rx: /^(mach|mache|machen)\b/i },
  { verb: 'plane', rx: /^(plane|plan|planen)\b/i },
  // English imperative.
  { verb: 'create', rx: /^create\b/i },
  { verb: 'build', rx: /^build\b/i },
  { verb: 'generate', rx: /^generate\b/i },
  { verb: 'make', rx: /^make\b/i },
  { verb: 'design', rx: /^design\b/i },
  { verb: 'develop', rx: /^develop\b/i },
];

/**
 * Objects that signal a flow-worthy result type. Captures everything
 * that appears in the owner reference flow "Erstelle eine Webseite" plus the
 * obvious siblings (brand, video, pitch deck, campaign, app).
 *
 * NO word anchor — the object may appear anywhere in the input
 * ("baue ein Online-Shop für …" matches via `shop|webshop|e-commerce`).
 */
const FLOW_OBJECT_PATTERNS: ReadonlyArray<{ obj: string; rx: RegExp }> = [
  // Web / digital surfaces.
  { obj: 'webseite', rx: /\b(webseite|websites?|webpage|webpages?)\b/i },
  { obj: 'landingpage', rx: /\b(landing\s*page|landingpages?|landing\b)/i },
  { obj: 'website', rx: /\bwebsite\b/i },
  { obj: 'seite', rx: /\b(seite|page|site)\b/i },
  { obj: 'shop', rx: /\b(shop|webshop|e[- ]?commerce|online[- ]?shop)\b/i },
  // App / product.
  { obj: 'app', rx: /\b(app|application|mobile[- ]app|web[- ]app)\b/i },
  { obj: 'prototyp', rx: /\b(prototyp|prototype|mvp)\b/i },
  { obj: 'mockup', rx: /\b(mockup|mock[- ]up|wireframe|wireframes?)\b/i },
  // Brand / identity.
  { obj: 'brand', rx: /\b(brand|brand[- ]?identity|markenidentität|markenauftritt|corporate[- ]?identity|ci)\b/i },
  { obj: 'logo', rx: /\blogos?\b/i },
  // Marketing assets.
  { obj: 'video', rx: /\b(video|videos|videoclip|reel|reels)\b/i },
  { obj: 'kampagne', rx: /\b(kampagne|campaign|ad[- ]?campaign|ads?)\b/i },
  { obj: 'pitchdeck', rx: /\b(pitch[- ]?deck|pitchdecks?|deck|präsentation|presentation|slides?)\b/i },
  { obj: 'grafik', rx: /\b(grafik|grafiken|graphic|graphics|illustration|illustrationen)\b/i },
  { obj: 'banner', rx: /\b(banner|hero[- ]?banner|social[- ]?banner)\b/i },
  // Avatar / motion.
  { obj: 'avatar', rx: /\b(avatar|avatars|talking[- ]?head)\b/i },
];

/**
 * 2026-05-29 — politeness-form patterns (Slice B, additive).
 *
 * Owner finding (verbatim): „Ich möchte eine website erstellen weil wir aktuell
 * das problem haben das die dienstleistung…" was NOT recognized by Path A,
 * because it requires an imperative verb at the start of the sentence. But DE
 * politeness forms are dominant in the owner corpus.
 *
 * Strategy (Path B): if the input starts with a politeness form AND there is a
 * flow verb somewhere in the REST of the input AND a flow object somewhere in
 * the text → match. The disqualifier logic (questions, read verbs) runs
 * BEFORE this as usual and wins.
 *
 * Deliberate limitation:
 *   - The politeness-form match is `^`-anchored, so "weil ich möchte eine App"
 *     in an explanatory context does NOT trigger.
 *   - The flow verb may only appear as a REAL verb (infinitive form common
 *     in DE politeness: "… eine Webseite erstellen") — we therefore also match
 *     on `\b<verb>(en|n)?\b` without a sentence anchor.
 *   - Read/explain politeness ("ich möchte verstehen", "ich möchte wissen")
 *     has NO flow verb → falls through automatically.
 */
const FLOW_POLITENESS_PATTERNS: ReadonlyArray<{ form: string; rx: RegExp }> = [
  // German — wish/need in the 1st/3rd person.
  { form: 'ich möchte', rx: /^ich\s+möchte\b/i },
  { form: 'ich will', rx: /^ich\s+will\b/i },
  { form: 'ich brauche', rx: /^ich\s+brauche\b/i },
  { form: 'ich hätte gern', rx: /^ich\s+hätte\s+(gern|gerne)\b/i },
  { form: 'wir möchten', rx: /^wir\s+möchten\b/i },
  { form: 'wir wollen', rx: /^wir\s+wollen\b/i },
  { form: 'wir brauchen', rx: /^wir\s+brauchen\b/i },
  { form: 'wir hätten gern', rx: /^wir\s+hätten\s+(gern|gerne)\b/i },
  // Inclusive form — "lass uns / lasst uns".
  { form: 'lass uns', rx: /^(lass|lasst)\s+uns\b/i },
  // We-form with a direct verb ("wir bauen", "wir machen") — actually
  // indicative, but used as a declaration of intent in the owner corpus.
  { form: 'wir bauen', rx: /^wir\s+(bauen|baun)\b/i },
  { form: 'wir machen', rx: /^wir\s+machen\b/i },
  { form: 'wir erstellen', rx: /^wir\s+erstellen\b/i },
  { form: 'wir entwickeln', rx: /^wir\s+entwickeln\b/i },
  { form: 'wir generieren', rx: /^wir\s+generieren\b/i },
  { form: 'wir designen', rx: /^wir\s+(designen|gestalten)\b/i },
  // English.
  { form: 'i want', rx: /^i\s+want\b/i },
  { form: 'i need', rx: /^i\s+need\b/i },
  { form: "i'd like", rx: /^(i'd|i\s+would)\s+like\b/i },
  { form: 'we want', rx: /^we\s+want\b/i },
  { form: 'we need', rx: /^we\s+need\b/i },
  { form: "we'd like", rx: /^(we'd|we\s+would)\s+like\b/i },
  { form: "let's", rx: /^let'?s\b/i },
];

/**
 * 2026-05-29 — flow verbs for Path B (politeness form).
 *
 * Unlike Path A: NO `^` anchor. The verb may appear anywhere in the rest of the
 * input, because the DE infinitive form places the verb at the end ("eine
 * Webseite ERSTELLEN"). We match the imperative stem, the infinitive (+en/+n)
 * and the 1st person singular/plural ("erstelle", "erstellen", "baue", "bauen",
 * "mache", "machen", "generieren", "designen", "entwickeln") in the same
 * pattern list.
 *
 * The label is the canonical lemma — used in the reason text.
 */
const FLOW_VERB_INLINE_PATTERNS: ReadonlyArray<{ verb: string; rx: RegExp }> = [
  // German — stem + optional infinitive/plural ending.
  { verb: 'erstellen', rx: /\b(erstell(?:e|en|t)?)\b/i },
  { verb: 'bauen', rx: /\b(bau(?:e|en|t)?)\b/i },
  { verb: 'generieren', rx: /\b(generier(?:e|en|t)?)\b/i },
  { verb: 'designen', rx: /\b(design(?:e|en|t)?|gestalt(?:e|en|et)?)\b/i },
  { verb: 'entwickeln', rx: /\b(entwickel(?:n|t)?|entwickle)\b/i },
  { verb: 'machen', rx: /\b(mach(?:e|en|t)?)\b/i },
  { verb: 'planen', rx: /\b(plan(?:e|en|t)?)\b/i },
  // English — the infinitive is enough.
  { verb: 'create', rx: /\bcreate\b/i },
  { verb: 'build', rx: /\bbuild\b/i },
  { verb: 'generate', rx: /\bgenerate\b/i },
  { verb: 'make', rx: /\bmake\b/i },
  { verb: 'design', rx: /\bdesign\b/i },
  { verb: 'develop', rx: /\bdevelop\b/i },
];

/**
 * Disqualifiers — when these match, we switch HARD back to 'unknown',
 * even if verb+object were hit. This catches questions/discussions/read
 * requests that would happen to end on verb+object.
 */
const DISQUALIFIER_PATTERNS: ReadonlyArray<{ kind: string; rx: RegExp }> = [
  // Questions.
  { kind: 'question', rx: /\?$/ },
  { kind: 'wh-question-de', rx: /^(wie|was|wann|warum|wieso|welche?|wer|wo|wozu)\b/i },
  { kind: 'wh-question-en', rx: /^(how|what|when|why|which|who|where)\b/i },
  // Read/status requests — often look similar but belong in the
  // normal chat path.
  { kind: 'read', rx: /^(les|lese|lies|zeig|zeige|schau|schaue|öffne|liste|list|show|read|open|find)\b/i },
  // Meta commands.
  { kind: 'meta', rx: /^(erkläre|erklär|erläutere|explain|describe)\b/i },
  // Discussion markers.
  { kind: 'discuss', rx: /^(was hältst|was meinst|was denkst|deine meinung|deine sicht|what do you think)\b/i },
];

/** Publicly exported for tests (FN coverage across all patterns). */
export const FLOW_INTENT_PATTERNS = {
  verbs: FLOW_VERB_PATTERNS,
  objects: FLOW_OBJECT_PATTERNS,
  disqualifiers: DISQUALIFIER_PATTERNS,
  /** 2026-05-29 Path-B additive: politeness prefixes (DE+EN). */
  politeness: FLOW_POLITENESS_PATTERNS,
  /** 2026-05-29 Path-B additive: flow verbs "somewhere in the sentence" (infinitive). */
  inlineVerbs: FLOW_VERB_INLINE_PATTERNS,
} as const;

// ---------------------------------------------------------------------------
// Strip politeness prefixes BEFORE the verb match runs
// ---------------------------------------------------------------------------

/**
 * Cuts off harmless politeness/salutation prefixes so that
 * "Bitte erstelle eine Webseite" or "Hey, bau mir eine Landingpage"
 * do not miss the verb match. Applies ONLY to a small, controlled
 * list — no generic NLP.
 */
function stripPoliteness(text: string): string {
  // All patterns are ^-anchored and case-insensitive; trim after each cut.
  const cuts: RegExp[] = [
    /^bitte\s+/i,
    /^kannst\s+du\s+(bitte\s+)?/i,
    /^könntest\s+du\s+(bitte\s+)?/i,
    /^kann\s+ich\s+/i,
    /^hey\s*[,:]?\s*/i,
    /^hi\s*[,:]?\s*/i,
    /^hallo\s*[,:]?\s*/i,
    /^ok\s*[,:]?\s*/i,
    /^okay\s*[,:]?\s*/i,
    /^please\s+/i,
    /^could\s+you\s+(please\s+)?/i,
    /^can\s+you\s+(please\s+)?/i,
  ];
  let current = text.trim();
  // Apply multiple times, because "Hey bitte erstelle …" needs two cuts.
  // Limit 4 iterations → hard bound against pathological inputs.
  for (let i = 0; i < 4; i++) {
    let cutThisRound = false;
    for (const rx of cuts) {
      if (rx.test(current)) {
        current = current.replace(rx, '').trim();
        cutThisRound = true;
      }
    }
    if (!cutThisRound) break;
  }
  return current;
}

// ---------------------------------------------------------------------------
// classifyFlowIntent — main entry
// ---------------------------------------------------------------------------

/**
 * Classifies a user input as 'flow' or 'unknown'.
 *
 * Algorithm (deterministic):
 *   1. Trim + word-count check (`minWords`, default 3). Too short → unknown.
 *   2. If the input already starts with `/` → unknown (slash routing
 *      takes over; the classifier stays out of it).
 *   3. Strip politeness prefixes.
 *   4. Disqualifier (question, read, discussion) → unknown.
 *   5. Verb match at the start of the sentence. No match → unknown.
 *   6. Object match anywhere in the text. No match → unknown.
 *   7. Otherwise → 'flow' with a confidence score:
 *      - 0.95 if verb + object both hit AND >=4 words
 *      - 0.80 if verb + object + 3 words
 *      - 0.70 if only verb + object at the minimum limit
 */
export function classifyFlowIntent(
  text: string,
  opts: FlowIntentOptions = {},
): FlowIntentResult {
  const minWords = opts.minWords ?? 3;

  // 1. Trim + Sanity.
  if (typeof text !== 'string') {
    return {
      kind: 'unknown',
      reason: 'non-string input',
      confidence: 0,
      matchedVerb: null,
      matchedObject: null,
    };
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return {
      kind: 'unknown',
      reason: 'empty input',
      confidence: 0,
      matchedVerb: null,
      matchedObject: null,
    };
  }

  // 2. If already a slash command, stay out of it.
  if (trimmed.startsWith('/')) {
    return {
      kind: 'unknown',
      reason: 'already a slash command',
      confidence: 0,
      matchedVerb: null,
      matchedObject: null,
    };
  }

  // Politeness removed.
  const stripped = stripPoliteness(trimmed);

  // Check the word count on the stripped variant — "bitte bau" would otherwise
  // be 2 words, but the real intent is "bau" → 1 word, clearly below
  // minWords.
  const wordCount = stripped.split(/\s+/).filter(Boolean).length;
  if (wordCount < minWords) {
    return {
      kind: 'unknown',
      reason: `too short (${wordCount} words < min ${minWords})`,
      confidence: 0,
      matchedVerb: null,
      matchedObject: null,
    };
  }

  // 4. Disqualifier.
  for (const dq of DISQUALIFIER_PATTERNS) {
    if (dq.rx.test(stripped)) {
      return {
        kind: 'unknown',
        reason: `disqualified by ${dq.kind}`,
        confidence: 0,
        matchedVerb: null,
        matchedObject: null,
      };
    }
  }

  // 5. Verb at the start of the sentence (Path A — imperative, existing).
  let matchedVerb: string | null = null;
  for (const v of FLOW_VERB_PATTERNS) {
    if (v.rx.test(stripped)) {
      matchedVerb = v.verb;
      break;
    }
  }

  // 5b. Path B (2026-05-29, additive) — politeness form at the start of the
  // sentence + flow verb (infinitive) somewhere in the rest. Example:
  //   "Ich möchte eine Webseite erstellen weil …"
  //   politenessForm = "ich möchte", inlineVerb = "erstellen"
  //
  // Plus: implicit want signal — if the politeness form is a strong
  // wish/need phrase (möchten/wollen/brauchen/hätte gern /
  // want/need/like), it suffices as a build intent, provided NO explicit
  // explain verb ("verstehen|wissen|erfahren|lernen|understand|know|learn")
  // appears in the rest of the sentence.
  //
  // Path B runs ONLY if Path A came up empty — Path A has precedence because
  // its verb label is more specific (e.g. "baue mir" instead of "bauen").
  let matchedPoliteness: string | null = null;
  if (matchedVerb === null) {
    for (const p of FLOW_POLITENESS_PATTERNS) {
      if (p.rx.test(stripped)) {
        matchedPoliteness = p.form;
        break;
      }
    }
    if (matchedPoliteness !== null) {
      // Explain-verb guard (DE+EN): "möchte verstehen", "want to understand".
      // Fires ONLY in Path B, because Path A does not produce the symptom
      // ("verstehe X" would be `^verstehe` — no flow verb → unknown anyway).
      const explainGuard =
        /\b(verstehen|wissen|erfahren|lernen|understand|know|learn)\b/i.test(
          stripped,
        );
      if (explainGuard) {
        return {
          kind: 'unknown',
          reason: `politeness "${matchedPoliteness}" but explain-verb in rest`,
          confidence: 0,
          matchedVerb: null,
          matchedObject: null,
        };
      }

      // 5b.i — explicit flow verb anywhere.
      for (const v of FLOW_VERB_INLINE_PATTERNS) {
        if (v.rx.test(stripped)) {
          matchedVerb = v.verb;
          break;
        }
      }

      // 5b.ii — implicit want signal. Only if NO explicit verb was
      // found AND the politeness is a genuine wish phrase.
      // We couple the verb label to the canonical wish form so the
      // reason text stays traceable for the toast.
      if (matchedVerb === null) {
        const implicitWant =
          /^(ich möchte|wir möchten|ich will|wir wollen|ich brauche|wir brauchen|ich hätte gern|wir hätten gern|i want|we want|i need|we need|i'd like|we'd like|i would like|we would like)$/i.test(
            matchedPoliteness,
          );
        if (implicitWant) {
          matchedVerb = matchedPoliteness;
        }
      }
    }
  }

  if (matchedVerb === null) {
    return {
      kind: 'unknown',
      reason: matchedPoliteness
        ? `politeness "${matchedPoliteness}" matched but no flow-verb`
        : 'no imperative build-verb at start',
      confidence: 0,
      matchedVerb: null,
      matchedObject: null,
    };
  }

  // 6. Object anywhere.
  let matchedObject: string | null = null;
  for (const o of FLOW_OBJECT_PATTERNS) {
    if (o.rx.test(stripped)) {
      matchedObject = o.obj;
      break;
    }
  }
  if (matchedObject === null) {
    return {
      kind: 'unknown',
      reason: matchedPoliteness
        ? `politeness "${matchedPoliteness}" + verb "${matchedVerb}" matched but no flow-object`
        : `verb "${matchedVerb}" matched but no flow-object`,
      confidence: 0,
      matchedVerb,
      matchedObject: null,
    };
  }

  // 7. Confidence — informational, not used for routing.
  let confidence = 0.7;
  if (wordCount >= 4) confidence = 0.8;
  if (wordCount >= 5) confidence = 0.95;

  const reason = matchedPoliteness
    ? `politeness "${matchedPoliteness}" + verb "${matchedVerb}" + object "${matchedObject}" + ${wordCount} words`
    : `verb "${matchedVerb}" + object "${matchedObject}" + ${wordCount} words`;

  return {
    kind: 'flow',
    reason,
    confidence,
    matchedVerb,
    matchedObject,
  };
}

// ---------------------------------------------------------------------------
// Convenience: slash synthesis
// ---------------------------------------------------------------------------

/**
 * Builds, from an input classified as 'flow', the synthetic
 * slash-command string that ChatShell can instead forward to
 * `parseSlashCommand`.
 *
 * N1 verbatim: the original text stays untouched — only a `/flow `
 * in front. `extractSlashArgs` then returns the original text as args.
 */
export function buildSyntheticFlowCommand(originalText: string): string {
  return `/flow ${originalText}`;
}
