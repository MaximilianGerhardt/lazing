// Plan-First mode — LLM-driven plan proposer for COMPLEX programming intents.
//
// BACKPORT-03 von Lazing-V2 (2026-05-23 · Agent 3/8).
// Quelle: lazing-wt/realtime-orchestrator-v2/apps/web/src/lib/plan-first/
//         orchestrate-plan.ts (330 LOC, V2 Slice C).
//
// Für komplexe Programmier-Intents erwartet der Operator:
//
//   1. Das Plan-Surface erscheint ZUERST (noch kein Code läuft, nur ein Plan).
//   2. Der Operator approved/editiert den Plan.
//   3. Approved Plan-Steps spawnen parallele Coder-Subagents — jeder Step
//      wird zu einer eigenen Subdispatch.
//
// Dieses Modul besitzt Schritt (1): gegeben das verbatim User-Intent ruft es
// das Routing-LLM mit einem plan-shaped Prompt und gibt eine geparste,
// validierte `ProposedPlan` zurück. Schritt (3) ist die approve-plan-route,
// die den (möglicherweise editierten) Plan in Follow-up-Intents umwandelt
// und in die reguläre `dispatchIntent`-Pipeline einspeist.
//
// Discipline:
//   - N1: jeder PlanStep.title + rationale ist VERBATIM aus der LLM-Emission —
//     wir formatieren NICHT um, sliceн NICHT. Das ProposedPlan trägt
//     `originalIntent` 1:1 vom Operator.
//   - N6: deterministischer JSON-Validator (`parseProposedPlan`) gated den
//     LLM-Output vor jedem Dispatch. Hard-Fail bei malformed shape, missing
//     fields, wrong types.
//   - N11: max 7 Steps (small/fast iteration loop; bei mehr trunc'en wir).

import { randomUUID } from 'node:crypto';

const MIN_STEPS = 1;
const MAX_STEPS = 7;

export type PlanSubagentRole = 'architect' | 'coder' | 'tester' | 'reviewer';

const VALID_COMPLEXITIES: ReadonlySet<ProposedPlan['estimatedComplexity']> =
  new Set(['M', 'L', 'XL']);
const VALID_ROLES: ReadonlySet<PlanSubagentRole> = new Set<PlanSubagentRole>([
  'architect',
  'coder',
  'tester',
  'reviewer',
]);

export interface PlanStep {
  readonly id: string;
  /** 1-based, source-order. */
  readonly index: number;
  /** Short, action-oriented — verbatim from the LLM (N1). */
  readonly title: string;
  /** One-sentence reason — verbatim (N1). */
  readonly rationale: string;
  /** 1-3 path-heuristic file hints; may be inaccurate. */
  readonly targetFiles?: readonly string[];
  /** Role steering which engine / subagent picks the step up. */
  readonly subagentRole?: PlanSubagentRole;
  /**
   * 1-3 keyword artifacts THIS step produces (e.g. "failing test",
   * "pr/feature-x", "profiling report"). Verbatim from the LLM
   * proposer (N1). Consumed by the plan-walker to build SubagentHandoff
   * `expectedArtifacts` and downstream `dependencies` lists so the next
   * step's subagent knows what predecessors emitted.
   */
  readonly expectedArtifacts?: readonly string[];
  /**
   * Tools this step is permitted to request at the R2 execution gate.
   * e.g. ['Read', 'Grep'] (read-only default) or ['Read', 'Grep', 'Write', 'Edit']
   * for a coder step that needs to write files.
   *
   * undefined / absent → conservative default ['Read', 'Grep'] applied at runtime
   * by plan-executor.ts. Only write/edit-capable steps need to carry an explicit
   * allowedTools list (N6: gate reads real step tools — no hardcoded override).
   *
   * Source: sop_steps.mcp_tool_allowlist_json or operator-supplied PlanNode.
   */
  readonly allowedTools?: readonly string[];
}

export interface ProposedPlan {
  readonly id: string;
  /** Verbatim user text (N1). */
  readonly originalIntent: string;
  readonly steps: readonly PlanStep[];
  readonly estimatedComplexity: 'M' | 'L' | 'XL';
  /** Wallclock ms (Date.now). */
  readonly proposedAt: number;
}

/** Engine-side error — das Routing-LLM hat einen ungültigen Plan emittiert. */
export class PlanValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PlanValidationError';
  }
}

/**
 * Build the plan-designer prompt. Deutsch + scharf per Task-Spec.
 * Exported damit Tests den Wortlaut prüfen können (N1 — wir müssen
 * Paraphrasierung des Operator-Intents explizit verbieten).
 */
export function buildPlanPrompt(intentText: string): string {
  return [
    'Du bist ein Software-Plan-Designer für laz.ing.',
    `Operator-Intent: "${intentText}"`,
    '',
    'Erstelle einen Plan in 3-7 Schritten. Jeder Schritt:',
    '- ist ein konkreter, in 5-30 Minuten umsetzbarer Arbeitsblock',
    '- hat eine 1-Satz-Begründung',
    '- nennt 1-3 Ziel-Dateien (Pfad-Heuristik, kann ungenau sein)',
    '- bekommt eine Rolle: architect (Design), coder (Implementation), tester (Tests), reviewer (Code-Review)',
    "- optionaler 'expectedArtifacts' array (1-3 Stichwörter): was dieser Step konkret produziert (z.B. 'failing test', 'pr/feature-x', 'profiling report'). Verbatim — keine Umformulierung in nachgelagerten Steps.",
    '',
    'JSON-Output (STRICT, kein Prosa drumherum):',
    '{',
    '  "estimatedComplexity": "M"|"L"|"XL",',
    '  "steps": [',
    '    {"index": 1, "title": "…", "rationale": "…", "targetFiles": ["…"], "subagentRole": "architect", "expectedArtifacts": ["…"]},',
    '    …',
    '  ]',
    '}',
  ].join('\n');
}

/**
 * Parse + validate the LLM's raw plan output.
 *
 * Tolerant of:
 *   - leading/trailing whitespace
 *   - ```json … ``` code fences
 *
 * Strict on:
 *   - shape (estimatedComplexity ∈ {M,L,XL}; steps array; per-step
 *     index/title/rationale)
 *   - role values (must be one of the four)
 *   - step count (truncates to MAX_STEPS; rejects fewer than MIN_STEPS)
 *
 * Throws `PlanValidationError` with a stable code on any violation.
 */
export function parseProposedPlan(
  raw: string,
  originalIntent: string,
  mintId: () => string = () => randomUUID(),
  now: () => number = () => Date.now(),
): ProposedPlan {
  if (typeof raw !== 'string') {
    throw new PlanValidationError('not-a-string', 'plan output must be a string');
  }
  let body = raw.trim();
  if (body.startsWith('```')) {
    const firstNewline = body.indexOf('\n');
    if (firstNewline !== -1) body = body.slice(firstNewline + 1);
    if (body.endsWith('```')) body = body.slice(0, -3);
    body = body.trim();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new PlanValidationError(
      'bad-json',
      `plan output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new PlanValidationError('not-an-object', 'plan output must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  const complexityRaw = obj['estimatedComplexity'];
  if (
    typeof complexityRaw !== 'string' ||
    !VALID_COMPLEXITIES.has(complexityRaw as ProposedPlan['estimatedComplexity'])
  ) {
    throw new PlanValidationError(
      'bad-complexity',
      `estimatedComplexity must be one of M|L|XL (got ${JSON.stringify(complexityRaw)})`,
    );
  }
  const stepsRaw = obj['steps'];
  if (!Array.isArray(stepsRaw)) {
    throw new PlanValidationError('missing-steps', 'plan output missing `steps` array');
  }
  if (stepsRaw.length < MIN_STEPS) {
    throw new PlanValidationError(
      'too-few-steps',
      `plan must have at least ${MIN_STEPS} step (got ${stepsRaw.length})`,
    );
  }
  // Truncate to MAX_STEPS — better than failing for an over-eager LLM.
  const effective = stepsRaw.slice(0, MAX_STEPS);
  const steps: PlanStep[] = [];
  for (let i = 0; i < effective.length; i += 1) {
    const item = effective[i];
    if (typeof item !== 'object' || item === null) {
      throw new PlanValidationError(
        'bad-step-shape',
        `steps[${i}] is not an object`,
      );
    }
    const s = item as Record<string, unknown>;
    const indexRaw = s['index'];
    const titleRaw = s['title'];
    const rationaleRaw = s['rationale'];
    const targetFilesRaw = s['targetFiles'];
    const roleRaw = s['subagentRole'];
    const expectedArtifactsRaw = s['expectedArtifacts'];
    let index: number;
    if (typeof indexRaw === 'number' && Number.isInteger(indexRaw) && indexRaw > 0) {
      index = indexRaw;
    } else {
      index = i + 1;
    }
    if (typeof titleRaw !== 'string' || titleRaw.length === 0) {
      throw new PlanValidationError(
        'bad-step-title',
        `steps[${i}].title must be a non-empty string`,
      );
    }
    if (typeof rationaleRaw !== 'string' || rationaleRaw.length === 0) {
      throw new PlanValidationError(
        'bad-step-rationale',
        `steps[${i}].rationale must be a non-empty string`,
      );
    }
    let targetFiles: readonly string[] | undefined;
    if (Array.isArray(targetFilesRaw)) {
      const filtered: string[] = [];
      for (const f of targetFilesRaw) {
        if (typeof f === 'string' && f.length > 0) filtered.push(f);
        if (filtered.length >= 3) break;
      }
      if (filtered.length > 0) targetFiles = filtered;
    } else if (targetFilesRaw !== undefined && targetFilesRaw !== null) {
      targetFiles = undefined;
    }
    let subagentRole: PlanSubagentRole | undefined;
    if (typeof roleRaw === 'string' && VALID_ROLES.has(roleRaw as PlanSubagentRole)) {
      subagentRole = roleRaw as PlanSubagentRole;
    } else if (roleRaw !== undefined && roleRaw !== null) {
      subagentRole = 'coder';
    }
    let expectedArtifacts: readonly string[] | undefined;
    if (Array.isArray(expectedArtifactsRaw)) {
      const filtered: string[] = [];
      for (const a of expectedArtifactsRaw) {
        if (typeof a === 'string' && a.length > 0) filtered.push(a);
        if (filtered.length >= 3) break;
      }
      if (filtered.length > 0) expectedArtifacts = filtered;
    } else if (
      expectedArtifactsRaw !== undefined &&
      expectedArtifactsRaw !== null
    ) {
      expectedArtifacts = undefined;
    }
    steps.push({
      id: mintId(),
      index,
      title: titleRaw, // verbatim (N1)
      rationale: rationaleRaw, // verbatim (N1)
      ...(targetFiles ? { targetFiles } : {}),
      ...(subagentRole ? { subagentRole } : {}),
      ...(expectedArtifacts ? { expectedArtifacts } : {}),
    });
  }
  return {
    id: mintId(),
    originalIntent, // verbatim (N1)
    steps,
    estimatedComplexity: complexityRaw as ProposedPlan['estimatedComplexity'],
    proposedAt: now(),
  };
}

/**
 * Build a proposed plan by calling the routing LLM and parsing its
 * output. `callEngine` is injected so the route can supply a wired-up
 * Ollama/Codex/Claude-cli adapter ohne dass dieses Modul eine harte
 * Dep auf das adapter package nimmt.
 *
 * Engine choice (N11): die Route SOLLTE einen llama3-Caller für
 * small/medium Intents übergeben und einen deepseek-r1:14b-Caller für
 * XL Intents — aber wir lassen die Entscheidung dem Caller, diese
 * Funktion ist engine-agnostisch.
 */
export async function proposePlan(
  intentText: string,
  callEngine: (prompt: string) => Promise<string>,
  opts: {
    readonly mintId?: () => string;
    readonly now?: () => number;
    /**
     * P0.3a — Self-Learning / WARUM-Engine (2026-05-27). Ein bereits gerenderter
     * WARUM-Block (lib/reasoning/why-context.ts::renderWhyContextForPrompt) mit
     * früheren Begründungen + aktiven Beliefs dieses Workspace. Wenn gesetzt +
     * nicht leer, wird er dem buildPlanPrompt-Output VORANGESTELLT — analog wie
     * compose.ts es im Default-Decompose macht — damit der Plan-Proposer nicht
     * amnesisch startet, sondern konsistent begründet empfiehlt ("wir haben X
     * gewählt, weil … letztes Mal").
     *
     * KEINE DB-Kopplung: dieses Modul liest NIE selbst — der String kommt fertig
     * vom Caller (der das workspace-gescopte Read-Back besitzt, N9). Fehlt der
     * Parameter ODER ist er leer/whitespace, ist der an die Engine gereichte
     * Prompt BIT-IDENTISCH zu vorher (bestehende Caller/Tests unverändert).
     *
     * N6: Der WARUM-Block ist NUR LLM-Kontext. Der deterministische
     * parseProposedPlan-Validator läuft danach unverändert — der Kontext kann
     * den Validator nicht umgehen.
     */
    readonly whyContext?: string;
  } = {},
): Promise<ProposedPlan> {
  if (typeof intentText !== 'string' || intentText.length === 0) {
    throw new PlanValidationError(
      'empty-intent',
      'proposePlan requires a non-empty intentText',
    );
  }
  const basePrompt = buildPlanPrompt(intentText);
  // P0.3a: WARUM-Block voranstellen (nur wenn nicht leer). Leerer/fehlender
  // whyContext ⇒ bit-identischer Prompt (Identitäts-Pfad).
  const why = typeof opts.whyContext === 'string' ? opts.whyContext.trim() : '';
  const prompt = why.length === 0 ? basePrompt : `${why}\n\n${basePrompt}`;
  const raw = await callEngine(prompt);
  return parseProposedPlan(raw, intentText, opts.mintId, opts.now);
}

/**
 * Thin wrapper around `proposePlan` that captures the parent step +
 * recursion depth so the call-site is uniform with
 * `recursive-plan.proposeLazySubplan`. Use case: routes (e.g.
 * approve-plan) die nicht die volle Recursive-Plan-Proposer-Dep
 * brauchen, können einen Subplan über diesen Helfer aufdrehen während
 * sie den Parent-Kontext an den per-lane LLM-Prompt durchreichen.
 *
 * Der Wrapper enriched den Intent-Text mit Parent-Step-Title +
 * Rationale damit das LLM den verbatim Parent-Kontext (N1) hat —
 * praktisch wenn der User "expand subplan for step X" im UI klickt.
 */
export async function proposeSubplan(
  parentStep: PlanStep,
  depth: number,
  deps: {
    readonly callEngine: (prompt: string) => Promise<string>;
    readonly mintId?: () => string;
    readonly now?: () => number;
  },
): Promise<ProposedPlan> {
  void depth; // depth is informational here; depth cap is enforced
  //              upstream by the walker (`subplanTrigger`).
  const intentText = `${parentStep.title} — ${parentStep.rationale}`;
  return proposePlan(intentText, deps.callEngine, {
    ...(deps.mintId ? { mintId: deps.mintId } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
}
