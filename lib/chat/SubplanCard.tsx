'use client';

/**
 * SubplanCard — BACKPORT-03 from Lazing-V2 (2026-05-23 · Agent 3/8).
 *
 * Source: lazing-wt/realtime-orchestrator-v2/packages/manifestation/src/surfaces/Subplan/
 * (V2 manifestation primitive). Port strategy (R-02-... analogous): the V2 surface
 * is frame-wrapped; lazyos chat cards are flat (no frame). We reproduce
 * the reducer-logic core verbatim, swap the render tree for the `srf-subplan__*`
 * className pattern (see BugFixSwarmCard / IteratePipelineCard).
 *
 * Discipline (Jobs/Rams — feedback_jobs_rams_design.md):
 *   - One primary action per card (Approve | Edit | Decline).
 *   - Body ≥ 13pt (CSS token --font-size-body).
 *   - Brand gradient ONLY on the highlight (active step), not everywhere.
 *   - 240ms cubic-bezier transitions.
 *   - Light-first (not dark-mode-only).
 *   - Manifestation-first — the surface is an output form, not telemetry.
 *
 * Collapse-to-pill at depth >= 2 — the operator should see the full story at
 * depth-0 + depth-1, deeper hops are a pill with n-pending.
 */

import { memo, useState, type ReactElement } from 'react';

import type { ProposedPlan, PlanStep } from '@/lib/plan-first/orchestrate-plan';

/**
 * Is the step rationale a verbose machine prompt (SOP-stepPromptTemplate)
 * instead of a short human reason? Codex parity (2026-06-02): such
 * templates (with `{{target_provider}}` placeholders + schema dumps) leaked
 * raw + dominant into the feed. We detect them heuristically and fold them into
 * a disclosure — the full text is preserved (N1), but does not dominate.
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
   * Owner fix 2026-05-28: the card starts collapsed (pill with chevron) even
   * at depth < 2. Set by plan-dispatch for child subplans, so that
   * parent + N children do not land expanded in the stream at the same time. The
   * user expands them with a tap. depth >= 2 still forces collapse
   * (the old heuristic stays unchanged).
   */
  readonly initialCollapsed?: boolean;
}

function SubplanCardImpl(props: SubplanCardProps): ReactElement {
  const { depth, plan, parentStep, awaitingApproval, stepStatuses } = props;
  // Owner fix 2026-05-28: the initialCollapsed flag (from the surface payload via
  // plan-dispatch for child subplans) forces the pill variant even at
  // depth < 2. depth >= 2 still collapses automatically (old path).
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
        {/* N1: verbatim originalIntent, no .slice */}
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
                  // Codex parity: do not scream verbose agent-prompt templates raw
                  // into the feed — fold into a disclosure. N1: the
                  // full text is preserved verbatim, only collapsed by default.
                  <details className="srf-subplan__step-promptbox">
                    <summary className="srf-subplan__step-promptbox-summary">
                      Agent-Prompt anzeigen
                    </summary>
                    <div className="srf-subplan__step-rationale">
                      {/* N1: verbatim rationale, no .slice */}
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
