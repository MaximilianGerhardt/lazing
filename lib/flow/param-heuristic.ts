/**
 * lib/flow/param-heuristic.ts — auto param extraction, slice 2b-4 (pure, N6).
 *
 * Design: docs/plans/2026-06-04_auto-param-extraction-design.md §5.
 *
 * The 1-run case: with only ONE recorded run no diff (2b-2) is possible —
 * the comparison that separates "variable vs. constant" is missing. Instead of
 * delivering nothing, this purely DETERMINISTIC heuristic (N6: deterministic
 * BEFORE symbolic — NO LLM in the routine path, N11) suggests which config fields
 * are likely parameters, based on field names + value form.
 *
 * IMPORTANT — suggestion, not automation: 1-run tips are low-confidence
 * (a single observation). The caller (auto-parametrize.ts) does NOT
 * apply them automatically to the template — it returns them as a suggestion; the
 * owner confirms in the flow editor. So the template stays reproducible
 * even on a wrong guess.
 *
 * An optional gated LLM refinement (deepseek, N11) is planned as a seam, but
 * deliberately NOT wired into the default path (no heavy model per /learn).
 */

import type { ParamCandidate, StepRunConfig } from './param-diff';

/** Deterministic slug (identical to param-diff, kept local = pure). */
function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'param'
  );
}

/**
 * Field names that typically name an input parameter (DE + EN).
 * Conservative: prefer few sure hits over over-parametrization.
 */
const NAME_HINT =
  /(topic|thema|title|titel|subject|betreff|query|suche|prompt|keyword|stichwort|theme|url|link|date|datum|zeit|recipient|empf(ae|ä)nger|region|ort|location|sprache|language|audience|zielgruppe|product|produkt|kunde|customer|client|firma|company|message|nachricht|frage|question|search|goal|ziel|inhalt|content|description|beschreibung|name)/i;

/**
 * Field names that are almost always CONSTANT configuration (brand/style/engine) —
 * never suggest as a parameter, even if the value looks "text-like".
 */
const NAME_EXCLUDE = /(brand|voice|tone|stil|style|model|engine|version|enabled|schema|format|mode|type|kind|locale|system)/i;

const VALUE_URL = /^https?:\/\/\S+$/i;
const VALUE_DATE = /^(\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{2,4})/;

/** Value looks "parameter-like": URL, date or free text (sentence). */
function valueLooksLikeParam(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return false;
  if (VALUE_URL.test(v)) return true;
  if (VALUE_DATE.test(v)) return true;
  // Free text: sufficiently long AND with spaces (several words) → more likely
  // a topic/prompt than an enum/flag value.
  if (v.length >= 24 && /\s/.test(v)) return true;
  return false;
}

/**
 * Suggests parameter candidates from ONE run (field-name OR value heuristic,
 * minus exclusion names). Keys are derived deterministically — identical
 * to the diffRuns logic (unique field → field slug, otherwise `step_field`, collision
 * → `_n`), so that a later ≥2-run diff produces the same keys.
 *
 * `observed` contains the ONE observed value (N1: verbatim).
 */
export function suggestParamsFromSingleRun(run: StepRunConfig[]): ParamCandidate[] {
  // 1. Collect raw candidates (step + field + value), drop duplicates per (label,field).
  interface Raw {
    stepLabel: string;
    field: string;
    value: string;
  }
  const raws: Raw[] = [];
  const seenStepField = new Set<string>();
  for (const step of run) {
    for (const [field, value] of Object.entries(step.values)) {
      if (NAME_EXCLUDE.test(field)) continue;
      const isCandidate = NAME_HINT.test(field) || valueLooksLikeParam(value);
      if (!isCandidate) continue;
      const sf = `${step.label}::${field}`;
      if (seenStepField.has(sf)) continue;
      seenStepField.add(sf);
      raws.push({ stepLabel: step.label, field, value });
    }
  }

  // 2. Field-name frequency → decides field slug vs. step_field (like diffRuns).
  const fieldCounts = new Map<string, number>();
  for (const r of raws) fieldCounts.set(r.field, (fieldCounts.get(r.field) ?? 0) + 1);

  // 3. Derive keys (deterministic, collision-free).
  const usedKeys = new Set<string>();
  const params: ParamCandidate[] = [];
  for (const r of raws) {
    const base = (fieldCounts.get(r.field) ?? 0) > 1 ? `${slug(r.stepLabel)}_${slug(r.field)}` : slug(r.field);
    let key = base;
    let n = 2;
    while (usedKeys.has(key)) key = `${base}_${n++}`;
    usedKeys.add(key);
    params.push({ key, stepLabel: r.stepLabel, field: r.field, observed: [r.value] });
  }

  params.sort((a, b) => a.key.localeCompare(b.key));
  return params;
}
