'use client';

/**
 * SubplanCard — BACKPORT-03 von Lazing-V2 (2026-05-23 · Agent 3/8).
 *
 * Quelle: lazing-wt/realtime-orchestrator-v2/packages/manifestation/src/surfaces/Subplan/
 * (V2 manifestation primitive). Port-Strategie (R-02-... analog): das V2-Surface
 * ist Frame-wrapped; lazyos chat-cards sind flat (kein Frame). Wir reproduzieren
 * den reducer-Logik-Kern verbatim, swap den Render-Tree gegen `srf-subplan__*`
 * className-Pattern (siehe BugFixSwarmCard / IteratePipelineCard).
 *
 * Discipline (Jobs/Rams — feedback_jobs_rams_design.md):
 *   - Eine Primary Action pro Karte (Approve | Edit | Decline).
 *   - Body ≥ 13pt (CSS-Token --font-size-body).
 *   - Brand-Gradient NUR auf Highlight (active step), nicht überall.
 *   - 240ms cubic-bezier Transitions.
 *   - Light-first (kein Dark-Mode-only).
 *   - Manifestation-first — Surface ist Output-Form, nicht Telemetry.
 *
 * Collapse-to-pill bei depth >= 2 — der Operator soll auf depth-0 + depth-1
 * die volle Story sehen, deeper hops sind ein Pill mit n-pending.
 */

import { memo, useState, type ReactElement } from 'react';

import type { ProposedPlan, PlanStep } from '@/lib/plan-first/orchestrate-plan';

/**
 * Ist die Step-Rationale ein verbose Maschinen-Prompt (SOP-stepPromptTemplate)
 * statt eines kurzen menschlichen Grunds? Codex-Parität (2026-06-02): solche
 * Templates (mit `{{target_provider}}`-Platzhaltern + Schema-Dumps) leakten
 * roh + dominant in den Feed. Wir erkennen sie heuristisch und klappen sie in
 * eine Disclosure — der volle Text bleibt erhalten (N1), dominiert aber nicht.
 */
function isVerbosePrompt(rationale: string): boolean {
  return (
    rationale.length > 280 ||
    /\{\{\s*[a-z0-9_]+\s*\}\}/i.test(rationale) ||
    /input_schema_json:|PRIORITY\s+\d|enumerateMcpTools|McpTool\b/.test(rationale)
  );
}

export interface SubplanCardProps {
  /** Recursion depth: 0 = root plan, 1 = first subplan, 2..3 = collapse-to-pill. */
  readonly depth: number;
  /** The proposed plan to render. */
  readonly plan: ProposedPlan;
  /** Parent step that triggered this subplan (null on root). */
  readonly parentStep: PlanStep | null;
  /** Subplan needs operator approval (per-level cascade mode). */
  readonly awaitingApproval: boolean;
  /** Subplan-promote callback — triggers backend insertProposedPlan. */
  readonly onApprove?: (planId: string) => void;
  readonly onEdit?: (planId: string) => void;
  readonly onDecline?: (planId: string) => void;
  /** Per-step status snapshot keyed by step.id. */
  readonly stepStatuses?: Readonly<Record<string, 'pending' | 'active' | 'done' | 'failed' | 'in-critic' | 'fix-iter-1' | 'fix-iter-2' | 'escalated' | 'cancelled'>>;
  /**
   * Owner-Fix 2026-05-28: Card startet eingeklappt (Pill mit Chevron) auch
   * bei depth < 2. Wird vom plan-dispatch fuer Child-Subplaene gesetzt, damit
   * nicht parent + N children gleichzeitig aufgeklappt im Strom landen. Der
   * User klappt sie per Tap auf. depth >= 2 erzwingt weiterhin Collapse
   * (alte Heuristik bleibt unveraendert).
   */
  readonly initialCollapsed?: boolean;
}

function SubplanCardImpl(props: SubplanCardProps): ReactElement {
  const { depth, plan, parentStep, awaitingApproval, stepStatuses } = props;
  // Owner-Fix 2026-05-28: initialCollapsed-Flag (aus dem Surface-Payload via
  // plan-dispatch fuer Child-Subplaene) erzwingt die Pill-Variante auch bei
  // depth < 2. depth >= 2 kollabiert weiter automatisch (alter Pfad).
  const startCollapsed = props.initialCollapsed === true || depth >= 2;
  const [collapsed, setCollapsed] = useState(startCollapsed);

  if (collapsed) {
    const pendingCount = plan.steps.filter(
      (s) => (stepStatuses?.[s.id] ?? 'pending') === 'pending',
    ).length;
    const label = depth >= 2 ? `Subplan (Tiefe ${depth})` : 'Subplan';
    const subtitle =
      depth < 2 && parentStep
        ? parentStep.title
        : undefined;
    return (
      <div className="srf-subplan srf-subplan--pill" data-depth={depth}>
        <button
          className="srf-subplan__pill"
          onClick={() => setCollapsed(false)}
          aria-label={`${label} ausklappen`}
          data-test="subplan-pill-collapsed"
        >
          <span className="srf-subplan__pill-icon" aria-hidden>
            {'▸'}
          </span>
          <span className="srf-subplan__pill-label">
            {label}
            {subtitle ? ` — ${subtitle}` : ''}
          </span>
          <span className="srf-subplan__pill-count">
            {pendingCount} offen
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      className="srf-subplan"
      data-depth={depth}
      data-awaiting={awaitingApproval ? '1' : '0'}
    >
      <div className="srf-subplan__header">
        <span className="srf-subplan__title">
          {depth === 0
            ? 'Plan'
            : `Subplan — ${parentStep?.title ?? 'unbekannter Parent'}`}
        </span>
        <span className="srf-subplan__chip" data-complexity={plan.estimatedComplexity}>
          {plan.estimatedComplexity}
        </span>
        {depth >= 2 ? (
          <button
            className="srf-subplan__collapse"
            onClick={() => setCollapsed(true)}
            aria-label="Subplan einklappen"
          >
            {'−'}
          </button>
        ) : null}
      </div>

      <div className="srf-subplan__intent">
        {/* N1: verbatim originalIntent, kein .slice */}
        {plan.originalIntent}
      </div>

      <ol className="srf-subplan__steps">
        {plan.steps.map((step) => {
          const status = stepStatuses?.[step.id] ?? 'pending';
          return (
            <li
              key={step.id}
              className="srf-subplan__step"
              data-status={status}
              data-role={step.subagentRole ?? 'coder'}
            >
              <div className="srf-subplan__step-head">
                <span className="srf-subplan__step-index">
                  {String(step.index).padStart(2, '0')}
                </span>
                <span className="srf-subplan__step-title">{step.title}</span>
                <span
                  className="srf-subplan__step-status"
                  data-status={status}
                >
                  {status}
                </span>
              </div>
              {step.rationale ? (
                isVerbosePrompt(step.rationale) ? (
                  // Codex-Parität: verbose Agent-Prompt-Templates nicht roh in
                  // den Feed schreien — in eine Disclosure klappen. N1: der
                  // volle Text bleibt verbatim erhalten, nur default zu.
                  <details className="srf-subplan__step-promptbox">
                    <summary className="srf-subplan__step-promptbox-summary">
                      Agent-Prompt anzeigen
                    </summary>
                    <div className="srf-subplan__step-rationale">
                      {/* N1: verbatim rationale, kein .slice */}
                      {step.rationale}
                    </div>
                  </details>
                ) : (
                  <div className="srf-subplan__step-rationale">
                    {/* N1: verbatim rationale, kein .slice */}
                    {step.rationale}
                  </div>
                )
              ) : null}
              {step.expectedArtifacts && step.expectedArtifacts.length > 0 ? (
                <ul className="srf-subplan__step-artifacts">
                  {step.expectedArtifacts.map((a) => (
                    <li key={a} className="srf-subplan__step-artifact">
                      {a}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ol>

      {awaitingApproval ? (
        <div className="srf-subplan__actions">
          <button
            type="button"
            className="srf-subplan__btn srf-subplan__btn--primary"
            onClick={() => props.onApprove?.(plan.id)}
          >
            Approve subplan
          </button>
          <button
            type="button"
            className="srf-subplan__btn srf-subplan__btn--secondary"
            onClick={() => props.onEdit?.(plan.id)}
          >
            Edit
          </button>
          <button
            type="button"
            className="srf-subplan__btn srf-subplan__btn--ghost"
            onClick={() => props.onDecline?.(plan.id)}
          >
            Decline
          </button>
        </div>
      ) : null}
    </div>
  );
}

export const SubplanCard = memo(SubplanCardImpl);
