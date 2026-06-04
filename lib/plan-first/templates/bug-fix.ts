// Plan template — bug-fix (5 steps).
//
// BACKPORT-03 von Lazing-V2 (2026-05-23). Bytewise identisch zur V2-Quelle:
// lazing-wt/realtime-orchestrator-v2/apps/web/src/lib/plan-first/templates/bug-fix.ts
//
// Canonical "reproduce → locate → fix → verify → review" loop. Wins over
// every other template when both match (operators frequently embed
// bug-fix verbs in larger requests; matching the surgical template
// avoids accidentally promoting a hotfix to a 7-step feature plan).
//
// Regex anchors (N6 deterministic, SHARPENED 2026-05-29 Slice A):
//   - Match A — imperative bug-fix verbs at clause start
//       (fix / behebe / repariere / patch / hotfix / debug / korrigiere /
//        löse [den/das/die] [bug|fehler|problem])
//   - Match B — bug nouns (bug / fehler / problem / error / exception /
//       regression / crash / leak / panic / …) GATED BY code-noun
//       proximity (±150 chars). The bare word "problem"/"fehler"
//       alone NEVER matches — that was the false-positive root cause
//       (`lib/plan-first/templates/bug-fix.ts`) where the original
//       single-flat regex matched any prompt containing "Problem" (e.g.
//       owner briefs like "wir haben das problem dass die dienstleistung…").
//
// N1: titles + rationales are verbatim; the matcher never reformats
// the operator's intent text. The template is *added* as steps; the
// operator can edit them in the Plan-Surface before approval.
//
// N6: deterministic, regex-only, no LLM roundtrip. Same input ⇒ same
// matcher verdict every time.

import type { PlanTemplate } from './index';

// ---------------------------------------------------------------------------
// Match A — Imperative verbs at clause start.
//
// Anchored to start-of-string OR start-of-clause (after whitespace
// after a `.`, `?`, `!`, `;`, `:`, `-` or newline). This is the
// "low-friction core" path: when an operator types `fix the auth bug`
// or `behebe den login-bug`, the imperative verb at the start of the
// clause is unambiguous bug-fix intent — no proximity check needed.
//
// DE imperatives covered: behebe / repariere / korrigiere /
// löse (with optional "den/das/die" + optional bug-noun) / debug(gen|ge) /
// patch(e|en|ed)? / hotfix.
// EN imperatives covered: fix(e|es|ed)? / patch / debug / hotfix.
//
// Note: "löse" + bug-noun is its own sub-pattern because "löse das Problem"
// is unambiguous, but "löse" on its own (e.g. "löse die Aufgabe") is not.
// ---------------------------------------------------------------------------
export const BUG_FIX_IMPERATIVE_REGEX =
  /(?:^|[.?!;:\-\n]\s*)(fix(?:e|es|ed)?|behebe|repariere|korrigiere|debug(?:gen|ge)?|patch(?:e|en|ed)?|hotfix|löse(?:n)?\s+(?:das|den|die)\s+(?:bug|fehler|problem|regression|crash|leak))\b/i;

// ---------------------------------------------------------------------------
// Match B — Bug-nouns. ONLY a bug-fix trigger when a code-noun appears
// in proximity (see CODE_NOUN_REGEX + matchesBugFixIntent below).
//
// Vocabulary: bug / fehler / problem / error / exception / regression /
// crash / leak / panic / segfault / deadlock + multi-word "race condition" /
// "memory leak" / "null pointer" / "stack overflow" / "out of memory" /
// "type error" / "reference error" / "syntax error" / "core dump".
// ---------------------------------------------------------------------------
export const BUG_FIX_NOUN_REGEX =
  /\b(bug|fehler|problem|error|exception|regression|crash|leak|panic|segfault|deadlock|race\s+condition|memory\s+leak|null\s+pointer|stack\s+overflow|out\s+of\s+memory|type\s+error|reference\s+error|syntax\s+error|core\s+dump)\b/i;

// ---------------------------------------------------------------------------
// Code-noun anchor list. A bug-noun (Match B) is only treated as bug-fix
// intent if a code-noun appears within ±150 chars of it. This filters
// generic business / strategy / market uses of "Problem" / "Fehler"
// (e.g. "Problem unserer Dienstleistung", "Problem im Markt") while
// keeping real bug reports (e.g. "Problem im API-Handler bei POST
// /workspaces", "Fehler in Migration 0042") matching.
//
// Sources for the vocabulary:
//   - language constructs: function / class / module / import / export / hook /
//     effect / reducer / selector / query / mutation / store / state / prop /
//     context / provider / service / controller / model / view
//   - infra surface: api / endpoint / route / handler / component / test /
//     build / deploy / server / client / database / datenbank / migration /
//     schema / repo / repository / commit / PR / pull request / merge / branch
//   - runtime artefacts: spawn / compile / runtime / stack / trace / log /
//     callsite / file:line / line NN / column NN / status code / http NNN /
//     exit code / signal / SIGTERM / SIGKILL
//   - failure modes: regression / exception / null pointer / undefined /
//     type error / reference error / syntax error / race condition /
//     deadlock / stack overflow / out of memory / segfault / core dump / panic /
//     memory leak / leak
//
// Multi-word phrases are split into single-word alternations where the
// single word is itself a strong code-anchor (e.g. `migration`, `schema`,
// `handler`); compound phrases like `pull request` are included verbatim.
// ---------------------------------------------------------------------------
export const CODE_NOUN_REGEX =
  /\b(function|method|funktion|klasse|class|api|endpoint|route|handler|component|test|build|deploy|server|client|database|datenbank|migration|schema|repo|repository|commit|pr|pull\s+request|merge|branch|spawn|compile|runtime|module|import|export|hook|effect|reducer|selector|query|mutation|store|state|prop|context|provider|service|controller|model|view|router|middleware|middleware-kette|callsite|file:line|line\s+\d+|column\s+\d+|http\s+\d{3}|exit\s+code|signal|sigterm|sigkill|stack\s+trace|stack\s+overflow|null\s+pointer|undefined|type\s+error|reference\s+error|syntax\s+error|race\s+condition|deadlock|out\s+of\s+memory|segfault|core\s+dump|panic|memory\s+leak|leak|regression|exception|trace|log|stack)\b/i;

// Proximity window: ±150 characters around the bug-noun match.
// Picked empirically: covers "Problem im API-Handler bei POST /workspaces"
// (~50 chars) and "Fehler in der Migration 0042 die wir gestern deployed
// haben" (~70 chars) but excludes whole-paragraph drift where the noun
// is in a business sentence and a code-noun appears in an unrelated
// later sentence.
const PROXIMITY_CHARS = 150;

/**
 * Determines whether `text` carries bug-fix intent.
 *
 * Two pathways (N6 deterministic):
 *   - Match A — imperative verb at clause start (`fix`, `behebe`, `patch`, …).
 *     Fires directly; no proximity check needed.
 *   - Match B — bug-noun (`bug`, `fehler`, `problem`, `error`, `exception`, …)
 *     AND a code-noun within ±150 chars of the bug-noun match.
 *
 * Generic uses of "problem" / "fehler" without code-noun proximity
 * intentionally do NOT match (the 2026-05-29 owner-reported defect).
 *
 * @param text — operator intent text (already trimmed by the caller).
 * @returns true iff bug-fix intent is detected.
 */
export function matchesBugFixIntent(text: string): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;

  // Match A — imperative-at-clause-start wins immediately.
  if (BUG_FIX_IMPERATIVE_REGEX.test(trimmed)) {
    return true;
  }

  // Match B — bug-noun gated by code-noun proximity.
  // Walk every bug-noun occurrence, check ±150 chars for a code-noun.
  // Use a fresh non-global regex with `exec` in a loop so we can inspect
  // each occurrence's index. We rebuild the regex with the `g` flag
  // locally to iterate all matches.
  const nounIter = new RegExp(BUG_FIX_NOUN_REGEX.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = nounIter.exec(trimmed)) !== null) {
    const start = Math.max(0, m.index - PROXIMITY_CHARS);
    const end = Math.min(
      trimmed.length,
      m.index + m[0].length + PROXIMITY_CHARS,
    );
    const window = trimmed.slice(start, end);
    if (CODE_NOUN_REGEX.test(window)) {
      return true;
    }
    // Avoid infinite loop on zero-width matches.
    if (m.index === nounIter.lastIndex) {
      nounIter.lastIndex += 1;
    }
  }

  return false;
}

/**
 * @deprecated Use `matchesBugFixIntent` instead. Retained as a no-op
 * regex shape for backwards compatibility with any external importer
 * that referenced the old single-flat regex. The actual matching is now
 * done by `matchesBugFixIntent` which combines imperative + proximity
 * pathways.
 *
 * IMPORTANT: This regex is intentionally identical to
 * `BUG_FIX_IMPERATIVE_REGEX` so direct `.test()` calls on it produce
 * conservative (no-false-positive) behaviour even when called outside
 * `matchesBugFixIntent`.
 */
export const BUG_FIX_REGEX = BUG_FIX_IMPERATIVE_REGEX;

export const bugFixTemplate: PlanTemplate = {
  id: 'bug-fix',
  label: 'Bug fix (reproduce → locate → fix → verify → review)',
  estimatedComplexity: 'M',
  steps: [
    {
      index: 1,
      title: 'Reproduce the bug deterministically',
      rationale:
        'Without a stable repro the rest of the loop becomes guesswork — capture the minimal trigger before changing any code.',
      subagentRole: 'tester',
    },
    {
      index: 2,
      title: 'Locate the failing code path',
      rationale:
        'Trace from the symptom to the smallest function whose behaviour explains the failure; record the file + line for the fix step.',
      subagentRole: 'architect',
    },
    {
      index: 3,
      title: 'Apply the smallest correct fix',
      rationale:
        'Change only the lines needed; avoid drive-by refactors so the review surface stays scoped to the bug.',
      subagentRole: 'coder',
    },
    {
      index: 4,
      title: 'Verify the bug is gone and add a regression test',
      rationale:
        'Run the repro from step 1 → assert green; commit a test that fails without the patch so the bug stays fixed.',
      subagentRole: 'tester',
    },
    {
      index: 5,
      title: 'Review the diff for unintended scope',
      rationale:
        'Re-read the patch with fresh eyes; confirm no unrelated edits leaked in, no logging stripped, no side effects added.',
      subagentRole: 'reviewer',
    },
  ],
};
