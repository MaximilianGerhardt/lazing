'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import { BarChart, Heatmap, LineChart } from '@/lib/ui/chr';
import { Decision } from '@/lib/ui/dec';
import { CloudBrowser, Document, Folder } from '@/lib/ui/doc';
import { HeartbeatPulse } from '@/lib/ui/hbt';
import { Invoice } from '@/lib/ui/inv';
import { Pill } from '@/lib/ui/pil';
import { Pipeline } from '@/lib/ui/pip';
import { QuickChoice } from '@/lib/ui/qck';
import { Teammate } from '@/lib/ui/tmc';
import { Ticket } from '@/lib/ui/tck';
import { Terminal } from '@/lib/ui/trm';
import { Toast } from '@/lib/ui/tst';

import { SURFACE_KINDS, type SurfaceKind } from './surface-parser';
import { useSurfaceAction } from './SurfaceActionContext';
import { LiveSwarm } from './LiveSwarm';
import { ConsensusActionCard, type ConsensusLevel } from './ConsensusActionCard';
import { LivePipeline } from './LivePipeline';
import { IteratePipelineCard } from './IteratePipelineCard';
import { SubWorkstreamsCard } from './SubWorkstreamsCard';
import { RateLimitRetryCard } from './RateLimitRetryCard';
import { MilestoneCard } from './MilestoneCard';
import { LiveWorkflowSurface } from './LiveWorkflowSurface';
import { CredentialPromptCard } from './CredentialPromptCard';
import { FormPromptCard, type FormSchema } from './FormPromptCard';
import { OpenQuestionsInlineRef } from './ChatInlineOpenQuestions';
import { BugFixSwarmCard } from './BugFixSwarmCard';
import { LoopPhaseCard, type LoopPhaseKind } from './LoopPhaseCard';
import { IterateRoastCard } from './IterateRoastCard';
import { IterateVersionCard } from './IterateVersionCard';
import { UserCorrectionCard } from './UserCorrectionCard';
import { PlanOpenQuestionsCard } from './PlanOpenQuestionsCard';
import { WorkflowCard, type WorkflowPhase, type WorkflowStaticStep } from './WorkflowCard';
// BACKPORT-03 + BACKPORT-02 (2026-05-23) — Plan-First + Subagent-Fleet surfaces.
import { SubplanCard } from './SubplanCard';
import { SubagentFleetCard } from './SubagentFleetCard';
// ACL5-B (2026-05-24) — credential-request surface.
import { CredentialRequestCard } from './CredentialRequestCard';
// ACL5-E (2026-05-24) — connector-call-preview surface.
import { ConnectorCallPreviewCard } from './ConnectorCallPreviewCard';
// A1 (2026-05-25) — permission-setup surface.
import { PermissionSetupCard, type PermissionModeChoice } from './PermissionSetupCard';
import type { ConnectorCallPreviewPayload } from '@/lib/connectors/auto-connect';
import type { ProposedPlan, PlanStep } from '@/lib/plan-first/orchestrate-plan';
import type {
  SubagentFleetResolutionEvent,
  SubagentPane,
  SubagentPaneRole,
  SubagentPaneStatus,
} from './SubagentFleetCard.types';
// Stream X1 (2026-05-28) — generic auto-onboarding-SOP + cost-hint hint layer.
// Both modules are pure (no I/O, no LLM). Backwards-compat: when no SOP /
// no pricing entry exists, renderFlowCoupling falls back to the original
// CredentialRequestCard pathway with no cost line.
import {
  buildOnboardingSopForMissingTool,
  type OnboardingSop,
  type OnboardingSopStep,
} from '@/lib/connectors/onboarding-sop';
import { estimateCost, type CostEstimate } from '@/lib/connectors/pricing';
// W2.2 (2026-05-30): actionable flow nodes → THE SAME submit path as the
// ActionDeck pin. `executeGateAction` clicks the real stream-card action (one
// POST, no second routing); `BlockingGateKind` is the gate vocabulary.
import { executeGateAction } from './ActionDeck';
import type { BlockingGateKind, BlockingGateState } from '../projection/types';

// ---------------------------------------------------------------------------
// Shape schemas — runtime-tolerant. We accept noise (extra fields) and only
// fall back to "ignore" when a required field is missing. This keeps the
// renderer forgiving in the face of imperfect LLM output without the need
// for full Zod validation on every chunk.
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** className joiner (falsy → filtered out). */
function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function numArr(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map((x) => (typeof x === 'number' ? x : Number(x)));
  if (out.some((x) => !Number.isFinite(x))) return undefined;
  return out;
}

// ---------------------------------------------------------------------------
// Run-cockpit suppress registry (owner fix 2026-05-28).
//
// When a `<surface:run-cockpit>` card is already active for a
// (workspaceId, workstreamId), the three old sub-cards
// (`sub-workstreams`, `iterate-pipeline`, `iterate-version`) should NO longer
// appear in the stream — the cockpit card bundles them visibly in ONE surface.
//
// Cross-message coordination: every chat_message_completed event renders its
// own bubble; the suppress knowledge must be shared across all bubbles.
// We therefore use a React context that carries a live set of
// `coordKey` (= `workspaceId/workstreamId`). The RunCockpitCard
// registers itself on mount via `useEffect` and unregisters on unmount;
// the suppressible surfaces query via `useRunCockpitActive(coordKey)` and
// render `null` when the coord is active.
//
// Provider-free: without a provider `useRunCockpitActive` always returns `false`
// (back-compat — tests/voice/API consumers without a provider see the old
// cards unchanged). ChatShell must mount the provider — in the unrelated
// test environment the behavior stays bit-identical.
//
// SECURITY: the set carries only coord strings (workspaceId+workstreamId from
// surface payloads — both are already broadcast emitted), no secret.
// ---------------------------------------------------------------------------

interface RunCockpitRegistryActions {
  register: (coordKey: string) => void;
  unregister: (coordKey: string) => void;
}

interface RunCockpitRegistry extends RunCockpitRegistryActions {
  active: ReadonlySet<string>;
}

const RunCockpitRegistryContext = createContext<RunCockpitRegistry | null>(null);

/**
 * Pre-pass provider — marks the coord keys for which a run-cockpit surface
 * is already active in the current stream. On mount of the RunCockpitCard
 * its `coordKey` is registered; the three legacy surfaces query via
 * `useRunCockpitActive` and suppress themselves.
 *
 * Mounted in ChatShell above the surface rendering. Without a provider
 * the suppression logic does not work — the old cards then stay
 * visible (back-compat for tests and external renderers).
 *
 * Implementation note (owner fix 2026-05-28): register/unregister
 * reference the current `setActive` via `useCallback` with a constant
 * deps list (`[]`) — the provider value keeps stable function
 * references. This is important so that `useRunCockpitRegistration` does NOT
 * end up in an endless re-render loop (register call → setActive →
 * new context value → useEffect re-runs → register call).
 */
export function RunCockpitRegistryProvider({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  const [active, setActive] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  // Stable function refs: useCallback with a constant deps list so the
  // provider value stays identical as long as `active` does not change.
  const register = useCallback((coordKey: string): void => {
    if (!coordKey) return;
    setActive((prev) => {
      if (prev.has(coordKey)) return prev;
      const next = new Set(prev);
      next.add(coordKey);
      return next;
    });
  }, []);

  const unregister = useCallback((coordKey: string): void => {
    if (!coordKey) return;
    setActive((prev) => {
      if (!prev.has(coordKey)) return prev;
      const next = new Set(prev);
      next.delete(coordKey);
      return next;
    });
  }, []);

  const value = useMemo<RunCockpitRegistry>(
    () => ({ active, register, unregister }),
    // active changes on every register/unregister → suppression
    // consumers re-render. register/unregister are stable (see above).
    [active, register, unregister],
  );

  return (
    <RunCockpitRegistryContext.Provider value={value}>
      {children}
    </RunCockpitRegistryContext.Provider>
  );
}

/**
 * Returns true when a run-cockpit surface is already active for the given
 * coord key (`workspaceId/workstreamId`).
 * Provider-free: without a provider always false (legacy cards keep rendering).
 */
function useRunCockpitActive(coordKey: string | null): boolean {
  const ctx = useContext(RunCockpitRegistryContext);
  if (!ctx || !coordKey) return false;
  return ctx.active.has(coordKey);
}

/**
 * Mount hook for the RunCockpitCard. Registers its coord key on
 * mount, unregisters on unmount. Provider-free (without a provider: no-op).
 *
 * Deps: ONLY `coordKey` (and the stable register/unregister refs from the
 * provider) — the context itself comes from useContext but is NOT packed into
 * deps, otherwise there is an endless re-render. Instead we read
 * register/unregister once on mount and use them in the cleanup.
 */
function useRunCockpitRegistration(coordKey: string | null): void {
  const ctx = useContext(RunCockpitRegistryContext);
  // Stable function refs from the provider → we can use them as effect
  // deps without an active change triggering a re-run.
  const register = ctx?.register;
  const unregister = ctx?.unregister;
  useEffect(() => {
    if (!register || !unregister || !coordKey) return undefined;
    register(coordKey);
    return () => {
      unregister(coordKey);
    };
  }, [register, unregister, coordKey]);
}

/** Helper: builds the coord key from two strings. Returns null if incomplete. */
function buildCockpitCoordKey(
  workspaceId: string | undefined,
  workstreamId: string | undefined,
): string | null {
  if (!workspaceId || !workstreamId) return null;
  return `${workspaceId}/${workstreamId}`;
}

// ---------------------------------------------------------------------------
// F18 (2026-05-30) — pinned-decision registry.
//
// Owner directive F18 (near-verbatim): „Entscheidung benötigt / Gates IMMER
// unten über dem Chat angepinnt." An open decision/quickchoice is now captured
// by `projectWorkspaceState` as a blockingGate → the ActionDeck pins
// it at the bottom. So that there are NO two loud copies (one in the feed, one
// pinned), ChatShell marks the headline of the currently PINNED decision in
// this context; the in-feed `<surface:decision>`/`<surface:quickchoice>`
// card queries via `useDecisionPinned(headline)` and then renders a
// QUIET reference (collapsed, non-actionable, N8 evidence) instead of the loud
// card. This way the history is preserved without jumping the owner twice.
//
// Provider-free (back-compat): without a provider `useDecisionPinned` always returns
// false → the in-feed card renders loud unchanged (tests/voice/external
// renderers without the ChatShell provider see the old behavior bit-identical).
//
// SECURITY: the set carries only the verbatim decision headline (already
// broadcast surface payload), no secret.
// ---------------------------------------------------------------------------

interface PinnedDecisionRegistry {
  /** Verbatim headlines of the currently PINNED decisions (usually exactly one). */
  pinned: ReadonlySet<string>;
}

const PinnedDecisionRegistryContext =
  createContext<PinnedDecisionRegistry | null>(null);

/**
 * Provider — ChatShell mounts it above the surface rendering and passes
 * the headline of the currently pinned decision (from `selectPinnedItem`). The
 * in-feed decision/QuickChoice card with the same headline then suppresses
 * itself to the quiet reference.
 */
export function PinnedDecisionRegistryProvider({
  pinnedHeadline,
  children,
}: {
  /** Headline of the pinned decision, or null/undefined if none. */
  pinnedHeadline?: string | null;
  children: ReactNode;
}): ReactNode {
  const value = useMemo<PinnedDecisionRegistry>(() => {
    const set = new Set<string>();
    const h = typeof pinnedHeadline === 'string' ? pinnedHeadline.trim() : '';
    if (h.length > 0) set.add(h);
    return { pinned: set };
  }, [pinnedHeadline]);
  return (
    <PinnedDecisionRegistryContext.Provider value={value}>
      {children}
    </PinnedDecisionRegistryContext.Provider>
  );
}

/**
 * true when an in-feed decision/QuickChoice with this headline is currently
 * pinned at the BOTTOM → the feed card renders quiet instead of loud. Provider-free:
 * without a provider always false (back-compat).
 */
function useDecisionPinned(headline: string | null | undefined): boolean {
  const ctx = useContext(PinnedDecisionRegistryContext);
  if (!ctx || typeof headline !== 'string') return false;
  const h = headline.trim();
  if (h.length === 0) return false;
  return ctx.pinned.has(h);
}

// ---------------------------------------------------------------------------
// chart — accepts either a LineChart (data: number[]) or a BarChart
// (bars: Array<{height, variant}>). Routed by shape.
// ---------------------------------------------------------------------------

function renderChart(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const title = str(data.title) ?? 'Chart';
  const value = str(data.value);
  const sub = str(data.sub);
  const axisLeft = str(data.axisLeft);
  const axisCenter = str(data.axisCenter);
  const axisRight = str(data.axisRight);

  // BarChart path — if `bars` is present, prefer it.
  if (Array.isArray(data.bars)) {
    const bars: Array<{ height: number; variant?: 'median' | 'outlier' | 'default' }> = [];
    for (const raw of data.bars) {
      if (!isObject(raw)) continue;
      const h = num(raw.height);
      if (h === undefined) continue;
      const variantRaw = str(raw.variant);
      const variant =
        variantRaw === 'median' || variantRaw === 'outlier' || variantRaw === 'default'
          ? variantRaw
          : undefined;
      bars.push({ height: h, variant });
    }
    if (bars.length === 0) return null;
    return (
      <BarChart
        title={title}
        value={value}
        sub={sub}
        axisLeft={axisLeft}
        axisCenter={axisCenter}
        axisRight={axisRight}
        bars={bars}
      />
    );
  }

  // LineChart path.
  const points = numArr(data.data);
  if (!points || points.length === 0) return null;
  return (
    <LineChart
      title={title}
      value={value}
      sub={sub}
      axisLeft={axisLeft}
      axisCenter={axisCenter}
      axisRight={axisRight}
      data={points}
    />
  );
}

// ---------------------------------------------------------------------------
// decision
// ---------------------------------------------------------------------------

interface DecisionOpt {
  id: string;
  label: string;
  sublabel?: string;
  counter?: string;
  recommended?: boolean;
}

function DecisionCard({
  headline,
  sub,
  options,
}: {
  headline: string;
  sub?: string;
  options: DecisionOpt[];
}) {
  const { reply } = useSurfaceAction();

  // F18: is exactly THIS decision currently pinned at the bottom (ActionDeck)? Then
  // the feed card renders QUIET (N8 evidence/reference) instead of loud — no two
  // competing copies. Provider-free → false (back-compat: loud card).
  const pinned = useDecisionPinned(headline);

  // Exactly one recommended option (deterministic): server-marked or the first.
  const hasRecommended = options.some((o) => o.recommended);

  if (pinned) {
    // Quiet reference: non-actionable, collapsed. The owner acts via the
    // pinned ActionDeck at the bottom; here only the verbatim evidence remains (N1/N8).
    return (
      <div
        className="srf-decision srf-decision--pinned-ref"
        data-test="surface-decision-ref"
        data-pinned="true"
        aria-hidden="false"
      >
        <span className="srf-decision-ref-glyph" aria-hidden="true">
          ◆
        </span>
        <span className="srf-decision-ref-text">
          <span className="srf-decision-ref-kicker">Unten angepinnt</span>
          {/* N1: verbatim headline — CSS clamps visually, the text stays complete. */}
          <span className="srf-decision-ref-headline">{headline}</span>
        </span>
      </div>
    );
  }

  // Loud card (not pinned). data-test hooks on the wrapper + per option, so
  // the ActionDeck (executeGateAction) can click the REAL button — ONE
  // submit path (reply(label)), no second fetch.
  return (
    <div
      className="srf-decision srf-decision--live"
      data-test="surface-decision"
      data-headline={headline}
    >
      <Decision
        headline={headline}
        sub={sub}
        options={options.map((o, i) => ({
          ...o,
          // If the server marked NO recommended option, the
          // first becomes the recommended primary action (congruent with
          // extractGateOptions in the projection → deck + feed match).
          recommended: o.recommended || (!hasRecommended && i === 0),
          onSelect: () => reply(o.label),
        }))}
        mode={options.length === 2 ? 'binary' : options.length === 1 ? 'confirm' : 'multi'}
      />
      {/* Test/deck hooks: per option a data-test button that triggers THE SAME
          reply(label) as the visible .dopt row. Visually hidden
          (aria-hidden) — it is ONLY the programmatic click anchor for
          executeGateAction; the owner clicks the visible decision row.
          NO second submit path: both ways call exactly reply(label). */}
      <div className="srf-decision-hooks" aria-hidden="true" data-test="surface-decision-hooks">
        {options.map((o, i) => (
          <button
            key={o.id}
            type="button"
            tabIndex={-1}
            className="srf-decision-hook"
            data-test="surface-decision-option"
            data-option-id={o.id}
            data-recommended={
              o.recommended || (!hasRecommended && i === 0) ? 'true' : undefined
            }
            onClick={() => reply(o.label)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function renderDecision(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const headline = str(data.headline);
  if (!headline) return null;
  const sub = str(data.sub);
  const optsRaw = Array.isArray(data.options) ? data.options : [];
  const options: DecisionOpt[] = [];
  let idx = 0;
  for (const o of optsRaw) {
    if (!isObject(o)) {
      idx += 1;
      continue;
    }
    const id = str(o.id) ?? `opt-${idx}`;
    const label = str(o.label);
    if (!label) {
      idx += 1;
      continue;
    }
    options.push({
      id,
      label,
      sublabel: str(o.sublabel),
      counter: str(o.counter),
      recommended: o.recommended === true,
    });
    idx += 1;
  }

  if (options.length === 0) return null;
  return <DecisionCard headline={headline} sub={sub} options={options} />;
}

// ---------------------------------------------------------------------------
// ticket
// ---------------------------------------------------------------------------

function renderTicket(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const id = str(data.id) ?? 'TCK-?';
  const title = str(data.title);
  if (!title) return null;
  const statusRaw = str(data.status);
  const status =
    statusRaw === 'open' ||
    statusRaw === 'done' ||
    statusRaw === 'danger' ||
    statusRaw === 'wait'
      ? statusRaw
      : 'open';
  return (
    <Ticket
      id={id}
      title={title}
      status={status}
      prio={str(data.prio)}
      body={str(data.body)}
      segment={str(data.segment)}
      assignee={str(data.assignee)}
      due={str(data.due)}
    />
  );
}

// ---------------------------------------------------------------------------
// invoice
// ---------------------------------------------------------------------------

function renderInvoice(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const number = str(data.number);
  const title = str(data.title);
  const totalAmount = str(data.totalAmount);
  if (!number || !title || !totalAmount) return null;
  const statusRaw = str(data.status);
  const status =
    statusRaw === 'draft' ||
    statusRaw === 'sent' ||
    statusRaw === 'paid' ||
    statusRaw === 'overdue'
      ? statusRaw
      : 'draft';
  const linesRaw = Array.isArray(data.lines) ? data.lines : [];
  const lines: Array<{ label: string; amount: string; detail?: string }> = [];
  for (const l of linesRaw) {
    if (!isObject(l)) continue;
    const label = str(l.label);
    const amount = str(l.amount);
    if (!label || !amount) continue;
    lines.push({ label, amount, detail: str(l.detail) });
  }
  return (
    <Invoice
      status={status}
      number={number}
      title={title}
      subtitle={str(data.subtitle)}
      lines={lines}
      totalAmount={totalAmount}
      totalLabel={str(data.totalLabel)}
    />
  );
}

// ---------------------------------------------------------------------------
// pipeline
// ---------------------------------------------------------------------------

function renderPipeline(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const stepsRaw = Array.isArray(data.steps) ? data.steps : [];
  const steps: Array<{
    num: number;
    title: string;
    status: 'done' | 'running' | 'waiting';
    subtitle?: string;
  }> = [];
  let sIdx = 0;
  for (const s of stepsRaw) {
    if (!isObject(s)) {
      sIdx += 1;
      continue;
    }
    const title = str(s.title);
    if (!title) {
      sIdx += 1;
      continue;
    }
    const numV = num(s.num) ?? sIdx + 1;
    const statusRaw = str(s.status);
    const status: 'done' | 'running' | 'waiting' =
      statusRaw === 'done' || statusRaw === 'running' || statusRaw === 'waiting'
        ? statusRaw
        : 'waiting';
    steps.push({ num: numV, title, status, subtitle: str(s.subtitle) });
    sIdx += 1;
  }
  if (steps.length === 0) return null;
  return <Pipeline steps={steps} />;
}

// ---------------------------------------------------------------------------
// Public dispatcher
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Toast — variant + title + body. Small, but strongly present.
// ---------------------------------------------------------------------------

function renderToast(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const variantRaw = str(data.variant) ?? 'default';
  const variant = (['default', 'ok', 'warn', 'err'].includes(variantRaw)
    ? variantRaw
    : 'default') as 'default' | 'ok' | 'warn' | 'err';
  const title = str(data.title) ?? '';
  const body = str(data.body) ?? '';
  const iconGlyph = str(data.iconGlyph) ?? 'L';
  if (!title && !body) return null;
  return (
    <Toast
      variant={variant}
      iconGlyph={iconGlyph}
      title={title}
      body={body}
    />
  );
}

// ---------------------------------------------------------------------------
// QuickChoice — 2-3 buttons with a primary + optional sublabels.
// ---------------------------------------------------------------------------

interface QuickChoiceOpt {
  id: string;
  label: string;
  sublabel?: string;
  primary?: boolean;
}

/**
 * Phase 1 Track AB · Befund A (verbatim Handoff §7):
 *
 *   „QuickChoice-Klick ruft `reply(o.label)` auf. Gleichzeitig wird
 *    `window.dispatchEvent(new CustomEvent('lazyos:quickchoice', ...))`
 *    ausgelöst. ChatShell hört auf `lazyos:quickchoice`. Bei Flow-Style-
 *    Sessions repostet ChatShell an `/api/flow/compose-and-run` mit
 *    styleChoices. → Ein einziger Klick kann zwei Aktionen auslösen:
 *      1. gewünschte strukturierte Flow-Fortsetzung.
 *      2. zusätzliche normale Chat-Nachricht mit nur dem Button-Label.
 *    Das kann Kontext und Routing zerstören."
 *
 * FIX (additive, backward-compat):
 *   New payload field `behavior?: 'reply-and-event' | 'event-only'`.
 *   - 'reply-and-event' (default) → previous behavior, both fire.
 *     Backward-compat for every existing quickchoice caller that does NOT
 *     set `behavior`.
 *   - 'event-only' → ONLY dispatchEvent, NO reply(label). Used by
 *     callers like Flow Studio media-style choice (lib/flow/media-styles.ts
 *     ::buildMediaStyleChoicePayload), where the re-post to
 *     /api/flow/compose-and-run is the sole truth and the additional
 *     chat turn would destroy the routing (acceptance: „Klick auf Flow-Style-
 *     Quickchoice erzeugt genau einen Request an /api/flow/compose-and-run.").
 */
type QuickChoiceBehavior = 'reply-and-event' | 'event-only';

function QuickChoiceCard({
  options,
  behavior = 'reply-and-event',
}: {
  options: QuickChoiceOpt[];
  behavior?: QuickChoiceBehavior;
}) {
  const { reply } = useSurfaceAction();

  // F18: QuickChoice is option-only (no headline). The projection matches
  // the pinned decision via the option-label signature (join ' · ') — we
  // form the same signature here, so the feed card goes quiet when
  // EXACTLY this QuickChoice is pinned at the bottom. Provider-free → false.
  const signature = options.map((o) => o.label).join(' · ');
  const pinned = useDecisionPinned(signature);

  const hasPrimary = options.some((o) => o.primary);

  // One option selection: behavior switch preserved (event-only fires ONLY the
  // window event, default both) — UNCHANGED (back-compat, no double routing).
  const select = (o: QuickChoiceOpt): void => {
    if (behavior !== 'event-only') {
      reply(o.label);
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('lazyos:quickchoice', { detail: { id: o.id } }),
      );
    }
  };

  if (pinned) {
    return (
      <div
        className="srf-quickchoice srf-quickchoice--pinned-ref"
        data-test="surface-quickchoice-ref"
        data-pinned="true"
      >
        <span className="srf-quickchoice-ref-glyph" aria-hidden="true">
          ◆
        </span>
        <span className="srf-quickchoice-ref-text">
          <span className="srf-quickchoice-ref-kicker">Unten angepinnt</span>
          {/* N1: verbatim option labels as evidence. */}
          <span className="srf-quickchoice-ref-headline">{signature}</span>
        </span>
      </div>
    );
  }

  return (
    <div
      className="srf-quickchoice srf-quickchoice--live"
      data-test="surface-decision"
      data-quickchoice="true"
    >
      <QuickChoice options={options.map((o) => ({ ...o, onSelect: () => select(o) }))} />
      {/* Test/deck hooks (aria-hidden, programmatic click anchor) — THE SAME
          select(o) as the visible row. NO second submit path. */}
      <div className="srf-decision-hooks" aria-hidden="true" data-test="surface-decision-hooks">
        {options.map((o, i) => (
          <button
            key={o.id}
            type="button"
            tabIndex={-1}
            className="srf-decision-hook"
            data-test="surface-decision-option"
            data-option-id={o.id}
            data-recommended={
              o.primary || (!hasPrimary && i === 0) ? 'true' : undefined
            }
            onClick={() => select(o)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function renderQuickChoice(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const optsRaw = data.options;
  if (!Array.isArray(optsRaw)) return null;
  const options = optsRaw.flatMap((o): QuickChoiceOpt[] => {
    if (!isObject(o)) return [];
    const id = str(o.id);
    const label = str(o.label);
    if (!id || !label) return [];
    return [
      {
        id,
        label,
        sublabel: str(o.sublabel),
        primary: Boolean(o.primary),
      },
    ];
  });
  if (options.length === 0) return null;
  // Extract behavior from the payload — anything other than the explicit
  // string 'event-only' falls back to 'reply-and-event' (default,
  // backward-compat). Unknown values → default (defensive).
  const rawBehavior = (data as { behavior?: unknown }).behavior;
  const behavior: QuickChoiceBehavior =
    rawBehavior === 'event-only' ? 'event-only' : 'reply-and-event';
  return <QuickChoiceCard options={options} behavior={behavior} />;
}

// ---------------------------------------------------------------------------
// Approval — ticketId + title, rendered as a decision with approve/reject.
// ---------------------------------------------------------------------------

function ApprovalCard({
  ticketId,
  title,
  sub,
}: {
  ticketId: string;
  title: string;
  sub?: string;
}) {
  const { reply } = useSurfaceAction();
  return (
    <Decision
      headline={title}
      sub={sub}
      options={[
        {
          id: 'approve',
          label: 'Freigeben',
          sublabel: 'empfohlen',
          recommended: true,
          onSelect: () =>
            reply(
              ticketId
                ? `Freigeben: ${ticketId}`
                : 'Freigeben',
            ),
        },
        {
          id: 'reject',
          label: 'Ablehnen',
          onSelect: () =>
            reply(
              ticketId
                ? `Ablehnen: ${ticketId}`
                : 'Ablehnen',
            ),
        },
      ]}
      deepLink={
        ticketId
          ? {
              label: 'Ticket öffnen',
              onClick: () => {
                if (typeof window !== 'undefined') {
                  window.location.href = `/tickets/${ticketId}`;
                }
              },
            }
          : undefined
      }
    />
  );
}

function renderApproval(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const ticketId = str(data.ticketId) ?? '';
  const title = str(data.title) ?? 'Freigabe erforderlich';
  const sub = str(data.sub) ?? (ticketId ? `Ticket ${ticketId}` : undefined);
  return <ApprovalCard ticketId={ticketId} title={title} sub={sub} />;
}

// ---------------------------------------------------------------------------
// milestone — Apple-Keynote completion card (Phase NEU)
// ---------------------------------------------------------------------------

function renderMilestone(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const headline = str(data.headline);
  const sub = str(data.sub);
  const costSaved = str(data.costSaved) ?? str(data.cost_saved);
  const quality = num(data.quality);
  const href = str(data.href);
  const bullets = Array.isArray(data.bullets)
    ? data.bullets.filter((b): b is string => typeof b === 'string')
    : undefined;
  const ba = isObject(data.beforeAfter) ? data.beforeAfter : null;
  const beforeAfter = ba
    ? {
        before: str(ba.before),
        after: str(ba.after),
      }
    : undefined;
  // P11 (2026-05-01): synthesis cards optionally get an auditId for the
  // source-chip row in the footer. The mapper in event-to-surface.ts sets the field.
  const auditId = str(data.auditId) ?? str(data.audit_id);
  // Apple-UX (2026-05-30): `variant: 'quiet'` for de-prominenced info
  // milestones (e.g. plan synthesis) — a calm info line instead of a keynote card.
  const variant = str(data.variant) === 'quiet' ? 'quiet' : undefined;
  return (
    <MilestoneCard
      headline={headline}
      sub={sub}
      bullets={bullets}
      costSaved={costSaved}
      quality={quality}
      href={href}
      beforeAfter={beforeAfter}
      auditId={auditId}
      variant={variant}
    />
  );
}

// ---------------------------------------------------------------------------
// preview — completion/deployment surface (2026-05-27).
// Large, phone-friendly tappable card: opens the (Tailscale) preview URL
// in the browser (target=_blank → works on the smartphone). This way the
// owner gets a testable link IN the chat immediately after a build.
// ---------------------------------------------------------------------------

function renderPreview(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const url = str(data.url) ?? str(data.href);
  if (!url) return null;
  const title = str(data.title) ?? 'Vorschau bereit';
  const note = str(data.note) ?? str(data.sub);
  const statusRaw = (str(data.status) ?? 'ready').toLowerCase();
  const ready = statusRaw === 'ready' || statusRaw === 'done' || statusRaw === 'live';

  return (
    <div
      data-test="surface-preview"
      style={{
        background: 'var(--sheet-1, #0c0d0f)',
        border: '0.5px solid var(--line-2, #1f1f1f)',
        borderRadius: 16,
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        maxWidth: 520,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            background: ready ? 'var(--a-ok, #5fd39a)' : 'var(--a-warn, #f5c84b)',
            display: 'inline-block',
          }}
          aria-hidden
        />
        <span
          style={{
            fontFamily: 'var(--font-mono, ui-monospace)',
            fontSize: 11,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: 'var(--ink-3, #80848c)',
          }}
        >
          {ready ? 'Build fertig · Vorschau' : 'Build läuft'}
        </span>
      </div>

      <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--ink, #f4f5f7)', letterSpacing: '-0.01em' }}>
        {title}
      </div>
      {note ? (
        <div style={{ fontSize: 13.5, color: 'var(--ink-2, #b6b9c0)', lineHeight: 1.5 }}>{note}</div>
      ) : null}

      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        data-test="surface-preview-open"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          minHeight: 52,
          padding: '14px 22px',
          borderRadius: 999,
          background: 'var(--a-now, #5ad1e6)',
          color: 'var(--screen, #061417)',
          fontSize: 16,
          fontWeight: 600,
          letterSpacing: '-0.01em',
          textDecoration: 'none',
          boxShadow: '0 8px 32px var(--a-now-glow, rgba(90,209,230,0.28))',
        }}
      >
        Vorschau öffnen
        <span aria-hidden style={{ fontSize: 18, lineHeight: 1 }}>→</span>
      </a>

      <div
        style={{
          fontFamily: 'var(--font-mono, ui-monospace)',
          fontSize: 11.5,
          color: 'var(--ink-4, #7a7e85)',
          wordBreak: 'break-all',
        }}
      >
        {url}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// discovery — research pre-phase BEFORE plan decompose (Slice C, 2026-05-29)
// ---------------------------------------------------------------------------
//
// Owner-Befund (verbatim, 2026-05-29): „Ich sehe niemanden der die Website
// recherchiert oder sich ansieht, da müsste doch eine Art Browser Bash erstmal
// kommen usw oder nicht?! Analyse, Recherche…". plan-dispatch now fetches
// URLs referenced by the owner BEFORE the decompose; this card shows the
// progress + the snapshot titles + detected doc requirements.
//
// Design:
//   - collapsed-default (one-liner with domain list + status), expand-on-tap.
//   - Mobile-first: ≥44px touch target on the header.
//   - Token-only (var(--…) with hex fallback like renderPreview).
//   - „Dokument anfordern" anchor per pendingDocRequest (placeholder action;
//     the real endpoint follows in the doc-request slice — the card
//     here only offers the UX anchor, no submit).

interface DiscoveryUrlPayload {
  url: string;
  status: 'ok' | 'failed' | 'timeout';
  title?: string;
  summary?: string;
}

function isDiscoveryUrl(x: unknown): x is DiscoveryUrlPayload {
  if (!isObject(x)) return false;
  if (typeof x.url !== 'string') return false;
  if (x.status !== 'ok' && x.status !== 'failed' && x.status !== 'timeout') return false;
  return true;
}

/** Extracts the host of a fetched URL for the collapsed header list. */
function hostOf(u: string): string {
  const m = /^https?:\/\/([^\/\s?#]+)/i.exec(u);
  return m ? (m[1] ?? u) : u;
}

function renderDiscovery(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const status = (str(data.status) ?? 'done').toLowerCase();
  const urlsRaw = Array.isArray(data.urls) ? data.urls : [];
  const urls: DiscoveryUrlPayload[] = urlsRaw.filter(isDiscoveryUrl);
  const docs = Array.isArray(data.pendingDocRequests)
    ? data.pendingDocRequests.filter((x: unknown): x is string => typeof x === 'string')
    : [];
  const running = status === 'running';
  const hosts = urls.map((u) => hostOf(u.url));

  // Header text: „Discovery · example-agency.example · example.com" or „Discovery läuft …"
  const headerHosts = hosts.slice(0, 3).join(' · ');
  const headerSuffix = hosts.length > 3 ? ` +${hosts.length - 3}` : '';
  const headerText = running
    ? hosts.length > 0
      ? `Discovery läuft · ${headerHosts}${headerSuffix}`
      : 'Discovery läuft …'
    : hosts.length > 0
      ? `Discovery · ${headerHosts}${headerSuffix}`
      : docs.length > 0
        ? 'Discovery · Dokumente angefragt'
        : 'Discovery · nichts gefunden';

  return (
    <details
      data-test="surface-discovery"
      style={{
        background: 'var(--sheet-1, #0c0d0f)',
        border: '0.5px solid var(--line-2, #1f1f1f)',
        borderRadius: 16,
        padding: 0,
        maxWidth: 520,
      }}
    >
      <summary
        data-test="surface-discovery-summary"
        style={{
          listStyle: 'none',
          cursor: 'pointer',
          minHeight: 44,
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          userSelect: 'none',
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            background: running
              ? 'var(--a-now, #5ad1e6)'
              : 'var(--a-ok, #5fd39a)',
            display: 'inline-block',
            flex: '0 0 auto',
          }}
        />
        <span
          style={{
            fontFamily: 'var(--font-mono, ui-monospace)',
            fontSize: 11,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: 'var(--ink-3, #80848c)',
            flex: '0 0 auto',
            display: 'inline-flex',
          }}
        >
          <svg
            width={13}
            height={13}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
        </span>
        <span
          style={{
            fontSize: 13.5,
            color: 'var(--ink, #f4f5f7)',
            flex: '1 1 auto',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {headerText}
        </span>
      </summary>

      <div style={{ padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* URL list */}
        {urls.length > 0 ? (
          <div data-test="surface-discovery-urls" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {urls.map((u) => (
              <div
                key={u.url}
                style={{
                  borderTop: '0.5px solid var(--line-2, #1f1f1f)',
                  paddingTop: 10,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    aria-hidden
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 999,
                      background:
                        u.status === 'ok'
                          ? 'var(--a-ok, #5fd39a)'
                          : u.status === 'timeout'
                            ? 'var(--a-warn, #f5c84b)'
                            : 'var(--a-err, #ef6b6b)',
                      display: 'inline-block',
                    }}
                  />
                  <a
                    href={u.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      fontSize: 13,
                      color: 'var(--ink, #f4f5f7)',
                      textDecoration: 'none',
                      fontWeight: 500,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {u.title ?? hostOf(u.url)}
                  </a>
                </div>
                <div
                  style={{
                    fontFamily: 'var(--font-mono, ui-monospace)',
                    fontSize: 11,
                    color: 'var(--ink-4, #7a7e85)',
                    wordBreak: 'break-all',
                  }}
                >
                  {u.url}
                </div>
                {u.status !== 'ok' ? (
                  <div style={{ fontSize: 12, color: 'var(--ink-3, #80848c)' }}>
                    nicht erreichbar ({u.status})
                  </div>
                ) : null}
                {u.summary ? (
                  <div
                    style={{
                      fontSize: 12.5,
                      color: 'var(--ink-2, #b6b9c0)',
                      lineHeight: 1.5,
                      whiteSpace: 'pre-wrap',
                      maxHeight: 96,
                      overflow: 'hidden',
                    }}
                  >
                    {u.summary}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {/* Document-request list */}
        {docs.length > 0 ? (
          <div data-test="surface-discovery-docs" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div
              style={{
                fontFamily: 'var(--font-mono, ui-monospace)',
                fontSize: 11,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: 'var(--ink-3, #80848c)',
              }}
            >
              Dokumente vom Owner anfordern
            </div>
            {docs.map((d, idx) => (
              <div
                key={idx}
                style={{
                  fontSize: 12.5,
                  color: 'var(--ink-2, #b6b9c0)',
                  background: 'var(--sheet-2, #111317)',
                  border: '0.5px solid var(--line-2, #1f1f1f)',
                  borderRadius: 10,
                  padding: '8px 12px',
                  lineHeight: 1.5,
                }}
              >
                „…{d}…"
              </div>
            ))}
          </div>
        ) : null}

        {/* Empty hint (only if neither URLs nor docs) */}
        {urls.length === 0 && docs.length === 0 && !running ? (
          <div style={{ fontSize: 12.5, color: 'var(--ink-3, #80848c)' }}>
            Keine Quellen oder Dokumente im Prompt erkannt.
          </div>
        ) : null}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// form — generic structured input (Sub-Plan C, 2026-04-30)
// ---------------------------------------------------------------------------

function renderForm(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  // Schema validation happens in FormPromptCard.tsx via validateFormSchema.
  // Here only a minimal shape check, then pass through — the card
  // renders its own error states on an invalid schema.
  const title = str(data.title);
  const fields = Array.isArray(data.fields) ? data.fields : null;
  const endpoint = isObject(data.endpoint) ? data.endpoint : null;
  if (!title || !fields || !endpoint) return null;
  // Cast to an unknown schema — FormPromptCard validates internally.
  return <FormPromptCard schema={data as unknown as FormSchema} />;
}

// ---------------------------------------------------------------------------
// credential-prompt — AI asks for an API key, encrypted-storage path
// ---------------------------------------------------------------------------

function renderCredentialPrompt(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const workspaceId = str(data.workspaceId);
  const name = str(data.name);
  if (!workspaceId || !name) return null;
  return (
    <CredentialPromptCard
      workspaceId={workspaceId}
      name={name}
      description={str(data.description)}
      docsUrl={str(data.docsUrl) ?? str(data.docs_url)}
    />
  );
}

// ---------------------------------------------------------------------------
// workflow-pipeline — live pipeline card in the chat (FSM state live)
// ---------------------------------------------------------------------------

function renderWorkflowPipeline(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const ticketId = str(data.ticketId);
  if (!ticketId) return null;
  return (
    <LiveWorkflowSurface
      ticketId={ticketId}
      ticketTitle={str(data.ticketTitle) ?? str(data.title)}
      initialState={str(data.state) ?? str(data.workflowState) ?? 'draft'}
      workspaceId={str(data.workspaceId)}
      href={str(data.href)}
    />
  );
}

// ---------------------------------------------------------------------------
// rate-limit-retry — Phase RL.2 auto-retry toast on an Anthropic TPM throttle
// ---------------------------------------------------------------------------

function RateLimitRetryWrapper({
  attempt,
  maxAttempts,
  prompt,
}: {
  attempt: number;
  maxAttempts: number;
  prompt: string;
}) {
  const { reply } = useSurfaceAction();
  return (
    <RateLimitRetryCard
      attempt={attempt}
      maxAttempts={maxAttempts}
      onRetry={() => reply(prompt)}
      onCancel={() => undefined}
    />
  );
}

function renderRateLimitRetry(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const prompt = str(data.prompt);
  const attempt = num(data.attempt) ?? 1;
  const maxAttempts = num(data.maxAttempts) ?? 2;
  if (!prompt || prompt.length === 0) return null;
  return (
    <RateLimitRetryWrapper
      attempt={attempt}
      maxAttempts={maxAttempts}
      prompt={prompt}
    />
  );
}

// ---------------------------------------------------------------------------
// consensus-action — Phase AC.3 auto-countdown / quick-start / disagreement
// ---------------------------------------------------------------------------

function renderConsensusAction(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const workstreamId = str(data.workstreamId);
  const consensusLevelRaw = str(data.consensusLevel) ?? str(data.consensus_level);
  if (!workstreamId || !consensusLevelRaw) return null;
  const valid: ConsensusLevel[] = ['strong', 'majority', 'disagreement'];
  if (!(valid as string[]).includes(consensusLevelRaw)) return null;
  const consensusLevel = consensusLevelRaw as ConsensusLevel;
  const masterTicketId = str(data.masterTicketId) ?? str(data.master_ticket_id);
  const initialDispatched = data.dispatched === true;
  // Sub-Plan 04 (2026-04-29) — outlier inline instead of external.
  const rawOutliers = (data as { outliers?: unknown }).outliers;
  const outliers = Array.isArray(rawOutliers)
    ? rawOutliers
        .filter(
          (o): o is { cluster?: unknown; summary?: unknown } =>
            typeof o === 'object' && o !== null,
        )
        .map((o) => ({
          cluster: str((o as { cluster?: unknown }).cluster) ?? 'cluster',
          summary: str((o as { summary?: unknown }).summary) ?? '',
        }))
        .filter((o) => o.summary.length > 0)
    : undefined;
  // Sub-Plan 05 (2026-04-29) — subTickets-Inline + planText-Toggle
  const rawSubs = (data as { subTickets?: unknown }).subTickets;
  const subTickets = Array.isArray(rawSubs)
    ? rawSubs
        .filter(
          (s): s is { title?: unknown; prio?: unknown } =>
            typeof s === 'object' && s !== null,
        )
        .map((s) => ({
          title: str((s as { title?: unknown }).title) ?? '',
          prio: str((s as { prio?: unknown }).prio),
        }))
        .filter((s) => s.title.length > 0)
    : undefined;
  const planText = str((data as { planText?: unknown }).planText);
  return (
    <ConsensusActionCard
      workstreamId={workstreamId}
      consensusLevel={consensusLevel}
      masterTicketId={masterTicketId}
      initialDispatched={initialDispatched}
      outliers={outliers}
      subTickets={subTickets}
      planText={planText}
    />
  );
}

// ---------------------------------------------------------------------------
// iterate-pipeline — Sub-Plan 04 Wave 2 (2026-04-29) Phase=iterate
// One living card per workstream during V1...V5. Polls pause-status.
// ---------------------------------------------------------------------------

function renderIteratePipeline(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const workstreamId = str(data.workstreamId);
  const workspaceId = str(data.workspaceId);
  if (!workstreamId || !workspaceId) return null;
  const workstreamName = str(data.workstreamName) ?? str(data.name);
  const maxVersion = num(data.maxVersion) ?? num(data.max_version);
  // Owner fix 2026-05-28: suppress when a run-cockpit card is already active for
  // the same (workspaceId, workstreamId) — the cockpit card
  // bundles the iterate-pipeline info. Wrapper component, because hooks are
  // not allowed in the pure renderer.
  return (
    <IteratePipelineSuppressible
      workstreamId={workstreamId}
      workspaceId={workspaceId}
      workstreamName={workstreamName}
      maxVersion={maxVersion ?? undefined}
    />
  );
}

function IteratePipelineSuppressible(props: {
  workstreamId: string;
  workspaceId: string;
  workstreamName: string | undefined;
  maxVersion: number | undefined;
}): ReactNode {
  const coordKey = buildCockpitCoordKey(props.workspaceId, props.workstreamId);
  const suppress = useRunCockpitActive(coordKey);
  if (suppress) {
    // suppressed by run-cockpit (owner fix 2026-05-28)
    return null;
  }
  return (
    <IteratePipelineCard
      workstreamId={props.workstreamId}
      workspaceId={props.workspaceId}
      workstreamName={props.workstreamName}
      maxVersion={props.maxVersion}
    />
  );
}

// ---------------------------------------------------------------------------
// sub-workstreams — Sprint C (2026-04-29). Tree view of all sub-agents.
// ---------------------------------------------------------------------------

function renderSubWorkstreams(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const masterWorkstreamId =
    str(data.masterWorkstreamId) ?? str(data.workstreamId);
  const workspaceId = str(data.workspaceId);
  if (!masterWorkstreamId || !workspaceId) return null;
  // Owner fix 2026-05-28: suppress when a run-cockpit card is already active for
  // the same (workspaceId, masterWorkstreamId).
  return (
    <SubWorkstreamsSuppressible
      masterWorkstreamId={masterWorkstreamId}
      workspaceId={workspaceId}
    />
  );
}

function SubWorkstreamsSuppressible(props: {
  masterWorkstreamId: string;
  workspaceId: string;
}): ReactNode {
  const coordKey = buildCockpitCoordKey(
    props.workspaceId,
    props.masterWorkstreamId,
  );
  const suppress = useRunCockpitActive(coordKey);
  if (suppress) {
    // suppressed by run-cockpit (owner fix 2026-05-28)
    return null;
  }
  return (
    <SubWorkstreamsCard
      masterWorkstreamId={props.masterWorkstreamId}
      workspaceId={props.workspaceId}
    />
  );
}

// ---------------------------------------------------------------------------
// live-pipeline — Phase WSC.1 auto-dispatch live view in the chat
// ---------------------------------------------------------------------------

function renderLivePipeline(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const workstreamId = str(data.workstreamId);
  const workspaceId = str(data.workspaceId);
  const masterTicketId = str(data.masterTicketId) ?? str(data.master_ticket_id);
  if (!workstreamId || !workspaceId || !masterTicketId) return null;
  const subTicketsRaw = Array.isArray(data.subTickets) ? data.subTickets : [];
  const subTickets = subTicketsRaw
    .map((s) => {
      if (!isObject(s)) return null;
      const id = str(s.id);
      const title = str(s.title) ?? id ?? '';
      if (!id) return null;
      return { id, title };
    })
    .filter((s): s is { id: string; title: string } => s !== null);
  if (subTickets.length === 0) return null;
  const href = str(data.href) ?? `/tickets/${encodeURIComponent(masterTicketId)}`;
  return (
    <LivePipeline
      workstreamId={workstreamId}
      workspaceId={workspaceId}
      masterTicketId={masterTicketId}
      subTickets={subTickets}
      href={href}
    />
  );
}

// ---------------------------------------------------------------------------
// live-swarm — live-updating heatmap of the tier-spawn activity
// ---------------------------------------------------------------------------

function renderLiveSwarm(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const workstreamId = str(data.workstreamId);
  const workspaceId = str(data.workspaceId);
  const ticketId = str(data.ticketId);
  const tiersRaw = isObject(data.tierMix) ? data.tierMix : null;
  if (!workstreamId || !workspaceId || !tiersRaw) return null;
  const opus = num(tiersRaw.opus) ?? 0;
  const sonnet = num(tiersRaw.sonnet) ?? 0;
  const haiku = num(tiersRaw.haiku) ?? 0;
  const href = str(data.href) ?? `/workstreams/${encodeURIComponent(workstreamId)}`;
  return (
    <LiveSwarm
      workstreamId={workstreamId}
      workspaceId={workspaceId}
      ticketId={ticketId}
      tierMix={{ opus, sonnet, haiku }}
      href={href}
    />
  );
}

// ---------------------------------------------------------------------------
// tier-choice — multi-agent plan detection + tier-mix choice (Phase P).
// Sub-Plan A (2026-04-30): the picker now shows the real iterate presets
// (Schnell/Standard/Tief) and persists the choice as presetId, so that
// runIterate actually applies it.
// ---------------------------------------------------------------------------

import {
  TIER_PRESETS,
  totalAgents,
  type TierPresetId,
} from '@/lib/workstreams/tier-presets';

interface TierPreset {
  id: TierPresetId;
  label: string;
  cost?: string;
  totalAgents: number;
  estMinutes: number;
  recommended?: boolean;
}

function buildIteratePresets(): TierPreset[] {
  const presetMeta: Array<{
    id: TierPresetId;
    label: string;
    recommended?: boolean;
  }> = [
    { id: 'schnell', label: 'Schnell' },
    { id: 'standard', label: 'Standard', recommended: true },
    { id: 'tief', label: 'Tief' },
  ];
  return presetMeta.map(({ id, label, recommended }) => {
    const cfg = TIER_PRESETS[id];
    const total = totalAgents(cfg);
    const agentLabel = total === 1 ? '1 Agent' : `~${total} Agenten`;
    return {
      id,
      label,
      cost: `${agentLabel} · ~${cfg.estMinutes} min`,
      totalAgents: total,
      estMinutes: cfg.estMinutes,
      recommended,
    };
  });
}

function renderTierChoice(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const title = str(data.title) ?? 'Plan erkannt — wie tief soll\'s werden?';
  const summary = str(data.summary);
  const recommendationBasis = str(data.recommendation_basis);
  const ticketTitle = str(data.planTitle) ?? str(data.workstreamName) ?? title;
  const workspaceId = str(data.workspaceId);
  // Sub-Plan A (2026-04-30): we always build presets from tier-presets.ts.
  // If the server does send its own presets (legacy path), they are
  // ignored — the truth is the single source of truth in tier-presets.
  const presets = buildIteratePresets();
  return (
    <TierChoiceCard
      title={title}
      summary={summary}
      recommendationBasis={recommendationBasis}
      ticketTitle={ticketTitle}
      workspaceId={workspaceId}
      presets={presets}
    />
  );
}

function TierChoiceCard({
  title,
  summary,
  recommendationBasis,
  ticketTitle,
  workspaceId,
  presets,
}: {
  title: string;
  summary?: string;
  recommendationBasis?: string;
  ticketTitle: string;
  workspaceId?: string;
  presets: TierPreset[];
}) {
  const { reply, pushAssistant } = useSurfaceAction();

  const handlePick = async (preset: TierPreset): Promise<void> => {
    if (!workspaceId) return;
    // 1. Auto-create the workstream
    try {
      const resp = await fetch('/api/workstreams', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          name: ticketTitle,
        }),
      });
      if (!resp.ok) {
        reply(`Tier-Wahl: ${preset.label} (Workstream-Anlage fehlgeschlagen)`);
        return;
      }
      const data = (await resp.json()) as {
        workstream?: { id?: string; primaryTicketId?: string };
      };
      const wsId = data.workstream?.id;
      if (!wsId) return;
      // 2. Trigger the master-plan ticket + iterate spawn with presetId.
      // The server persists (mode='iterate', iterate_config_json=PRESET_JSON)
      // BEFORE runIterate spawns — runIterateMode then reads the config.
      const spawnResp = await fetch(
        `/api/workstreams/${encodeURIComponent(wsId)}/spawn`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            planTitle: ticketTitle,
            mode: 'iterate',
            presetId: preset.id,
          }),
        },
      ).catch(() => null);
      let masterTicketId: string | undefined;
      if (spawnResp && spawnResp.ok) {
        const spawnData = (await spawnResp.json().catch(() => ({}))) as {
          masterTicketId?: string;
        };
        masterTicketId = spawnData.masterTicketId;
      }
      // 3. Push a confirmation message (no more live-swarm — iterate
      // has its own IteratePipelineCard that the orchestrator emits).
      pushAssistant(
        `**Workstream angelegt** · ${preset.label} mit ${preset.totalAgents === 1 ? '1 Agent' : `~${preset.totalAgents} Agenten`} (~${preset.estMinutes} min).${
          masterTicketId ? `\n\nMaster-Ticket: \`${masterTicketId}\`` : ''
        }`,
      );
    } catch {
      reply(`Tier-Wahl: ${preset.label} (Fehler beim Anlegen)`);
    }
  };

  // Wave 4 (2026-05-01): tier block switched to .srf-fallback* CSS classes
  // (token bind, no inline style). Recommended border via
  // CSS-var override instead of a JS style spread.
  return (
    <div className="srf-fallback" role="region" aria-label={title}>
      <div className="srf-fallback__header">
        <span className="srf-fallback__badge">Plan erkannt</span>
        <h3 className="srf-fallback__title">{title}</h3>
        {summary ? <p className="srf-fallback__sub">{summary}</p> : null}
        {recommendationBasis ? (
          <p className="srf-fallback__basis">
            <svg
              width={13}
              height={13}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              style={{ verticalAlign: '-2px', marginRight: 5 }}
            >
              <path d="M4 20V10 M10 20V4 M16 20v-7 M20 20H3" />
            </svg>
            {recommendationBasis}
          </p>
        ) : null}
      </div>
      <div className="srf-fallback__grid">
        {presets.map((p) => {
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => void handlePick(p)}
              className="srf-fallback__preset press"
              style={{
                borderColor: p.recommended ? 'var(--a-now)' : 'var(--line-2)',
                background: p.recommended
                  ? 'color-mix(in oklab, var(--a-now) 8%, var(--sheet-2))'
                  : 'var(--sheet-2)',
              }}
            >
              <div style={tierPresetHeaderStyle}>
                <span style={tierPresetLabelStyle}>{p.label}</span>
                {p.recommended ? (
                  <span className="srf-fallback__rec">empfohlen</span>
                ) : null}
              </div>
              <div style={tierFooterStyle}>
                <span>
                  {p.totalAgents === 1 ? '1 Agent' : `~${p.totalAgents} Agenten`}
                </span>
                <span>~{p.estMinutes} min</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const tierPresetHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const tierPresetLabelStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--ink)',
};

const tierMixRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  flexWrap: 'wrap',
};

function tierTierChip(color: string): React.CSSProperties {
  return {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    padding: '2px 7px',
    borderRadius: 4,
    background: `color-mix(in oklab, ${color} 14%, transparent)`,
    color,
    letterSpacing: '0.04em',
  };
}

const tierFooterStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  fontSize: 11,
  color: 'var(--ink-3)',
  fontFamily: 'var(--font-mono)',
};

// ---------------------------------------------------------------------------
// Terminal — lines of shell output; prompt / host / dim / error / ok / etc.
// ---------------------------------------------------------------------------

function renderTerminal(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const linesRaw = data.lines;
  if (!Array.isArray(linesRaw)) return null;
  const lines = linesRaw.flatMap((l): Array<{ text?: string; spans?: Array<{ text: string; level?: 'host'|'prompt'|'dim'|'error'|'ok'|'claude'|'codex' }>; cursor?: boolean }> => {
    if (!isObject(l)) return [];
    const text = str(l.text);
    const spans = Array.isArray(l.spans)
      ? l.spans.flatMap((s): Array<{ text: string; level?: 'host'|'prompt'|'dim'|'error'|'ok'|'claude'|'codex' }> => {
          if (!isObject(s)) return [];
          const t = str(s.text);
          if (t === undefined) return [];
          const lvRaw = str(s.level);
          const level = lvRaw && ['host','prompt','dim','error','ok','claude','codex'].includes(lvRaw)
            ? (lvRaw as 'host'|'prompt'|'dim'|'error'|'ok'|'claude'|'codex')
            : undefined;
          return [{ text: t, level }];
        })
      : undefined;
    if (text === undefined && (!spans || spans.length === 0)) return [];
    return [{ text, spans, cursor: Boolean(l.cursor) }];
  });
  if (lines.length === 0) return null;
  return <Terminal lines={lines} />;
}

// ---------------------------------------------------------------------------
// Heartbeat — count + label. Simple ripple for the project pulse.
// ---------------------------------------------------------------------------

function renderHeartbeat(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const count = num(data.count) ?? 0;
  const label = str(data.label) ?? 'aktiv';
  const aria = str(data.ariaLabel) ?? `${count} ${label}`;
  return <HeartbeatPulse count={count} label={label} ariaLabel={aria} />;
}

// ---------------------------------------------------------------------------
// Workspace — single workspace label as a pill, optionally with a palette accent.
// ---------------------------------------------------------------------------

function renderWorkspace(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const label = str(data.label) ?? str(data.name) ?? '';
  if (!label) return null;
  const variantRaw = str(data.variant) ?? 'own';
  const variant = (['north','clientb','own','private','claude','codex','error'].includes(variantRaw)
    ? variantRaw
    : 'own') as 'north' | 'clientb' | 'own' | 'private' | 'claude' | 'codex' | 'error';
  return <Pill variant={variant}>{label}</Pill>;
}

// ---------------------------------------------------------------------------
// Routine — compact info line (reuses the toast structure for the MVP).
// ---------------------------------------------------------------------------

function renderRoutine(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const name = str(data.name) ?? 'Routine';
  const schedule = str(data.schedule) ?? str(data.trigger) ?? '';
  const lastRun = str(data.lastRun) ?? '';
  const bodyParts: string[] = [];
  if (schedule) bodyParts.push(schedule);
  if (lastRun) bodyParts.push(`zuletzt: ${lastRun}`);
  return (
    <Toast
      variant="default"
      iconGlyph="⟳"
      title={name}
      body={bodyParts.join(' · ')}
    />
  );
}

// ---------------------------------------------------------------------------
// Agent — shows a sub-agent (role + status + optional task preview).
// Uses the TMC/Teammate card.
// ---------------------------------------------------------------------------

function renderAgent(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const role = str(data.role) ?? str(data.name) ?? 'agent';
  const variantRaw = str(data.variant) ?? 'standard';
  const variant = (['lead', 'standard', 'add'].includes(variantRaw)
    ? variantRaw
    : 'standard') as 'lead' | 'standard' | 'add';
  const avatar = str(data.avatarGlyph) ?? role.slice(0, 1).toUpperCase();
  const avatarAccent = Boolean(data.avatarAccent ?? variant === 'lead');
  const statusVariantRaw = str(data.statusVariant) ?? 'live';
  const statusVariant = (['live', 'idle', 'eta'].includes(statusVariantRaw)
    ? statusVariantRaw
    : 'live') as 'live' | 'idle' | 'eta';
  const status = str(data.status);
  const counter = str(data.counter) ?? str(data.task);
  const tagsRaw = data.tags;
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw.filter((t): t is string => typeof t === 'string').slice(0, 3)
    : undefined;
  return (
    <Teammate
      variant={variant}
      avatarGlyph={avatar}
      avatarAccent={avatarAccent}
      name={role}
      role={str(data.desc) ?? str(data.description) ?? ''}
      tags={tags}
      stats={
        counter || status
          ? {
              counter: counter ?? '',
              status: status ?? 'läuft',
              statusVariant,
            }
          : undefined
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Swarm — consensus heatmap (n cells, colored per variant).
// Uses CHR/Heatmap from the design library.
// ---------------------------------------------------------------------------

function renderSwarm(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const title = str(data.title) ?? 'Schwarm-Konsens';
  const value = str(data.value);
  const sub = str(data.sub);
  const cellsRaw = data.cells;
  if (!Array.isArray(cellsRaw)) return null;
  const cells = cellsRaw
    .slice(0, 200)
    .map((c): { variant: 'consensus' | 'median' | 'outlier' | 'running' | 'empty' } => {
      const v = isObject(c) ? str(c.variant) : undefined;
      if (v === 'consensus' || v === 'median' || v === 'outlier' || v === 'running') {
        return { variant: v };
      }
      return { variant: 'empty' };
    });
  if (cells.length === 0) return null;
  return (
    <Heatmap title={title} cells={cells} value={value} sub={sub} />
  );
}

// ---------------------------------------------------------------------------
// Document / Folder / CloudBrowser — workspace cloud (Sprint X · 2026-04-27)
// ---------------------------------------------------------------------------

function renderDocument(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  // ID is OPTIONAL: a document referenced by the agent
  // (`<surface:document>{filename,mime,workspace}</surface:document>`) has
  // no artifact ID. Without an ID we still render a clean file card
  // (instead of a raw-text fallback) — only without download/preview links, because there is no
  // stored artifact to stream. The only required field is the
  // `filename` (otherwise there is nothing meaningful to show).
  const id = str(data.id);
  const filename = str(data.filename) ?? str(data.title) ?? str(data.name);
  const mime = str(data.mime) ?? 'application/octet-stream';
  const bytesRaw = data.bytes ?? data.size;
  const bytes =
    typeof bytesRaw === 'number'
      ? bytesRaw
      : typeof bytesRaw === 'string'
        ? Number(bytesRaw)
        : 0;
  if (!filename) return null;
  // Only derive URLs if an ID exists — otherwise leave undefined,
  // so the card does not show 404 links / broken <img> covers.
  const downloadUrl = id
    ? (str(data.downloadUrl) ?? `/api/cloud/${id}`)
    : undefined;
  const previewUrl = id
    ? (str(data.previewUrl) ?? `/api/cloud/${id}/preview`)
    : undefined;
  const thumbnailUrl = id ? str(data.thumbnailUrl) : undefined;
  const pagesRaw = data.pages;
  const pages =
    typeof pagesRaw === 'number'
      ? pagesRaw
      : typeof pagesRaw === 'string' && pagesRaw.length > 0
        ? Number(pagesRaw)
        : null;

  return (
    <Document
      id={id}
      filename={filename}
      mime={mime}
      bytes={isFinite(bytes) ? bytes : 0}
      pages={pages && isFinite(pages) ? pages : null}
      workspace={str(data.workspace) ?? str(data.workspaceId)}
      workspaceLabel={str(data.workspaceLabel)}
      downloadUrl={downloadUrl}
      previewUrl={previewUrl}
      thumbnailUrl={thumbnailUrl}
      createdBy={str(data.createdBy)}
      createdAt={str(data.createdAt)}
    />
  );
}

function renderFolder(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const id = str(data.id);
  const name = str(data.name);
  const path = str(data.path) ?? '/';
  if (!id || !name) return null;
  const itemCountRaw = data.itemCount ?? data.count;
  const itemCount =
    typeof itemCountRaw === 'number'
      ? itemCountRaw
      : typeof itemCountRaw === 'string'
        ? Number(itemCountRaw)
        : undefined;
  return (
    <Folder
      id={id}
      name={name}
      path={path}
      workspace={str(data.workspace) ?? str(data.workspaceId)}
      workspaceLabel={str(data.workspaceLabel)}
      itemCount={
        itemCount !== undefined && isFinite(itemCount) ? itemCount : undefined
      }
      href={str(data.href)}
    />
  );
}

// ---------------------------------------------------------------------------
// open-questions — Sub-Plan D (2026-04-30). Pointer to the bottom answer pill.
// ---------------------------------------------------------------------------
// SP-8 (2026-06): UNIFIED to ONE answer surface. A `<surface:open-questions>`
// tag in the stream used to mount the INTERACTIVE in-bubble stepper
// (ChatInlineOpenQuestions) — a second, competing reply() path that broke with
// the design (box-in-box, double-send risk). It now renders the SAME compact,
// NON-interactive `OpenQuestionsInlineRef` pointer that the `## Offene Fragen`
// markdown section already uses (surface-text-render.tsx). The single answer
// surface is the bottom pill (ChatOpenQuestionsPill via ActionDeck) — one
// reply() path, no in-feed stepper. We still parse the payload here so an
// empty/invalid set renders nothing (null) and the count is exact.

function renderOpenQuestions(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const rawQs = Array.isArray(data.questions) ? data.questions : null;
  if (!rawQs) return null;
  const questions = rawQs
    .filter(isObject)
    .map((q) => {
      const id = str(q.id) ?? '';
      // The surface payload uses `q` as the field name; PlanQuestion expects `text`.
      const text = str(q.q) ?? str(q.text) ?? '';
      return { id, text };
    })
    .filter((q) => q.id.length > 0 && q.text.length > 0);
  if (questions.length === 0) return null;
  return <OpenQuestionsInlineRef count={questions.length} />;
}

// ---------------------------------------------------------------------------
// bug-fix-swarm — Sprint H (2026-04-30). 3 parallel diagnosis spawns.
// ---------------------------------------------------------------------------

function renderBugFixSwarm(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const swarmId = str(data.swarmId);
  const workspaceId = str(data.workspaceId);
  const workstreamId = str(data.workstreamId);
  const masterTicketId = str(data.masterTicketId) ?? str(data.master_ticket_id);
  const bugDescription = str(data.bugDescription) ?? str(data.bug_description) ?? '';
  if (!swarmId || !workspaceId || !workstreamId || !masterTicketId) return null;
  return (
    <BugFixSwarmCard
      swarmId={swarmId}
      workspaceId={workspaceId}
      workstreamId={workstreamId}
      masterTicketId={masterTicketId}
      bugDescription={bugDescription}
    />
  );
}

// ---------------------------------------------------------------------------
// bug-fix-pipeline — Wave 2 (Sub-Plan Auto-Swarm Bug-Fix · 2026-05-03).
// Re-uses BugFixSwarmCard with the workstreamId as a swarmId surrogate.
// Polling endpoint: /api/bugs/pipeline/[workstreamId]. The backend emits
// `bug_fix_pipeline_phase` events; the card subscribes/polls for them.
// ---------------------------------------------------------------------------

function renderBugFixPipeline(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const workstreamId = str(data.workstreamId);
  const workspaceId = str(data.workspaceId);
  const masterTicketId =
    str(data.masterTicketId) ?? str(data.master_ticket_id) ?? workstreamId;
  const bugDescription =
    str(data.bugDescription) ?? str(data.bug_description) ?? '';
  if (!workstreamId || !workspaceId) return null;
  // We use workstreamId as the swarmId surrogate — the pipeline card
  // identifies itself by workstreamId, not by swarm-uuid.
  return (
    <BugFixSwarmCard
      swarmId={`pipeline-${workstreamId}`}
      workspaceId={workspaceId}
      workstreamId={workstreamId}
      masterTicketId={masterTicketId ?? workstreamId}
      bugDescription={bugDescription}
    />
  );
}

// ---------------------------------------------------------------------------
// Wave 7 (2026-05-01) — loop-phase coverage
// ---------------------------------------------------------------------------

const LOOP_PHASE_KINDS: ReadonlyArray<LoopPhaseKind> = [
  'auto-dispatch-stage',
  'auto-dispatch-stage-retry',
  'auto-dispatch-overview',
  'auto-dispatch-pause',
  'tier-output',
  'iterate-resumed',
  'sniper-pause-start',
];

function renderLoopPhase(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const kindRaw = str(data.kind);
  if (!kindRaw) return null;
  if (!(LOOP_PHASE_KINDS as readonly string[]).includes(kindRaw)) return null;
  const kind = kindRaw as LoopPhaseKind;
  return (
    <LoopPhaseCard
      kind={kind}
      workstreamId={str(data.workstreamId)}
      workspaceId={str(data.workspaceId)}
      stage={str(data.stage)}
      tier={str(data.tier)}
      agentIdx={num(data.agentIdx)}
      stageIdx={num(data.stageIdx)}
      attempt={num(data.attempt)}
      maxAttempts={num(data.maxAttempts)}
      waitMs={num(data.waitMs)}
      versionN={num(data.versionN)}
      text={str(data.text)}
      reason={str(data.reason)}
      actor={str(data.actor)}
    />
  );
}

function renderIterateRoast(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  return (
    <IterateRoastCard
      workstreamId={str(data.workstreamId)}
      workspaceId={str(data.workspaceId)}
      roasterIdx={num(data.roasterIdx)}
      role={str(data.role)}
      versionN={num(data.versionN)}
      text={str(data.text)}
      summary={str(data.summary)}
    />
  );
}

function renderIterateVersion(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  // Owner fix 2026-05-28: suppress when a run-cockpit card is already active for
  // the same (workspaceId, workstreamId).
  return (
    <IterateVersionSuppressible
      workstreamId={str(data.workstreamId)}
      workspaceId={str(data.workspaceId)}
      versionN={num(data.versionN)}
      text={str(data.text)}
      headline={str(data.headline)}
      costCents={num(data.costCents)}
    />
  );
}

function IterateVersionSuppressible(props: {
  workstreamId: string | undefined;
  workspaceId: string | undefined;
  versionN: number | undefined;
  text: string | undefined;
  headline: string | undefined;
  costCents: number | undefined;
}): ReactNode {
  const coordKey = buildCockpitCoordKey(props.workspaceId, props.workstreamId);
  const suppress = useRunCockpitActive(coordKey);
  if (suppress) {
    // suppressed by run-cockpit (owner fix 2026-05-28)
    return null;
  }
  return (
    <IterateVersionCard
      workstreamId={props.workstreamId}
      workspaceId={props.workspaceId}
      versionN={props.versionN}
      text={props.text}
      headline={props.headline}
      costCents={props.costCents}
    />
  );
}

function renderUserCorrection(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  return (
    <UserCorrectionCard
      workstreamId={str(data.workstreamId)}
      message={str(data.message)}
      injectedAt={str(data.injectedAt)}
      versionN={num(data.versionN)}
    />
  );
}

function renderPlanOpenQuestionsCard(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const rawQs = Array.isArray(data.questions) ? data.questions : [];
  const questions = rawQs
    .filter(isObject)
    .map((q) => {
      const id = str(q.id) ?? '';
      const text = str(q.q) ?? '';
      const opts = Array.isArray(q.options)
        ? q.options.filter((o): o is string => typeof o === 'string')
        : undefined;
      return { id, q: text, options: opts && opts.length > 0 ? opts : undefined };
    })
    .filter((q) => q.id.length > 0 && q.q.length > 0);
  if (questions.length === 0) return null;
  return (
    <PlanOpenQuestionsCard
      workstreamId={str(data.workstreamId)}
      workspaceId={str(data.workspaceId)}
      questions={questions}
    />
  );
}

function renderCloudBrowser(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const workspace = str(data.workspace) ?? str(data.workspaceId);
  const workspaceLabel = str(data.workspaceLabel) ?? workspace ?? 'Workspace';
  if (!workspace) return null;
  const artifactCountRaw = data.artifactCount ?? data.count ?? 0;
  const totalBytesRaw = data.totalBytes ?? data.bytes ?? 0;
  const folderCountRaw = data.folderCount ?? 0;
  const num = (v: unknown): number =>
    typeof v === 'number' && isFinite(v)
      ? v
      : typeof v === 'string'
        ? Number(v) || 0
        : 0;
  return (
    <CloudBrowser
      workspace={workspace}
      workspaceLabel={workspaceLabel}
      artifactCount={num(artifactCountRaw)}
      totalBytes={num(totalBytesRaw)}
      folderCount={num(folderCountRaw)}
      href={str(data.href) ?? `/workspaces/${workspace}/cloud`}
    />
  );
}

// ---------------------------------------------------------------------------
// subplan — BACKPORT-03 (2026-05-23). Renders a ProposedPlan card with
// a step list, complexity chip and optional approve/edit/decline flow.
// `data` comes as `unknown` from JSON.parse — we check every required field
// before casting. Malformed JSON → return null (no crash in the chat stream).
// ---------------------------------------------------------------------------

/** Guard: checks whether `v` is a valid PlanStep (required fields: id, index, title, rationale). */
function isPlanStep(v: unknown): v is PlanStep {
  if (!isObject(v)) return false;
  return (
    typeof v.id === 'string' && v.id.length > 0 &&
    typeof v.index === 'number' &&
    typeof v.title === 'string' && v.title.length > 0 &&
    typeof v.rationale === 'string'
  );
}

// ---------------------------------------------------------------------------
// SubplanCardWrapper — BACKPORT-03 approve wiring (2026-05-23).
// Encapsulates the approval flow: POST /api/workstreams/:id/execute-plan → pushAssistant.
// Pattern: analogous to TierChoiceCard further up (useSurfaceAction + fetch + pushAssistant).
// ---------------------------------------------------------------------------

/** All props that renderSubplan extracted, passed in bundled. */
interface SubplanCardWrapperProps {
  plan: ProposedPlan;
  depth: number;
  awaitingApproval: boolean;
  stepStatuses: Record<string, 'pending' | 'active' | 'done' | 'failed' | 'in-critic' | 'fix-iter-1' | 'fix-iter-2' | 'escalated' | 'cancelled'> | undefined;
  /** workstreamId from the surfacePayload — undefined if the payload is incomplete. */
  workstreamId: string | undefined;
  /**
   * The root step that triggered this subplan (depth-1 cards).
   * Null on the root card (depth 0) or when the payload does not contain the field.
   * SubplanCard uses it for the header „Subplan — <parentStep.title>".
   */
  parentStep: PlanStep | null;
  /**
   * Owner fix 2026-05-28: the card starts collapsed even at depth < 2 when
   * the surface payload carries `collapsed:true` (set by plan-dispatch
   * for child subplans). depth >= 2 still forces collapse.
   */
  initialCollapsed: boolean;
}

function SubplanCardWrapper({
  plan,
  depth,
  awaitingApproval,
  stepStatuses,
  workstreamId,
  parentStep,
  initialCollapsed,
}: SubplanCardWrapperProps) {
  const { pushAssistant } = useSurfaceAction();

  // handleApprove: POST execute-plan → confirmation or error message in the chat.
  // onApprove is (planId: string) => void on the SubplanCard side —
  // we start the fetch without an await at the render level.
  const handleApprove = (planId: string): void => {
    if (!workstreamId) {
      // No workstreamId in the payload — abort defensively instead of a blind POST.
      pushAssistant('Plan konnte nicht freigegeben werden — workstreamId fehlt im Payload.');
      return;
    }
    fetch(
      '/api/workstreams/' + encodeURIComponent(workstreamId) + '/execute-plan',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planId, coordKey: 'ws:' + workstreamId }),
      },
    )
      .then((r) => {
        if (r.ok) {
          pushAssistant('**Plan freigegeben** — Ausführung läuft, ich melde die Schritte hier.');
        } else {
          pushAssistant('Konnte den Plan nicht starten (HTTP ' + r.status + ').');
        }
      })
      .catch(() => {
        pushAssistant('Konnte den Plan nicht starten (Netzwerkfehler).');
      });
  };

  // handleDecline: no API call needed — user feedback in the chat is enough.
  const handleDecline = (_planId: string): void => {
    pushAssistant('Plan verworfen.');
  };

  return (
    <SubplanCard
      depth={depth}
      plan={plan}
      // parentStep: read from the payload (depth-1 cards provide the root step,
      // the root card and incomplete payloads land at null → SubplanCard shows
      // „unbekannter Parent" as a fallback (see SubplanCard.tsx line 84).
      parentStep={parentStep}
      awaitingApproval={awaitingApproval}
      stepStatuses={stepStatuses}
      onApprove={handleApprove}
      onDecline={handleDecline}
      initialCollapsed={initialCollapsed}
    />
  );
}

function renderSubplan(data: unknown): ReactNode {
  if (!isObject(data)) return null;

  // Check the required fields of ProposedPlan.
  const id = str(data.id);
  const originalIntent = str(data.originalIntent);
  const complexityRaw = str(data.estimatedComplexity);
  const proposedAt = num(data.proposedAt) ?? 0;
  if (!id || !originalIntent) return null;

  // estimatedComplexity must be in {M, L, XL}.
  const estimatedComplexity =
    complexityRaw === 'M' || complexityRaw === 'L' || complexityRaw === 'XL'
      ? complexityRaw
      : 'M'; // defensive fallback: we'd rather render as M than not at all

  // steps: each element is protected by isPlanStep.
  const rawSteps = Array.isArray(data.steps) ? data.steps : [];
  const steps: PlanStep[] = rawSteps.filter(isPlanStep);
  // We need at least one step — otherwise the plan is meaningless.
  if (steps.length === 0) return null;

  const plan: ProposedPlan = { id, originalIntent, steps, estimatedComplexity, proposedAt };

  // depth: integer ≥ 0 from the payload, fallback 0.
  const depthRaw = num(data.depth);
  const depth = typeof depthRaw === 'number' && depthRaw >= 0 ? Math.floor(depthRaw) : 0;

  // awaitingApproval: explicit true → true; anything else → false.
  const awaitingApproval = data.awaitingApproval === true;

  // stepStatuses: Record<string, Status> — defensive: only strings as values.
  const VALID_STEP_STATUSES = new Set([
    'pending', 'active', 'done', 'failed', 'in-critic',
    'fix-iter-1', 'fix-iter-2', 'escalated', 'cancelled',
  ]);
  let stepStatuses: Record<string, 'pending' | 'active' | 'done' | 'failed' | 'in-critic' | 'fix-iter-1' | 'fix-iter-2' | 'escalated' | 'cancelled'> | undefined;
  if (isObject(data.stepStatuses)) {
    const ssMap: typeof stepStatuses = {};
    let hasAny = false;
    for (const [k, v] of Object.entries(data.stepStatuses)) {
      if (typeof v === 'string' && VALID_STEP_STATUSES.has(v)) {
        ssMap[k] = v as NonNullable<typeof stepStatuses>[string];
        hasAny = true;
      }
    }
    if (hasAny) stepStatuses = ssMap;
  }

  // workstreamId: read from the payload — plan-dispatch sets surfacePayload.workstreamId.
  const workstreamId = str(data.workstreamId);

  // parentStep: shape guard via isPlanStep (required fields: id + title).
  // Depth-1 cards provide the root step that triggered them; the root card and
  // payloads without the field land at null. SubplanCard then renders
  // „unbekannter Parent" as a fallback (N1-conformant: no silent null render).
  const parentStep: PlanStep | null = isPlanStep(data.parentStep) ? data.parentStep : null;

  // Owner fix 2026-05-28: collapsed:true in the payload (set by plan-dispatch
  // for child subplans, lib/plan-first/plan-dispatch.ts:251) forces the
  // pill variant. Backwards-compat: missing/false ⇒ as before
  // (depth >= 2 forces collapse via the SubplanCard itself).
  const initialCollapsed = data.collapsed === true;

  // SubplanCardWrapper encapsulates approve/decline wiring via useSurfaceAction.
  return (
    <SubplanCardWrapper
      plan={plan}
      depth={depth}
      awaitingApproval={awaitingApproval}
      stepStatuses={stepStatuses}
      workstreamId={workstreamId}
      parentStep={parentStep}
      initialCollapsed={initialCollapsed}
    />
  );
}

// ---------------------------------------------------------------------------
// credential-request — ACL5-B (2026-05-24).
// Secret-entry surface for a provider API key. The secret value goes
// EXCLUSIVELY into the vault via POST /api/connectors/[provider]/credential
// — never into chat/SSE/ledger. The surface payload carries NO secret field.
// ---------------------------------------------------------------------------

function renderCredentialRequest(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const provider = str(data.provider);
  const workspaceId = str(data.workspaceId);
  // Required fields: provider + workspaceId.
  if (!provider || !workspaceId) return null;

  const scopeKindRaw = str(data.scopeKind);
  const scopeKind: 'workspace' | 'org' =
    scopeKindRaw === 'org' ? 'org' : 'workspace';

  const why = str(data.why) ?? str(data.reason) ?? str(data.description);
  const docsUrl = str(data.docsUrl) ?? str(data.docs_url);

  // FIX-B (2026-05-30): mobile connector-auth surface — pass authKind/engineBacked/
  // capability/signupUrl/credentialFieldHint through from the payload.
  // Backwards-compatible: if the field is missing → CredentialRequestCard falls back to 'apikey'.
  const authKindRaw = str(data.authKind) ?? '';
  const authKind: 'apikey' | 'oauth' | 'none' = ['apikey', 'oauth', 'none'].includes(
    authKindRaw,
  )
    ? (authKindRaw as 'apikey' | 'oauth' | 'none')
    : 'apikey';
  const engineBacked = data.engineBacked === true;
  const capability = str(data.capability);
  const signupUrl = str(data.signupUrl);
  const credentialFieldHint = str(data.credentialFieldHint);

  // configFields: optional plain-text fields (baseUrl, version).
  // SECURITY: this list must NEVER contain a "secret"/"key"/"token" field —
  // such values go through the dedicated secret input, not through configFields.
  const rawCfg = Array.isArray(data.configFields) ? data.configFields : [];
  const configFields = rawCfg
    .filter(isObject)
    .map((f) => {
      const key = str(f.key);
      const label = str(f.label);
      if (!key || !label) return null;
      // No secret/token/key field allowed as a configField.
      if (/secret|token|api.?key|password/i.test(key)) return null;
      return { key, label, placeholder: str(f.placeholder) };
    })
    .filter((f): f is { key: string; label: string; placeholder: string | undefined } => f !== null);

  return (
    <CredentialRequestCard
      provider={provider}
      scopeKind={scopeKind}
      workspaceId={workspaceId}
      why={why}
      configFields={configFields.length > 0 ? configFields : undefined}
      docsUrl={docsUrl}
      authKind={authKind}
      engineBacked={engineBacked}
      capability={capability}
      signupUrl={signupUrl}
      credentialFieldHint={credentialFieldHint}
    />
  );
}

// ---------------------------------------------------------------------------
// subagent-fleet — BACKPORT-02 (2026-05-23). Renders up to 5 subagent panes
// as a coordinated fleet view (status, abort, diff). Malformed or empty
// panes array → return null. The card itself internally falls back to
// SUBAGENT_FLEET_MAX_PANES (5) — we simply pass all valid
// panes through, without slicing again here.
// ---------------------------------------------------------------------------

/** Allowed values for SubagentPaneRole (from SubagentFleetCard.types). */
const VALID_PANE_ROLES = new Set<string>([
  'architect', 'coder', 'tester', 'reviewer', 'security', 'perf', 'generic',
]);

/** Allowed values for SubagentPaneStatus. */
const VALID_PANE_STATUSES = new Set<string>([
  'queued', 'running', 'done', 'failed', 'aborted',
]);

function renderSubagentFleet(data: unknown): ReactNode {
  if (!isObject(data)) return null;

  // fleetTitle is required for a meaningful header.
  const fleetTitle = str(data.fleetTitle) ?? str(data.title);
  if (!fleetTitle) return null;

  // panes: check the array, validate each entry defensively.
  const rawPanes = Array.isArray(data.panes) ? data.panes : null;
  if (!rawPanes) return null;

  const panes: SubagentPane[] = rawPanes.flatMap((raw): SubagentPane[] => {
    if (!isObject(raw)) return [];
    const subagentId = str(raw.subagentId);
    const title = str(raw.title);
    const roleRaw = str(raw.role);
    const statusRaw = str(raw.status);
    // Required fields: subagentId, title, role (in whitelist), status (in whitelist).
    if (!subagentId || !title) return [];
    const role: SubagentPaneRole = VALID_PANE_ROLES.has(roleRaw ?? '')
      ? (roleRaw as SubagentPaneRole)
      : 'generic';
    const status: SubagentPaneStatus = VALID_PANE_STATUSES.has(statusRaw ?? '')
      ? (statusRaw as SubagentPaneStatus)
      : 'queued';

    const pane: SubagentPane = {
      subagentId,
      role,
      title,
      status,
      tokensStreamed: num(raw.tokensStreamed),
      tailLine: str(raw.tailLine),
      startedAt: num(raw.startedAt),
      endedAt: num(raw.endedAt),
      errorMessage: str(raw.errorMessage),
      filesTouched: Array.isArray(raw.filesTouched)
        ? raw.filesTouched.filter((f): f is string => typeof f === 'string')
        : undefined,
    };
    return [pane];
  });

  // Null on 0 valid panes (defensive — the card does the same internally).
  if (panes.length === 0) return null;

  // activePaneId is optional — only pass through if a string.
  const activePaneId = str(data.activePaneId);
  // CP-2 (UX audit 2026-05-28): pull workstreamId from the payload, so
  // the abort action hits the correct workspace permission gate. If the
  // payload provides no value, the abort button stays dark (no
  // blind POST against 'unknown').
  const workstreamIdFromPayload = str(data.workstreamId);

  return (
    <SubagentFleetCardWired
      fleetTitle={fleetTitle}
      panes={panes}
      activePaneId={activePaneId}
      workstreamId={workstreamIdFromPayload}
    />
  );
}

// ---------------------------------------------------------------------------
// SubagentFleetCardWired — CP-2 / UX audit 2026-05-28.
// Hooks onResolve into an optimistic UI + fail-soft POST against
// /api/workstreams/[workstreamId]/subagent/[paneId]/abort.
//
// Before this wrapper, the SubagentFleetCard's abort / diff buttons were dead
// (`onResolve={undefined}`, explicit comment in the renderer). Diff stays
// phase-2 (no backend endpoint), abort + dismiss + abort-fleet are
// now wired:
//   - abort-pane    → POST … /subagent/{paneId}/abort
//   - abort-fleet   → POST per running pane (sequential, fail-soft)
//   - dismiss       → no-op (card-local state); no backend needed
//   - open-diff     → no-op stub (TODO: hook up the diff surface)
//
// Optimistic UI: a local aborting state marks the pane immediately, the POST
// runs in the background. On 4xx/5xx no rollback (the pane stays aborted from
// the user's view), but the error ID lands in the console-error for diagnostics.
// ---------------------------------------------------------------------------

interface SubagentFleetCardWiredProps {
  readonly fleetTitle: string;
  readonly panes: readonly SubagentPane[];
  readonly activePaneId?: string;
  readonly workstreamId?: string;
}

function SubagentFleetCardWired({
  fleetTitle,
  panes,
  activePaneId,
  workstreamId,
}: SubagentFleetCardWiredProps): ReactNode {
  // Optimistic layer: paneIds the user aborted locally. They are
  // immediately overlaid into the status 'aborted'.
  const [optimisticAborts, setOptimisticAborts] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  const sendAbort = useCallback(
    async (paneId: string): Promise<void> => {
      if (!workstreamId) {
        // Defensive: without workstreamId we would POST 'unknown' — the
        // server rejects that anyway, but we send nothing.
        // eslint-disable-next-line no-console
        console.warn(
          '[SubagentFleetCardWired] abort skipped — payload missing workstreamId',
          { paneId },
        );
        return;
      }
      // Optimistic: mark as aborted immediately.
      setOptimisticAborts((prev) => {
        if (prev.has(paneId)) return prev;
        const next = new Set(prev);
        next.add(paneId);
        return next;
      });
      try {
        const res = await fetch(
          `/api/workstreams/${encodeURIComponent(workstreamId)}/subagent/${encodeURIComponent(paneId)}/abort`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          },
        );
        if (!res.ok) {
          // eslint-disable-next-line no-console
          console.warn('[SubagentFleetCardWired] abort failed', {
            paneId,
            status: res.status,
          });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[SubagentFleetCardWired] abort threw', { paneId, err });
      }
    },
    [workstreamId],
  );

  const handleResolve = useCallback(
    (event: SubagentFleetResolutionEvent): void => {
      switch (event.kind) {
        case 'abort-pane':
          void sendAbort(event.subagentId);
          return;
        case 'abort-fleet': {
          // Abort all running/queued panes in sequence — fail-soft.
          for (const p of panes) {
            if (p.status === 'running' || p.status === 'queued') {
              void sendAbort(p.subagentId);
            }
          }
          return;
        }
        case 'expand-pane':
        case 'open-diff':
        case 'dismiss':
          // Phase-2 stubs — the card closes locally via parent state.
          return;
        default:
          return;
      }
    },
    [panes, sendAbort],
  );

  // Apply the optimistic overlay: show locally aborted panes as aborted,
  // BEFORE the SSE update flows in from the backend.
  const overlaidPanes = useMemo<readonly SubagentPane[]>(() => {
    if (optimisticAborts.size === 0) return panes;
    return panes.map((p) =>
      optimisticAborts.has(p.subagentId) &&
      p.status !== 'done' &&
      p.status !== 'failed' &&
      p.status !== 'aborted'
        ? { ...p, status: 'aborted' as const }
        : p,
    );
  }, [panes, optimisticAborts]);

  return (
    <SubagentFleetCard
      fleetTitle={fleetTitle}
      panes={overlaidPanes}
      activePaneId={activePaneId}
      onResolve={handleResolve}
    />
  );
}

// ---------------------------------------------------------------------------
// connector-call-preview — ACL5-E (2026-05-24).
// S5 preview: approve action → POST /api/connectors/invoke.
// The payload must contain NO secret field (defensively checked in auto-connect.ts).
// workspaceId comes from the payload (emitOrUpdateCard sets workspaceId in the
// coords field, but not in the surface payload itself — we read it from
// the card payload that auto-connect.ts filled correctly).
// ---------------------------------------------------------------------------

function renderConnectorCallPreview(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const provider = str(data.provider);
  const capability = str(data.capability);
  const workspaceId = str(data.workspaceId) ?? str(data.credentialScope)?.split(':')[1];
  // Required fields: provider + capability.
  if (!provider || !capability) return null;

  // Defensive payload reconstruction — only let known safe fields through.
  // SECURITY: no 'secret'/'token' field may pass from `data` into the payload.
  const payloadSummary: Record<string, string> = {};
  if (isObject(data.payloadSummary)) {
    for (const [k, v] of Object.entries(data.payloadSummary)) {
      if (typeof v === 'string') payloadSummary[k] = v;
    }
  }

  const trustRaw = str(data.currentTrust);
  const currentTrust: 'ask' | 'auto' = trustRaw === 'auto' ? 'auto' : 'ask';

  const payload: ConnectorCallPreviewPayload = {
    provider,
    capability,
    callId: str(data.callId) ?? 'unknown',
    mcpTool: str(data.mcpTool) ?? null,
    baseUrl: str(data.baseUrl) ?? null,
    payloadSummary,
    credentialScope: str(data.credentialScope) ?? `workspace:${workspaceId ?? 'unknown'}`,
    // credentialPreview: masked value from previewCall — NEVER the plaintext.
    credentialPreview: str(data.credentialPreview) ?? null,
    authKind: str(data.authKind) ?? 'api_key',
    payloadHash: str(data.payloadHash) ?? '',
    currentTrust,
    dryRun: data.dryRun === true,
    liveEnabled: data.liveEnabled === true,
  };

  return (
    <ConnectorCallPreviewCard
      payload={payload}
      workspaceId={workspaceId ?? ''}
    />
  );
}

// ---------------------------------------------------------------------------
// permission-setup — A1 (2026-05-25).
// One-time mode selection for a workspace. Appears exactly once.
// Payload: { workspaceId: string, currentMode?: string | null }
// SECURITY: no secret field. The PATCH route is auth-gated.
// ---------------------------------------------------------------------------

const VALID_SETUP_MODES = new Set<string>(['freerein', 'lane', 'ask']);

function renderPermissionSetup(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const workspaceId = str(data.workspaceId);
  if (!workspaceId) return null;

  const currentModeRaw = str(data.currentMode);
  const initialMode: PermissionModeChoice | null =
    currentModeRaw && VALID_SETUP_MODES.has(currentModeRaw)
      ? (currentModeRaw as PermissionModeChoice)
      : null;

  return (
    <PermissionSetupCard
      workspaceId={workspaceId}
      initialMode={initialMode}
    />
  );
}

// ---------------------------------------------------------------------------
// flow-graph — Flow Studio P3 (2026-05-27).
// Visual flow-graph surface (n8n/make style) as custom SVG + HTML nodes —
// NO new dependency (no React-Flow/dagre); rationale in the plan
// docs/plans/2026-05-27_flow-studio-architecture.md §3.
//
// Layout: simple topological DAG-level algorithm inline. Nodes without
// an incoming edge = level 0; every further node = max(parent level)+1. Per
// level a row (horizontal); on narrow (≤640px) vertical stacking —
// here via flex-wrap + max-width, so it stays mobile-capable without a JS-resize
// listener (the avatar reads on the iPhone).
//
// Pitch-Black/Apple discipline: calm, lots of air, one status dot per node.
// P3 = pure rendering; tap = only visual feedback (no handler needed).
// Live wiring (feeding from flow_steps/plan-step status) deliberately follows later.
// ---------------------------------------------------------------------------

type FlowNodeStatus = 'idle' | 'running' | 'done' | 'needs-input' | 'failed';

interface FlowNode {
  id: string;
  label: string;
  skill?: string;
  tool?: string;
  status: FlowNodeStatus;
  /**
   * P-now (2026-05-27): does this node point to a not-yet-coupled tool?
   * Controls the „koppeln" hint in the detail panel. Default false — without the
   * field the rendering stays identical to the P3 state.
   */
  needsCoupling?: boolean;
  /**
   * W2.2 (2026-05-30): on `needs-input` the gate kind the node tap
   * targets. The detail panel builds a minimal BlockingGateState from it and
   * calls `executeGateAction` — THE SAME path as the ActionDeck pin (one POST,
   * no double routing). Optional — without the field the node stays informative.
   */
  gateKind?: BlockingGateKind;
  /**
   * W2.2: a `done` assembly/serve node can carry a preview URL. The
   * detail panel then shows „Vorschau öffnen" (opens the URL — the `renderPreview`
   * link path 1:1). Optional — without a URL no button.
   */
  previewUrl?: string;
}

interface FlowEdge {
  from: string;
  to: string;
}

const FLOW_NODE_STATUSES: ReadonlyArray<FlowNodeStatus> = [
  'idle',
  'running',
  'done',
  'needs-input',
  'failed',
];

// W2.2: allowed gate kinds for actionable needs-input nodes (mirror of
// BlockingGateKind in projection/types — the executeGateAction path knows them).
const BLOCKING_GATE_KINDS: ReadonlyArray<BlockingGateKind> = [
  'credential-request',
  'connector-call-preview',
  'live-warn',
  'counter-evidence',
  'human-decision',
];

type FlowRunStatus = 'idle' | 'running' | 'done' | 'failed';
const FLOW_RUN_STATUSES: ReadonlyArray<FlowRunStatus> = [
  'idle',
  'running',
  'done',
  'failed',
];

/** Status-dot color per node status. Token bind with hex fallback (renderPreview pattern). */
function flowStatusColor(status: FlowNodeStatus): string {
  switch (status) {
    case 'running':
      return 'var(--a-now, #5ad1e6)';
    case 'done':
      return 'var(--a-ok, #5fd39a)';
    case 'needs-input':
      return 'var(--a-warn, #FFD60A)';
    case 'failed':
      return 'var(--a-danger, #FF453A)';
    case 'idle':
    default:
      return 'var(--ink-3, #636366)';
  }
}

/**
 * Topological layer layout: assigns each node a level.
 * Level = max(parent level)+1, roots (no incoming edge) = 0.
 * Cycle-safe: fixed iteration upper bound (#nodes) — whoever is not stable after
 * that many rounds (a cycle) stays at the last computed
 * level instead of producing an endless loop.
 */
function computeFlowLevels(
  nodes: FlowNode[],
  edges: FlowEdge[],
): Map<string, number> {
  const level = new Map<string, number>();
  for (const n of nodes) level.set(n.id, 0);
  // Incoming edges per node (only valid ones, dangling are pre-filtered).
  const parents = new Map<string, string[]>();
  for (const n of nodes) parents.set(n.id, []);
  for (const e of edges) {
    const arr = parents.get(e.to);
    if (arr) arr.push(e.from);
  }
  const maxRounds = nodes.length;
  for (let round = 0; round < maxRounds; round++) {
    let changed = false;
    for (const n of nodes) {
      const ps = parents.get(n.id) ?? [];
      if (ps.length === 0) continue;
      let best = 0;
      for (const p of ps) {
        const pl = level.get(p) ?? 0;
        if (pl + 1 > best) best = pl + 1;
      }
      if (best !== (level.get(n.id) ?? 0)) {
        level.set(n.id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return level;
}

function renderFlowGraph(data: unknown): ReactNode {
  if (!isObject(data)) return null;

  // parse nodes — required fields id + label. Normalize status defensively.
  const rawNodes = Array.isArray(data.nodes) ? data.nodes : null;
  const nodes: FlowNode[] = rawNodes
    ? rawNodes.flatMap((raw): FlowNode[] => {
        if (!isObject(raw)) return [];
        const id = str(raw.id);
        const label = str(raw.label) ?? str(raw.title);
        if (!id || !label) return [];
        const statusRaw = str(raw.status);
        const status: FlowNodeStatus =
          statusRaw && (FLOW_NODE_STATUSES as readonly string[]).includes(statusRaw)
            ? (statusRaw as FlowNodeStatus)
            : 'idle';
        // W2.2: normalize gateKind (only meaningful on needs-input) defensively.
        const gateKindRaw = str(raw.gateKind);
        const gateKind: BlockingGateKind | undefined =
          gateKindRaw &&
          (BLOCKING_GATE_KINDS as readonly string[]).includes(gateKindRaw)
            ? (gateKindRaw as BlockingGateKind)
            : undefined;
        return [
          {
            id,
            label,
            skill: str(raw.skill),
            tool: str(raw.tool),
            status,
            // P-now: a node can point to an uncoupled tool
            // (`needsCoupling: true` or a reason hint). Optional — default
            // false, so the existing rendering stays unchanged.
            needsCoupling: isObject(raw) && raw.needsCoupling === true,
            ...(gateKind ? { gateKind } : {}),
            ...(str(raw.previewUrl) ? { previewUrl: str(raw.previewUrl) } : {}),
          },
        ];
      })
    : [];

  // Empty/missing nodes → render nothing (no throw).
  if (nodes.length === 0) return null;

  const nodeIds = new Set(nodes.map((n) => n.id));

  // parse edges — dangling ones (from/to not in nodes) are ignored.
  const rawEdges = Array.isArray(data.edges) ? data.edges : [];
  const edges: FlowEdge[] = rawEdges.flatMap((raw): FlowEdge[] => {
    if (!isObject(raw)) return [];
    const from = str(raw.from);
    const to = str(raw.to);
    if (!from || !to) return [];
    if (!nodeIds.has(from) || !nodeIds.has(to)) return [];
    return [{ from, to }];
  });

  const title = str(data.title);
  // Apple pass (2026-05-30): explicit subtitle (SOP detail). The title is
  // clamped to 1 line in the header (line-clamp:1), the detail — if the
  // payload provides `subtitle` — sits below it in the 13pt subtitle. No deriving
  // via a title split (would cut the meaning-bearing title head, N1).
  const subtitle = str(data.subtitle);
  const runStatusRaw = str(data.runStatus);
  const runStatus: FlowRunStatus =
    runStatusRaw && (FLOW_RUN_STATUSES as readonly string[]).includes(runStatusRaw)
      ? (runStatusRaw as FlowRunStatus)
      : 'idle';

  // Stream C (2026-05-27): workstreamId + workspaceId from the payload — the
  // FlowGraphCard needs both for „Als Prozess speichern" (POST
  // /api/flow/from-workstream). Optional: without them the button stays hidden
  // (e.g. /design preview), the rendering is otherwise identical.
  const workstreamId = str(data.workstreamId);
  const workspaceId = str(data.workspaceId);
  // C2 (2026-05-27): a flow graph can start COLLAPSED — then the
  // card shows only a tappable „Prozess ansehen" chip that opens the full surface.
  // Owner intent: „muss nicht dauerhaft sein, aber klickbar → oeffnet
  // die Surface". Default false (today's behavior: visible immediately).
  const startCollapsed = data.collapsed === true;

  // P-now (2026-05-27): the tappable nodes need local state (open
  // node-id) → its own component. Pure parsing stays in renderFlowGraph,
  // so the existing, tested parse logic is unchanged.
  return (
    <FlowGraphCard
      nodes={nodes}
      edges={edges}
      title={title}
      subtitle={subtitle}
      runStatus={runStatus}
      workstreamId={workstreamId}
      workspaceId={workspaceId}
      startCollapsed={startCollapsed}
    />
  );
}

function FlowGraphCard({
  nodes,
  edges,
  title,
  subtitle,
  runStatus,
  workstreamId,
  workspaceId,
  startCollapsed,
}: {
  nodes: FlowNode[];
  edges: FlowEdge[];
  title: string | undefined;
  subtitle?: string;
  runStatus: FlowRunStatus;
  workstreamId?: string;
  workspaceId?: string;
  startCollapsed?: boolean;
}): ReactNode {
  // IMPORTANT (React hook rules): ALL useState calls are BEFORE any
  // conditional return (collapsed). Otherwise the hook order jumps between
  // renders — forbidden. That is why openNodeId is co-declared up here.
  // C2: collapse/expand state. Starts collapsed when the payload says so.
  const [collapsed, setCollapsed] = useState<boolean>(startCollapsed === true);
  // C3: „Als Prozess speichern" state (optimistic, fail-soft).
  // idle → saving → saved | error. The button needs workstreamId+workspaceId.
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>(
    'idle',
  );
  // Open node-id (detail panel). null = no panel open. Toggle on re-tap.
  const [openNodeId, setOpenNodeId] = useState<string | null>(null);
  // W2.2 (2026-05-30) — anti-proliferation: if a run-cockpit surface is already
  // active for the same (workspaceId, workstreamId), the
  // flow-graph moves into the cockpit (as a view section) → the free-floating
  // card suppresses itself here (like sub-workstreams/iterate-pipeline). The
  // ActionDeck stays the global bottom pin; the needs-input node + the ActionDeck
  // gate point at THE SAME gate (one executeGateAction). Hook BEFORE any
  // conditional return (React rule). Provider-free → false (back-compat).
  const cockpitCoordKey = buildCockpitCoordKey(workspaceId, workstreamId);
  const suppressedByCockpit = useRunCockpitActive(cockpitCoordKey);
  const canSaveAsProcess =
    typeof workstreamId === 'string' &&
    workstreamId.length > 0 &&
    typeof workspaceId === 'string' &&
    workspaceId.length > 0;

  const handleSaveAsProcess = async (): Promise<void> => {
    if (!canSaveAsProcess || saveState === 'saving' || saveState === 'saved') return;
    // Optimistic: show „saved" immediately, reset on error.
    setSaveState('saving');
    try {
      const resp = await fetch('/api/flow/from-workstream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workstreamId,
          workspaceId,
          ...(title ? { name: title } : {}),
        }),
      });
      // fail-soft: any non-2xx → error state (no throw, no crash).
      setSaveState(resp.ok ? 'saved' : 'error');
    } catch {
      setSaveState('error');
    }
  };

  // W2.2 — anti-proliferation: run-cockpit active → suppress the flow-graph card
  // (the cockpit pulls the graph in as a view section). AFTER all hooks.
  if (suppressedByCockpit) {
    return null;
  }

  // C2: collapsed → only a tappable chip that opens the surface.
  if (collapsed) {
    return (
      <button
        type="button"
        data-test="flow-graph-collapsed-chip"
        className="press"
        aria-expanded={false}
        onClick={() => setCollapsed(false)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 9,
          minHeight: 40,
          padding: '9px 15px',
          borderRadius: 999,
          background: 'var(--sheet-2, #0E0E0F)',
          border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
          color: 'var(--ink, #F5F5F7)',
          font: 'inherit',
          fontSize: 13.5,
          fontWeight: 600,
          letterSpacing: '-0.01em',
          cursor: 'pointer',
        }}
      >
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            backgroundColor:
              runStatus === 'running'
                ? 'var(--a-now, #5ad1e6)'
                : runStatus === 'done'
                  ? 'var(--a-ok, #5fd39a)'
                  : runStatus === 'failed'
                    ? 'var(--a-danger, #FF453A)'
                    : 'var(--ink-3, #636366)',
            display: 'inline-block',
          }}
        />
        Prozess ansehen
        {title ? (
          <span
            style={{
              color: 'var(--ink-3, #636366)',
              fontWeight: 500,
              fontFamily: 'var(--font-mono, ui-monospace)',
              fontSize: 11.5,
            }}
          >
            · {title}
          </span>
        ) : null}
      </button>
    );
  }

  const openNode = openNodeId
    ? (nodes.find((n) => n.id === openNodeId) ?? null)
    : null;

  const levels = computeFlowLevels(nodes, edges);

  // Group nodes by level (row layout).
  const byLevel = new Map<number, FlowNode[]>();
  let maxLevel = 0;
  for (const n of nodes) {
    const lv = levels.get(n.id) ?? 0;
    if (lv > maxLevel) maxLevel = lv;
    const arr = byLevel.get(lv);
    if (arr) arr.push(n);
    else byLevel.set(lv, [n]);
  }
  const orderedLevels: number[] = [];
  for (let lv = 0; lv <= maxLevel; lv++) {
    if (byLevel.has(lv)) orderedLevels.push(lv);
  }

  // W2.2 (2026-05-30): in-/out-degree per node — pure render derivation from the
  // existing `edges`, NO new data layer. From it we derive fork (one
  // level fans out into >1 parallel strands) and join (several strands run
  // into ONE node). A level with >1 node is a parallel
  // lane group; it is named („⑂ parallel · N") + rendered indented,
  // so parallel/sequential stays distinguishable even at a narrow 390px.
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const n of nodes) {
    inDeg.set(n.id, 0);
    outDeg.set(n.id, 0);
  }
  for (const e of edges) {
    outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }
  // A level is „parallel" when it carries more than one node.
  const isParallelLevel = (lv: number): boolean => (byLevel.get(lv)?.length ?? 0) > 1;
  // A join marker sits BEFORE a level whose (single) node has in-degree>1
  // — several parallel strands run together here.
  const isJoinLevel = (lv: number): boolean => {
    const row = byLevel.get(lv) ?? [];
    return row.length === 1 && (inDeg.get(row[0]!.id) ?? 0) > 1;
  };

  const runStatusLabel: Record<FlowRunStatus, string> = {
    idle: 'Bereit',
    running: 'Läuft',
    done: 'Fertig',
    failed: 'Fehlgeschlagen',
  };
  const runStatusColor: Record<FlowRunStatus, string> = {
    idle: 'var(--ink-3, #636366)',
    running: 'var(--a-now, #5ad1e6)',
    done: 'var(--a-ok, #5fd39a)',
    failed: 'var(--a-danger, #FF453A)',
  };

  // W2.2: a flow node as a tappable button. Tap toggles the detail panel.
  // `running` carries the „läuft jetzt" accent (--a-now) + pulse; `needs-input`
  // the warn accent (actionable). Markup unchanged from the previous state —
  // only hoisted into a helper function (levels×lanes call it twice).
  const renderFlowNode = (n: FlowNode): React.JSX.Element => {
    const isOpen = openNodeId === n.id;
    const isNow = n.status === 'running';
    const needsInput = n.status === 'needs-input';
    return (
      <button
        key={n.id}
        type="button"
        data-test="flow-node"
        data-node-id={n.id}
        data-status={n.status}
        data-now={isNow ? 'true' : 'false'}
        data-open={isOpen ? 'true' : 'false'}
        aria-expanded={isOpen}
        aria-label={`Node ${n.label}`}
        className={cx(
          'press',
          'flow-graph-node',
          isNow && 'flow-graph-node--now',
          needsInput && 'flow-graph-node--needs-input',
          isOpen && 'flow-graph-node--open',
        )}
        onClick={() =>
          // Tap toggles the detail panel: another tap closes it again.
          setOpenNodeId((cur) => (cur === n.id ? null : n.id))
        }
      >
        <span
          data-test="flow-node-dot"
          data-status={n.status}
          // data-dot-color mirrors the token-bind color as a testable attribute —
          // happy-dom swallows color properties with a var(--token, #fallback)
          // value when serializing the style (the browser renders correctly). This keeps the
          // status→color mapping deterministically checkable without a CSS round-trip.
          data-dot-color={flowStatusColor(n.status)}
          aria-hidden
          style={{
            marginTop: 4,
            width: 9,
            height: 9,
            flexShrink: 0,
            borderRadius: 999,
            backgroundColor: flowStatusColor(n.status),
            // running pulses calmly (accent). Reuse @keyframes pulse.
            animation: isNow ? 'pulse 1.6s ease-in-out infinite' : undefined,
          }}
        />
        <div className="flow-graph-node-body">
          <span className="flow-graph-node-label">{n.label}</span>
          {n.skill || n.tool ? (
            <span className="flow-graph-node-meta">
              {n.skill ? (
                <span data-test="flow-node-skill" className="flow-graph-node-skill">
                  {n.skill}
                </span>
              ) : null}
              {n.tool ? (
                <span data-test="flow-node-tool" className="flow-graph-node-tool">
                  {n.tool}
                </span>
              ) : null}
              {needsInput ? (
                <span data-test="flow-node-badge-needs-input" className="flow-graph-node-badge">
                  Eingabe nötig
                </span>
              ) : null}
            </span>
          ) : needsInput ? (
            <span className="flow-graph-node-meta">
              <span data-test="flow-node-badge-needs-input" className="flow-graph-node-badge">
                Eingabe nötig
              </span>
            </span>
          ) : null}
        </div>
      </button>
    );
  };

  return (
    <div
      data-test="surface-flow-graph"
      role="group"
      aria-label={title ?? 'Flow'}
      style={{
        background: 'var(--sheet-1, #0A0A0B)',
        border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
        borderRadius: 16,
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
        maxWidth: 640,
      }}
    >
      {/* Header: title (1 line, 17pt semibold) + optional 13pt subtitle +
          runStatus pill. Calm, lots of air. Apple pass (2026-05-30): title clamped to
          1 line — no 3-line SOP wall in the header. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            data-test="flow-graph-title"
            style={{
              fontSize: 17,
              fontWeight: 600,
              color: 'var(--ink, #F5F5F7)',
              letterSpacing: '-0.01em',
              display: '-webkit-box',
              WebkitLineClamp: 1,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {title ?? 'Flow'}
          </div>
          {subtitle ? (
            <div
              data-test="flow-graph-subtitle"
              style={{
                marginTop: 4,
                fontSize: 13,
                fontWeight: 400,
                color: 'var(--ink-2, #A1A1A6)',
                letterSpacing: '-0.005em',
                lineHeight: 1.4,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {subtitle}
            </div>
          ) : null}
        </div>
        <span
          data-test="flow-run-status"
          data-run-status={runStatus}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            padding: '5px 11px',
            borderRadius: 999,
            background: 'var(--sheet-2, #0E0E0F)',
            border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
            fontFamily: 'var(--font-mono, ui-monospace)',
            fontSize: 11,
            letterSpacing: '0.04em',
            color: 'var(--ink-2, #A1A1A6)',
            whiteSpace: 'nowrap',
          }}
        >
          <span
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              backgroundColor: runStatusColor[runStatus],
              display: 'inline-block',
            }}
          />
          {runStatusLabel[runStatus]}
        </span>
      </div>

      {/* Action row (Stream C, 2026-05-27): „Als Prozess speichern" (C3) +
          „Einklappen" (C2). Both calm, secondary — the visualization stays
          the main thing (one primary action per surface). */}
      <div
        data-test="flow-graph-actions"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        {/* C3: save as a recurring process (optimistic, fail-soft).
            Only visible when workstreamId+workspaceId are in the payload. */}
        {canSaveAsProcess ? (
          <button
            type="button"
            data-test="flow-graph-save-process"
            data-save-state={saveState}
            className="press"
            disabled={saveState === 'saving' || saveState === 'saved'}
            onClick={() => void handleSaveAsProcess()}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              minHeight: 40,
              padding: '9px 15px',
              borderRadius: 999,
              background:
                saveState === 'saved'
                  ? 'color-mix(in oklab, var(--a-ok, #5fd39a) 14%, var(--sheet-2, #0E0E0F))'
                  : saveState === 'error'
                    ? 'color-mix(in oklab, var(--a-danger, #FF453A) 12%, var(--sheet-2, #0E0E0F))'
                    : 'var(--sheet-2, #0E0E0F)',
              border:
                saveState === 'saved'
                  ? '0.5px solid var(--a-ok, #5fd39a)'
                  : saveState === 'error'
                    ? '0.5px solid var(--a-danger, #FF453A)'
                    : '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
              color: 'var(--ink, #F5F5F7)',
              font: 'inherit',
              fontSize: 13,
              fontWeight: 600,
              letterSpacing: '-0.01em',
              cursor:
                saveState === 'saving' || saveState === 'saved'
                  ? 'default'
                  : 'pointer',
              opacity: saveState === 'saving' ? 0.7 : 1,
            }}
          >
            {saveState === 'saved'
              ? 'Als Prozess gespeichert'
              : saveState === 'saving'
                ? 'Speichere…'
                : saveState === 'error'
                  ? 'Erneut speichern'
                  : 'Als Prozess speichern'}
          </button>
        ) : null}

        {/* C2: collapse → shows only the „Prozess ansehen" chip again. */}
        <button
          type="button"
          data-test="flow-graph-collapse"
          className="press"
          aria-expanded
          onClick={() => setCollapsed(true)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            minHeight: 40,
            padding: '9px 13px',
            borderRadius: 999,
            background: 'transparent',
            border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
            color: 'var(--ink-2, #A1A1A6)',
            font: 'inherit',
            fontSize: 12.5,
            cursor: 'pointer',
          }}
        >
          Einklappen
        </button>
      </div>

      {/* Graph: levels×lanes (W2.2, 2026-05-30). Sequence = levels stacked;
          Parallel = several nodes of ONE level as a named lane group with a
          fork header („⑂ parallel · N") + join marker. The layout is
          token-/CSS-driven (`flow-graph-*` in components.css): desktop places
          the parallel nodes side by side, at ≤390px they stack INDENTED
          under the fork header (no flex-wrap stack) → parallel/sequential
          stays distinguishable when narrow. */}
      <div className="flow-graph-stages" data-test="flow-graph-stages">
        {/* Edge list (non-visible): the VALID, dangling-filtered edges
            as testable + machine-readable markers. The levels×lanes layout
            makes sequence/parallel/join visually recognizable without absolute SVG;
            these markers preserve the edge contract (data-edge-from/-to). */}
        <div data-test="flow-edges" hidden aria-hidden style={{ display: 'none' }}>
          {edges.map((e, i) => (
            <span
              key={`${e.from}-${e.to}-${i}`}
              data-test="flow-edge"
              data-edge-from={e.from}
              data-edge-to={e.to}
            />
          ))}
        </div>
        {orderedLevels.map((lv, idx) => {
          const row = byLevel.get(lv) ?? [];
          const parallel = isParallelLevel(lv);
          const join = isJoinLevel(lv);
          const stageNo = idx + 1;
          return (
            <div
              key={`level-${lv}`}
              data-test="flow-level"
              data-level={lv}
              data-parallel={parallel ? 'true' : 'false'}
              data-join={join ? 'true' : 'false'}
              className="flow-graph-stage"
            >
              {/* Join marker: several strands run together here. */}
              {join ? (
                <div className="flow-graph-join" data-test="flow-join-marker" aria-hidden>
                  <span className="flow-graph-join-glyph">⑃</span>
                  <span className="flow-graph-join-label">zusammenführen</span>
                </div>
              ) : null}

              {parallel ? (
                // Parallel lane group: fork header + indented nodes.
                <div
                  className="flow-graph-fork"
                  data-test="flow-fork-group"
                  role="group"
                  aria-label={`parallel · ${row.length} Stränge · Stufe ${stageNo}`}
                >
                  <div className="flow-graph-fork-header" data-test="flow-fork-header">
                    <span className="flow-graph-fork-glyph" aria-hidden>⑂</span>
                    <span className="flow-graph-fork-title">parallel</span>
                    <span className="flow-graph-fork-count" data-test="flow-fork-count">
                      · {row.length}
                    </span>
                    <span className="flow-graph-stage-no" aria-hidden>
                      Stufe {stageNo}
                    </span>
                  </div>
                  <div className="flow-graph-lanes" data-test="flow-lanes">
                    {row.map((n) => renderFlowNode(n))}
                  </div>
                </div>
              ) : (
                // Sequential level: one node + level number.
                <div className="flow-graph-seq" data-test="flow-seq-stage">
                  <span className="flow-graph-stage-no" aria-hidden>
                    Stufe {stageNo}
                  </span>
                  {row.map((n) => renderFlowNode(n))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Detail panel — P-now (2026-05-27). Inline (no floating popover), so
          it needs no overlay positioning on the iPhone. Shows label, skill,
          tool, status; on needsCoupling additionally a „koppeln" hint. */}
      {openNode ? (
        <div
          data-test="flow-node-detail"
          data-node-id={openNode.id}
          role="group"
          aria-label={`Detail ${openNode.label}`}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            padding: '14px 16px',
            borderRadius: 12,
            background: 'var(--sheet-2, #0E0E0F)',
            border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <span
              data-test="flow-node-detail-label"
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: 'var(--ink, #F5F5F7)',
                letterSpacing: '-0.01em',
              }}
            >
              {openNode.label}
            </span>
            <span
              data-test="flow-node-detail-status"
              data-status={openNode.status}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontFamily: 'var(--font-mono, ui-monospace)',
                fontSize: 11,
                letterSpacing: '0.04em',
                color: 'var(--ink-2, #A1A1A6)',
                whiteSpace: 'nowrap',
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 999,
                  backgroundColor: flowStatusColor(openNode.status),
                  display: 'inline-block',
                }}
              />
              {FLOW_NODE_STATUS_LABEL[openNode.status]}
            </span>
          </div>

          {openNode.skill ? (
            <div
              data-test="flow-node-detail-skill"
              style={{
                fontFamily: 'var(--font-mono, ui-monospace)',
                fontSize: 12,
                color: 'var(--ink-3, #636366)',
              }}
            >
              Skill: {openNode.skill}
            </div>
          ) : null}

          {openNode.tool ? (
            <div
              data-test="flow-node-detail-tool"
              style={{
                fontFamily: 'var(--font-mono, ui-monospace)',
                fontSize: 12,
                color: 'var(--ink-3, #636366)',
              }}
            >
              Tool: {openNode.tool}
            </div>
          ) : null}

          {openNode.needsCoupling ? (
            <div
              data-test="flow-node-detail-coupling-hint"
              style={{
                fontSize: 12.5,
                lineHeight: 1.5,
                color: 'var(--a-warn, #FFD60A)',
              }}
            >
              Dieser Schritt braucht ein Tool, das noch nicht gekoppelt ist —
              koppeln, dann läuft der Flow.
            </div>
          ) : null}

          {/* W2.2 (2026-05-30): action row. Only a node with an ALLOWED
              action gets a button (no empty button):
                · needs-input → primary button → executeGateAction(gate). This
                  is THE SAME submit path as the ActionDeck pin: it clicks the
                  real <surface:…> gate card in the DOM (one POST, no drift).
                · failed     → „Neu starten" → reply text (retry/resume) via
                  the existing SurfaceAction reply path.
                · done + previewUrl → „Vorschau öffnen" (renderPreview link 1:1).
              Nodes without an allowed action stay purely informative. */}
          {renderFlowNodeAction(openNode)}
        </div>
      ) : null}
    </div>
  );
}

/**
 * W2.2: the allowed action of an opened flow node — or null
 * (informative). Hook-free (no useState) — safe in the render function.
 * `useSurfaceAction` is provided by the caller (FlowGraphCard).
 */
function FlowNodeAction({ node }: { node: FlowNode }): React.JSX.Element | null {
  const { reply } = useSurfaceAction();

  // needs-input → the ONE executeGateAction path (clicks the real gate card).
  if (node.status === 'needs-input') {
    const kind: BlockingGateKind = node.gateKind ?? 'human-decision';
    // Minimal BlockingGateState: executeGateAction reads ONLY `kind`, to find the
    // associated stream card — THE SAME target as the ActionDeck pin.
    const gate: BlockingGateState = {
      kind,
      description: node.label,
      createdAt: Date.now(),
    };
    return (
      <div className="flow-graph-node-action" data-test="flow-node-action-row">
        <button
          type="button"
          data-test="flow-node-action"
          data-action="gate"
          data-gate-kind={kind}
          className="press flow-graph-node-action-btn flow-graph-node-action-btn--primary"
          onClick={() => {
            // THE SAME path as the ActionDeck pin — no second routing.
            executeGateAction(gate);
          }}
        >
          Antworten & freigeben
        </button>
      </div>
    );
  }

  // failed → „Neu starten" (retry/resume) via the reply path.
  if (node.status === 'failed') {
    return (
      <div className="flow-graph-node-action" data-test="flow-node-action-row">
        <button
          type="button"
          data-test="flow-node-action"
          data-action="retry"
          className="press flow-graph-node-action-btn flow-graph-node-action-btn--danger"
          onClick={() => {
            // N1: verbatim step label into the retry hint (no .slice).
            reply(`Schritt „${node.label}" neu starten`);
          }}
        >
          Neu starten
        </button>
      </div>
    );
  }

  // done + previewUrl → „Vorschau öffnen" (renderPreview link 1:1).
  if (node.status === 'done' && typeof node.previewUrl === 'string' && node.previewUrl) {
    return (
      <div className="flow-graph-node-action" data-test="flow-node-action-row">
        <a
          href={node.previewUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-test="flow-node-action"
          data-action="preview"
          className="flow-graph-node-action-btn flow-graph-node-action-btn--preview"
        >
          Vorschau öffnen
          <span aria-hidden style={{ fontSize: 16, lineHeight: 1, marginLeft: 6 }}>→</span>
        </a>
      </div>
    );
  }

  // No allowed action path → purely informative (no empty button).
  return null;
}

/** Render helper: the action row of an opened node (or null). */
function renderFlowNodeAction(node: FlowNode): React.JSX.Element | null {
  return <FlowNodeAction node={node} />;
}

const FLOW_NODE_STATUS_LABEL: Record<FlowNodeStatus, string> = {
  idle: 'Bereit',
  running: 'Läuft',
  done: 'Fertig',
  'needs-input': 'Eingabe nötig',
  failed: 'Fehlgeschlagen',
};

// ---------------------------------------------------------------------------
// flow-coupling — Flow Studio P-now (2026-05-27).
// Tool-coupling surface: appears when a flow contains steps whose
// required tools/connectors are not yet coupled. Per missing tool
// one row (stepTitle N1 + provider + reason hint) with a „Koppeln"
// button. The button opens the EXISTING credential entry
// (CredentialRequestCard → POST /api/connectors/[provider]/credential; secret
// NEVER in chat/SSE/ledger). When all tools are coupled (or skipped via „Trotzdem
// starten") → a primary „Flow starten" button →
// POST /api/flow/[flowId]/run {workspaceId}.
//
// SECURITY: the surface payload carries NO secret field. The secret path is
// exclusively the one from ACL5-B (CredentialRequestCard). We build NO
// new secret entry here.
//
// reason → hint mapping:
//   credential → „API-Key/OAuth fehlt"
//   profile    → „Tool verbinden"
//   unknown    → generic „Tool für diesen Schritt wählen/verbinden" hint
//                (typical when provider === null).
// ---------------------------------------------------------------------------

type FlowCouplingReason = 'credential' | 'profile' | 'unknown';
const FLOW_COUPLING_REASONS: ReadonlyArray<FlowCouplingReason> = [
  'credential',
  'profile',
  'unknown',
];

interface FlowMissingTool {
  stepId: string;
  stepTitle: string;
  /** Provider slug — null/undefined when the tool for the step is unclear. */
  provider: string | null;
  neededCapabilities?: string[];
  reason: FlowCouplingReason;
}

function flowCouplingReasonHint(
  reason: FlowCouplingReason,
  hasProvider: boolean,
): string {
  switch (reason) {
    case 'credential':
      return 'API-Key/OAuth fehlt';
    case 'profile':
      return 'Tool verbinden';
    case 'unknown':
    default:
      // provider===null → we don't know the tool yet.
      return hasProvider
        ? 'Tool verbinden'
        : 'Tool für diesen Schritt wählen/verbinden';
  }
}

function renderFlowCoupling(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const flowId = str(data.flowId);
  const workspaceId = str(data.workspaceId);
  // Required fields: flowId + workspaceId. Without them nothing can be coupled or
  // started — defensively null (no crash in the stream).
  if (!flowId || !workspaceId) return null;

  const rawMissing = Array.isArray(data.missingTools) ? data.missingTools : [];
  const missingTools: FlowMissingTool[] = rawMissing.flatMap(
    (raw): FlowMissingTool[] => {
      if (!isObject(raw)) return [];
      const stepId = str(raw.stepId);
      // N1: stepTitle is NOT shortened — take it in full.
      const stepTitle = str(raw.stepTitle) ?? str(raw.title);
      if (!stepId || !stepTitle) return [];
      const providerRaw = str(raw.provider);
      const provider = providerRaw && providerRaw.length > 0 ? providerRaw : null;
      const reasonRaw = str(raw.reason);
      const reason: FlowCouplingReason =
        reasonRaw && (FLOW_COUPLING_REASONS as readonly string[]).includes(reasonRaw)
          ? (reasonRaw as FlowCouplingReason)
          : 'unknown';
      const neededCapabilities = Array.isArray(raw.neededCapabilities)
        ? raw.neededCapabilities.filter((c): c is string => typeof c === 'string')
        : undefined;
      return [
        {
          stepId,
          stepTitle,
          provider,
          neededCapabilities:
            neededCapabilities && neededCapabilities.length > 0
              ? neededCapabilities
              : undefined,
          reason,
        },
      ];
    },
  );

  return (
    <FlowCouplingCard
      flowId={flowId}
      workspaceId={workspaceId}
      missingTools={missingTools}
    />
  );
}

function FlowCouplingCard({
  flowId,
  workspaceId,
  missingTools,
}: {
  flowId: string;
  workspaceId: string;
  missingTools: FlowMissingTool[];
}): ReactNode {
  const { pushAssistant } = useSurfaceAction();
  // Which stepId currently has the credential entry open? null = none.
  const [openCouplingStepId, setOpenCouplingStepId] = useState<string | null>(
    null,
  );
  // stepIds the user marked locally as „done"/„skipped".
  // (The real coupling confirmation lives in CredentialRequestCard; here only
  //  the UI state for the „Flow starten" gate.)
  const [resolvedStepIds, setResolvedStepIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [forceStart, setForceStart] = useState(false);
  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allResolved =
    missingTools.length === 0 ||
    missingTools.every((t) => resolvedStepIds.has(t.stepId));
  const canStart = allResolved || forceStart;

  const markResolved = (stepId: string): void => {
    setResolvedStepIds((prev) => {
      const next = new Set(prev);
      next.add(stepId);
      return next;
    });
    setOpenCouplingStepId(null);
  };

  const startFlow = async (): Promise<void> => {
    if (starting) return;
    setStarting(true);
    setError(null);
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(10);
    }
    try {
      const res = await fetch(
        `/api/flow/${encodeURIComponent(flowId)}/run`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        setError(body.message ?? body.error ?? `HTTP ${res.status}`);
        return;
      }
      setStarted(true);
      pushAssistant('**Flow gestartet** — ich melde die Schritte hier.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  // ── Done state ──────────────────────────────────────────────────────────────
  if (started) {
    return (
      <div
        data-test="surface-flow-coupling"
        data-state="started"
        role="group"
        aria-label="Flow gestartet"
        style={flowCouplingCardStyle}
      >
        <div style={flowCouplingKickerStyle}>Flow gestartet</div>
        <div
          style={{
            fontSize: 13.5,
            color: 'var(--ink-2, #A1A1A6)',
            lineHeight: 1.5,
          }}
        >
          Die Schritte laufen jetzt — ich melde den Fortschritt im Chat.
        </div>
      </div>
    );
  }

  return (
    <div
      data-test="surface-flow-coupling"
      role="group"
      aria-label="Tools koppeln"
      style={flowCouplingCardStyle}
    >
      <div style={flowCouplingKickerStyle}>Tools koppeln</div>
      <div
        style={{
          fontSize: 16,
          fontWeight: 600,
          color: 'var(--ink, #F5F5F7)',
          letterSpacing: '-0.01em',
        }}
      >
        Tools koppeln, dann läuft der Flow
      </div>

      {missingTools.length === 0 ? (
        <div
          data-test="flow-coupling-empty"
          style={{
            fontSize: 13.5,
            color: 'var(--ink-2, #A1A1A6)',
            lineHeight: 1.5,
          }}
        >
          Alle Tools sind gekoppelt. Der Flow kann starten.
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          {missingTools.map((t) => {
            const resolved = resolvedStepIds.has(t.stepId);
            const open = openCouplingStepId === t.stepId;
            const hasProvider = t.provider !== null;
            const hint = flowCouplingReasonHint(t.reason, hasProvider);
            return (
              <div
                key={t.stepId}
                data-test="flow-missing-tool"
                data-step-id={t.stepId}
                data-reason={t.reason}
                data-resolved={resolved ? 'true' : 'false'}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  padding: '12px 14px',
                  borderRadius: 12,
                  background: 'var(--sheet-2, #0E0E0F)',
                  border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 5,
                      minWidth: 0,
                    }}
                  >
                    {/* N1: stepTitle in full, unshortened. */}
                    <span
                      data-test="flow-missing-tool-title"
                      style={{
                        fontSize: 13.5,
                        fontWeight: 600,
                        color: 'var(--ink, #F5F5F7)',
                        letterSpacing: '-0.01em',
                        lineHeight: 1.35,
                      }}
                    >
                      {t.stepTitle}
                    </span>
                    <span
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        flexWrap: 'wrap',
                      }}
                    >
                      {hasProvider ? (
                        <span
                          data-test="flow-missing-tool-provider"
                          style={{
                            fontFamily: 'var(--font-mono, ui-monospace)',
                            fontSize: 11,
                            padding: '1px 7px',
                            borderRadius: 5,
                            background:
                              'color-mix(in oklab, var(--a-now, #5ad1e6) 12%, transparent)',
                            color: 'var(--a-now, #5ad1e6)',
                            letterSpacing: '0.04em',
                          }}
                        >
                          {t.provider}
                        </span>
                      ) : null}
                      <span
                        data-test="flow-missing-tool-hint"
                        style={{
                          fontSize: 12,
                          color: 'var(--ink-3, #636366)',
                        }}
                      >
                        {hint}
                      </span>
                    </span>
                  </div>

                  {resolved ? (
                    <span
                      data-test="flow-missing-tool-resolved"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        fontFamily: 'var(--font-mono, ui-monospace)',
                        fontSize: 11,
                        letterSpacing: '0.04em',
                        color: 'var(--a-ok, #5fd39a)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: 999,
                          backgroundColor: 'var(--a-ok, #5fd39a)',
                          display: 'inline-block',
                        }}
                      />
                      Gekoppelt
                    </span>
                  ) : hasProvider ? (
                    <button
                      type="button"
                      data-test="flow-couple-btn"
                      data-step-id={t.stepId}
                      className="press"
                      onClick={() =>
                        setOpenCouplingStepId((cur) =>
                          cur === t.stepId ? null : t.stepId,
                        )
                      }
                      style={{
                        flexShrink: 0,
                        minHeight: 36,
                        padding: '7px 16px',
                        borderRadius: 999,
                        border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
                        background: 'var(--sheet-1, #0A0A0B)',
                        color: 'var(--ink, #F5F5F7)',
                        fontSize: 13,
                        fontWeight: 600,
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {open ? 'Abbrechen' : 'Koppeln'}
                    </button>
                  ) : null}
                </div>

                {/* Provider===null → no „Koppeln" button (we don't know the tool);
                    instead a generic hint. */}
                {!hasProvider ? (
                  <div
                    data-test="flow-missing-tool-generic"
                    style={{
                      fontSize: 12.5,
                      lineHeight: 1.5,
                      color: 'var(--ink-2, #A1A1A6)',
                    }}
                  >
                    Tool für diesen Schritt wählen/verbinden — sag mir, welches
                    Tool den Schritt erledigen soll.
                  </div>
                ) : null}

                {/* Existing credential entry (ACL5-B). The secret goes ONLY via
                    POST /api/connectors/[provider]/credential — never into the chat.
                    We build NO new secret entry.
                    Stream X1 (2026-05-28): if an onboarding SOP exists for the
                    provider, FlowCouplingCouplingPane renders
                    the SOP steps (signup → key → provider-budget hint →
                    credential entry) PLUS a cost-hint line. Without
                    a SOP: backwards-compatible CredentialRequestCard directly. */}
                {open && hasProvider && t.provider ? (
                  <div data-test="flow-couple-credential">
                    <FlowCouplingCouplingPane
                      provider={t.provider}
                      stepTitle={t.stepTitle}
                      workspaceId={workspaceId}
                      neededCapabilities={t.neededCapabilities}
                    />
                    <button
                      type="button"
                      data-test="flow-couple-done-btn"
                      className="press"
                      onClick={() => markResolved(t.stepId)}
                      style={{
                        marginTop: 8,
                        minHeight: 32,
                        padding: '6px 14px',
                        borderRadius: 999,
                        border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
                        background: 'transparent',
                        color: 'var(--ink-2, #A1A1A6)',
                        fontSize: 12.5,
                        cursor: 'pointer',
                      }}
                    >
                      Fertig — als gekoppelt markieren
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {error ? (
        <div
          data-test="flow-coupling-error"
          role="alert"
          style={{
            fontSize: 12.5,
            color: 'var(--a-danger, #FF453A)',
            lineHeight: 1.5,
          }}
        >
          {error}
        </div>
      ) : null}

      {/* Actions: primary „Flow starten" (gated) + secondary „Trotzdem
          starten", as long as not everything is coupled yet. */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <button
          type="button"
          data-test="flow-start-btn"
          data-enabled={canStart ? 'true' : 'false'}
          className="press"
          disabled={!canStart || starting}
          onClick={() => void startFlow()}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            minHeight: 52,
            padding: '14px 22px',
            borderRadius: 999,
            border: 'none',
            background: canStart
              ? 'var(--a-now, #5ad1e6)'
              : 'var(--sheet-2, #0E0E0F)',
            color: canStart ? 'var(--screen, #061417)' : 'var(--ink-3, #636366)',
            fontSize: 16,
            fontWeight: 600,
            letterSpacing: '-0.01em',
            cursor: canStart && !starting ? 'pointer' : 'not-allowed',
            opacity: starting ? 0.7 : 1,
          }}
        >
          {starting ? 'Startet …' : 'Flow starten'}
        </button>

        {!allResolved && !forceStart ? (
          <button
            type="button"
            data-test="flow-force-start-btn"
            className="press"
            onClick={() => setForceStart(true)}
            style={{
              minHeight: 40,
              padding: '9px 18px',
              borderRadius: 999,
              border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
              background: 'transparent',
              color: 'var(--ink-2, #A1A1A6)',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Trotzdem starten
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Stream X1 (2026-05-28) — Onboarding-SOP-aware coupling pane.
 *
 * Renders for a single missing tool either:
 *   - the generic onboarding SOP (signup → key → provider-budget hint →
 *     credential entry) PLUS a top cost-hint line, OR
 *   - backwards-compatible: just the CredentialRequestCard (when no SOP
 *     entry exists for the provider).
 *
 * SECURITY: this component NEVER receives or stores a secret value. The
 * credential step delegates to CredentialRequestCard which posts directly
 * to /api/connectors/[provider]/credential — never via SSE/chat/ledger.
 */
function FlowCouplingCouplingPane({
  provider,
  stepTitle,
  workspaceId,
  neededCapabilities,
}: {
  provider: string;
  stepTitle: string;
  workspaceId: string;
  neededCapabilities?: string[];
}): ReactNode {
  // Lookup is pure + idempotent — safe to call on every render.
  const sop: OnboardingSop | null = buildOnboardingSopForMissingTool({
    provider,
    reason: 'credential',
  });

  // Best-effort cost hint: take the first needed capability (if any) and
  // ask pricing for an estimate. Unknown combos return an explicit
  // unknown-marker (owner directive #2 — never silently 0).
  const capForCost =
    neededCapabilities && neededCapabilities.length > 0
      ? neededCapabilities[0]
      : '';
  const cost: CostEstimate | null = capForCost
    ? estimateCost(provider, capForCost)
    : null;

  // Backwards-compatible: without a SOP → the original CredentialRequestCard.
  if (!sop) {
    return (
      <>
        {cost ? <FlowCouplingCostHint cost={cost} /> : null}
        <CredentialRequestCard
          provider={provider}
          scopeKind="workspace"
          workspaceId={workspaceId}
          why={`Für den Schritt „${stepTitle}" wird ${provider} benötigt.`}
        />
      </>
    );
  }

  return (
    <div
      data-test="flow-onboarding-sop"
      data-provider={sop.providerId}
      data-engine-backed={sop.engineBacked ? 'true' : 'false'}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {cost ? <FlowCouplingCostHint cost={cost} /> : null}

      <div
        data-test="flow-onboarding-sop-title"
        style={{
          fontFamily: 'var(--font-mono, ui-monospace)',
          fontSize: 11,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--ink-3, #636366)',
        }}
      >
        Onboarding · {sop.displayName}
      </div>

      <ol
        data-test="flow-onboarding-sop-steps"
        style={{
          listStyle: 'none',
          padding: 0,
          margin: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {sop.keyAcquisitionSteps.map((step) => (
          <FlowOnboardingStepRow
            key={step.num}
            step={step}
            provider={sop.providerId}
            stepTitle={stepTitle}
            workspaceId={workspaceId}
            engineBacked={sop.engineBacked}
          />
        ))}
      </ol>
    </div>
  );
}

function FlowCouplingCostHint({ cost }: { cost: CostEstimate }): ReactNode {
  // Owner directive #2: hint, no cap.
  // - Unknown → explicit "unbekannt" (never 0).
  // - Known → range + basis + recognizable hint text.
  const label = cost.unknown
    ? 'Kosten-Schätzung: unbekannt für diese Kombination'
    : `Geschätzte Kosten: ${formatEurRange(cost.eurMin, cost.eurMax)} · ${cost.basis}`;
  return (
    <div
      data-test="flow-coupling-cost-hint"
      data-unknown={cost.unknown ? 'true' : 'false'}
      role="note"
      aria-label="Kosten-Hinweis (kein Cap, nur Schätzung)"
      style={{
        fontSize: 12.5,
        lineHeight: 1.5,
        color: 'var(--ink-2, #A1A1A6)',
        padding: '8px 12px',
        borderRadius: 10,
        background: 'var(--sheet-2, #0E0E0F)',
        border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
      }}
    >
      <div style={{ fontWeight: 600, color: 'var(--ink, #F5F5F7)' }}>{label}</div>
      <div
        data-test="flow-coupling-cost-note"
        style={{ marginTop: 4, fontSize: 12, color: 'var(--ink-3, #636366)' }}
      >
        Hinweis, kein Cap — dein Provider-seitiges Budget liegt bei dir.
      </div>
    </div>
  );
}

function formatEurRange(min: number | null, max: number | null): string {
  if (min === null || max === null) return 'unbekannt';
  if (min === max) return `${formatEur(min)}`;
  return `${formatEur(min)} – ${formatEur(max)}`;
}

function formatEur(eur: number): string {
  // Amounts under 1 € with 2 decimal places, otherwise 2 (standard).
  return `${eur.toFixed(2).replace('.', ',')} €`;
}

function FlowOnboardingStepRow({
  step,
  provider,
  stepTitle,
  workspaceId,
  engineBacked,
}: {
  step: OnboardingSopStep;
  provider: string;
  stepTitle: string;
  workspaceId: string;
  engineBacked: boolean;
}): ReactNode {
  return (
    <li
      data-test="flow-onboarding-step"
      data-step-num={step.num}
      data-step-kind={step.kind}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '10px 12px',
        borderRadius: 10,
        background: 'var(--sheet-2, #0E0E0F)',
        border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
        }}
      >
        <span
          aria-hidden
          style={{
            fontFamily: 'var(--font-mono, ui-monospace)',
            fontSize: 11,
            color: 'var(--ink-3, #636366)',
            minWidth: 18,
          }}
        >
          {step.num}.
        </span>
        <span
          data-test="flow-onboarding-step-title"
          style={{
            fontSize: 13.5,
            fontWeight: 600,
            color: 'var(--ink, #F5F5F7)',
            letterSpacing: '-0.01em',
            lineHeight: 1.35,
          }}
        >
          {step.title}
        </span>
      </div>
      <div
        data-test="flow-onboarding-step-body"
        style={{
          fontSize: 12.5,
          lineHeight: 1.5,
          color: 'var(--ink-2, #A1A1A6)',
        }}
      >
        {step.body}
      </div>
      {step.href ? (
        <a
          data-test="flow-onboarding-step-link"
          href={step.href}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: 12.5,
            color: 'var(--a-now, #5ad1e6)',
            textDecoration: 'none',
            wordBreak: 'break-all',
          }}
        >
          {step.href}
        </a>
      ) : null}
      {/* Credential entry exactly where the SOP requires it — not stacked
          at the top. For engine-backed providers the SOP shows an 'info'
          step instead of a 'credential' step; accordingly nothing
          renders here. */}
      {step.kind === 'credential' && !engineBacked ? (
        <div
          data-test="flow-onboarding-credential-slot"
          style={{ marginTop: 6 }}
        >
          <CredentialRequestCard
            provider={provider}
            scopeKind="workspace"
            workspaceId={workspaceId}
            why={`Für den Schritt „${stepTitle}" wird ${provider} benötigt.`}
          />
        </div>
      ) : null}
    </li>
  );
}

const flowCouplingCardStyle: React.CSSProperties = {
  background: 'var(--sheet-1, #0A0A0B)',
  border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
  borderRadius: 16,
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  maxWidth: 560,
};

const flowCouplingKickerStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono, ui-monospace)',
  fontSize: 11,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--ink-3, #636366)',
};

// ---------------------------------------------------------------------------
// Stream X1 (2026-05-28) — live-warn surface.
//
// Appears exactly ONCE per workspace on the first LIVE run
// (LAZYOS_CONNECTOR_LIVE=on AND topic='live-warn-acked' not yet
// stored). Owner directive #3: all 3 providers flippable to live in parallel — the
// warn surface protects against that happening accidentally.
//
// SECURITY: the payload carries NO secret — only { workspaceId }. POST
// /api/workspace/[workspaceId]/live-warn-ack is auth-gated and idempotent
// (clicking twice does not create two beliefs — supersede in beliefs-repo).
// ---------------------------------------------------------------------------

function renderLiveWarn(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const workspaceId = str(data.workspaceId);
  if (!workspaceId) return null;
  return <LiveWarnCard workspaceId={workspaceId} />;
}

function LiveWarnCard({ workspaceId }: { workspaceId: string }): ReactNode {
  const [state, setState] = useState<'idle' | 'acking' | 'acked' | 'declined' | 'error'>(
    'idle',
  );
  const [error, setError] = useState<string | null>(null);

  const post = async (decision: 'ack' | 'decline'): Promise<void> => {
    if (state === 'acking') return;
    setState('acking');
    setError(null);
    try {
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/live-warn-ack`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        setError(body.message ?? body.error ?? `HTTP ${res.status}`);
        setState('error');
        return;
      }
      setState(decision === 'ack' ? 'acked' : 'declined');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState('error');
    }
  };

  if (state === 'acked') {
    return (
      <div
        data-test="surface-live-warn"
        data-state="acked"
        role="status"
        style={liveWarnCardStyle}
      >
        <div style={flowCouplingKickerStyle}>LIVE bestätigt</div>
        <div
          style={{
            fontSize: 13.5,
            color: 'var(--ink-2, #A1A1A6)',
            lineHeight: 1.5,
          }}
        >
          OK. Connector-LIVE-Mode bestätigt — diese Warnung erscheint nicht
          erneut für diesen Workspace.
        </div>
      </div>
    );
  }

  if (state === 'declined') {
    return (
      <div
        data-test="surface-live-warn"
        data-state="declined"
        role="status"
        style={liveWarnCardStyle}
      >
        <div style={flowCouplingKickerStyle}>LIVE pausiert</div>
        <div
          style={{
            fontSize: 13.5,
            color: 'var(--ink-2, #A1A1A6)',
            lineHeight: 1.5,
          }}
        >
          Verstanden — du prüfst die Provider-Budgets erst. Der LIVE-Lauf wurde
          nicht freigegeben.
        </div>
      </div>
    );
  }

  return (
    <div
      data-test="surface-live-warn"
      data-state={state}
      role="group"
      aria-label="LIVE-Mode-Warnung"
      style={liveWarnCardStyle}
    >
      <div style={flowCouplingKickerStyle}>LIVE-Mode aktiv</div>
      <div
        style={{
          fontSize: 16,
          fontWeight: 600,
          color: 'var(--ink, #F5F5F7)',
          letterSpacing: '-0.01em',
          lineHeight: 1.35,
        }}
      >
        Du hast LIVE-Mode aktiv. Echte API-Calls = echte Kosten.
      </div>
      <div
        style={{
          fontSize: 13.5,
          lineHeight: 1.5,
          color: 'var(--ink-2, #A1A1A6)',
        }}
      >
        Provider-Budgets gesetzt? laz.ing zeigt nur Kosten-Schätzungen als
        Hinweis — der echte Cap liegt in der Konsole des jeweiligen Providers
        (Higgsfield / HeyGen / Codex-MAX). Diese Warnung erscheint einmalig
        pro Workspace.
      </div>
      {error ? (
        <div
          data-test="live-warn-error"
          role="alert"
          style={{
            fontSize: 12.5,
            color: 'var(--a-danger, #FF453A)',
            lineHeight: 1.5,
          }}
        >
          {error}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          data-test="live-warn-ack-btn"
          className="press"
          disabled={state === 'acking'}
          onClick={() => void post('ack')}
          style={{
            minHeight: 44,
            padding: '10px 18px',
            borderRadius: 999,
            border: 'none',
            background: 'var(--a-now, #5ad1e6)',
            color: 'var(--screen, #061417)',
            fontSize: 13.5,
            fontWeight: 600,
            cursor: state === 'acking' ? 'not-allowed' : 'pointer',
            opacity: state === 'acking' ? 0.7 : 1,
          }}
        >
          {state === 'acking' ? 'Speichert …' : 'OK weiter'}
        </button>
        <button
          type="button"
          data-test="live-warn-decline-btn"
          className="press"
          disabled={state === 'acking'}
          onClick={() => void post('decline')}
          style={{
            minHeight: 44,
            padding: '10px 18px',
            borderRadius: 999,
            border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
            background: 'transparent',
            color: 'var(--ink, #F5F5F7)',
            fontSize: 13.5,
            cursor: state === 'acking' ? 'not-allowed' : 'pointer',
          }}
        >
          Nein, ich prüfe erst
        </button>
      </div>
    </div>
  );
}

const liveWarnCardStyle: React.CSSProperties = {
  background: 'var(--sheet-1, #0A0A0B)',
  border: '0.5px solid var(--a-warn, #FFD60A)',
  borderRadius: 16,
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  maxWidth: 560,
};

// ---------------------------------------------------------------------------
// Cluster A — workflow (Sub-Plan 3, 2026-05-01)
// Pipeline-family merge. The phase state decides the sub-layout.
// ---------------------------------------------------------------------------

const WORKFLOW_PHASES: ReadonlyArray<WorkflowPhase> = [
  'intake',
  'plan',
  'dispatch',
  'execute',
  'iterate',
  'review',
  'done',
];

function renderWorkflow(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const phaseRaw = str(data.phase) ?? 'execute';
  const phase = (WORKFLOW_PHASES as readonly string[]).includes(phaseRaw)
    ? (phaseRaw as WorkflowPhase)
    : 'execute';
  const stepsRaw = Array.isArray(data.steps) ? data.steps : [];
  const steps: WorkflowStaticStep[] = [];
  let sIdx = 0;
  for (const s of stepsRaw) {
    if (!isObject(s)) {
      sIdx += 1;
      continue;
    }
    const title = str(s.title);
    if (!title) {
      sIdx += 1;
      continue;
    }
    const numV = num(s.num) ?? sIdx + 1;
    const statusRaw = str(s.status);
    const status: 'done' | 'running' | 'waiting' =
      statusRaw === 'done' || statusRaw === 'running' || statusRaw === 'waiting'
        ? statusRaw
        : 'waiting';
    steps.push({ num: numV, title, status, subtitle: str(s.subtitle) });
    sIdx += 1;
  }
  const subTicketsRaw = Array.isArray(data.subTickets) ? data.subTickets : [];
  const subTickets = subTicketsRaw
    .map((s) => {
      if (!isObject(s)) return null;
      const id = str(s.id);
      const title = str(s.title) ?? id ?? '';
      if (!id) return null;
      return { id, title };
    })
    .filter((s): s is { id: string; title: string } => s !== null);

  return (
    <WorkflowCard
      phase={phase}
      workstreamId={str(data.workstreamId)}
      workspaceId={str(data.workspaceId)}
      workstreamName={str(data.workstreamName) ?? str(data.name)}
      steps={steps.length > 0 ? steps : undefined}
      masterTicketId={str(data.masterTicketId) ?? str(data.master_ticket_id)}
      subTickets={subTickets.length > 0 ? subTickets : undefined}
      ticketId={str(data.ticketId)}
      ticketTitle={str(data.ticketTitle) ?? str(data.title)}
      initialState={str(data.state) ?? str(data.workflowState)}
      maxVersion={num(data.maxVersion) ?? num(data.max_version)}
      href={str(data.href)}
    />
  );
}

// ---------------------------------------------------------------------------
// Cluster C — prompt (Sub-Plan 3, 2026-05-01)
// Prompt-family merge. `variant` discriminates.
// ---------------------------------------------------------------------------

function renderPrompt(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const variantRaw = str(data.variant);
  switch (variantRaw) {
    case 'form':
      return renderForm(data);
    case 'credential':
      return renderCredentialPrompt(data);
    case 'open-questions':
      return renderOpenQuestions(data);
    case 'plan-questions':
      return renderPlanOpenQuestionsCard(data);
    case 'quickchoice':
      return renderQuickChoice(data);
    case 'decision':
      return renderDecision(data);
    // R4 (2026-05-29) — decision brief (surface-manifestation strategy §7.3):
    // a confirmable decision with source + confidence + consequence + options.
    // event-only behavior (no double routing): a click plays back structured
    // data without additionally creating a reply bubble.
    case 'decision-brief':
      return renderDecisionBrief(data);
    default:
      // Sniffing: if `endpoint` is set, form. If `name`+`workspaceId`,
      // then credential. If `headline`+`options`, decision. Otherwise null.
      if (isObject(data.endpoint) && Array.isArray(data.fields)) {
        return renderForm(data);
      }
      if (str(data.name) && str(data.workspaceId)) {
        return renderCredentialPrompt(data);
      }
      if (str(data.headline) && Array.isArray(data.options)) {
        return renderDecision(data);
      }
      if (Array.isArray(data.questions)) {
        return renderOpenQuestions(data);
      }
      if (Array.isArray(data.options)) {
        return renderQuickChoice(data);
      }
      return null;
  }
}

// ---------------------------------------------------------------------------
// Cluster D — agent-step (Sub-Plan 3, 2026-05-01)
// Tool/step merge. `mode` discriminates.
// ---------------------------------------------------------------------------

function renderAgentStep(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const modeRaw = str(data.mode);
  switch (modeRaw) {
    case 'agent':
      return renderAgent(data);
    case 'swarm':
      return renderSwarm(data);
    case 'live-swarm':
      return renderLiveSwarm(data);
    case 'bug-fix-swarm':
      return renderBugFixSwarm(data);
    case 'bug-fix-pipeline':
      return renderBugFixPipeline(data);
    case 'loop-phase':
      return renderLoopPhase(data);
    case 'tier-choice':
      return renderTierChoice(data);
    default:
      // Sniffing: typical fields, defensive order.
      if (str(data.swarmId) && str(data.bugDescription)) {
        return renderBugFixSwarm(data);
      }
      if (isObject(data.tierMix)) {
        return renderLiveSwarm(data);
      }
      if (Array.isArray(data.cells)) {
        return renderSwarm(data);
      }
      if (Array.isArray(data.presets) || str(data.recommendation_basis)) {
        return renderTierChoice(data);
      }
      if (str(data.kind) && str(data.workstreamId)) {
        return renderLoopPhase(data);
      }
      if (str(data.role) || str(data.name)) {
        return renderAgent(data);
      }
      return null;
  }
}

// ---------------------------------------------------------------------------
// counter-evidence — E4 / P13 Devil's Advocate (2026-05-27).
//
// Anti-confirmation-bias: appears as its OWN card AFTER a synthesis
// (gated on consensus 'strong' OR WHY feed-in). NOT mixed into the
// synthesis stream — the user reads synthesis and counter-evidence
// separately. Red flag (var(--a-danger)) when the thesis is not
// falsifiable (tautological/unverifiable) — then it must be
// re-formulated. Token bind (no hardcoded hex; var(--token, #fallback) pattern
// like all cards).
// ---------------------------------------------------------------------------

type CounterVerdict = 'falsifiable' | 'unfalsifiable' | 'weak-evidence';

const COUNTER_VERDICTS: ReadonlyArray<CounterVerdict> = [
  'falsifiable',
  'unfalsifiable',
  'weak-evidence',
];

/**
 * Splits the DA markdown output into individual counter points. Recognizes the
 * `### Counter N: <title>` headers from the Devil's-Advocate system prompt.
 * Tolerant: without recognizable headers, counters stays empty and the card
 * renders only the full text. Pure helper function (no state).
 */
function parseCounterPoints(text: string): Array<{ title: string; body: string }> {
  if (typeof text !== 'string' || text.length === 0) return [];
  const re = /^###\s+Counter\s*\d*\s*:?\s*(.*)$/gim;
  const points: Array<{ title: string; body: string }> = [];
  const matches: Array<{ title: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    matches.push({
      title: (m[1] ?? '').trim(),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    // Body = everything up to the next counter header or up to the next
    // section (##), N1: do not shorten.
    const sliceEnd = i + 1 < matches.length ? matches[i + 1].start : text.length;
    let body = text.slice(cur.end, sliceEnd).trim();
    const nextSection = body.search(/^##\s/m);
    if (nextSection >= 0) body = body.slice(0, nextSection).trim();
    points.push({ title: cur.title, body });
  }
  return points;
}

function renderCounterEvidence(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  // N1: do not shorten the full text.
  const text = str(data.text) ?? '';
  const verdictRaw = str(data.verdict);
  const verdict: CounterVerdict =
    verdictRaw && (COUNTER_VERDICTS as readonly string[]).includes(verdictRaw)
      ? (verdictRaw as CounterVerdict)
      : 'weak-evidence';
  // unfalsifiable: explicitly from the payload OR derived from the verdict.
  const unfalsifiable = data.unfalsifiable === true || verdict === 'unfalsifiable';
  const counterEvidenceCount =
    num(data.counterEvidenceCount) ?? num(data.counterCount) ?? 0;

  // Without text AND without counter → nothing to show (no throw).
  if (text.trim().length === 0 && counterEvidenceCount === 0 && !unfalsifiable) {
    return null;
  }

  return (
    <CounterEvidenceCard
      text={text}
      verdict={verdict}
      unfalsifiable={unfalsifiable}
      counterEvidenceCount={counterEvidenceCount}
    />
  );
}

function CounterEvidenceCard({
  text,
  verdict,
  unfalsifiable,
  counterEvidenceCount,
}: {
  text: string;
  verdict: CounterVerdict;
  unfalsifiable: boolean;
  counterEvidenceCount: number;
}): ReactNode {
  const points = parseCounterPoints(text);

  // Accent: red on unfalsifiable (red flag), warn on weak-evidence,
  // neutral-info otherwise. Token bind.
  const accent = unfalsifiable
    ? 'var(--a-danger, #FF453A)'
    : verdict === 'weak-evidence'
      ? 'var(--a-warn, #FFD60A)'
      : 'var(--a-now, #c9ff4d)';

  const verdictLabel: Record<CounterVerdict, string> = {
    falsifiable: 'Falsifizierbar',
    unfalsifiable: 'Nicht falsifizierbar',
    'weak-evidence': 'Dünne Evidenz',
  };

  return (
    <div
      data-test="surface-counter-evidence"
      data-verdict={verdict}
      data-unfalsifiable={unfalsifiable ? 'true' : 'false'}
      role="group"
      aria-label="Gegen-Evidenz (Devil's Advocate)"
      style={{
        background: 'var(--sheet-1, #0A0A0B)',
        border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
        borderLeft: `2px solid ${accent}`,
        borderRadius: 16,
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        maxWidth: 640,
      }}
    >
      {/* Header: title + verdict pill. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <span
          style={{
            fontSize: 14.5,
            fontWeight: 600,
            letterSpacing: '-0.01em',
            color: 'var(--ink, #F5F5F7)',
          }}
        >
          Gegen-Evidenz
          <span
            style={{
              color: 'var(--ink-3, #636366)',
              fontWeight: 500,
              fontSize: 12,
              marginLeft: 8,
            }}
          >
            Devil&rsquo;s Advocate
          </span>
        </span>
        <span
          data-test="counter-evidence-verdict"
          data-verdict={verdict}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            borderRadius: 999,
            fontSize: 11.5,
            fontWeight: 600,
            letterSpacing: '-0.005em',
            color: accent,
            background:
              'color-mix(in oklab, var(--sheet-2, #0E0E0F) 92%, transparent)',
            border: `0.5px solid ${accent}`,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              backgroundColor: accent,
              display: 'inline-block',
            }}
          />
          {verdictLabel[verdict]}
        </span>
      </div>

      {/* Red-flag banner: only when the thesis is not falsifiable. */}
      {unfalsifiable ? (
        <div
          data-test="counter-evidence-red-flag"
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            padding: '10px 12px',
            borderRadius: 10,
            background:
              'color-mix(in oklab, var(--a-danger, #FF453A) 12%, var(--sheet-2, #0E0E0F))',
            border: '0.5px solid var(--a-danger, #FF453A)',
            color: 'var(--ink, #F5F5F7)',
            fontSize: 12.5,
            lineHeight: 1.45,
          }}
        >
          <span aria-hidden style={{ color: 'var(--a-danger, #FF453A)', display: 'inline-flex', flex: '0 0 auto' }}>
            <svg
              width={14}
              height={14}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M5 21V4 M5 4h11l-2.5 4L16 12H5" />
            </svg>
          </span>
          <span>
            <strong style={{ color: 'var(--a-danger, #FF453A)' }}>
              These nicht falsifizierbar.
            </strong>{' '}
            Die Synthesis ist tautologisch oder unprüfbar — keine widerlegende
            Beobachtung formulierbar. Re-formulieren, damit sie testbar wird.
          </span>
        </div>
      ) : (
        <p
          data-test="counter-evidence-count"
          style={{
            margin: 0,
            fontSize: 12.5,
            lineHeight: 1.45,
            color: 'var(--ink-2, #A1A1A6)',
          }}
        >
          {counterEvidenceCount > 0
            ? `${counterEvidenceCount} widerlegende Beobachtung${
                counterEvidenceCount === 1 ? '' : 'en'
              } gefunden — prüfe, ob die These standhält.`
            : 'Kein klarer Counter gefunden — Evidenzbasis dünn.'}
        </p>
      )}

      {/* Counter points individually, if recognizable; otherwise full text (N1). */}
      {points.length > 0 ? (
        <ol
          data-test="counter-evidence-points"
          style={{
            margin: 0,
            paddingLeft: 18,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          {points.map((p, i) => (
            <li
              key={i}
              data-test="counter-evidence-point"
              style={{
                fontSize: 13,
                lineHeight: 1.5,
                color: 'var(--ink, #F5F5F7)',
              }}
            >
              {p.title ? (
                <span style={{ fontWeight: 600 }}>{p.title}</span>
              ) : null}
              {p.body ? (
                <span
                  style={{
                    display: 'block',
                    marginTop: 3,
                    color: 'var(--ink-2, #A1A1A6)',
                  }}
                >
                  {p.body}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : text.trim().length > 0 ? (
        <p
          data-test="counter-evidence-fulltext"
          style={{
            margin: 0,
            whiteSpace: 'pre-wrap',
            fontSize: 13,
            lineHeight: 1.5,
            color: 'var(--ink, #F5F5F7)',
          }}
        >
          {text}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// run-cockpit — owner fix (2026-05-28).
// Aggregated master surface: phase stepper + sub-workstream list collapsed-
// default + next-phase hint + token/cost counter. Replaces the 3 simultaneous
// emit sites (sub-workstreams + iterate-pipeline + iterate-version) in the
// stream; the legacy cards stay emitted, but are suppressed in the renderer
// (see RunCockpitRegistryProvider + useRunCockpitActive).
//
// Mobile-first: 375px-capable, no horizontal overflows. Touch targets
// >= 44px. Token-only (var(--ink), var(--sheet-*), var(--line-*), var(--a-*)).
// ---------------------------------------------------------------------------

/** Phase order of the cockpit. */
const RUN_COCKPIT_PHASES = [
  'decompose',
  'tier-spawn',
  'lead',
  'roaster',
  'consensus',
  'done',
] as const;
type RunCockpitPhase = (typeof RUN_COCKPIT_PHASES)[number];

const RUN_COCKPIT_PHASE_LABEL: Record<RunCockpitPhase, string> = {
  decompose: 'Decompose',
  'tier-spawn': 'Tier-Spawn',
  lead: 'Lead',
  roaster: 'Roaster',
  consensus: 'Consensus',
  done: 'Done',
};

function isRunCockpitPhase(s: string | undefined): s is RunCockpitPhase {
  return (
    typeof s === 'string' && (RUN_COCKPIT_PHASES as readonly string[]).includes(s)
  );
}

/** Default hint per phase — can be overridden by Payload.nextStepHint. */
function defaultNextHint(phase: RunCockpitPhase): string {
  switch (phase) {
    case 'decompose':
      return 'Sobald der Plan zerlegt ist: Tier-Wahl erscheint mit 1, 4 oder 8 Agenten.';
    case 'tier-spawn':
      return 'Sobald die Agenten gestartet sind: Lead schreibt V1, dann kommen Roaster-Stimmen.';
    case 'lead':
      return 'Sobald V1 steht: Roaster vergleichen + verbessern.';
    case 'roaster':
      return 'Sobald Lead + Roaster konsensiert: Consensus-Card erscheint für deine Freigabe.';
    case 'consensus':
      return 'Sobald freigegeben: Lauf schliesst ab und Preview erscheint.';
    case 'done':
      return 'Lauf abgeschlossen.';
  }
}

interface SubWorkstreamRowData {
  /** Stable Key — id oder role. */
  key: string;
  role: string;
  status: string | undefined;
  tokensOut: number | undefined;
  model: string | undefined;
}

function isSubWorkstreamRow(v: unknown): v is Record<string, unknown> {
  return isObject(v);
}

function extractSubWorkstreams(data: unknown): SubWorkstreamRowData[] {
  if (!Array.isArray(data)) return [];
  return data
    .filter(isSubWorkstreamRow)
    .map((r, i) => {
      const id = str(r.id);
      const role = str(r.role) ?? str(r.name) ?? `sub-${i + 1}`;
      const status = str(r.status);
      const tokensOut =
        num(r.tokensOut) ?? num(r.tokens_out) ?? num(r.tokens?.['output' as never]);
      const model = str(r.model);
      return {
        key: id ?? `${role}#${i}`,
        role,
        status,
        tokensOut: tokensOut ?? undefined,
        model: model ?? undefined,
      };
    });
}

/** Status-dot color per status. */
function statusDotColor(status: string | undefined): string {
  if (!status) return 'var(--ink-3, #80848c)';
  if (status === 'done' || status === 'success') {
    return 'var(--a-ok, #5fd39a)';
  }
  if (status === 'failed' || status === 'error') {
    return 'var(--a-danger, #ff453a)';
  }
  if (status === 'paused' || status === 'pending') {
    return 'var(--a-warn, #f5c84b)';
  }
  if (status === 'active' || status === 'running') {
    return 'var(--a-now, #5ad1e6)';
  }
  return 'var(--ink-3, #80848c)';
}

interface RunCockpitProps {
  workspaceId: string;
  workstreamId: string;
  phase: RunCockpitPhase;
  phaseIndex: number;
  phaseTotal: number;
  workstreamName: string | undefined;
  subs: SubWorkstreamRowData[];
  nextStepHint: string;
  tokensTotal: number | undefined;
  costCents: number | undefined;
}

function RunCockpitCard(props: RunCockpitProps): ReactNode {
  const coordKey = buildCockpitCoordKey(props.workspaceId, props.workstreamId);
  // Mount: registers the coord in the registry → the 3 legacy cards (sub-workstreams,
  // iterate-pipeline, iterate-version) suppress themselves as long as this card lives.
  useRunCockpitRegistration(coordKey);

  const [subsCollapsed, setSubsCollapsed] = useState<boolean>(true);

  const activeIdx = props.phaseIndex - 1; // 1-based → 0-based

  // Cost counter: cents → € with 2 decimal places if present.
  const costLabel =
    typeof props.costCents === 'number' && Number.isFinite(props.costCents)
      ? `${(props.costCents / 100).toFixed(2)}€`
      : null;
  const tokenLabel =
    typeof props.tokensTotal === 'number' && Number.isFinite(props.tokensTotal)
      ? `${props.tokensTotal.toLocaleString('de-DE')} tok`
      : null;
  const counterParts = [tokenLabel, costLabel].filter(Boolean) as string[];

  return (
    <div
      data-test="run-cockpit-card"
      data-phase={props.phase}
      data-coord-key={coordKey ?? ''}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        padding: 14,
        borderRadius: 14,
        background: 'var(--sheet-1, #0c0d0f)',
        border: '0.5px solid var(--line-2, #1f1f1f)',
        // mobile-first: no horizontal overflows
        maxWidth: '100%',
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    >
      {/* Header: title + active-phase display + token/cost counter on the right */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span
            style={{
              fontSize: 11.5,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: 'var(--ink-3, #80848c)',
              fontFamily: 'var(--font-mono, ui-monospace)',
            }}
          >
            Run-Cockpit
          </span>
          <span
            data-test="run-cockpit-phase-headline"
            style={{
              fontSize: 15,
              fontWeight: 600,
              letterSpacing: '-0.01em',
              color: 'var(--ink, #f4f5f7)',
              wordBreak: 'break-word',
            }}
          >
            Phase {props.phaseIndex} von {props.phaseTotal}:{' '}
            {RUN_COCKPIT_PHASE_LABEL[props.phase]}
            {props.workstreamName ? (
              <span
                style={{
                  fontWeight: 500,
                  color: 'var(--ink-2, #b6b9c0)',
                  marginLeft: 6,
                }}
              >
                — {props.workstreamName}
              </span>
            ) : null}
          </span>
        </div>
        {counterParts.length > 0 ? (
          <span
            data-test="run-cockpit-cost-counter"
            style={{
              fontFamily: 'var(--font-mono, ui-monospace)',
              fontSize: 12,
              color: 'var(--ink-3, #80848c)',
              padding: '4px 10px',
              borderRadius: 999,
              border: '0.5px solid var(--line-2, #1f1f1f)',
              background: 'var(--sheet-2, #0e0e0f)',
              whiteSpace: 'nowrap',
            }}
          >
            {counterParts.join(' · ')}
          </span>
        ) : null}
      </div>

      {/* Phase stepper: compact horizontal pill sequence, mobile-first wrap. */}
      <ol
        data-test="run-cockpit-stepper"
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
        }}
      >
        {RUN_COCKPIT_PHASES.map((p, i) => {
          const isActive = i === activeIdx;
          const isDone = i < activeIdx;
          const bg = isActive
            ? 'color-mix(in oklab, var(--a-now, #5ad1e6) 14%, var(--sheet-2, #0e0e0f))'
            : 'var(--sheet-2, #0e0e0f)';
          const border = isActive
            ? '0.5px solid var(--a-now, #5ad1e6)'
            : '0.5px solid var(--line-2, #1f1f1f)';
          const color = isActive
            ? 'var(--ink, #f4f5f7)'
            : isDone
              ? 'var(--ink-2, #b6b9c0)'
              : 'var(--ink-3, #80848c)';
          return (
            <li
              key={p}
              data-test="run-cockpit-step"
              data-step={p}
              data-active={isActive ? '1' : '0'}
              data-done={isDone ? '1' : '0'}
              style={{
                fontSize: 11.5,
                lineHeight: 1.2,
                padding: '6px 10px',
                borderRadius: 999,
                background: bg,
                border,
                color,
                fontWeight: isActive ? 600 : 500,
                letterSpacing: '-0.005em',
                minHeight: 28,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: isDone
                    ? 'var(--a-ok, #5fd39a)'
                    : isActive
                      ? 'var(--a-now, #5ad1e6)'
                      : 'var(--ink-3, #80848c)',
                  display: 'inline-block',
                }}
              />
              {RUN_COCKPIT_PHASE_LABEL[p]}
            </li>
          );
        })}
      </ol>

      {/* Sub-workstreams section: collapsed-default. */}
      {props.subs.length > 0 ? (
        <div
          data-test="run-cockpit-subs-section"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            borderTop: '0.5px dashed var(--line-2, #1f1f1f)',
            paddingTop: 10,
          }}
        >
          <button
            type="button"
            data-test="run-cockpit-subs-toggle"
            data-collapsed={subsCollapsed ? '1' : '0'}
            onClick={() => setSubsCollapsed((c) => !c)}
            aria-expanded={!subsCollapsed}
            style={{
              appearance: 'none',
              background: 'transparent',
              border: 'none',
              padding: '6px 0',
              minHeight: 44,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              color: 'var(--ink, #f4f5f7)',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span aria-hidden style={{ fontSize: 11, color: 'var(--ink-3, #80848c)' }}>
                {subsCollapsed ? '▸' : '▾'}
              </span>
              Sub-Workstreams ({props.subs.length})
            </span>
            <span style={{ fontSize: 11.5, color: 'var(--ink-3, #80848c)' }}>
              {subsCollapsed ? 'antippen zum Ausklappen' : 'antippen zum Einklappen'}
            </span>
          </button>
          {!subsCollapsed ? (
            <ul
              data-test="run-cockpit-subs-list"
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              {props.subs.map((s) => (
                <li
                  key={s.key}
                  data-test="run-cockpit-sub-row"
                  data-status={s.status ?? ''}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 12.5,
                    color: 'var(--ink-2, #b6b9c0)',
                    padding: '8px 4px',
                    minHeight: 32,
                    borderBottom: '0.5px solid var(--line-2, #1f1f1f)',
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background: statusDotColor(s.status),
                      display: 'inline-block',
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      flex: '1 1 auto',
                      minWidth: 0,
                      color: 'var(--ink, #f4f5f7)',
                      wordBreak: 'break-word',
                    }}
                  >
                    {s.role}
                  </span>
                  {s.status ? (
                    <span
                      style={{
                        fontFamily: 'var(--font-mono, ui-monospace)',
                        fontSize: 11,
                        color: 'var(--ink-3, #80848c)',
                      }}
                    >
                      {s.status}
                    </span>
                  ) : null}
                  {typeof s.tokensOut === 'number' ? (
                    <span
                      style={{
                        fontFamily: 'var(--font-mono, ui-monospace)',
                        fontSize: 11,
                        color: 'var(--ink-3, #80848c)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {s.tokensOut.toLocaleString('de-DE')} tok
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* „What comes next" hint.
          Finding 3 (owner 2026-05-29): „auch wieder ein Hintergrund der unnötig
          ist". The hint was a --sheet-2-filled, framed block INSIDE
          the --sheet-1 card → background-on-background box. Rams fix: fill +
          frame rectangle removed, instead only a hairline separation on top +
          the brand arrow as the only highlight. Flatly layered instead of
          box-in-box. */}
      <p
        data-test="run-cockpit-next-hint"
        style={{
          margin: 0,
          padding: '10px 2px 0',
          borderTop: '0.5px solid var(--line-2, #1f1f1f)',
          background: 'transparent',
          fontSize: 12.5,
          lineHeight: 1.45,
          color: 'var(--ink-2, #b6b9c0)',
        }}
      >
        <span
          aria-hidden
          style={{
            color: 'var(--a-now, #5ad1e6)',
            fontWeight: 600,
            marginRight: 6,
          }}
        >
          →
        </span>
        {props.nextStepHint}
      </p>
    </div>
  );
}

function renderRunCockpit(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const workspaceId = str(data.workspaceId);
  const workstreamId = str(data.workstreamId);
  // Both required fields — otherwise we can neither coordinate suppression
  // nor render meaningfully (the coord key depends on them).
  if (!workspaceId || !workstreamId) return null;

  const phaseRaw = str(data.phase);
  const phase: RunCockpitPhase = isRunCockpitPhase(phaseRaw)
    ? phaseRaw
    : 'decompose';

  const total = num(data.phaseTotal) ?? RUN_COCKPIT_PHASES.length;
  const phaseTotal =
    Number.isFinite(total) && total > 0
      ? Math.min(Math.floor(total), RUN_COCKPIT_PHASES.length)
      : RUN_COCKPIT_PHASES.length;

  // If phaseIndex is missing: derive it from phase (1-based).
  const phaseIndexRaw = num(data.phaseIndex);
  const derivedIdx = RUN_COCKPIT_PHASES.indexOf(phase) + 1;
  const phaseIndex =
    typeof phaseIndexRaw === 'number' && phaseIndexRaw >= 1 && phaseIndexRaw <= phaseTotal
      ? Math.floor(phaseIndexRaw)
      : derivedIdx;

  const workstreamName = str(data.workstreamName) ?? str(data.name);
  const subs = extractSubWorkstreams(data.subWorkstreams);
  const nextStepHint = str(data.nextStepHint) ?? defaultNextHint(phase);
  const tokensTotal = num(data.tokensTotal) ?? num(data.tokens_total);
  const costCents = num(data.costCents) ?? num(data.cost_cents);

  return (
    <RunCockpitCard
      workspaceId={workspaceId}
      workstreamId={workstreamId}
      phase={phase}
      phaseIndex={phaseIndex}
      phaseTotal={phaseTotal}
      workstreamName={workstreamName}
      subs={subs}
      nextStepHint={nextStepHint}
      tokensTotal={tokensTotal}
      costCents={costCents}
    />
  );
}

// ---------------------------------------------------------------------------
// A4 (2026-05-29, Opus 4.8) — merge-offer surface.
//
// Closes the accumulation loop: the assembled work of all
// successful steps lies in the run branch `lazing/run/prun-…`. This card is
// the ONLY owner-visible path that brings it into the live checkout
// with a click (R3 human gate — NEVER automatic).
//
//   [Diff ansehen]   → POST /api/workstreams/[id]/merge-run {preview:true}
//                       (read-only — file list + stat, NO merge).
//   [In Live mergen] → POST /api/workstreams/[id]/merge-run {}
//                       (the ONLY write action → resolved after success).
//   [Verwerfen]      → purely local (no write call).
//
// SECURITY: no secret in the payload — only run/file metadata.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Self-learning workflow recording (2026-06-03, Slice 1) — recurrence nudge.
// Appears when the repetition detector recognizes that this flow has
// structurally run ≥3× already. Owner-gated: ONE button saves it as a
// reusable flow template (POST /api/flow/from-workstream = C3 path,
// the same as the „Als Prozess speichern" button on the flow-graph card).
// No auto-save. SECURITY: no secret in the payload.
// ---------------------------------------------------------------------------

function FlowRecurrenceCard(props: {
  workstreamId: string;
  workspaceId: string | undefined;
  title: string | undefined;
  seenCount: number;
  stepCount: number;
  summary: string | undefined;
}): React.JSX.Element {
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [dismissed, setDismissed] = useState(false);

  const canSave =
    props.workstreamId.length > 0 &&
    typeof props.workspaceId === 'string' &&
    props.workspaceId.length > 0;

  const handleSave = async (): Promise<void> => {
    if (!canSave || saveState === 'saving' || saveState === 'saved') return;
    setSaveState('saving');
    try {
      const resp = await fetch('/api/flow/from-workstream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workstreamId: props.workstreamId,
          workspaceId: props.workspaceId,
          ...(props.title ? { name: props.title } : {}),
        }),
      });
      setSaveState(resp.ok ? 'saved' : 'error');
    } catch {
      setSaveState('error');
    }
  };

  if (dismissed) return <></>;

  const headline =
    saveState === 'saved'
      ? 'Als wiederverwendbarer Workflow gespeichert'
      : `Diesen Ablauf hast du jetzt ${props.seenCount}× so gefahren`;

  return (
    <div
      data-test="surface-flow-recurrence"
      role="group"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        maxWidth: 520,
        padding: '14px 16px',
        borderRadius: 16,
        background: 'var(--sheet-2, #0E0E0F)',
        border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
        color: 'var(--ink, #F5F5F7)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span aria-hidden style={{ fontSize: 16 }}>
          ♻️
        </span>
        <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>
          {headline}
        </span>
      </div>
      {props.summary ? (
        <div
          style={{
            fontSize: 12.5,
            color: 'var(--ink-2, rgba(245,245,247,0.62))',
            wordBreak: 'break-word',
          }}
        >
          {props.stepCount} Schritte · {props.summary}
        </div>
      ) : null}
      {saveState !== 'saved' ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
          <button
            type="button"
            data-test="flow-recurrence-save"
            className="press"
            disabled={!canSave || saveState === 'saving'}
            onClick={() => void handleSave()}
            style={{
              minHeight: 38,
              padding: '8px 16px',
              borderRadius: 999,
              background: 'var(--ink, #F5F5F7)',
              color: 'var(--bg, #070707)',
              border: 'none',
              font: 'inherit',
              fontSize: 13,
              fontWeight: 600,
              cursor: canSave ? 'pointer' : 'default',
              opacity: !canSave || saveState === 'saving' ? 0.6 : 1,
            }}
          >
            {saveState === 'saving' ? 'Speichere …' : 'Als Workflow speichern'}
          </button>
          <button
            type="button"
            data-test="flow-recurrence-dismiss"
            className="press"
            onClick={() => setDismissed(true)}
            style={{
              minHeight: 38,
              padding: '8px 14px',
              borderRadius: 999,
              background: 'transparent',
              color: 'var(--ink-2, rgba(245,245,247,0.62))',
              border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
              font: 'inherit',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Nicht jetzt
          </button>
        </div>
      ) : null}
      {saveState === 'error' ? (
        <div style={{ fontSize: 12, color: 'var(--danger, #FF6B6B)' }}>
          Speichern fehlgeschlagen — bitte später erneut versuchen.
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// image-gen (2026-06-03) — self-driving, ANIMATED image-loading surface.
// Owner finding: the old /image blocked ~30–90 s (proxy timeout → „Fehler,
// kein Bild") + showed only a static toast. Now: IMMEDIATELY a shimmer surface,
// the card starts the job (async), polls /api/imagegen/status, swaps the image
// in (like Codex). On success → lazyos:image-gen-done event → ChatShell
// persists the <surface:document> image bubble. On error → retry inline.
// ---------------------------------------------------------------------------

interface ImageGenCardProps {
  prompt: string;
  workspace: string;
  token: string;
}

function ImageGenCard(props: ImageGenCardProps): React.JSX.Element {
  const [phase, setPhase] = useState<'starting' | 'generating' | 'done' | 'error'>('starting');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const startedRef = useRef(false);
  const ssKey = `lazyos.imggen.${props.token}`;

  const run = useCallback(async () => {
    setPhase('starting');
    setErrMsg(null);
    setBusy(false);
    const t0 = Date.now();
    const tick = window.setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 500);
    try {
      // Reuse jobId from sessionStorage (re-mount/reload → no double job).
      let jobId = (() => {
        try {
          return window.sessionStorage.getItem(ssKey);
        } catch {
          return null;
        }
      })();
      if (!jobId) {
        const r = await fetch('/api/imagegen/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ workspace: props.workspace, prompt: props.prompt }),
        });
        if (!r.ok) {
          const b = (await r.json().catch(() => null)) as { message?: string } | null;
          throw new Error(b?.message ?? `HTTP ${r.status}`);
        }
        const b = (await r.json()) as { jobId?: string };
        jobId = b.jobId ?? null;
        if (!jobId) throw new Error('Kein Job gestartet.');
        try {
          window.sessionStorage.setItem(ssKey, jobId);
        } catch {
          /* ignore */
        }
      }
      setPhase('generating');
      // Poll until done/error (max ~4 min).
      for (let i = 0; i < 120; i += 1) {
        await new Promise((res) => window.setTimeout(res, 2000));
        const s = await fetch(`/api/imagegen/status?jobId=${encodeURIComponent(jobId)}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!s.ok) {
          if (s.status === 404) throw new Error('Job nicht gefunden (Server neu gestartet?).');
          continue;
        }
        const st = (await s.json()) as {
          status?: string;
          imageUrl?: string;
          surfaceMarkup?: string;
          errorCode?: string;
          message?: string;
        };
        if (st.status === 'done') {
          setImageUrl(st.imageUrl ?? null);
          setPhase('done');
          try {
            window.sessionStorage.removeItem(ssKey);
          } catch {
            /* ignore */
          }
          // Persist: ChatShell replaces this card with the image bubble.
          if (st.surfaceMarkup) {
            window.dispatchEvent(
              new CustomEvent('lazyos:image-gen-done', {
                detail: { token: props.token, surfaceMarkup: st.surfaceMarkup },
              }),
            );
          }
          window.clearInterval(tick);
          return;
        }
        if (st.status === 'error') {
          setBusy(st.errorCode === 'busy');
          throw new Error(
            st.errorCode === 'busy'
              ? 'Es läuft gerade schon eine Bild-Generierung — kurz warten.'
              : st.errorCode === 'no-image'
                ? 'Kein Bild erzeugt — formuliere den Wunsch konkreter.'
                : st.message ?? 'Generierung fehlgeschlagen.',
          );
        }
      }
      throw new Error('Zeitüberschreitung.');
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
      setPhase('error');
      try {
        window.sessionStorage.removeItem(ssKey);
      } catch {
        /* ignore */
      }
    } finally {
      window.clearInterval(tick);
    }
  }, [props.prompt, props.workspace, props.token, ssKey]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void run();
  }, [run]);

  // done → image bubble (until ChatShell does the swap; seamlessly identical).
  if (phase === 'done' && imageUrl) {
    return (
      <div className="lazyos-imggen lazyos-imggen--done">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUrl} alt={props.prompt} className="lazyos-imggen__img" loading="lazy" />
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="lazyos-imggen lazyos-imggen--error" role="group">
        <div className="lazyos-imggen__errtext">
          {busy ? 'Bild-Generierung läuft schon' : 'Bild fehlgeschlagen'}
        </div>
        <div className="lazyos-imggen__errsub">{errMsg}</div>
        <button
          type="button"
          className="lazyos-imggen__retry press"
          onClick={() => {
            startedRef.current = false;
            void run();
          }}
        >
          Erneut versuchen
        </button>
      </div>
    );
  }

  // starting / generating → animated shimmer (like Codex).
  return (
    <div className="lazyos-imggen lazyos-imggen--loading" role="group" aria-busy="true">
      <div className="lazyos-imggen__shimmer" aria-hidden />
      <div className="lazyos-imggen__caption">
        <span className="lazyos-imggen__dot" aria-hidden />
        {phase === 'starting' ? 'Bild wird gestartet …' : 'Bild wird erzeugt …'}
        {elapsed > 0 ? <span className="lazyos-imggen__elapsed"> · {elapsed}s</span> : null}
      </div>
      <div className="lazyos-imggen__prompt">{props.prompt}</div>
    </div>
  );
}

function renderImageGen(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const prompt = str(data.prompt);
  const workspace = str(data.workspace);
  const token = str(data.token);
  if (!prompt || !workspace || !token) return null;
  return <ImageGenCard prompt={prompt} workspace={workspace} token={token} />;
}

function renderFlowRecurrence(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const workstreamId = str(data.workstreamId);
  if (!workstreamId) return null;
  const seenRaw = data.seenCount;
  const stepRaw = data.stepCount;
  const seenCount = typeof seenRaw === 'number' ? seenRaw : Number(seenRaw) || 0;
  const stepCount = typeof stepRaw === 'number' ? stepRaw : Number(stepRaw) || 0;
  return (
    <FlowRecurrenceCard
      workstreamId={workstreamId}
      workspaceId={str(data.workspaceId)}
      title={str(data.title)}
      seenCount={seenCount}
      stepCount={stepCount}
      summary={str(data.summary)}
    />
  );
}

function renderMergeOffer(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const workstreamId = str(data.workstreamId);
  if (!workstreamId) return null;
  const filesRaw = Array.isArray(data.files) ? data.files : [];
  const files = filesRaw.filter((f): f is string => typeof f === 'string' && f.length > 0);
  const fileCount = num(data.fileCount) ?? files.length;
  return (
    <MergeOfferCard
      workstreamId={workstreamId}
      runBranch={str(data.runBranch)}
      files={files}
      fileCount={fileCount}
      workstreamName={str(data.workstreamName) ?? str(data.name)}
    />
  );
}

const mergeOfferCardStyle: React.CSSProperties = {
  background: 'var(--sheet-1, #0A0A0B)',
  border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
  borderRadius: 16,
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  maxWidth: 600,
};

function MergeOfferCard({
  workstreamId,
  runBranch,
  files,
  fileCount,
  workstreamName,
}: {
  workstreamId: string;
  runBranch?: string;
  files: string[];
  fileCount: number;
  workstreamName?: string;
}): ReactNode {
  const [state, setState] = useState<
    'idle' | 'previewing' | 'merging' | 'merged' | 'conflict' | 'discarded' | 'error'
  >('idle');
  const [error, setError] = useState<string | null>(null);
  const [mergedSha, setMergedSha] = useState<string | null>(null);
  // Diff preview: additional files the server returns on preview
  // (overrides the optimistic payload list, if present).
  const [previewFiles, setPreviewFiles] = useState<string[] | null>(null);

  const endpoint = `/api/workstreams/${encodeURIComponent(workstreamId)}/merge-run`;

  const shownFiles = previewFiles ?? files;
  const shownCount = previewFiles ? previewFiles.length : fileCount;

  const doPreview = async (): Promise<void> => {
    if (state === 'previewing' || state === 'merging') return;
    setState('previewing');
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ preview: true }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        files?: unknown;
        error?: string;
        message?: string;
        hint?: string;
      };
      if (!res.ok || body.ok === false) {
        setError(body.hint ?? body.message ?? body.error ?? `HTTP ${res.status}`);
        setState('error');
        return;
      }
      const pf = Array.isArray(body.files)
        ? body.files.filter((f): f is string => typeof f === 'string')
        : null;
      if (pf) setPreviewFiles(pf);
      setState('idle');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState('error');
    }
  };

  const doMerge = async (): Promise<void> => {
    if (state === 'merging' || state === 'previewing') return;
    setState('merging');
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        merged?: boolean;
        sha?: string;
        conflict?: string;
        error?: string;
        message?: string;
        hint?: string;
      };
      if (res.status === 409 || body.merged === false) {
        setError(body.conflict ?? 'Merge-Konflikt — Live blieb unverändert.');
        setState('conflict');
        return;
      }
      if (!res.ok || body.ok === false) {
        setError(body.hint ?? body.message ?? body.error ?? `HTTP ${res.status}`);
        setState('error');
        return;
      }
      setMergedSha(str(body.sha) ?? null);
      setState('merged');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState('error');
    }
  };

  // --- resolved state: merge successful -----------------------------------
  if (state === 'merged') {
    return (
      <div
        data-test="surface-merge-offer"
        data-state="merged"
        role="status"
        style={{ ...mergeOfferCardStyle, borderLeft: '2px solid var(--a-now, #c9ff4d)' }}
      >
        <div style={flowCouplingKickerStyle}>Gemergt</div>
        <div
          style={{
            fontSize: 15.5,
            fontWeight: 600,
            color: 'var(--ink, #F5F5F7)',
            letterSpacing: '-0.01em',
          }}
        >
          In Live gemergt — {shownCount} {shownCount === 1 ? 'Datei' : 'Dateien'}.
        </div>
        <div style={{ fontSize: 13, color: 'var(--ink-2, #A1A1A6)', lineHeight: 1.5 }}>
          {mergedSha
            ? `Live-Checkout aktualisiert (${mergedSha.slice(0, 10)}).`
            : 'Live-Checkout aktualisiert.'}
        </div>
      </div>
    );
  }

  if (state === 'discarded') {
    return (
      <div
        data-test="surface-merge-offer"
        data-state="discarded"
        role="status"
        style={mergeOfferCardStyle}
      >
        <div style={flowCouplingKickerStyle}>Verworfen</div>
        <div style={{ fontSize: 13.5, color: 'var(--ink-2, #A1A1A6)', lineHeight: 1.5 }}>
          Der Run-Branch wurde nicht gemergt. Die Arbeit bleibt im Branch
          {runBranch ? ` ${runBranch}` : ''} erhalten.
        </div>
      </div>
    );
  }

  const busy = state === 'merging' || state === 'previewing';

  return (
    <div
      data-test="surface-merge-offer"
      data-state={state}
      role="group"
      aria-label="Merge-Offer"
      style={mergeOfferCardStyle}
    >
      <div style={flowCouplingKickerStyle}>Build fertig</div>
      <div
        style={{
          fontSize: 16,
          fontWeight: 600,
          color: 'var(--ink, #F5F5F7)',
          letterSpacing: '-0.01em',
          lineHeight: 1.35,
        }}
      >
        Build fertig — {shownCount} {shownCount === 1 ? 'Datei' : 'Dateien'} bereit
        {workstreamName ? ` (${workstreamName})` : ''}
      </div>
      {runBranch ? (
        <div
          data-test="merge-offer-branch"
          style={{
            fontSize: 12,
            color: 'var(--ink-3, #636366)',
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
          }}
        >
          {runBranch}
        </div>
      ) : null}

      {shownFiles.length > 0 ? (
        <ul
          data-test="merge-offer-files"
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            maxHeight: 220,
            overflowY: 'auto',
          }}
        >
          {shownFiles.map((f) => (
            <li
              key={f}
              data-test="merge-offer-file"
              style={{
                fontSize: 12.5,
                color: 'var(--ink-2, #A1A1A6)',
                fontFamily:
                  'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {f}
            </li>
          ))}
        </ul>
      ) : null}

      {error ? (
        <div
          data-test="merge-offer-error"
          role="alert"
          style={{
            fontSize: 12.5,
            color:
              state === 'conflict'
                ? 'var(--a-warn, #FFD60A)'
                : 'var(--a-danger, #FF453A)',
            lineHeight: 1.5,
          }}
        >
          {error}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {/* Write action — the ONLY one. Brand accent only here (Jobs/Rams). */}
        <button
          type="button"
          data-test="merge-offer-merge-btn"
          data-endpoint={endpoint}
          className="press"
          disabled={busy}
          onClick={() => void doMerge()}
          style={{
            minHeight: 44,
            padding: '10px 18px',
            borderRadius: 999,
            border: 'none',
            background: 'var(--a-now, #c9ff4d)',
            color: 'var(--screen, #061417)',
            fontSize: 13.5,
            fontWeight: 600,
            cursor: busy ? 'not-allowed' : 'pointer',
            opacity: busy ? 0.7 : 1,
          }}
        >
          {state === 'merging' ? 'Merge läuft …' : 'In Live mergen'}
        </button>
        {/* read-only diff preview. */}
        <button
          type="button"
          data-test="merge-offer-diff-btn"
          className="press"
          disabled={busy}
          onClick={() => void doPreview()}
          style={{
            minHeight: 44,
            padding: '10px 18px',
            borderRadius: 999,
            border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
            background: 'transparent',
            color: 'var(--ink, #F5F5F7)',
            fontSize: 13.5,
            cursor: busy ? 'not-allowed' : 'pointer',
          }}
        >
          {state === 'previewing' ? 'Lädt Diff …' : 'Diff ansehen'}
        </button>
        {/* purely local — no write call. */}
        <button
          type="button"
          data-test="merge-offer-discard-btn"
          className="press"
          disabled={busy}
          onClick={() => setState('discarded')}
          style={{
            minHeight: 44,
            padding: '10px 18px',
            borderRadius: 999,
            border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
            background: 'transparent',
            color: 'var(--ink-2, #A1A1A6)',
            fontSize: 13.5,
            cursor: busy ? 'not-allowed' : 'pointer',
          }}
        >
          Verwerfen
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// R4 (2026-05-29) — decision brief (prompt variant=decision-brief).
//
// Surface-manifestation strategy §7.3: a decision from communication/
// meeting/chat as a confirmable object — what was said, by whom, source,
// confidence, consequence, options. event-only behavior (Rule 4 „Evidence
// not equal Decision"): a click plays back structured data without an additional
// reply-routing duplicate.
//
// Payload:
//   { variant:'decision-brief', headline, statement?, source?, sourceBy?,
//     confidence? (0..1 | 'low'|'medium'|'high'), consequence?,
//     options:[{id,label,sublabel?,recommended?}], behavior? }.
// ---------------------------------------------------------------------------

interface DecisionBriefOpt {
  id: string;
  label: string;
  sublabel?: string;
  recommended?: boolean;
}

function confidenceLabel(v: unknown): string | undefined {
  const n = num(v);
  if (typeof n === 'number') {
    const pct = n <= 1 ? Math.round(n * 100) : Math.round(n);
    return `${pct}%`;
  }
  const s = str(v);
  if (s === 'low') return 'niedrig';
  if (s === 'medium') return 'mittel';
  if (s === 'high') return 'hoch';
  return s;
}

function renderDecisionBrief(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const headline = str(data.headline) ?? str(data.statement);
  if (!headline) return null;
  const optsRaw = Array.isArray(data.options) ? data.options : [];
  const options: DecisionBriefOpt[] = [];
  let idx = 0;
  for (const o of optsRaw) {
    if (!isObject(o)) {
      idx += 1;
      continue;
    }
    const label = str(o.label);
    if (!label) {
      idx += 1;
      continue;
    }
    options.push({
      id: str(o.id) ?? `opt-${idx}`,
      label,
      sublabel: str(o.sublabel),
      recommended: o.recommended === true,
    });
    idx += 1;
  }
  if (options.length === 0) {
    // Default: confirm/reject.
    options.push({ id: 'confirm', label: 'Bestätigen', recommended: true });
    options.push({ id: 'reject', label: 'Ablehnen' });
  }
  const rawBehavior = (data as { behavior?: unknown }).behavior;
  const eventOnly = rawBehavior !== 'reply-and-event'; // default: event-only.
  return (
    <DecisionBriefCard
      headline={headline}
      statement={str(data.statement)}
      source={str(data.source)}
      sourceBy={str(data.sourceBy) ?? str(data.by)}
      confidence={confidenceLabel(data.confidence)}
      consequence={str(data.consequence)}
      options={options}
      eventOnly={eventOnly}
    />
  );
}

function DecisionBriefCard({
  headline,
  statement,
  source,
  sourceBy,
  confidence,
  consequence,
  options,
  eventOnly,
}: {
  headline: string;
  statement?: string;
  source?: string;
  sourceBy?: string;
  confidence?: string;
  consequence?: string;
  options: DecisionBriefOpt[];
  eventOnly: boolean;
}): ReactNode {
  const { reply } = useSurfaceAction();
  const [chosen, setChosen] = useState<string | null>(null);

  const onPick = (opt: DecisionBriefOpt): void => {
    if (chosen) return;
    setChosen(opt.id);
    // event-only: no additional reply-routing duplicate. In the default mode
    // (event-only) we emit NO reply bubble — the structured
    // decision becomes visible solely via the data-chosen state. Only in the
    // explicitly requested reply-and-event mode does a reply go out.
    if (!eventOnly) {
      reply(`Entscheidung: ${opt.label} — ${headline}`);
    }
  };

  const metaRow = (lbl: string, val?: string, testId?: string): ReactNode =>
    val ? (
      <div
        data-test={testId}
        style={{ display: 'flex', gap: 8, fontSize: 12.5, lineHeight: 1.5 }}
      >
        <span style={{ color: 'var(--ink-3, #636366)', minWidth: 88 }}>{lbl}</span>
        <span style={{ color: 'var(--ink-2, #A1A1A6)' }}>{val}</span>
      </div>
    ) : null;

  return (
    <div
      data-test="surface-decision-brief"
      data-behavior={eventOnly ? 'event-only' : 'reply-and-event'}
      data-chosen={chosen ?? ''}
      role="group"
      aria-label="Entscheidungs-Brief"
      style={{
        background: 'var(--sheet-1, #0A0A0B)',
        border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
        borderLeft: '2px solid var(--a-now, #c9ff4d)',
        borderRadius: 16,
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        maxWidth: 600,
      }}
    >
      <div style={flowCouplingKickerStyle}>Entscheidung</div>
      <div
        style={{
          fontSize: 15.5,
          fontWeight: 600,
          color: 'var(--ink, #F5F5F7)',
          letterSpacing: '-0.01em',
          lineHeight: 1.35,
        }}
      >
        {headline}
      </div>
      {statement && statement !== headline ? (
        <div
          data-test="decision-brief-statement"
          style={{ fontSize: 13.5, color: 'var(--ink-2, #A1A1A6)', lineHeight: 1.5 }}
        >
          {statement}
        </div>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {metaRow('Quelle', source, 'decision-brief-source')}
        {metaRow('Von', sourceBy, 'decision-brief-by')}
        {metaRow('Confidence', confidence, 'decision-brief-confidence')}
        {metaRow('Konsequenz', consequence, 'decision-brief-consequence')}
      </div>

      <div
        data-test="decision-brief-options"
        style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 2 }}
      >
        {options.map((opt) => {
          const picked = chosen === opt.id;
          const isPrimary = opt.recommended;
          return (
            <button
              key={opt.id}
              type="button"
              data-test="decision-brief-option"
              data-option-id={opt.id}
              data-recommended={opt.recommended ? 'true' : 'false'}
              className="press"
              disabled={chosen !== null}
              onClick={() => onPick(opt)}
              style={{
                minHeight: 44,
                padding: '10px 18px',
                borderRadius: 999,
                border: isPrimary
                  ? 'none'
                  : '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
                background: isPrimary
                  ? 'var(--a-now, #c9ff4d)'
                  : 'transparent',
                color: isPrimary ? 'var(--screen, #061417)' : 'var(--ink, #F5F5F7)',
                fontSize: 13.5,
                fontWeight: isPrimary ? 600 : 500,
                cursor: chosen !== null ? 'default' : 'pointer',
                opacity: chosen !== null && !picked ? 0.5 : 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 2,
              }}
            >
              <span>{opt.label}</span>
              {opt.sublabel ? (
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 400,
                    color: isPrimary
                      ? 'var(--screen, #061417)'
                      : 'var(--ink-3, #636366)',
                  }}
                >
                  {opt.sublabel}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A3/R7 (2026-05-29) — project-truth surface (long-lived read anchor).
//
// Surface-manifestation strategy §7.2: shows the currently secured
// project truth ACROSS runs — vision, decisions, beliefs,
// open-unknowns, contradictions. ONE card per workspace (idempotent via
// subKey='project-truth'). NOT interactive (read anchor), but collapsible.
//
// Payload:
//   { workspaceId?, workstreamId?, vision?,
//     decisions?:[{text}|string], beliefs?:[{text,confidence?}|string],
//     openUnknowns?:string[], contradictions?:[{text}|string], updatedAt? }.
// ---------------------------------------------------------------------------

interface TruthItem {
  text: string;
  meta?: string;
}

function toTruthItems(v: unknown): TruthItem[] {
  if (!Array.isArray(v)) return [];
  const out: TruthItem[] = [];
  for (const x of v) {
    if (typeof x === 'string') {
      if (x.trim().length > 0) out.push({ text: x });
      continue;
    }
    if (isObject(x)) {
      const text = str(x.text) ?? str(x.label) ?? str(x.q);
      if (!text) continue;
      const conf = confidenceLabel(x.confidence);
      out.push({ text, meta: conf ? `Confidence ${conf}` : str(x.source) });
    }
  }
  return out;
}

function renderProjectTruth(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const vision = str(data.vision);
  const decisions = toTruthItems(data.decisions);
  const beliefs = toTruthItems(data.beliefs);
  const openUnknowns = toTruthItems(data.openUnknowns ?? data.open_unknowns);
  const contradictions = toTruthItems(data.contradictions);
  // Empty anchor → render nothing (no empty frame).
  if (
    !vision &&
    decisions.length === 0 &&
    beliefs.length === 0 &&
    openUnknowns.length === 0 &&
    contradictions.length === 0
  ) {
    return null;
  }
  return (
    <ProjectTruthCard
      vision={vision}
      decisions={decisions}
      beliefs={beliefs}
      openUnknowns={openUnknowns}
      contradictions={contradictions}
      updatedAt={str(data.updatedAt) ?? str(data.updated_at)}
    />
  );
}

function ProjectTruthSection({
  title,
  items,
  testId,
  accent,
}: {
  title: string;
  items: TruthItem[];
  testId: string;
  accent?: string;
}): ReactNode {
  if (items.length === 0) return null;
  return (
    <div data-test={testId} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div
        style={{
          fontSize: 11.5,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: accent ?? 'var(--ink-3, #636366)',
        }}
      >
        {title}
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
        {items.map((it, i) => (
          <li
            key={`${testId}-${i}`}
            data-test={`${testId}-item`}
            style={{
              fontSize: 13,
              color: 'var(--ink-2, #A1A1A6)',
              lineHeight: 1.5,
              display: 'flex',
              gap: 8,
            }}
          >
            <span style={{ color: accent ?? 'var(--ink-3, #636366)', flexShrink: 0 }}>•</span>
            <span>
              {it.text}
              {it.meta ? (
                <span style={{ color: 'var(--ink-3, #636366)', marginLeft: 6, fontSize: 11.5 }}>
                  {it.meta}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProjectTruthCard({
  vision,
  decisions,
  beliefs,
  openUnknowns,
  contradictions,
  updatedAt,
}: {
  vision?: string;
  decisions: TruthItem[];
  beliefs: TruthItem[];
  openUnknowns: TruthItem[];
  contradictions: TruthItem[];
  updatedAt?: string;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);

  const totalDetail =
    decisions.length + beliefs.length + openUnknowns.length + contradictions.length;

  return (
    <div
      data-test="surface-project-truth"
      data-expanded={expanded ? 'true' : 'false'}
      role="region"
      aria-label="Projekt-Wahrheit"
      style={{
        background: 'var(--sheet-1, #0A0A0B)',
        border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
        borderLeft: '2px solid var(--a-now, #c9ff4d)',
        borderRadius: 16,
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        maxWidth: 640,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <span
          style={{
            fontSize: 14.5,
            fontWeight: 600,
            letterSpacing: '-0.01em',
            color: 'var(--ink, #F5F5F7)',
          }}
        >
          Projekt-Wahrheit
        </span>
        {updatedAt ? (
          <span style={{ fontSize: 11.5, color: 'var(--ink-3, #636366)' }}>{updatedAt}</span>
        ) : null}
      </div>

      {vision ? (
        <div
          data-test="project-truth-vision"
          style={{
            fontSize: 14,
            color: 'var(--ink, #F5F5F7)',
            lineHeight: 1.5,
            fontWeight: 500,
          }}
        >
          {vision}
        </div>
      ) : null}

      {/* Decisions are always visible (the most important anchor). */}
      <ProjectTruthSection
        title="Decisions"
        items={decisions}
        testId="project-truth-decisions"
      />

      {/* Beliefs also directly visible. */}
      <ProjectTruthSection
        title="Beliefs"
        items={beliefs}
        testId="project-truth-beliefs"
      />

      {/* Open-Unknowns directly visible (open points are action-guiding). */}
      <ProjectTruthSection
        title="Open Unknowns"
        items={openUnknowns}
        testId="project-truth-open-unknowns"
        accent="var(--a-warn, #FFD60A)"
      />

      {/* Contradictions only in the expanded detail (red accent). */}
      {expanded ? (
        <ProjectTruthSection
          title="Widersprüche"
          items={contradictions}
          testId="project-truth-contradictions"
          accent="var(--a-danger, #FF453A)"
        />
      ) : null}

      {totalDetail > 0 ? (
        <button
          type="button"
          data-test="project-truth-toggle"
          className="press"
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
          style={{
            alignSelf: 'flex-start',
            minHeight: 44,
            padding: '8px 0',
            border: 'none',
            background: 'transparent',
            color: 'var(--ink-3, #636366)',
            fontSize: 12.5,
            cursor: 'pointer',
          }}
        >
          {expanded
            ? 'Weniger anzeigen'
            : contradictions.length > 0
              ? `Mehr Details ausklappen (${contradictions.length} Widerspr${contradictions.length === 1 ? 'uch' : 'üche'})`
              : 'Mehr Details ausklappen'}
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public dispatcher
// ---------------------------------------------------------------------------

export function renderSurface(kind: SurfaceKind, data: unknown): ReactNode {
  switch (kind) {
    case 'chart':
      return renderChart(data);
    case 'decision':
      return renderDecision(data);
    case 'ticket':
      return renderTicket(data);
    case 'invoice':
      return renderInvoice(data);
    case 'pipeline':
      return renderPipeline(data);
    case 'toast':
      return renderToast(data);
    case 'quickchoice':
      return renderQuickChoice(data);
    case 'approval':
      return renderApproval(data);
    case 'terminal':
      return renderTerminal(data);
    case 'heartbeat':
      return renderHeartbeat(data);
    case 'workspace':
      return renderWorkspace(data);
    case 'routine':
      return renderRoutine(data);
    case 'agent':
      return renderAgent(data);
    case 'swarm':
      return renderSwarm(data);
    case 'tier-choice':
      return renderTierChoice(data);
    case 'live-swarm':
      return renderLiveSwarm(data);
    case 'milestone':
      return renderMilestone(data);
    case 'preview':
      return renderPreview(data);
    case 'workflow-pipeline':
      return renderWorkflowPipeline(data);
    case 'credential-prompt':
      return renderCredentialPrompt(data);
    case 'form':
      return renderForm(data);
    case 'consensus-action':
      return renderConsensusAction(data);
    case 'live-pipeline':
      return renderLivePipeline(data);
    case 'iterate-pipeline':
      return renderIteratePipeline(data);
    case 'sub-workstreams':
      return renderSubWorkstreams(data);
    case 'document':
      return renderDocument(data);
    case 'folder':
      return renderFolder(data);
    case 'cloud-browser':
      return renderCloudBrowser(data);
    case 'rate-limit-retry':
      return renderRateLimitRetry(data);
    case 'open-questions':
      return renderOpenQuestions(data);
    case 'bug-fix-swarm':
      return renderBugFixSwarm(data);
    case 'bug-fix-pipeline':
      return renderBugFixPipeline(data);
    case 'loop-phase':
      return renderLoopPhase(data);
    case 'iterate-roast':
      return renderIterateRoast(data);
    case 'iterate-version':
      return renderIterateVersion(data);
    case 'user-correction':
      return renderUserCorrection(data);
    case 'plan-open-questions':
      return renderPlanOpenQuestionsCard(data);
    // Sub-Plan 3 · cluster merges (2026-05-01) — canonical targets
    case 'workflow':
      return renderWorkflow(data);
    case 'prompt':
      return renderPrompt(data);
    case 'agent-step':
      return renderAgentStep(data);
    // BACKPORT-03 (2026-05-23) — Plan-First V2 surfaces.
    case 'subplan':
      return renderSubplan(data);
    // BACKPORT-02 (2026-05-23) — subagent-fleet view.
    case 'subagent-fleet':
      return renderSubagentFleet(data);
    // ACL5-B (2026-05-24) — credential-request surface.
    // SECURITY: surface payload NO secret; secret only via POST /api/connectors/[provider]/credential.
    case 'credential-request':
      return renderCredentialRequest(data);
    // ACL5-E (2026-05-24) — connector-call-preview surface.
    // Approve action → POST /api/connectors/invoke. No secret in the payload.
    case 'connector-call-preview':
      return renderConnectorCallPreview(data);
    // P1-#5 (2026-05-25) — Connector-Onboarding-Progress-Surface.
    // Shows workstreamId / planId / stepCount / status for dispatched onboarding SOP.
    // TODO(Wave-3): render a real progress card; for now fall through to null.
    case 'onboarding-progress':
      return null;
    // A1 (2026-05-25) — permission-setup surface.
    // SECURITY: no secret fields. PATCH route is auth-gated.
    case 'permission-setup':
      return renderPermissionSetup(data);
    // Flow Studio P3 (2026-05-27) — visual flow-graph surface (custom SVG).
    // Pure rendering; live wiring (flow_steps/plan-step status) follows later.
    case 'flow-graph':
      return renderFlowGraph(data);
    // Self-learning workflow recording (2026-06-03, Slice 1) — recurrence nudge.
    case 'flow-recurrence':
      return renderFlowRecurrence(data);
    // Image generation (2026-06-03) — self-driving animated loading surface.
    case 'image-gen':
      return renderImageGen(data);
    // Flow Studio P-now (2026-05-27) — tool-coupling surface.
    // SECURITY: surface payload NO secret; secret only via CredentialRequestCard
    // → POST /api/connectors/[provider]/credential. „Flow starten" → POST
    // /api/flow/[flowId]/run {workspaceId}.
    case 'flow-coupling':
      return renderFlowCoupling(data);
    // Stream X1 (2026-05-28) — one-time LIVE-mode warn surface.
    // The owner acknowledgement is stored in workspace_beliefs (topic='live-warn-acked').
    // Payload schema: { workspaceId }.
    case 'live-warn':
      return renderLiveWarn(data);
    // E4 — Devil's Advocate / counter-evidence (P13, 2026-05-27). Its own
    // card AFTER the synthesis (gated), NOT mixed into the synthesis
    // stream. Red flag when the thesis is not falsifiable.
    case 'counter-evidence':
      return renderCounterEvidence(data);
    // Owner fix run-cockpit (2026-05-28) — aggregated master surface that
    // bundles the simultaneous emission of sub-workstreams + iterate-pipeline +
    // iterate-version into ONE trackable card. Mount
    // registers the coord key in the RunCockpitRegistry → the 3 legacy cards
    // suppress themselves as long as the cockpit card lives in the stream.
    case 'run-cockpit':
      return renderRunCockpit(data);
    // Slice C (2026-05-29) — discovery phase BEFORE plan decompose.
    // SECURITY: no secret in the payload; WebFetch only on public URLs explicitly
    // named by the owner (N2 untouched).
    case 'discovery':
      return renderDiscovery(data);
    // A4 (2026-05-29) — merge-offer surface (clickable operator merge gate).
    // „In Live mergen" → POST /api/workstreams/[id]/merge-run {} is the
    // ONLY write action (R3 human gate). „Diff ansehen" is read-only.
    // SECURITY: no secret in the payload.
    case 'merge-offer':
      return renderMergeOffer(data);
    // A3/R7 (2026-05-29) — project-truth surface (long-lived read anchor).
    // Bundles vision/decisions/beliefs/open-unknowns/contradictions; non-
    // interactive, collapsible. SECURITY: no secret in the payload.
    case 'project-truth':
      return renderProjectTruth(data);
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Manifestation-layer helper (owner request 2026-05-30)
// ---------------------------------------------------------------------------
//
// Owner request (near-verbatim): „Surface/Manifestation-Layer-Helper oder so, der
// ggf. korrigiert oder wenn etwas nicht visualisiert wird, dass man direkt neues
// Surface generieren drücken kann mit einem Icon Magic-Stift was weiß ich?!"
//
// `renderSurfaceOrHelper` is the ONE place that the render path
// (surface-text-render.tsx) calls at the non-render point. It tries the
// normal rendering and replaces the old naked tag-text fallback with the
// Magic-Wand affordance (`SurfaceHelperAffordance`) as soon as NOTHING visible
// came out — the three real non-render cases:
//
//   • render-null   — `renderSurface(kind, data)` returned `null` (payload
//                     incomplete/empty, or a not-yet-implemented
//                     kind like 'onboarding-progress').
//   • parse-error   — `data === null` signals that the surface JSON
//                     could not be parsed (the caller sets data=null).
//   • unknown-kind  — the kind is not in the SURFACE_KINDS whitelist.
//
// Additive & minimally invasive: existing render paths are untouched — this
// function is called ONLY in the else branch (non-render) of the two renderChatText
// variants.

import { SurfaceHelperAffordance } from './SurfaceHelperAffordance';

function isKnownSurfaceKind(kind: string): kind is SurfaceKind {
  return (SURFACE_KINDS as readonly string[]).includes(kind);
}

/**
 * Renders a surface — and on non-render the Magic-Wand affordance instead
 * of the naked tag text. `data === null` is interpreted as a parse error
 * (the caller sets data=null when JSON.parse failed).
 *
 * @param kind  the (possibly unknown) surface kind as a raw string
 * @param data  parsed payload, or `null` on a parse error
 * @param raw   the raw `<surface:…>…</surface:…>` tag (context for re-gen)
 */
export function renderSurfaceOrHelper(
  kind: string,
  data: unknown,
  raw: string,
): ReactNode {
  // (c) unknown-kind — not whitelisted.
  if (!isKnownSurfaceKind(kind)) {
    return (
      <SurfaceHelperAffordance reason="unknown-kind" kind={kind} raw={raw} />
    );
  }
  // (b) parse-error — the caller signals via data === null.
  if (data === null) {
    return (
      <SurfaceHelperAffordance reason="parse-error" kind={kind} raw={raw} />
    );
  }
  // Normal path.
  let rendered: ReactNode = null;
  try {
    rendered = renderSurface(kind, data);
  } catch {
    rendered = null;
  }
  if (rendered != null) return rendered;
  // (a) render-null — the renderer returned nothing visible.
  return <SurfaceHelperAffordance reason="render-null" kind={kind} raw={raw} />;
}
