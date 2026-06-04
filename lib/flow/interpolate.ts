/**
 * lib/flow/interpolate.ts — Self-Learning slice 2: parametrization.
 *
 * Design: docs/plans/2026-06-03_self-learning-workflow-recording-design.md (b).
 *
 * Pure, deterministic interpolation (N6) of `{{param.<key>}}` placeholders in
 * flow-step texts (title/configJson). Makes a recorded template
 * REUSABLE instead of merely reproducible: the same reel flow runs again with a
 * different `topic` param.
 *
 * N1 discipline: the STORED template stays verbatim; ONLY a copy is interpolated
 * at runtime. If a param value is missing, the placeholder stays
 * unchanged (visible instead of silently wrong) — fail-visible.
 *
 * Slice 2 covers `{{param.*}}`. The step→step chaining `{{step.X.output.Y}}`
 * (runtime output capture) is a later slice and is deliberately NOT
 * resolved here (the placeholder stays).
 */

export type ParamValue = string | number | boolean | string[];
export type ParamValues = Record<string, ParamValue>;

const PARAM_RE = /\{\{\s*param\.([a-zA-Z0-9_-]+)\s*\}\}/g;

/** Materialize a param value into a string (arrays comma-separated). */
function materialize(v: ParamValue): string {
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

/**
 * Replaces `{{param.key}}` in `text` with the value from `params`. Unknown keys
 * stay unchanged (fail-visible). Returns `text` 1:1 if there is nothing to do
 * (no placeholder / empty params) — then it is a no-op (no regression).
 */
export function interpolateParams(text: string, params: ParamValues | undefined): string {
  if (!text || !params) return text;
  if (!text.includes('{{')) return text;
  return text.replace(PARAM_RE, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      return materialize(params[key]!);
    }
    return match; // unknown param → leave the placeholder visible
  });
}

/**
 * Interpolates a `configJson` blob (string). Since configJson is itself a
 * JSON string, we interpolate at the string level (before the parse by
 * the step executor) — this keeps N1 (no re-serialize drift) and is robust
 * against arbitrary config structure. Passes null through when null.
 */
export function interpolateConfigJson(
  configJson: string | null,
  params: ParamValues | undefined,
): string | null {
  if (configJson == null) return null;
  return interpolateParams(configJson, params);
}

/** Defensive: sanitize a raw param-values record (e.g. from the request body). */
export function sanitizeParamValues(raw: unknown): ParamValues {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: ParamValues = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(k)) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = v.filter((x): x is string => typeof x === 'string');
    }
  }
  return out;
}
