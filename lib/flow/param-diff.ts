/**
 * lib/flow/param-diff.ts — auto param extraction, slice 2b-2 (pure, N6).
 *
 * Design: docs/plans/2026-06-04_auto-param-extraction-design.md §3.
 *
 * The "uncanny instinct": from N runs of the SAME run structure, derive
 * which config values VARY (= parameters) and which are CONSTANT (= hard-
 * coded). Purely deterministic — no LLM, no I/O. Compares steps by
 * (label, position) and config fields.
 */

export interface StepRunConfig {
  /** Step label (stable across runs). */
  label: string;
  /** Parsed config fields of this step in THIS run (field → value as string). */
  values: Record<string, string>;
}

export interface ParamCandidate {
  /** Derived, deterministic parameter key (e.g. `topic`, `step2_prompt`). */
  key: string;
  /** Step to which the variable field belongs. */
  stepLabel: string;
  /** Config field name. */
  field: string;
  /** The distinct observed values across the runs (N1: verbatim). */
  observed: string[];
}

export interface DiffResult {
  /** Variable fields → parameter candidates. */
  params: ParamCandidate[];
  /** Number of constant (hard-coded) fields. */
  constantCount: number;
  /** How many runs were compared. */
  runs: number;
}

/** Deterministic slug from a string (for key derivation). */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'param';
}

/**
 * Compares the config values across N runs (≥2 needed). Steps are matched by
 * (label, occurrence index) — so two steps with the same
 * label don't collide. Returns the variable fields as parameter candidates.
 */
export function diffRuns(runs: StepRunConfig[][]): DiffResult {
  if (runs.length < 2) return { params: [], constantCount: 0, runs: runs.length };

  // Key per field: `${stepLabel}#${occurrenceIdx}.${field}` → distinct values (in order).
  const observedByKey = new Map<string, { stepLabel: string; field: string; values: string[] }>();

  for (const run of runs) {
    // Occurrence index per label within a run (two "copy" steps → #0,#1).
    const labelSeen = new Map<string, number>();
    for (const step of run) {
      const occ = labelSeen.get(step.label) ?? 0;
      labelSeen.set(step.label, occ + 1);
      for (const [field, value] of Object.entries(step.values)) {
        const k = `${step.label}#${occ}.${field}`;
        let entry = observedByKey.get(k);
        if (!entry) {
          entry = { stepLabel: step.label, field, values: [] };
          observedByKey.set(k, entry);
        }
        if (!entry.values.includes(value)) entry.values.push(value);
      }
    }
  }

  const params: ParamCandidate[] = [];
  let constantCount = 0;
  // How often a field name occurs across all candidates → decides whether the
  // key can consist of the field alone or must be prefixed with the step slug.
  const fieldCounts = new Map<string, number>();
  for (const e of observedByKey.values()) {
    if (e.values.length >= 2) fieldCounts.set(e.field, (fieldCounts.get(e.field) ?? 0) + 1);
  }

  const usedKeys = new Set<string>();
  for (const e of observedByKey.values()) {
    if (e.values.length < 2) {
      constantCount += 1;
      continue;
    }
    // Key derivation: unique field → field slug; otherwise step_field; collision → suffix.
    let base = (fieldCounts.get(e.field) ?? 0) > 1 ? `${slug(e.stepLabel)}_${slug(e.field)}` : slug(e.field);
    let key = base;
    let n = 2;
    while (usedKeys.has(key)) key = `${base}_${n++}`;
    usedKeys.add(key);
    params.push({ key, stepLabel: e.stepLabel, field: e.field, observed: e.values });
  }

  // Stable order (deterministic): by key.
  params.sort((a, b) => a.key.localeCompare(b.key));
  return { params, constantCount, runs: runs.length };
}
