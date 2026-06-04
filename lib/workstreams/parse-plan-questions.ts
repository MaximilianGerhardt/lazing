/**
 * Sub-plan 02 — plan-markdown question extractor.
 *
 * Finds the `## Offene Fragen` (or `## Open Questions`) section in the
 * V_n plan output + extracts the individual bullet points. Accepts various
 * variants:
 *   - `- [?] <frage>`
 *   - `- <frage>`
 *   - `* <frage>`
 *   - Plus the DACH-common „[?]" marker at the start.
 *
 * Stop marker: next `##` section, end of string, or a code fence ```.
 */

export interface PlanQuestion {
  text: string;
  /** Optional: short hash for stable IDs (for surface tracking). */
  id: string;
  /**
   * Sub-plan D (2026-04-30) — QuickChoice buttons.
   * When the question was written in the plan markdown in the format
   *   `- [?] <Frage> | OPTIONS: A | B | C`
   * this array contains the trimmed options
   * (max 5). The renderer then shows click buttons instead of a textarea.
   * Empty array or undefined → free-text fallback.
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
 * De-dupe (2026-05-26, bug report Max): the build/swarm DEPTH is already
 * asked by the dedicated depth picker (SubplanCard „PLAN ERKANNT — wie tief?",
 * Schnell/Standard/Tief). When the plan LLM ADDITIONALLY writes the same
 * decision as an open question („Build-Tiefe?", „Wie viele Agenten?"), two
 * surfaces arise for ONE decision → confusing + contradictory. Such questions
 * are discarded here; the picker stays the only depth/spawn source.
 * Content questions (tech stack, copy vs design, …) are left untouched.
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

  // Find the section-header match
  let startIndex = -1;
  for (const re of SECTION_HEADERS) {
    const m = re.exec(planText);
    if (m && m.index !== undefined) {
      startIndex = m.index + m[0].length;
      break;
    }
  }
  if (startIndex < 0) return [];

  // Read up to the next ## or end
  const rest = planText.slice(startIndex);
  const stopMatch = /\n##\s+/m.exec(rest);
  const sectionEnd = stopMatch ? stopMatch.index : rest.length;
  const block = rest.slice(0, sectionEnd);

  // Extract bullet lines
  const lines = block.split('\n');
  const questions: PlanQuestion[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    // Match `- ` or `* ` or `1.` or an optional `[?]` marker before it
    const m = /^[-*]\s+(?:\[\?\]\s+)?(.*)$/i.exec(line);
    if (!m) continue;
    const rawText = m[1].trim();
    if (rawText.length < 3) continue; // noise filter
    // Code fence opens/closes? Ignore if inside one
    if (rawText.startsWith('```')) continue;

    // Sub-plan D (2026-04-30): split off the OPTIONS: suffix.
    //
    // C1 (2026-05-29, bug report Max + owner directive handoff §9, N1):
    // comma as an options separator REMOVED. Observed data from
    // example-website-project showed that "Copy zuerst (SOP-Logik,
    // empfohlen)" broke into two broken options ("Copy zuerst (SOP-Logik" +
    // "empfohlen)") because the internal comma acted as a separator. Pipe `|`
    // is from now on the ONLY canonical separator — the LLM prompt already
    // demands a pipe (see buildRepromptHint l.201), so no regression for
    // correctly formatted plans.
    //
    // C2: additionally we accept a structured JSON path
    //   "<frage> | OPTIONS_JSON: [\"A\",\"B (mit, Komma)\",\"C\"]"
    // for future prompts that emit options cleanly as a JSON array —
    // without markdown-parsing tricks.
    //
    // Accepted formats:
    //   "<frage> | OPTIONS: A | B | C"
    //   "<frage> | OPTIONS_JSON: [\"A\",\"B\",\"C\"]"
    let text = rawText;
    let options: string[] | undefined;

    // C2 — JSON-first path (additive, takes precedence over pipe parsing).
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
              .map((s) => s.trim()) // C3 — whitespace normalization
              .filter((s) => s.length > 0) // C3 — discard empties
              .slice(0, 5);
            if (parts.length > 0) {
              text = head;
              options = parts;
            }
          }
        } catch {
          // Invalid JSON → we don't let the pipe fallback kick in, because the
          // user explicitly chose OPTIONS_JSON:; the question slips through as
          // free text (safe, non-destructive).
        }
      }
    }

    if (!options) {
      // Pipe-only fallback (C1).
      const optMatch = /^(.*?)\s*[|]\s*OPTIONS\s*:\s*(.+)$/i.exec(rawText);
      if (optMatch) {
        const head = optMatch[1].trim();
        const tail = optMatch[2].trim();
        if (head.length >= 3 && tail.length > 0) {
          const parts = tail
            .split(/\s*\|\s*/) // C1 — pipe is from now on the ONLY separator.
            .map((s) => s.trim()) // C3 — whitespace normalization
            .filter((s) => s.length > 0) // C3 — discard empties
            .slice(0, 5);
          if (parts.length > 0) {
            text = head;
            options = parts;
          }
        }
      }
    }

    // De-dupe: depth/spawn questions belong to the depth picker, not the
    // open-questions card (otherwise two surfaces for one decision).
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
 * Sub-plan 03 — pattern 1 (symbolic guards, 2026-04-30).
 *
 * Quota check for the OPTIONS requirement. Returns a verdict that
 * runIterate/runSynthesis/runIterateResume use to trigger ONE
 * automatic reprompt on a violation.
 *
 * Rules (from the V_final synthesis):
 * 1. Minimum coverage: ≥80% of questions have options[].
 * 2. Minimum distinct: every options list has ≥2 distinct entries
 *    (format-gaming protection: „A | A | A" would otherwise slip through).
 * 3. With <2 questions total: quota check skipped (too little data).
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
 * Reprompt system hint for the symbolic-guard trigger.
 * Injected into the next lead prompt when the quota is missed.
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
// Legacy repair (2026-05-29, C4)
// ---------------------------------------------------------------------------
//
// C4 — backward-compat guard. Before the C1 fix (comma as a generic
// options separator), options with an embedded comma like
// "Copy zuerst (SOP-Logik, empfohlen)" were cut into two broken options:
//   ["Copy zuerst (SOP-Logik", "empfohlen)", "Design zuerst", "Beides parallel"]
//
// Such already-PERSISTED broken options arrays are no longer worsened by
// new parser calls (the new parser never sees the DB data),
// but they are also not self-healing. This helper heuristically rejoins all
// fragments that have open `(` parentheses without a closing `)` with the
// following fragment. Deliberately NO auto-invocation — the owner can
// apply it later to old records via a maintenance script.
//
// Guarantees:
//   - Pure `A | B | C` arrays stay unchanged (roundtrip-stable).
//   - On an unmatched `(`: the next fragment is appended with ", ".
//   - At most 5 options at the end (same cap as the parser).

/**
 * Heuristic-only legacy repair for already-persisted broken options[].
 * The owner can apply this as an opt-in maintenance script to old workstream
 * records. NOT called automatically by the parser.
 */
export function repairLegacyOptions(opts: readonly string[]): string[] {
  if (!Array.isArray(opts) || opts.length === 0) return [];
  const out: string[] = [];
  let buffer: string | null = null;
  for (const raw of opts) {
    const part = typeof raw === 'string' ? raw.trim() : '';
    if (part.length === 0) continue;
    if (buffer !== null) {
      // We had an open "(" — append this part.
      buffer = `${buffer}, ${part}`;
    } else {
      buffer = part;
    }
    // Match: is the parenthesis still open?
    const opens = (buffer.match(/\(/g) ?? []).length;
    const closes = (buffer.match(/\)/g) ?? []).length;
    if (opens > closes) {
      // keep collecting
      continue;
    }
    out.push(buffer);
    buffer = null;
  }
  // If an open buffer still exists at the end (e.g. never closed):
  // take it anyway, otherwise we lose data.
  if (buffer !== null) out.push(buffer);
  return out.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Chat inline split (2026-05-23)
// ---------------------------------------------------------------------------
// Bug report (Max): the `## Offene Fragen` section in free chat replies
// was NOT clickable — it was rendered as dead markdown bullets. The
// click mechanic existed only for `<surface:open-questions>` with an active
// workstream (POST /inject). In free chat (without a workstream) every
// renderer path was missing.
//
// This helper finds the section in arbitrary markdown and splits it into
// `before` / `questions` / `after`, so the chat text renderer can
// render the middle part as an interactive QuickChoice card.

/**
 * Matches an open-questions heading line (`## Offene Fragen`,
 * `## Open Questions`, `## Fragen`, `## Questions`) — deliberately the same
 * variants as SECTION_HEADERS, but as ONE regex with index capture.
 */
const ANY_OQ_HEADER =
  /^##[ \t]+(?:Offene[ \t]+Fragen|Open[ \t]+Questions|Fragen|Questions)\b[^\n]*$/im;

export interface OpenQuestionsSplit {
  /** Markdown before the heading line (incl. a possible `## User-Sicht` etc.). */
  before: string;
  /** Parsed questions of the section (with optional `options[]`). */
  questions: PlanQuestion[];
  /** Markdown from the next `##` section after the questions (or ''). */
  after: string;
}

/**
 * Finds the first open-questions section in `text` and splits around it.
 * Returns null when no section exists, no questions are parseable, or
 * the heading line sits inside a ``` code fence (a format explanation instead of
 * a real section → no quasi-render).
 */
export function splitOpenQuestionsSection(
  text: string,
): OpenQuestionsSplit | null {
  if (!text || text.indexOf('#') < 0) return null;

  const m = ANY_OQ_HEADER.exec(text);
  if (!m || m.index === undefined) return null;
  const headingStart = m.index;

  // Code-fence guard: an odd number of ``` before the heading → we are INSIDE
  // a fence (e.g. the agent is explaining the format), not in a section.
  const fencesBefore = (text.slice(0, headingStart).match(/```/g) ?? []).length;
  if (fencesBefore % 2 === 1) return null;

  const headingEnd = headingStart + m[0].length;
  const rest = text.slice(headingEnd);
  const stop = /\n##[ \t]+/m.exec(rest);
  const after = stop ? rest.slice(stop.index).replace(/^\n+/, '') : '';

  // parsePlanQuestions finds the header again in the slice + reads up to the
  // next `##` — so it returns exactly the questions of THIS section.
  const questions = parsePlanQuestions(text.slice(headingStart));
  if (questions.length === 0) return null;

  return { before: text.slice(0, headingStart), questions, after };
}
