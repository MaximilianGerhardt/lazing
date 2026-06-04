/**
 * open-questions-lifecycle — Workstream 4b (2026-05-27).
 *
 * Pure (no React, no DOM) lifecycle logic for the pinned open-questions
 * pill (`ChatOpenQuestionsPill` above the composer in `ChatShell`).
 *
 * OWNER-SYMPTOM (verbatim): „Im Chat erscheint eine Frage-Surface, dann laufen
 * Bash-Befehle + ‚server 200' — die Frage scrollt weg, obwohl der Run im
 * ask-but-proceed-Modus parallel weiterlief. Wenn parallel gearbeitet wird,
 * muss die Frage trotzdem unten gepinnt sein, beantwortbar."
 *
 * ROOT-CAUSE (verified in code, 2026-05-27):
 *  1. The pill population (`ChatShell` effect ~:941) pulled questions ONLY from
 *     the `## Offene Fragen` markdown section of the MOST RECENT assistant item via
 *     `splitOpenQuestionsSection`. Questions emitted as a `<surface:open-questions>`
 *     tag (the actual run-surface path) landed ONLY in
 *     the in-stream `ChatInlineOpenQuestions` card and NEVER filled the pinned
 *     pill → they scrolled away with the stream.
 *  2. The effect had `if (isStreaming) return;` → while an ask-but-proceed
 *     run continues (Bash, „server 200", new tokens), it was NOT populated
 *     AT ALL; and as soon as a later assistant item without a question became the
 *     most recent one, the „latest-only" scan no longer found the question.
 *
 * FIX STRATEGY (additive):
 *  - `collectOpenQuestionsFromHistory` scans ALL assistant items (most recent
 *    first) and accepts BOTH sources (markdown section AND surface tag).
 *  - Population also runs WHILE `isStreaming` (ask-but-proceed) — the question
 *    stays pinned at the bottom, answerable, while work continues in parallel.
 *  - It is cleared ONLY when (i) the Q-set was answered/submitted
 *    (signature-tracked) or (ii) the workstream is terminal
 *    (done/failed/cancelled). NOT on step-done / wave change.
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
 * 2026-05-28 — Open-questions expand fields (additive, backwards-compat).
 *
 * Owner finding: „dann lieber die Offenen Fragen mit der Möglichkeit auf mehr
 * Details ausklappen lassen, dass da zu jeder Frage ggf. Kontext, Pro/Kontra
 * usw. vorhanden ist". When the system emits a RICHER recommendation for the same
 * question (today a second surface → duplication), we carry the
 * enrichment onto the existing pill card instead of opening a second card.
 *
 * All fields are optional. Old payloads (only `id` + `q`/`text` + `options`)
 * render unchanged as before.
 */
export interface OpenQuestionEnrichment {
  /** Short context paragraph — why is the question coming up right now? */
  context?: string;
  /** Pro arguments for an (implicit or explicitly recommended) answer. */
  pros?: string[];
  /** Con arguments. */
  cons?: string[];
  /** Concrete recommendation (one line, ideally = one of the options[]). */
  recommendation?: string;
  /** Evidence/sources (markdown links or plain strings — pill renders plain). */
  evidence?: string[];
  /** ISO timestamp of when the question was first asked (for age decay). */
  askedAt?: string;
}

/**
 * Parses the questions from ONE `<surface:open-questions>` JSON body. Mirrors the
 * field tolerance of `SurfaceRenderer.renderOpenQuestions` (`q.q ?? q.text`,
 * `options[]` trimmed + capped at max 5) — same source, same shape.
 *
 * 2026-05-28 (additive): additionally pulls the optional expand fields
 * (context/pros/cons/recommendation/evidence/askedAt) onto the PlanQuestion object.
 * Omitted for old payloads (undefined → backward-compat).
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

    // Additive enrichment fields. Strings are trimmed; empty strings/arrays
    // do NOT land in the output (undef = „nicht da" as a renderer signal).
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
 * Helper cleaner for the enrichment string arrays (pros/cons/evidence).
 * - filters to strings,
 * - trims,
 * - throws away empty ones,
 * - caps at max 8 (UI protection; a huge bullet block breaks the pill on
 *   narrow iPhone viewports).
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
 * Extended PlanQuestion type incl. the optional expand fields
 * (2026-05-28). Backwards-compat: every `PlanQuestion` is a valid
 * `OpenQuestion` (the enrichment fields are all optional).
 */
export type OpenQuestion = PlanQuestion & OpenQuestionEnrichment;

/**
 * Pulls ALL open questions from ONE assistant content — from both sources:
 *   1. `<surface:open-questions>` tag(s)  (run / sub-agent surface path)
 *   2. `## Offene Fragen` markdown section (free-chat path)
 *
 * Order: surface tags first (they are the structured source, and
 * ONLY they can carry the enrichment fields context/pros/cons/recommendation/
 * evidence/askedAt — markdown bullets are necessarily flat), then
 * the markdown section. De-duplication happens via the ID in the caller
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
    // Markdown questions carry no enrichment fields. PlanQuestion → OpenQuestion
    // is structurally conformant (all enrichment fields optional).
    out.push(...split.questions);
  }

  return out;
}

/** Minimal shape of a history item that this module reads (decoupled from
 *  the full ChatShell `HistoryItem`, so the reducer stays purely testable). */
export interface OpenQuestionsSourceItem {
  role: 'user' | 'assistant';
  content: unknown;
}

/**
 * Scans the ENTIRE history (most recent assistant item first) and returns the
 * open questions of the most recent assistant turn that contains any at all.
 *
 * WHY most-recent-first instead of „merge all": a new question set replaces the
 * old one (the agent re-asked); pinning two sets at once would be
 * confusing. Within the SAME item, both sources are merged + deduplicated by ID.
 *
 * 2026-05-28 — Anti-duplication (owner finding):
 *   „Wenn der mir eine neue Frage stellt, dann wieder im alten Muster/Surface
 *    mit Empfehlung usw. ist ganz cool, aber dadurch etwas doppelt und ggf.
 *    redundant."
 * Instead of creating two cards per ID, we MERGE all emissions of the SAME
 * item with the same id: the first occurrence keeps text/options, every later
 * occurrence enriches ONLY the enrichment fields (context/pros/cons/
 * recommendation/evidence/askedAt — last-write-wins per field). This way a
 * later recommendation emission („recommendation:…") for the SAME question gets
 * added to the ONE existing card, instead of creating a second surface.
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
 * Merges multiple emissions of the SAME question ID into ONE OpenQuestion card.
 *
 * Order guarantees:
 *  - The first occurrence of an ID determines `text` and `options` (surface before
 *    markdown — see `extractOpenQuestionsFromContent`).
 *  - Every later emission WITH the same enrichment fields overwrites the
 *    previous field (last-write-wins) — a later, richer recommendation
 *    wins over the initially empty pill card.
 *  - The output order matches the FIRST occurrence of each ID.
 *
 * Pure function — no React, no DOM. Idempotent.
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
    // Enrichment fields: last-write-wins, but only if the new occurrence
    // actually SETS the field (otherwise a later empty emission would null
    // the existing value).
    const merged: OpenQuestion = { ...existing };
    if (q.context !== undefined) merged.context = q.context;
    if (q.pros !== undefined) merged.pros = q.pros;
    if (q.cons !== undefined) merged.cons = q.cons;
    if (q.recommendation !== undefined) merged.recommendation = q.recommendation;
    if (q.evidence !== undefined) merged.evidence = q.evidence;
    if (q.askedAt !== undefined) merged.askedAt = q.askedAt;
    // text/options: first occurrence wins → do NOT overwrite (otherwise
    // an „enrichment-only" emit with an empty options[] would kill the buttons).
    byId.set(q.id, merged);
  }
  return order.map((id) => byId.get(id)!);
}

// ---------------------------------------------------------------------------
// Pure lifecycle reducer — for tests + as reference semantics
// ---------------------------------------------------------------------------

/** The pinned pill state (minimal — only what the lifecycle determines). */
export interface OpenQuestionsState {
  /** Currently pinned open questions (empty = pill hidden).
   *  2026-05-28: type softened to `OpenQuestion` (PlanQuestion +
   *  optional enrichment fields). Structurally backwards-compatible — a
   *  PlanQuestion without extras is a valid OpenQuestion. */
  questions: OpenQuestion[];
  /** Signature of the last loaded set (question IDs joined) — re-load protection. */
  signature: string | null;
}

export const EMPTY_OPEN_QUESTIONS_STATE: OpenQuestionsState = {
  questions: [],
  signature: null,
};

/** Signature of a question set = question IDs in order, pipe-separated. */
export function questionsSignature(
  questions: ReadonlyArray<{ id: string }>,
): string {
  return questions.map((q) => q.id).join('|');
}

/**
 * Lifecycle events that are allowed to change the pinned pill state.
 *
 *  - `questions-detected`: the history scan found a (possibly new) question set.
 *    Population — also while an ask-but-proceed run is running.
 *  - `step-done`: a single run step / a wave is finished. The pill
 *    stays UNCHANGED (THAT was the bug — previously it was cleared here).
 *  - `answered`: the active question set was answered/submitted → clear.
 *  - `workstream-terminal`: the whole run is done/failed/cancelled → clear.
 *  - `hard-reset`: workspace switch / /clear → reset everything incl. signature.
 *  - `enriched` (2026-05-28): a LATER emission for the same question ID
 *    brings enrichment fields (context/pros/cons/recommendation/evidence) →
 *    the pill card is enriched IN PLACE, do not emit a second surface.
 *  - `dismissed` (2026-05-28): the user clicked „×" / „beantwortet" for ONE
 *    question → remove that one question, adjust the signature to the rest.
 *  - `stale-resolved` (2026-05-28): batch resolve from
 *    `detectResolvedAndStaleQuestions` (lexical match + age decay) → remove the
 *    listed IDs from the pill.
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
 * Pure reducer. Determines the next pinned open-questions state from the
 * previous state + a lifecycle event.
 *
 * Invariants (test gate Workstream 4b):
 *  - run-emitted question (`questions-detected`) → in the state.
 *  - `step-done` → state STAYS (NOT cleared) — core of the fix.
 *  - `answered` → questions removed (signature stays: the same turn does not pop
 *    up again immediately, until a NEW set with a different signature arrives).
 *  - `workstream-terminal` → cleared (run over, question obsolete).
 */
export function nextOpenQuestionsState(
  prev: OpenQuestionsState,
  event: OpenQuestionsEvent,
): OpenQuestionsState {
  switch (event.type) {
    case 'questions-detected': {
      if (event.questions.length === 0) return prev;
      const signature = questionsSignature(event.questions);
      // Same signature → no re-load (would reset given answers).
      if (signature === prev.signature) return prev;
      return { questions: event.questions, signature };
    }
    case 'step-done':
      // DELIBERATELY no-op: a step/wave end MUST NOT clear the pinned
      // question. (Previously implicit via run-end clear → owner symptom.)
      return prev;
    case 'answered':
      if (prev.questions.length === 0) return prev;
      // Questions removed, signature STAYS — protects against immediate re-pop of
      // the same turn. A new set (different signature) loads normally afterwards.
      return { questions: [], signature: prev.signature };
    case 'workstream-terminal':
      if (prev.questions.length === 0 && prev.signature === null) return prev;
      // Run over → question obsolete. ALSO clear the signature, so that a new run
      // with a (coincidentally) identical signature can pin again.
      return EMPTY_OPEN_QUESTIONS_STATE;
    case 'hard-reset':
      return EMPTY_OPEN_QUESTIONS_STATE;
    case 'enriched': {
      if (prev.questions.length === 0) return prev;
      const merged = mergeQuestionEnrichmentsById([
        ...prev.questions,
        ...event.questions,
      ]);
      // Pure-value comparison: if the merge produces IDENTICAL objects (no
      // fields changed), return unchanged — prevents pointless
      // re-renders of the pill component on repeated re-emit.
      if (sameEnrichmentValues(prev.questions, merged)) return prev;
      return { questions: merged, signature: prev.signature };
    }
    case 'dismissed': {
      if (prev.questions.length === 0) return prev;
      const remaining = prev.questions.filter((q) => q.id !== event.questionId);
      if (remaining.length === prev.questions.length) return prev; // id not present
      if (remaining.length === 0) {
        // Last question removed → pill removed, signature STAYS (no re-pop of the
        // same set until a new one with a different signature arrives).
        return { questions: [], signature: prev.signature };
      }
      // Adjust the signature to the shortened list, otherwise
      // `questions-detected` with the original signature guards the re-load.
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
      // Exhaustiveness guard.
      const _never: never = event;
      return _never;
    }
  }
}

/** Compares enrichment-relevant fields of TWO same-id-sorted lists. */
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
// 2026-05-28 — Stale-out + auto-resolve (deterministic, N6/N7: lexical, no LLM)
// ---------------------------------------------------------------------------
// OWNER-BEFUND (verbatim): „Im PA Chat ist immer noch Offene Fragen, obwohl die
// schon unfassbar alt sind und schon lange beantwortet." Concrete example:
// „Erst Copy oder erst Design, obwohl schon längst gebaut wurde" is still in
// the pill.
//
// We detect two deterministic triggers:
//
//   (a) LEXICAL-RESOLVE: after the question comes a USER message whose
//       trimmed lower-case content contains at least N content tokens of the
//       question. „Content tokens" = tokens ≥ 3 chars minus the
//       built-in stopword list (de+en, lowercase). Threshold: ≥1 if the
//       question itself has only 1 content token, otherwise ≥2 — both a deliberately
//       conservative minimum (rather leave it than delete on a false positive).
//
//   (b) AGE-DECAY: askedAt lies before the configurable cutoff
//       (default 24h OR 20 user/assistant turns after the question). Both
//       must be cumulatively true, NOT just one — safety margin against a
//       false-positive removal right after the emit.
//
// Non-goal: knowing whether the question was „actually answered". A
// real semantic evaluation requires an LLM lookup → its own slice, which would
// need the LIVE-mode consent + cost budget. Here: deterministic + idempotent.

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

/** Tokenizes a text into content tokens (≥3 chars, not a stopword). */
function contentTokens(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  // Strip surface tags + markdown bullets/headings so the match is not dominated
  // by structural remnants.
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

/** Computes how many content tokens of the question occur in `replyText`. */
function lexicalOverlap(questionText: string, replyText: string): {
  matched: number;
  needed: number;
} {
  const qTokens = new Set(contentTokens(questionText));
  if (qTokens.size === 0) return { matched: 0, needed: 1 };
  // For very short questions (1 content token) 1 match suffices — otherwise ≥2.
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
 * Options for `detectResolvedAndStaleQuestions` — everything defaults to
 * conservative values that should take effect in the live pill.
 */
export interface StaleResolveOptions {
  /** „Now" as a ms timestamp (injectable for tests). Default Date.now(). */
  nowMs?: number;
  /** Max age of a question in ms (age decay, default 24h). */
  maxAgeMs?: number;
  /** Max turns after the question (user+assistant combined), default 20. */
  maxTurnsAfter?: number;
}

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_MAX_TURNS_AFTER = 20;

/**
 * Finds the IDs of questions that, GIVEN the state of the history, count as
 * „resolved/stale" and should disappear from the pill.
 *
 * Inputs:
 *  - `questions`: question set currently pinned in the pill.
 *  - `history`: full chat history (for lexical match + turn count).
 *  - `options`: cutoffs (injectable for tests).
 *
 * Output: list of question IDs to remove (can be empty). Deterministic,
 * idempotent, side-effect-free. A returned ID means: „lexical
 * resolved" OR „cumulatively old AND many turns elapsed". Never both
 * implicit from each other.
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
    // ---- (a) Lexical resolve: ANY user message AFTER the question hits the
    // question tokens. „After the question" = index after the MOST RECENT assistant item
    // that emitted this question ID. If the item is not found,
    // the WHOLE history counts as „after".
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

    // ---- (b) Age decay: askedAt present AND > maxAge old AND ≥maxTurns
    // user+assistant items after the question. Cumulative — both required.
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
 * Finds the history index of the MOST RECENT assistant item that emitted the
 * question `qId`. -1 if not found.
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
 * Maintenance helper (NOT auto-invoked — available as a lib function).
 *
 * Takes `raw` (a surface-body JSON), scans all open-questions surfaces
 * within it, checks them against `history`/`now` with `detectResolvedAndStaleQuestions`
 * and returns the IDs that a downstream worker would mark as „resolved".
 * Does NOTHING to the DB itself — the caller decides whether it
 * e.g. sets a belief or writes a workstream_decisions row.
 *
 * Owner spec point E: „falls heute alte Pill-Items irgendwo persistiert sind …
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
