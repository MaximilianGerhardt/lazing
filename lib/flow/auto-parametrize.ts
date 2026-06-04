/**
 * lib/flow/auto-parametrize.ts — auto param extraction, slice 2b-3 (2026-06-04).
 *
 * Design: docs/plans/2026-06-04_auto-param-extraction-design.md §4. Ticket TCK-01KT8FQ7.
 *
 * When saving a recurring run as a flow_template:
 *   1. Compute the structure signature of the workstream (like the detector).
 *   2. Load the per-run captured config values (2b-1: workflow.structure_seen events)
 *      → N runs.
 *   3. diffRuns (2b-2) → variable fields = parameter candidates.
 *   4. In the STORED flow_steps.configJson, replace the observed values with
 *      {{param.<key>}} (N1: only the exact value) +
 *      write flow_templates.params_json.
 *
 * Purely deterministic (N6), raw over better-sqlite3 (in-memory testable). Needs
 * ≥2 runs (otherwise a {{param}} diff is not possible → empty result, the template stays
 * reproducible; 1-run case = slice 2b-4 LLM fallback, separate).
 */

import { parseFlowAnnotation } from './from-workstream';
import { computeStructureSignature, type SignatureStep } from './structure-signature';
import { diffRuns, type ParamCandidate, type StepRunConfig } from './param-diff';
import { suggestParamsFromSingleRun } from './param-heuristic';

type RawDb = import('better-sqlite3').Database;

export interface AutoParamResult {
  params: ParamCandidate[];
  /** Number of flow_steps in which values were replaced by {{param.*}}. */
  appliedToSteps: number;
  /** Number of compared runs. */
  runs: number;
  /**
   * true = `params` are 1-run SUGGESTIONS of the heuristic (2b-4), NOT derived from a
   * ≥2-run diff and NOT applied to the template. The owner
   * confirms them; until then the template stays unparametrized/reproducible.
   */
  heuristic: boolean;
}

/** configJson string → flat field→value map (top-level string/number/boolean). */
function parseConfigValues(configJson: string | null): Record<string, string> {
  if (!configJson) return {};
  try {
    const o: unknown = JSON.parse(configJson);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
      else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
    }
    return out;
  } catch {
    return {};
  }
}

interface PlanRow {
  rationale: string | null;
  subagent_role: string | null;
}
interface FlowStepRow {
  id: string;
  label: string | null;
  skill: string | null;
  config_json: string | null;
}

export function autoParametrizeFlow(
  raw: RawDb,
  input: { flowId: string; workstreamId: string; workspaceId: string },
): AutoParamResult {
  const empty: AutoParamResult = { params: [], appliedToSteps: 0, runs: 0, heuristic: false };
  const { flowId, workstreamId, workspaceId } = input;
  if (!flowId || !workstreamId || !workspaceId) return empty;

  // 1. Signature from the workstream (same logic as the detector). In parallel the
  //    config values of THIS (current) run for the 2b-4 heuristic fallback.
  const planRows = raw
    .prepare(
      `SELECT rationale, subagent_role FROM workstream_plan_steps
        WHERE workstream_id = ? AND depth = 0 ORDER BY step_index ASC`,
    )
    .all(workstreamId) as PlanRow[];
  if (planRows.length === 0) return empty;
  const currentRun: StepRunConfig[] = [];
  const sigSteps: SignatureStep[] = planRows.map((r, i) => {
    const { annotation } = parseFlowAnnotation(r.rationale ?? '');
    const skill = annotation?.skill ?? (r.subagent_role ?? null);
    currentRun.push({
      label: skill ?? `step-${i}`,
      values: parseConfigValues(annotation?.configJson ?? null),
    });
    return {
      skill,
      toolKind: annotation?.toolKind ?? null,
      connectorId: annotation?.connectorId ?? null,
    };
  });
  const signature = computeStructureSignature(sigSteps);

  // 2. Load captured config runs of this signature (2b-1 events).
  let events: { payload: string }[];
  try {
    events = raw
      .prepare(
        `SELECT payload FROM events
          WHERE segment_id = ? AND entity_id = ? AND event_type = 'workflow.structure_seen'
          ORDER BY created_at ASC`,
      )
      .all(workspaceId, signature) as { payload: string }[];
  } catch {
    return empty;
  }
  const runs: StepRunConfig[][] = [];
  for (const e of events) {
    try {
      const p = JSON.parse(e.payload) as { configs?: Array<{ label: string; config: string | null }> };
      if (Array.isArray(p.configs)) {
        runs.push(p.configs.map((c) => ({ label: c.label, values: parseConfigValues(c.config) })));
      }
    } catch {
      /* skip a corrupted event */
    }
  }
  if (runs.length < 2) {
    // 2b-4: no diff possible → deterministic 1-run heuristic (N6) as a
    // SUGGESTION (no template rewrite, owner confirms). The template stays
    // unparametrized + reproducible.
    const suggested = suggestParamsFromSingleRun(currentRun);
    return { params: suggested, appliedToSteps: 0, runs: runs.length, heuristic: true };
  }

  // 3. Diff → parameter candidates.
  const diff = diffRuns(runs);
  if (diff.params.length === 0) return { ...empty, runs: runs.length };

  // 4. Rewrite stored flow_steps (value → {{param.key}}).
  const flowSteps = raw
    .prepare(`SELECT id, label, skill, config_json FROM flow_steps WHERE flow_id = ? ORDER BY idx ASC`)
    .all(flowId) as FlowStepRow[];
  let applied = 0;
  for (const fs of flowSteps) {
    if (!fs.config_json) continue;
    let cfg = fs.config_json;
    const stepLabel = fs.skill ?? fs.label ?? '';
    for (const p of diff.params) {
      if (p.stepLabel !== stepLabel) continue;
      for (const val of p.observed) {
        // Replace only the exact (JSON-escaped) value — N1, no slice.
        const needle = JSON.stringify(val).slice(1, -1);
        if (needle.length > 0 && cfg.includes(needle)) {
          cfg = cfg.split(needle).join(`{{param.${p.key}}}`);
        }
      }
    }
    if (cfg !== fs.config_json) {
      raw.prepare(`UPDATE flow_steps SET config_json = ? WHERE id = ?`).run(cfg, fs.id);
      applied += 1;
    }
  }

  // 5. Write params_json onto the template.
  const paramsJson = JSON.stringify(
    diff.params.map((p) => ({ key: p.key, label: p.field, type: 'string', observed: p.observed })),
  );
  try {
    raw.prepare(`UPDATE flow_templates SET params_json = ? WHERE id = ?`).run(paramsJson, flowId);
  } catch {
    /* params_json column missing (migration 0130 not applied) → steps only */
  }

  return { params: diff.params, appliedToSteps: applied, runs: runs.length, heuristic: false };
}
