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
import { OpenQuestionsSurface } from './OpenQuestionsSurface';
import { ChatInlineOpenQuestions } from './ChatInlineOpenQuestions';
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
// ACL5-B (2026-05-24) — Credential-Request-Surface.
import { CredentialRequestCard } from './CredentialRequestCard';
// ACL5-E (2026-05-24) — Connector-Call-Preview-Surface.
import { ConnectorCallPreviewCard } from './ConnectorCallPreviewCard';
// A1 (2026-05-25) — Permission-Setup-Surface.
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
// W2.2 (2026-05-30): aktionierbare Flow-Knoten → DERSELBE Submit-Pfad wie der
// ActionDeck-Pin. `executeGateAction` klickt die echte Stream-Card-Aktion (ein
// POST, kein zweites Routing); `BlockingGateKind` ist das Gate-Vokabular.
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

/** className-Joiner (falsy → weggefiltert). */
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
// Run-Cockpit Suppress-Registry (Owner-Fix 2026-05-28).
//
// Wenn fuer einen (workspaceId, workstreamId) bereits eine
// `<surface:run-cockpit>`-Card aktiv ist, sollen die drei alten Sub-Cards
// (`sub-workstreams`, `iterate-pipeline`, `iterate-version`) NICHT mehr im
// Strom auftauchen — die Cockpit-Card bundelt sie sichtbar in EINER Surface.
//
// Cross-Message-Koordination: jede chat_message_completed-Event rendert eine
// eigene Bubble; das suppress-Wissen muss ueber alle Bubbles hinweg geteilt
// werden. Wir nutzen daher einen React-Context der ein lebendes Set von
// `coordKey` (= `workspaceId/workstreamId`) traegt. Die RunCockpitCard
// registriert sich beim Mount via `useEffect` und unregisters beim Unmount;
// die suppressible Surfaces fragen via `useRunCockpitActive(coordKey)` ab und
// rendern `null`, wenn der Coord aktiv ist.
//
// Provider-frei: ohne Provider liefert `useRunCockpitActive` immer `false`
// (Back-Compat — Tests/Voice/API-Konsumenten ohne Provider sehen die alten
// Cards unveraendert). Mounten muss ChatShell den Provider — in der unrelated
// Test-Umgebung bleibt das Verhalten bit-identisch.
//
// SECURITY: das Set traegt nur Coord-Strings (workspaceId+workstreamId aus
// Surface-Payloads — beide werden bereits broadcast emittiert), kein Secret.
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
 * Pre-Pass-Provider — markiert die Coord-Keys, fuer die im aktuellen Stream
 * bereits eine run-cockpit-Surface aktiv ist. Beim Mount der RunCockpitCard
 * wird sein `coordKey` registriert; die drei Legacy-Surfaces fragen via
 * `useRunCockpitActive` ab und supprimieren sich selbst.
 *
 * Wird in ChatShell oberhalb des Surface-Renderings gemountet. Ohne Provider
 * funktioniert die Suppression-Logik nicht — die alten Cards bleiben dann
 * sichtbar (Back-Compat fuer Tests und externe Renderer).
 *
 * Implementations-Hinweis (Owner-Fix 2026-05-28): register/unregister
 * referenzieren das aktuelle `setActive` ueber `useCallback` mit konstanter
 * Deps-Liste (`[]`) — der Provider-Wert behaelt stabile Funktions-
 * Referenzen. Das ist wichtig, damit `useRunCockpitRegistration` NICHT in
 * einer Endlos-Re-Render-Schleife landet (register-Aufruf → setActive →
 * neuer Context-Value → useEffect re-runs → register-Aufruf).
 */
export function RunCockpitRegistryProvider({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  const [active, setActive] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  // Stable Function-Refs: useCallback mit konstanter Deps-Liste damit der
  // Provider-Value identisch bleibt, solange sich `active` nicht aendert.
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
    // active aendert sich bei jedem register/unregister → Suppression-
    // Consumer rendern neu. register/unregister sind stabil (siehe oben).
    [active, register, unregister],
  );

  return (
    <RunCockpitRegistryContext.Provider value={value}>
      {children}
    </RunCockpitRegistryContext.Provider>
  );
}

/**
 * Liefert true, wenn fuer den uebergebenen Coord-Key
 * (`workspaceId/workstreamId`) eine run-cockpit-Surface bereits aktiv ist.
 * Provider-frei: ohne Provider immer false (Legacy-Cards rendern weiter).
 */
function useRunCockpitActive(coordKey: string | null): boolean {
  const ctx = useContext(RunCockpitRegistryContext);
  if (!ctx || !coordKey) return false;
  return ctx.active.has(coordKey);
}

/**
 * Mount-Hook fuer die RunCockpitCard. Registriert ihren Coord-Key beim
 * Mount, unregisters beim Unmount. Provider-frei (ohne Provider: no-op).
 *
 * Deps: NUR `coordKey` (und die stabilen register/unregister-Refs aus dem
 * Provider) — der Context selbst kommt aus useContext aber wird NICHT in
 * deps gepackt, sonst gibt es Endlos-Re-Render. Stattdessen lesen wir
 * register/unregister einmal beim Mount und nutzen sie im Cleanup.
 */
function useRunCockpitRegistration(coordKey: string | null): void {
  const ctx = useContext(RunCockpitRegistryContext);
  // Stable Funktions-Refs aus dem Provider → wir koennen sie als Effect-
  // Deps nutzen, ohne dass active-Change einen Re-Run triggert.
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

/** Helper: baut den Coord-Key aus zwei Strings. Gibt null wenn unvollstaendig. */
function buildCockpitCoordKey(
  workspaceId: string | undefined,
  workstreamId: string | undefined,
): string | null {
  if (!workspaceId || !workstreamId) return null;
  return `${workspaceId}/${workstreamId}`;
}

// ---------------------------------------------------------------------------
// F18 (2026-05-30) — Pinned-Decision-Registry.
//
// Owner-Direktive F18 (verbatim-nah): „Entscheidung benötigt / Gates IMMER
// unten über dem Chat angepinnt." Eine offene Decision/quickchoice wird jetzt
// von `projectWorkspaceState` als blockingGate erfasst → der ActionDeck pinnt
// sie unten. Damit es KEINE zwei lauten Kopien gibt (eine im Feed, eine
// gepinnt), markiert ChatShell die Headline der aktuell GEPINNTEN Decision in
// diesem Context; die in-feed `<surface:decision>`-/`<surface:quickchoice>`-
// Karte fragt via `useDecisionPinned(headline)` ab und rendert dann eine
// RUHIGE Referenz (collapsed, nicht-aktionierbar, N8-Beleg) statt der lauten
// Karte. So bleibt der Verlauf erhalten, ohne den Owner doppelt anzuspringen.
//
// Provider-frei (Back-Compat): ohne Provider liefert `useDecisionPinned` immer
// false → die in-feed-Karte rendert unverändert laut (Tests/Voice/externe
// Renderer ohne ChatShell-Provider sehen das alte Verhalten bit-identisch).
//
// SECURITY: das Set trägt nur die verbatim Decision-Headline (bereits
// broadcastete Surface-Payload), kein Secret.
// ---------------------------------------------------------------------------

interface PinnedDecisionRegistry {
  /** Verbatim-Headlines der aktuell GEPINNTEN Decisions (i.d.R. genau eine). */
  pinned: ReadonlySet<string>;
}

const PinnedDecisionRegistryContext =
  createContext<PinnedDecisionRegistry | null>(null);

/**
 * Provider — ChatShell mountet ihn oberhalb des Surface-Renderings und übergibt
 * die Headline der aktuell gepinnten Decision (aus `selectPinnedItem`). Die
 * in-feed Decision/QuickChoice-Karte mit derselben Headline supprimiert sich
 * dann zur ruhigen Referenz.
 */
export function PinnedDecisionRegistryProvider({
  pinnedHeadline,
  children,
}: {
  /** Headline der gepinnten Decision, oder null/undefined wenn keine. */
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
 * true, wenn eine in-feed Decision/QuickChoice mit dieser Headline aktuell
 * UNTEN gepinnt ist → die Feed-Karte rendert ruhig statt laut. Provider-frei:
 * ohne Provider immer false (Back-Compat).
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

  // F18: ist genau DIESE Decision aktuell unten gepinnt (ActionDeck)? Dann
  // rendert die Feed-Karte RUHIG (N8-Beleg/Referenz) statt laut — keine zwei
  // konkurrierenden Kopien. Provider-frei → false (Back-Compat: laute Karte).
  const pinned = useDecisionPinned(headline);

  // Genau eine empfohlene Option (deterministisch): server-markiert oder erste.
  const hasRecommended = options.some((o) => o.recommended);

  if (pinned) {
    // Ruhige Referenz: nicht-aktionierbar, collapsed. Der Owner agiert über den
    // gepinnten ActionDeck unten; hier bleibt nur der verbatim Beleg (N1/N8).
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
          {/* N1: verbatim Headline — CSS klemmt visuell, Text bleibt vollständig. */}
          <span className="srf-decision-ref-headline">{headline}</span>
        </span>
      </div>
    );
  }

  // Laute Karte (nicht gepinnt). data-test-Hooks am Wrapper + je Option, damit
  // der ActionDeck (executeGateAction) den ECHTEN Button klicken kann — EIN
  // Submit-Pfad (reply(label)), kein zweiter fetch.
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
          // Wenn der Server KEINE recommended-Option markiert hat, wird die
          // erste zur empfohlenen Primär-Aktion (deckungsgleich mit
          // extractGateOptions in der Projektion → Deck + Feed stimmen überein).
          recommended: o.recommended || (!hasRecommended && i === 0),
          onSelect: () => reply(o.label),
        }))}
        mode={options.length === 2 ? 'binary' : options.length === 1 ? 'confirm' : 'multi'}
      />
      {/* Test-/Deck-Hooks: pro Option ein data-test-Button, der DENSELBEN
          reply(label) auslöst wie die sichtbare .dopt-Zeile. Visuell verborgen
          (aria-hidden) — er ist NUR der programmatische Klick-Anker für
          executeGateAction; der Owner klickt die sichtbare Decision-Zeile.
          KEIN zweiter Submit-Pfad: beide Wege rufen exakt reply(label). */}
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
// Toast — variant + title + body. Klein, aber stark präsent.
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
// QuickChoice — 2-3 Buttons mit Primary + optional sublabels.
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
 * FIX (additiv, backward-compat):
 *   Neues Payload-Feld `behavior?: 'reply-and-event' | 'event-only'`.
 *   - 'reply-and-event' (Default) → bisheriges Verhalten, beides feuert.
 *     Backward-Compat für jeden bestehenden quickchoice-Caller, der KEIN
 *     `behavior` setzt.
 *   - 'event-only' → NUR dispatchEvent, KEIN reply(label). Verwendet von
 *     Callern wie Flow-Studio Medien-Stil-Wahl (lib/flow/media-styles.ts
 *     ::buildMediaStyleChoicePayload), wo das Re-Post an
 *     /api/flow/compose-and-run die alleinige Wahrheit ist und der zusätzliche
 *     Chat-Turn das Routing zerstören würde (Akzeptanz: „Klick auf Flow-Style-
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

  // F18: QuickChoice ist option-only (keine Headline). Die Projektion matcht
  // die gepinnte Decision über die Option-Label-Signatur (join ' · ') — wir
  // bilden hier dieselbe Signatur, damit sich die Feed-Karte ruhig stellt, wenn
  // GENAU diese QuickChoice unten gepinnt ist. Provider-frei → false.
  const signature = options.map((o) => o.label).join(' · ');
  const pinned = useDecisionPinned(signature);

  const hasPrimary = options.some((o) => o.primary);

  // Eine Option-Auswahl: behavior-Switch erhalten (event-only feuert NUR das
  // Window-Event, Default beides) — UNVERÄNDERT (Back-Compat, kein Doppel-Routing).
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
          {/* N1: verbatim Option-Labels als Beleg. */}
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
      {/* Test-/Deck-Hooks (aria-hidden, programmatischer Klick-Anker) — DENSELBEN
          select(o) wie die sichtbare Zeile. KEIN zweiter Submit-Pfad. */}
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
  // behavior aus dem Payload extrahieren — alles ausser dem expliziten
  // String 'event-only' fällt auf 'reply-and-event' zurück (Default,
  // Backward-Compat). Unbekannte Werte → Default (defensiv).
  const rawBehavior = (data as { behavior?: unknown }).behavior;
  const behavior: QuickChoiceBehavior =
    rawBehavior === 'event-only' ? 'event-only' : 'reply-and-event';
  return <QuickChoiceCard options={options} behavior={behavior} />;
}

// ---------------------------------------------------------------------------
// Approval — ticketId + title, rendered als Decision mit Approve/Reject.
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
// milestone — Apple-Keynote Completion-Card (Phase NEU)
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
  // P11 (2026-05-01): Synthesis-Cards bekommen optional auditId für
  // Source-Chip-Row im Footer. Mapper in event-to-surface.ts setzt das Feld.
  const auditId = str(data.auditId) ?? str(data.audit_id);
  // Apple-UX (2026-05-30): `variant: 'quiet'` für entprominenzierte Info-
  // Milestones (z.B. Plan-Synthese) — ruhige Info-Zeile statt Keynote-Card.
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
// preview — Fertigstellungs-/Deployment-Surface (2026-05-27).
// Große, handy-taugliche tippbare Karte: öffnet die (Tailscale-)Vorschau-URL
// im Browser (target=_blank → funktioniert am Smartphone). So bekommt der
// Owner nach einem Build sofort einen testbaren Link IM Chat.
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
// discovery — Recherche-Vorphase VOR Plan-Decompose (Slice C, 2026-05-29)
// ---------------------------------------------------------------------------
//
// Owner-Befund (verbatim, 2026-05-29): „Ich sehe niemanden der die Website
// recherchiert oder sich ansieht, da müsste doch eine Art Browser Bash erstmal
// kommen usw oder nicht?! Analyse, Recherche…". plan-dispatch fetcht jetzt
// vom Owner referenzierte URLs VOR dem Decompose; diese Card zeigt den Fort-
// schritt + die Snapshot-Titel + erkannte Doku-Anforderungen.
//
// Design:
//   - collapsed-default (1-Zeiler mit Domain-Liste + Status), expand-on-tap.
//   - Mobile-first: ≥44px Touch-Target am Header.
//   - Token-only (var(--…) mit Hex-Fallback wie renderPreview).
//   - „Dokument anfordern"-Anker pro pendingDocRequest (placeholder action;
//     der reale Endpoint folgt im Doku-Anforderungs-Slice — die Karte
//     bietet hier nur den UX-Anker, kein Submit).

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

/** Extracts the host of a fetched URL für die collapsed-Header-Liste. */
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

  // Header-Text: „Discovery · example-agency.example · example.com" oder „Discovery läuft …"
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
        {/* URL-Liste */}
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

        {/* Dokument-Anforderungs-Liste */}
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

        {/* Leer-Hinweis (nur wenn weder URLs noch Docs) */}
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
// form — Generic strukturierte Eingabe (Sub-Plan C, 2026-04-30)
// ---------------------------------------------------------------------------

function renderForm(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  // Schema-Validation passiert in FormPromptCard.tsx via validateFormSchema.
  // Hier nur ein minimaler Shape-Check, dann durchreichen — die Card
  // rendert eigene Error-States bei invalidem Schema.
  const title = str(data.title);
  const fields = Array.isArray(data.fields) ? data.fields : null;
  const endpoint = isObject(data.endpoint) ? data.endpoint : null;
  if (!title || !fields || !endpoint) return null;
  // Cast zu unbekanntem Schema — FormPromptCard validiert intern.
  return <FormPromptCard schema={data as unknown as FormSchema} />;
}

// ---------------------------------------------------------------------------
// credential-prompt — KI fragt nach API-Key, encrypted-storage Pfad
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
// workflow-pipeline — Live-Pipeline-Card im Chat (FSM-State live)
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
// rate-limit-retry — Phase RL.2 Auto-Retry-Toast bei Anthropic-TPM-Throttle
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
// consensus-action — Phase AC.3 Auto-Countdown / Quick-Start / Disagreement
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
  // Sub-Plan 04 (2026-04-29) — Outlier-Inline statt extern.
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
// iterate-pipeline — Sub-Plan 04 Welle 2 (2026-04-29) Phase=iterate
// Eine lebende Card pro Workstream während V1...V5. Pollt pause-status.
// ---------------------------------------------------------------------------

function renderIteratePipeline(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const workstreamId = str(data.workstreamId);
  const workspaceId = str(data.workspaceId);
  if (!workstreamId || !workspaceId) return null;
  const workstreamName = str(data.workstreamName) ?? str(data.name);
  const maxVersion = num(data.maxVersion) ?? num(data.max_version);
  // Owner-Fix 2026-05-28: Suppress wenn bereits eine Run-Cockpit-Card fuer
  // denselben (workspaceId, workstreamId) aktiv ist — die Cockpit-Card
  // bundelt die Iterate-Pipeline-Info. Wrapper-Komponente, weil Hooks im
  // pure-Renderer nicht erlaubt sind.
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
    // suppressed by run-cockpit (Owner-Fix 2026-05-28)
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
// sub-workstreams — Sprint C (2026-04-29). Tree-View aller Sub-Agents.
// ---------------------------------------------------------------------------

function renderSubWorkstreams(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const masterWorkstreamId =
    str(data.masterWorkstreamId) ?? str(data.workstreamId);
  const workspaceId = str(data.workspaceId);
  if (!masterWorkstreamId || !workspaceId) return null;
  // Owner-Fix 2026-05-28: Suppress wenn bereits eine Run-Cockpit-Card fuer
  // denselben (workspaceId, masterWorkstreamId) aktiv ist.
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
    // suppressed by run-cockpit (Owner-Fix 2026-05-28)
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
// live-pipeline — Phase WSC.1 Auto-Dispatch-Live-View im Chat
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
// live-swarm — live-updating Heatmap der Tier-Spawn-Aktivitaet
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
// tier-choice — Multi-Agent-Plan-Detection + Tier-Mix-Wahl (Phase P).
// Sub-Plan A (2026-04-30): Picker zeigt jetzt die echten Iterate-Presets
// (Schnell/Standard/Tief) und persistiert die Wahl als presetId, damit
// runIterate sie wirklich umsetzt.
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
  // Sub-Plan A (2026-04-30): Wir bauen Presets immer aus tier-presets.ts.
  // Falls der Server doch eigene Presets schickt (Legacy-Pfad), werden sie
  // ignoriert — die Wahrheit ist die Single-Source-of-Truth in tier-presets.
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
    // 1. Workstream auto-anlegen
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
      // 2. Master-Plan-Ticket + Iterate-Spawn ausloesen mit presetId.
      // Server persistiert (mode='iterate', iterate_config_json=PRESET_JSON)
      // BEVOR runIterate spawnt — runIterateMode liest dann die Config.
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
      // 3. Bestätigungs-Message pushen (kein live-swarm mehr — Iterate
      // hat seine eigene IteratePipelineCard, die der Orchestrator emittiert).
      pushAssistant(
        `**Workstream angelegt** · ${preset.label} mit ${preset.totalAgents === 1 ? '1 Agent' : `~${preset.totalAgents} Agenten`} (~${preset.estMinutes} min).${
          masterTicketId ? `\n\nMaster-Ticket: \`${masterTicketId}\`` : ''
        }`,
      );
    } catch {
      reply(`Tier-Wahl: ${preset.label} (Fehler beim Anlegen)`);
    }
  };

  // Welle 4 (2026-05-01): tier-Block auf .srf-fallback* CSS-Klassen
  // umgestellt (Token-bind, kein Inline-Style). Recommended-Border via
  // CSS-Var-Override statt JS-Style-Spread.
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
// Terminal — lines von shell output; prompt / host / dim / error / ok / etc.
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
// Heartbeat — count + label. Simple Ripple für Projekt-Pulse.
// ---------------------------------------------------------------------------

function renderHeartbeat(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const count = num(data.count) ?? 0;
  const label = str(data.label) ?? 'aktiv';
  const aria = str(data.ariaLabel) ?? `${count} ${label}`;
  return <HeartbeatPulse count={count} label={label} ariaLabel={aria} />;
}

// ---------------------------------------------------------------------------
// Workspace — Single workspace-Label als Pill, optional mit palette accent.
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
// Routine — kompakte Info-Zeile (reuse Toast-Struktur für MVP).
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
// Agent — zeigt einen Sub-Agent (role + status + optional task-preview).
// Nutzt TMC/Teammate-Card.
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
// Swarm — Konsens-Heatmap (n Zellen, pro Variant gefärbt).
// Nutzt CHR/Heatmap aus der Design-Library.
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
// Document / Folder / CloudBrowser — Workspace-Cloud (Sprint X · 2026-04-27)
// ---------------------------------------------------------------------------

function renderDocument(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  // ID ist OPTIONAL: ein vom Agent referenziertes Dokument
  // (`<surface:document>{filename,mime,workspace}</surface:document>`) hat
  // keine Artifact-ID. Ohne ID rendern wir trotzdem eine saubere Datei-Karte
  // (statt Rohtext-Fallback) — nur ohne Download/Preview-Links, weil es kein
  // gespeichertes Artefakt zum Streamen gibt. Pflichtfeld ist allein der
  // `filename` (sonst gibt es nichts Sinnvolles zu zeigen).
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
  // URLs nur ableiten wenn eine ID existiert — sonst undefined lassen,
  // damit die Card keine 404-Links / kaputten <img>-Cover zeigt.
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
// open-questions — Sub-Plan D (2026-04-30). QuickChoice-Buttons im Chat.
// ---------------------------------------------------------------------------
// 2026-05-25 Bug-Fix UX1: Rendert jetzt ChatInlineOpenQuestions (Stepper) statt
// OpenQuestionsSurface. Die alte Variante hat jeden Antwort-Klick sofort als
// separaten Chat-Turn via /inject abgesetzt. Der Stepper hält alle Antworten
// lokal (answers/drafts) und sendet EINMAL mit reply() wenn der User "Antworten
// absenden" klickt. workstreamId ist für den Stepper nicht erforderlich —
// reply() im SurfaceActionContext übernimmt das finale Absenden.
// OpenQuestionsSurface bleibt für den workspace-mode (workspaceId-Polling-Pfad)
// als Alt-Pfad erhalten; der workspace-mode hat keine aktiven in-chat-Call-Sites.

function renderOpenQuestions(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const rawQs = Array.isArray(data.questions) ? data.questions : null;
  if (!rawQs) return null;
  const questions = rawQs
    .filter(isObject)
    .map((q) => {
      const id = str(q.id) ?? '';
      // Surface-Payload nutzt `q` als Feldname; PlanQuestion erwartet `text`.
      const text = str(q.q) ?? str(q.text) ?? '';
      const options = Array.isArray(q.options)
        ? q.options
            .filter((o): o is string => typeof o === 'string')
            .map((o) => o.trim())
            .filter((o) => o.length > 0)
            .slice(0, 5)
        : undefined;
      return {
        id,
        text,
        options: options && options.length > 0 ? options : undefined,
      };
    })
    .filter((q) => q.id.length > 0 && q.text.length > 0);
  if (questions.length === 0) return null;
  return <ChatInlineOpenQuestions questions={questions} />;
}

// ---------------------------------------------------------------------------
// bug-fix-swarm — Sprint H (2026-04-30). 3 parallele Diagnose-Spawns.
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
// bug-fix-pipeline — Welle 2 (Sub-Plan Auto-Swarm Bug-Fix · 2026-05-03).
// Re-uses BugFixSwarmCard mit der workstreamId als swarmId-Surrogate.
// Polling endpoint: /api/bugs/pipeline/[workstreamId]. Backend emittiert
// `bug_fix_pipeline_phase`-Events, die Card subscribed/polled darauf.
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
  // Wir nutzen workstreamId als swarmId-Surrogat — die Pipeline-Card
  // identifiziert sich per workstreamId, nicht per swarm-uuid.
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
// Welle 7 (2026-05-01) — Loop-Phase-Coverage
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
  // Owner-Fix 2026-05-28: Suppress wenn bereits eine Run-Cockpit-Card fuer
  // denselben (workspaceId, workstreamId) aktiv ist.
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
    // suppressed by run-cockpit (Owner-Fix 2026-05-28)
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
// subplan — BACKPORT-03 (2026-05-23). Rendert eine ProposedPlan-Card mit
// step-Liste, complexity-Chip und optionalem Approve/Edit/Decline-Flow.
// `data` kommt als `unknown` aus JSON.parse — wir prüfen jedes Pflichtfeld
// bevor wir casten. Malformes JSON → return null (kein Crash im Chat-Stream).
// ---------------------------------------------------------------------------

/** Guard: prüft ob `v` ein valider PlanStep ist (Pflichtfelder: id, index, title, rationale). */
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
// SubplanCardWrapper — BACKPORT-03 Approve-Wiring (2026-05-23).
// Kapselt den Freigabe-Flow: POST /api/workstreams/:id/execute-plan → pushAssistant.
// Muster: analog TierChoiceCard weiter oben (useSurfaceAction + fetch + pushAssistant).
// ---------------------------------------------------------------------------

/** Alle Props, die renderSubplan extrahiert hat, gebündelt übergeben. */
interface SubplanCardWrapperProps {
  plan: ProposedPlan;
  depth: number;
  awaitingApproval: boolean;
  stepStatuses: Record<string, 'pending' | 'active' | 'done' | 'failed' | 'in-critic' | 'fix-iter-1' | 'fix-iter-2' | 'escalated' | 'cancelled'> | undefined;
  /** workstreamId aus dem surfacePayload — undefined wenn Payload unvollständig. */
  workstreamId: string | undefined;
  /**
   * Der Root-Step, der diesen Subplan ausgelöst hat (depth-1-Cards).
   * Null bei der Root-Card (depth 0) oder wenn der Payload das Feld nicht enthält.
   * SubplanCard nutzt es für den Header „Subplan — <parentStep.title>".
   */
  parentStep: PlanStep | null;
  /**
   * Owner-Fix 2026-05-28: Card startet eingeklappt auch bei depth < 2 wenn
   * der Surface-Payload `collapsed:true` traegt (gesetzt von plan-dispatch
   * fuer Child-Subplaene). depth >= 2 erzwingt weiterhin Collapse.
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

  // handleApprove: POST execute-plan → Bestätigung oder Fehler-Meldung im Chat.
  // onApprove ist (planId: string) => void auf der SubplanCard-Seite —
  // wir starten den fetch ohne await auf der Render-Ebene.
  const handleApprove = (planId: string): void => {
    if (!workstreamId) {
      // Kein workstreamId im Payload — defensiv abbrechen statt blinder POST.
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

  // handleDecline: kein API-Call nötig — Nutzerfeedback im Chat reicht.
  const handleDecline = (_planId: string): void => {
    pushAssistant('Plan verworfen.');
  };

  return (
    <SubplanCard
      depth={depth}
      plan={plan}
      // parentStep: aus dem Payload gelesen (depth-1-Cards liefern den Root-Step,
      // Root-Card und unvollständige Payloads landen bei null → SubplanCard zeigt
      // „unbekannter Parent" als Fallback (s. SubplanCard.tsx Zeile 84).
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

  // Pflichtfelder von ProposedPlan prüfen.
  const id = str(data.id);
  const originalIntent = str(data.originalIntent);
  const complexityRaw = str(data.estimatedComplexity);
  const proposedAt = num(data.proposedAt) ?? 0;
  if (!id || !originalIntent) return null;

  // estimatedComplexity muss in {M, L, XL} liegen.
  const estimatedComplexity =
    complexityRaw === 'M' || complexityRaw === 'L' || complexityRaw === 'XL'
      ? complexityRaw
      : 'M'; // defensiver Fallback: wir rendern lieber als M statt gar nicht

  // steps: jedes Element wird durch isPlanStep geschützt.
  const rawSteps = Array.isArray(data.steps) ? data.steps : [];
  const steps: PlanStep[] = rawSteps.filter(isPlanStep);
  // Mindestens einen Step brauchen wir — sonst ist der Plan bedeutungslos.
  if (steps.length === 0) return null;

  const plan: ProposedPlan = { id, originalIntent, steps, estimatedComplexity, proposedAt };

  // depth: integer ≥ 0 aus payload, Fallback 0.
  const depthRaw = num(data.depth);
  const depth = typeof depthRaw === 'number' && depthRaw >= 0 ? Math.floor(depthRaw) : 0;

  // awaitingApproval: explizit true → true; alles andere → false.
  const awaitingApproval = data.awaitingApproval === true;

  // stepStatuses: Record<string, Status> — defensiv: nur Strings als Values.
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

  // workstreamId: aus Payload lesen — der Plan-Dispatch setzt surfacePayload.workstreamId.
  const workstreamId = str(data.workstreamId);

  // parentStep: Shape-Guard via isPlanStep (Pflichtfelder: id + title).
  // Depth-1-Cards liefern den Root-Step der sie ausgelöst hat; Root-Card und
  // Payloads ohne das Feld landen bei null. SubplanCard rendert dann
  // „unbekannter Parent" als Fallback (N1-konform: kein Silent-Null-Render).
  const parentStep: PlanStep | null = isPlanStep(data.parentStep) ? data.parentStep : null;

  // Owner-Fix 2026-05-28: collapsed:true im Payload (gesetzt von plan-dispatch
  // fuer Child-Subplaene, lib/plan-first/plan-dispatch.ts:251) erzwingt die
  // Pill-Variante. Backwards-compat: missing/false ⇒ wie bisher
  // (depth >= 2 erzwingt Collapse durch die SubplanCard selbst).
  const initialCollapsed = data.collapsed === true;

  // SubplanCardWrapper kapselt Approve/Decline-Wiring via useSurfaceAction.
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
// Secret-Eingabe-Surface für einen Provider-API-Key. Der Secret-Wert geht
// AUSSCHLIESSLICH über POST /api/connectors/[provider]/credential in den
// Vault — niemals in Chat/SSE/Ledger. Surface-Payload trägt KEIN secret-Feld.
// ---------------------------------------------------------------------------

function renderCredentialRequest(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const provider = str(data.provider);
  const workspaceId = str(data.workspaceId);
  // Pflichtfelder: provider + workspaceId.
  if (!provider || !workspaceId) return null;

  const scopeKindRaw = str(data.scopeKind);
  const scopeKind: 'workspace' | 'org' =
    scopeKindRaw === 'org' ? 'org' : 'workspace';

  const why = str(data.why) ?? str(data.reason) ?? str(data.description);
  const docsUrl = str(data.docsUrl) ?? str(data.docs_url);

  // FIX-B (2026-05-30): mobiles Connector-Auth-Surface — authKind/engineBacked/
  // capability/signupUrl/credentialFieldHint aus dem Payload durchreichen.
  // Rückwärtskompatibel: fehlt das Feld → CredentialRequestCard fällt auf 'apikey'.
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

  // configFields: optionale Plain-Text-Felder (baseUrl, version).
  // SECURITY: diese Liste darf NIEMALS ein "secret"/"key"/"token"-Feld enthalten —
  // solche Werte gehen über den dedizierten secret-Input, nicht über configFields.
  const rawCfg = Array.isArray(data.configFields) ? data.configFields : [];
  const configFields = rawCfg
    .filter(isObject)
    .map((f) => {
      const key = str(f.key);
      const label = str(f.label);
      if (!key || !label) return null;
      // Kein secret-/token-/key-Feld als configField erlaubt.
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
// subagent-fleet — BACKPORT-02 (2026-05-23). Rendert bis zu 5 Subagent-Panes
// als koordinierten Fleet-View (status, abort, diff). Malformes oder leeres
// panes-Array → return null. Die Card selbst greift intern auf
// SUBAGENT_FLEET_MAX_PANES (5) zurück — wir reichen einfach alle validen
// Panes durch, ohne hier erneut zu slicen.
// ---------------------------------------------------------------------------

/** Erlaubte Werte für SubagentPaneRole (von SubagentFleetCard.types). */
const VALID_PANE_ROLES = new Set<string>([
  'architect', 'coder', 'tester', 'reviewer', 'security', 'perf', 'generic',
]);

/** Erlaubte Werte für SubagentPaneStatus. */
const VALID_PANE_STATUSES = new Set<string>([
  'queued', 'running', 'done', 'failed', 'aborted',
]);

function renderSubagentFleet(data: unknown): ReactNode {
  if (!isObject(data)) return null;

  // fleetTitle ist Pflicht für einen sinnvollen Header.
  const fleetTitle = str(data.fleetTitle) ?? str(data.title);
  if (!fleetTitle) return null;

  // panes: Array prüfen, jeden Eintrag defensiv validieren.
  const rawPanes = Array.isArray(data.panes) ? data.panes : null;
  if (!rawPanes) return null;

  const panes: SubagentPane[] = rawPanes.flatMap((raw): SubagentPane[] => {
    if (!isObject(raw)) return [];
    const subagentId = str(raw.subagentId);
    const title = str(raw.title);
    const roleRaw = str(raw.role);
    const statusRaw = str(raw.status);
    // Pflichtfelder: subagentId, title, role (in Whitelist), status (in Whitelist).
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

  // Null bei 0 validen Panes (defensiv — die Card macht dasselbe intern).
  if (panes.length === 0) return null;

  // activePaneId ist optional — nur reichen wenn String.
  const activePaneId = str(data.activePaneId);
  // CP-2 (UX-Audit 2026-05-28): workstreamId aus dem Payload ziehen, damit
  // die Abort-Action das korrekte Workspace-Permission-Gate trifft. Wenn der
  // Payload keinen Wert mitliefert, bleibt der Abort-Button dark (kein
  // blinder POST gegen 'unknown').
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
// SubagentFleetCardWired — CP-2 / UX-Audit 2026-05-28.
// Hookt onResolve in einen optimistic-UI + fail-soft POST gegen
// /api/workstreams/[workstreamId]/subagent/[paneId]/abort.
//
// Vor diesem Wrapper waren Abort / Diff Buttons der SubagentFleetCard tot
// (`onResolve={undefined}`, expliziter Kommentar im Renderer). Diff bleibt
// Phase-2 (kein Backend-Endpoint), Abort + Dismiss + Abort-Fleet werden
// jetzt verdrahtet:
//   - abort-pane    → POST … /subagent/{paneId}/abort
//   - abort-fleet   → POST je laufender Pane (sequentiell, fail-soft)
//   - dismiss       → no-op (Card-Local-State); kein Backend nötig
//   - open-diff     → no-op-Stub (TODO: Diff-Surface anbinden)
//
// Optimistic UI: lokaler aborting-State markiert die Pane sofort, der POST
// läuft im Hintergrund. Bei 4xx/5xx kein Rollback (Pane bleibt aborted aus
// User-Sicht), aber die Fehler-ID landet im console-error für Diagnose.
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
  // Optimistic-Layer: paneIds, die der User lokal abgebrochen hat. Werden
  // sofort in den Status 'aborted' überlagert.
  const [optimisticAborts, setOptimisticAborts] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  const sendAbort = useCallback(
    async (paneId: string): Promise<void> => {
      if (!workstreamId) {
        // Defensiv: ohne workstreamId würden wir 'unknown' POSTen — der
        // Server lehnt das eh ab, aber wir verschicken nichts.
        // eslint-disable-next-line no-console
        console.warn(
          '[SubagentFleetCardWired] abort skipped — payload missing workstreamId',
          { paneId },
        );
        return;
      }
      // Optimistic: sofort als aborted markieren.
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
          // Alle running/queued Panes hintereinander abbrechen — fail-soft.
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
          // Phase-2 Stubs — die Card schließt lokal über Eltern-State.
          return;
        default:
          return;
      }
    },
    [panes, sendAbort],
  );

  // Optimistic-Overlay anwenden: lokal abgebrochene Panes als aborted
  // anzeigen, BEVOR das SSE-Update vom Backend nachfließt.
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
// S5-Preview: Approve-Action → POST /api/connectors/invoke.
// Payload darf KEIN secret-Feld enthalten (defensiv geprüft in auto-connect.ts).
// workspaceId kommt aus dem Payload (emitOrUpdateCard setzt workspaceId ins
// coords-Feld, aber nicht in den Surface-Payload selbst — wir lesen es aus
// dem Card-Payload, das auto-connect.ts korrekt befüllt hat).
// ---------------------------------------------------------------------------

function renderConnectorCallPreview(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const provider = str(data.provider);
  const capability = str(data.capability);
  const workspaceId = str(data.workspaceId) ?? str(data.credentialScope)?.split(':')[1];
  // Pflichtfelder: provider + capability.
  if (!provider || !capability) return null;

  // Defensive Payload-Rekonstruktion — nur bekannte sichere Felder durchlassen.
  // SECURITY: kein 'secret'/'token'-Feld darf aus `data` ins Payload gelangen.
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
    // credentialPreview: maskierter Wert aus previewCall — NIE der Klartext.
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
// Einmalige Modus-Auswahl fuer einen Workspace. Erscheint genau einmal.
// Payload: { workspaceId: string, currentMode?: string | null }
// SECURITY: kein secret-Feld. PATCH-Route ist auth-gated.
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
// Visuelle Flow-Graph-Surface (n8n/make-Stil) als custom-SVG + HTML-Nodes —
// KEINE neue Dependency (kein React-Flow/dagre); Begruendung im Plan
// docs/plans/2026-05-27_flow-studio-architecture.md §3.
//
// Layout: einfacher topologischer DAG-Level-Algorithmus inline. Nodes ohne
// eingehende Kante = Ebene 0; jede weitere Node = max(parent-Ebene)+1. Pro
// Ebene eine Reihe (horizontal); auf schmal (≤640px) vertikale Stapelung —
// hier via flex-wrap + max-width, damit es ohne JS-Resize-Listener
// mobil-tauglich bleibt (Avatar liest am iPhone).
//
// Pitch-Black/Apple-Disziplin: ruhig, viel Luft, ein Status-Dot pro Node.
// P3 = reines Rendering; Tap = nur visuelles Feedback (kein Handler noetig).
// Live-Wiring (Speisung aus flow_steps/plan-step-Status) folgt bewusst spaeter.
// ---------------------------------------------------------------------------

type FlowNodeStatus = 'idle' | 'running' | 'done' | 'needs-input' | 'failed';

interface FlowNode {
  id: string;
  label: string;
  skill?: string;
  tool?: string;
  status: FlowNodeStatus;
  /**
   * P-now (2026-05-27): zeigt dieser Node auf ein noch ungekoppeltes Tool?
   * Steuert den „koppeln"-Hinweis im Detail-Panel. Default false — ohne das
   * Feld bleibt das Rendering identisch zum P3-Stand.
   */
  needsCoupling?: boolean;
  /**
   * W2.2 (2026-05-30): bei `needs-input` der Gate-Kind, auf den der Node-Tap
   * zielt. Das Detail-Panel baut daraus einen minimalen BlockingGateState und
   * ruft `executeGateAction` — DERSELBE Pfad wie der ActionDeck-Pin (ein POST,
   * kein Doppel-Routing). Optional — ohne das Feld bleibt der Node informativ.
   */
  gateKind?: BlockingGateKind;
  /**
   * W2.2: ein `done` Assembly-/Serve-Knoten kann eine Vorschau-URL tragen. Das
   * Detail-Panel zeigt dann „Vorschau öffnen" (öffnet die URL — der `renderPreview`-
   * Link-Pfad 1:1). Optional — ohne URL kein Button.
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

// W2.2: erlaubte Gate-Kinds für aktionierbare needs-input-Knoten (Spiegel von
// BlockingGateKind in projection/types — der executeGateAction-Pfad kennt sie).
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

/** Status-Dot-Farbe je Node-Status. Token-bind mit Hex-Fallback (renderPreview-Muster). */
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
 * Topologisches Schicht-Layout: weist jeder Node eine Ebene zu.
 * Ebene = max(parent-Ebene)+1, Roots (keine eingehende Kante) = 0.
 * Zyklen-sicher: feste Iterations-Obergrenze (#nodes) — wer nach so vielen
 * Runden noch nicht stabil ist (Zyklus), bleibt auf der zuletzt berechneten
 * Ebene stehen statt eine Endlosschleife zu erzeugen.
 */
function computeFlowLevels(
  nodes: FlowNode[],
  edges: FlowEdge[],
): Map<string, number> {
  const level = new Map<string, number>();
  for (const n of nodes) level.set(n.id, 0);
  // Eingehende Kanten pro Node (nur valide, dangling sind vorab gefiltert).
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

  // nodes parsen — Pflichtfelder id + label. Status defensiv normalisieren.
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
        // W2.2: gateKind (nur sinnvoll bei needs-input) defensiv normalisieren.
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
            // P-now: ein Node kann auf ein ungekoppeltes Tool zeigen
            // (`needsCoupling: true` oder reason-Hinweis). Optional — Default
            // false, damit das bestehende Rendering unveraendert bleibt.
            needsCoupling: isObject(raw) && raw.needsCoupling === true,
            ...(gateKind ? { gateKind } : {}),
            ...(str(raw.previewUrl) ? { previewUrl: str(raw.previewUrl) } : {}),
          },
        ];
      })
    : [];

  // Leere/fehlende nodes → nichts rendern (kein Throw).
  if (nodes.length === 0) return null;

  const nodeIds = new Set(nodes.map((n) => n.id));

  // edges parsen — dangling (from/to nicht in nodes) werden ignoriert.
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
  // Apple-Pass (2026-05-30): expliziter Untertitel (SOP-Detail). Der Titel wird
  // im Header auf 1 Zeile geclampt (line-clamp:1), das Detail steht — falls die
  // Payload `subtitle` mitliefert — darunter im 13pt-Untertitel. Kein Ableiten
  // per Titel-Split (würde den sinntragenden Titel-Kopf zerschneiden, N1).
  const subtitle = str(data.subtitle);
  const runStatusRaw = str(data.runStatus);
  const runStatus: FlowRunStatus =
    runStatusRaw && (FLOW_RUN_STATUSES as readonly string[]).includes(runStatusRaw)
      ? (runStatusRaw as FlowRunStatus)
      : 'idle';

  // Stream C (2026-05-27): workstreamId + workspaceId aus der Payload — die
  // FlowGraphCard braucht beide fuer „Als Prozess speichern" (POST
  // /api/flow/from-workstream). Optional: ohne sie bleibt der Button verborgen
  // (z.B. /design-Preview), das Rendering ist sonst identisch.
  const workstreamId = str(data.workstreamId);
  const workspaceId = str(data.workspaceId);
  // C2 (2026-05-27): ein Flow-Graph kann EINGEKLAPPT starten — dann zeigt die
  // Card nur einen tippbaren „Prozess ansehen"-Chip, der die volle Surface
  // oeffnet. Owner-SOLL: „muss nicht dauerhaft sein, aber klickbar → oeffnet
  // die Surface". Default false (heutiges Verhalten: sofort sichtbar).
  const startCollapsed = data.collapsed === true;

  // P-now (2026-05-27): die tappbaren Nodes brauchen lokalen State (offene
  // node-id) → eigene Komponente. Reines Parsing bleibt in renderFlowGraph,
  // damit die bestehende, getestete Parse-Logik unveraendert ist.
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
  // WICHTIG (React hook rules): ALLE useState-Aufrufe stehen VOR jedem
  // bedingten return (collapsed). Sonst springt die Hook-Reihenfolge zwischen
  // den Renders — verboten. Deshalb wird openNodeId hier oben mit-deklariert.
  // C2: collapse/expand-State. Startet eingeklappt, wenn die Payload es sagt.
  const [collapsed, setCollapsed] = useState<boolean>(startCollapsed === true);
  // C3: „Als Prozess speichern"-State (optimistic, fail-soft).
  // idle → saving → saved | error. Der Button braucht workstreamId+workspaceId.
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>(
    'idle',
  );
  // Offene node-id (Detail-Panel). null = kein Panel offen. Toggle bei Re-Tap.
  const [openNodeId, setOpenNodeId] = useState<string | null>(null);
  // W2.2 (2026-05-30) — Anti-Proliferation: ist für denselben
  // (workspaceId, workstreamId) bereits eine run-cockpit-Surface aktiv, zieht
  // der flow-graph in das Cockpit (als view-Sektion) → die freischwebende
  // Card supprimiert sich hier (wie sub-workstreams/iterate-pipeline). Der
  // ActionDeck bleibt der globale Bottom-Pin; needs-input-Node + ActionDeck-
  // Gate zeigen auf DASSELBE Gate (ein executeGateAction). Hook VOR jedem
  // bedingten return (React-Regel). Provider-frei → false (Back-Compat).
  const cockpitCoordKey = buildCockpitCoordKey(workspaceId, workstreamId);
  const suppressedByCockpit = useRunCockpitActive(cockpitCoordKey);
  const canSaveAsProcess =
    typeof workstreamId === 'string' &&
    workstreamId.length > 0 &&
    typeof workspaceId === 'string' &&
    workspaceId.length > 0;

  const handleSaveAsProcess = async (): Promise<void> => {
    if (!canSaveAsProcess || saveState === 'saving' || saveState === 'saved') return;
    // Optimistic: sofort „gespeichert" anzeigen, bei Fehler zuruecksetzen.
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
      // fail-soft: jeder Nicht-2xx → error-State (kein Throw, kein Crash).
      setSaveState(resp.ok ? 'saved' : 'error');
    } catch {
      setSaveState('error');
    }
  };

  // W2.2 — Anti-Proliferation: run-cockpit aktiv → flow-graph-Card supprimieren
  // (das Cockpit zieht den Graph als view-Sektion ein). NACH allen Hooks.
  if (suppressedByCockpit) {
    return null;
  }

  // C2: eingeklappt → nur ein tippbarer Chip, der die Surface oeffnet.
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

  // Nodes nach Ebene gruppieren (Reihen-Layout).
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

  // W2.2 (2026-05-30): in-/out-degree pro Node — reine Render-Ableitung aus den
  // vorhandenen `edges`, KEINE neue Datenschicht. Daraus leiten wir Fork (eine
  // Stufe fächert in >1 parallelen Strang) und Join (mehrere Stränge laufen in
  // EINEN Node zusammen) ab. Eine Stufe mit >1 Node ist eine parallele
  // Spur-Gruppe; sie wird benannt („⑂ parallel · N") + eingerückt gerendert,
  // damit parallel/sequentiell auch bei 390px schmal unterscheidbar bleibt.
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
  // Eine Stufe ist „parallel", wenn sie mehr als einen Knoten trägt.
  const isParallelLevel = (lv: number): boolean => (byLevel.get(lv)?.length ?? 0) > 1;
  // Ein Join-Marker steht VOR einer Stufe, deren (einziger) Knoten in-degree>1
  // hat — mehrere parallele Stränge laufen hier zusammen.
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

  // W2.2: ein Flow-Knoten als tappbarer Button. Tap toggelt das Detail-Panel.
  // `running` trägt den „läuft jetzt"-Akzent (--a-now) + Puls; `needs-input`
  // den Warn-Akzent (aktionierbar). Markup unverändert ggü. dem Vor-Stand —
  // nur in eine Helper-Funktion gehoben (Stufen×Spuren rufen sie zweimal auf).
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
          // Tap toggelt das Detail-Panel: erneuter Tap schliesst es wieder.
          setOpenNodeId((cur) => (cur === n.id ? null : n.id))
        }
      >
        <span
          data-test="flow-node-dot"
          data-status={n.status}
          // data-dot-color spiegelt die Token-bind Farbe als testbares Attribut —
          // happy-dom verschluckt color-Properties mit var(--token, #fallback)-
          // Wert beim style-Serialisieren (Browser rendert korrekt). So bleibt die
          // Status→Farbe-Zuordnung deterministisch pruefbar ohne CSS-Round-Trip.
          data-dot-color={flowStatusColor(n.status)}
          aria-hidden
          style={{
            marginTop: 4,
            width: 9,
            height: 9,
            flexShrink: 0,
            borderRadius: 999,
            backgroundColor: flowStatusColor(n.status),
            // running pulsiert ruhig (Accent). Reuse @keyframes pulse.
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
      {/* Header: title (1 Zeile, 17pt semibold) + optional 13pt-Untertitel +
          runStatus-Pill. Ruhig, viel Luft. Apple-Pass (2026-05-30): Titel auf
          1 Zeile geclampt — kein 3-zeiliger SOP-Wall im Header. */}
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

      {/* Aktions-Zeile (Stream C, 2026-05-27): „Als Prozess speichern" (C3) +
          „Einklappen" (C2). Beide ruhig, sekundaer — die Visualisierung bleibt
          die Hauptsache (eine primaere Aktion pro Surface). */}
      <div
        data-test="flow-graph-actions"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        {/* C3: Als wiederkehrenden Prozess speichern (optimistic, fail-soft).
            Nur sichtbar, wenn workstreamId+workspaceId in der Payload sind. */}
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

        {/* C2: Einklappen → zeigt wieder nur den „Prozess ansehen"-Chip. */}
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

      {/* Graph: Stufen×Spuren (W2.2, 2026-05-30). Sequenz = Stufen untereinander;
          Parallel = mehrere Knoten EINER Stufe als benannte Spur-Gruppe mit
          Fork-Header („⑂ parallel · N") + Join-Marker. Das Layout ist
          Token-/CSS-getrieben (`flow-graph-*` in components.css): Desktop legt
          die parallelen Knoten nebeneinander, bei ≤390px stapeln sie EINGERÜCKT
          unter dem Fork-Header (kein flex-wrap-Stapel) → parallel/sequentiell
          bleibt schmal unterscheidbar. */}
      <div className="flow-graph-stages" data-test="flow-graph-stages">
        {/* Edge-Liste (nicht-sichtbar): die VALIDEN, dangling-gefilterten Kanten
            als testbare + maschinen-lesbare Marker. Das Stufen×Spuren-Layout
            macht Sequenz/Parallel/Join visuell ohne absolutes SVG erkennbar;
            diese Marker erhalten den edge-Vertrag (data-edge-from/-to). */}
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
              {/* Join-Marker: mehrere Stränge laufen hier zusammen. */}
              {join ? (
                <div className="flow-graph-join" data-test="flow-join-marker" aria-hidden>
                  <span className="flow-graph-join-glyph">⑃</span>
                  <span className="flow-graph-join-label">zusammenführen</span>
                </div>
              ) : null}

              {parallel ? (
                // Parallele Spur-Gruppe: Fork-Header + eingerückte Knoten.
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
                // Sequenzielle Stufe: ein Knoten + Stufen-Nummer.
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

      {/* Detail-Panel — P-now (2026-05-27). Inline (kein Floating-Popover), damit
          es am iPhone keine Overlay-Positionierung braucht. Zeigt label, skill,
          tool, status; bei needsCoupling zusaetzlich ein „koppeln"-Hinweis. */}
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

          {/* W2.2 (2026-05-30): Aktions-Zeile. Nur ein Knoten mit ERLAUBTER
              Aktion bekommt einen Button (kein leerer Button):
                · needs-input → primärer Button → executeGateAction(gate). Das
                  ist DERSELBE Submit-Pfad wie der ActionDeck-Pin: er klickt die
                  echte <surface:…>-Gate-Card im DOM (ein POST, kein Drift).
                · failed     → „Neu starten" → reply-Text (Retry/Resume) über
                  den bestehenden SurfaceAction-reply-Pfad.
                · done + previewUrl → „Vorschau öffnen" (renderPreview-Link 1:1).
              Knoten ohne erlaubte Aktion bleiben rein informativ. */}
          {renderFlowNodeAction(openNode)}
        </div>
      ) : null}
    </div>
  );
}

/**
 * W2.2: die erlaubte Aktion eines geöffneten Flow-Knotens — oder null
 * (informativ). Hook-frei (kein useState) — sicher in der Render-Funktion.
 * `useSurfaceAction` wird vom Aufrufer (FlowGraphCard) geliefert.
 */
function FlowNodeAction({ node }: { node: FlowNode }): React.JSX.Element | null {
  const { reply } = useSurfaceAction();

  // needs-input → der EINE executeGateAction-Pfad (klickt die echte Gate-Card).
  if (node.status === 'needs-input') {
    const kind: BlockingGateKind = node.gateKind ?? 'human-decision';
    // Minimaler BlockingGateState: executeGateAction liest NUR `kind`, um die
    // zugehörige Stream-Card zu finden — DASSELBE Ziel wie der ActionDeck-Pin.
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
            // DERSELBE Pfad wie der ActionDeck-Pin — kein zweites Routing.
            executeGateAction(gate);
          }}
        >
          Antworten & freigeben
        </button>
      </div>
    );
  }

  // failed → „Neu starten" (Retry/Resume) über den reply-Pfad.
  if (node.status === 'failed') {
    return (
      <div className="flow-graph-node-action" data-test="flow-node-action-row">
        <button
          type="button"
          data-test="flow-node-action"
          data-action="retry"
          className="press flow-graph-node-action-btn flow-graph-node-action-btn--danger"
          onClick={() => {
            // N1: verbatim Schritt-Label in den Retry-Hinweis (kein .slice).
            reply(`Schritt „${node.label}" neu starten`);
          }}
        >
          Neu starten
        </button>
      </div>
    );
  }

  // done + previewUrl → „Vorschau öffnen" (renderPreview-Link 1:1).
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

  // Kein erlaubter Aktions-Pfad → rein informativ (kein leerer Button).
  return null;
}

/** Render-Helper: die Aktions-Zeile eines geöffneten Knotens (oder null). */
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
// Tool-Kopplungs-Surface: erscheint wenn ein Flow Schritte enthaelt, deren
// benoetigte Tools/Connectoren noch nicht gekoppelt sind. Pro fehlendem Tool
// eine Zeile (stepTitle N1 + provider + reason-Hinweis) mit einem „Koppeln"-
// Button. Der Button oeffnet die BESTEHENDE Credential-Eingabe
// (CredentialRequestCard → POST /api/connectors/[provider]/credential; Secret
// NIE in Chat/SSE/Ledger). Sind alle Tools gekoppelt (oder via „Trotzdem
// starten" uebersprungen) → ein primaerer „Flow starten"-Button →
// POST /api/flow/[flowId]/run {workspaceId}.
//
// SECURITY: die Surface-Payload traegt KEIN secret-Feld. Der Secret-Pfad ist
// ausschliesslich der von ACL5-B (CredentialRequestCard). Wir bauen hier KEINE
// neue Secret-Eingabe.
//
// reason → Hinweis-Mapping:
//   credential → „API-Key/OAuth fehlt"
//   profile    → „Tool verbinden"
//   unknown    → generischer „Tool für diesen Schritt wählen/verbinden"-Hinweis
//                (typisch wenn provider === null).
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
  /** Provider-Slug — null/undefined wenn das Tool fuer den Schritt unklar ist. */
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
      // provider===null → wir wissen das Tool noch nicht.
      return hasProvider
        ? 'Tool verbinden'
        : 'Tool für diesen Schritt wählen/verbinden';
  }
}

function renderFlowCoupling(data: unknown): ReactNode {
  if (!isObject(data)) return null;
  const flowId = str(data.flowId);
  const workspaceId = str(data.workspaceId);
  // Pflichtfelder: flowId + workspaceId. Ohne sie kann weder gekoppelt noch
  // gestartet werden — defensiv null (kein Crash im Stream).
  if (!flowId || !workspaceId) return null;

  const rawMissing = Array.isArray(data.missingTools) ? data.missingTools : [];
  const missingTools: FlowMissingTool[] = rawMissing.flatMap(
    (raw): FlowMissingTool[] => {
      if (!isObject(raw)) return [];
      const stepId = str(raw.stepId);
      // N1: stepTitle wird NICHT gekuerzt — voll uebernehmen.
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
  // Welche stepId hat gerade die Credential-Eingabe offen? null = keine.
  const [openCouplingStepId, setOpenCouplingStepId] = useState<string | null>(
    null,
  );
  // stepIds, die der User lokal als „erledigt"/„uebersprungen" markiert hat.
  // (Die echte Kopplungs-Bestaetigung lebt in CredentialRequestCard; hier nur
  //  der UI-Zustand fuer den „Flow starten"-Gate.)
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

  // ── Done-State ──────────────────────────────────────────────────────────────
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
                    {/* N1: stepTitle voll, ungekuerzt. */}
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

                {/* Provider===null → kein „Koppeln"-Button (wir kennen das Tool
                    nicht); stattdessen ein generischer Hinweis. */}
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

                {/* Bestehende Credential-Eingabe (ACL5-B). Secret geht NUR via
                    POST /api/connectors/[provider]/credential — nie in den Chat.
                    Wir bauen KEINE neue Secret-Eingabe.
                    Stream X1 (2026-05-28): Wenn fuer den Provider eine
                    Onboarding-SOP existiert, rendert FlowCouplingCouplingPane
                    die SOP-Schritte (Signup → Key → Provider-Budget-Hinweis →
                    Credential-Eingabe) PLUS eine Kosten-Hinweis-Zeile. Ohne
                    SOP: rueckwaertskompatibel CredentialRequestCard direkt. */}
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

      {/* Aktionen: primaerer „Flow starten" (gated) + sekundaeres „Trotzdem
          starten", solange noch nicht alles gekoppelt ist. */}
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
 *   - the generic onboarding SOP (Signup → Key → Provider-Budget-Hinweis →
 *     Credential-Eingabe) PLUS a top cost-hint line, OR
 *   - rueckwaertskompatibel: just the CredentialRequestCard (when no SOP
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
  // unknown-marker (Owner-Direktive #2 — nie still 0).
  const capForCost =
    neededCapabilities && neededCapabilities.length > 0
      ? neededCapabilities[0]
      : '';
  const cost: CostEstimate | null = capForCost
    ? estimateCost(provider, capForCost)
    : null;

  // Rueckwaertskompatibel: ohne SOP → originale CredentialRequestCard.
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
  // Owner-Direktive #2: Hinweis, kein Cap.
  // - Unknown → explizit "unbekannt" (nie 0).
  // - Bekannt → Spanne + Basis + erkennbarer Hinweis-Text.
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
  // Beträge unter 1 € mit 2 Nachkommastellen, sonst 2 (Standard).
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
      {/* Credential-Eingabe genau dort, wo die SOP sie verlangt — nicht oben
          aufgestapelt. Bei engine-backed-Providern zeigt die SOP einen 'info'-
          Step statt eines 'credential'-Steps; entsprechend rendert hier
          nichts. */}
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
// Erscheint genau EIN Mal pro Workspace beim ersten LIVE-Lauf
// (LAZYOS_CONNECTOR_LIVE=on UND topic='live-warn-acked' noch nicht
// hinterlegt). Owner-Direktive #3: alle 3 Provider parallel live-flippbar — die
// Warn-Surface schuetzt davor, dass das versehentlich passiert.
//
// SECURITY: Payload traegt KEIN secret — nur { workspaceId }. POST
// /api/workspace/[workspaceId]/live-warn-ack ist auth-gated und idempotent
// (zweimal klicken erzeugt nicht zwei Beliefs — supersede in beliefs-repo).
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
// Pipeline-Family-Merge. Phase-State entscheidet Sub-Layout.
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
// Prompt-Family-Merge. `variant` diskriminiert.
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
    // R4 (2026-05-29) — Decision-Brief (Surface-Manifestation-Strategie §7.3):
    // bestätigbare Entscheidung mit Quelle + Confidence + Konsequenz + Optionen.
    // event-only-Verhalten (kein Doppel-Routing): Klick spielt strukturiert
    // zurück, ohne zusätzlich eine Reply-Bubble zu erzeugen.
    case 'decision-brief':
      return renderDecisionBrief(data);
    default:
      // Sniffing: wenn `endpoint` gesetzt ist, Form. Wenn `name`+`workspaceId`,
      // dann credential. Wenn `headline`+`options`, decision. Sonst null.
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
// Tool/Step-Merge. `mode` diskriminiert.
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
      // Sniffing: typische Felder, defensive Reihenfolge.
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
// counter-evidence — E4 / P13 Devil's-Advocate (2026-05-27).
//
// Anti-Confirmation-Bias: erscheint als EIGENE Card NACH einer Synthesis
// (gated auf consensus 'strong' ODER WHY-Einspeisung). NICHT in den
// Synthesis-Stream gemischt — der User liest Synthesis und Gegen-Evidenz
// getrennt. Rotes Flag (var(--a-danger)) wenn die These nicht
// falsifizierbar ist (tautologisch/unprüfbar) — dann muss re-formuliert
// werden. Token-bind (kein Hardcode-Hex; var(--token, #fallback)-Muster
// wie alle Cards).
// ---------------------------------------------------------------------------

type CounterVerdict = 'falsifiable' | 'unfalsifiable' | 'weak-evidence';

const COUNTER_VERDICTS: ReadonlyArray<CounterVerdict> = [
  'falsifiable',
  'unfalsifiable',
  'weak-evidence',
];

/**
 * Zerlegt den DA-Markdown-Output in einzelne Counter-Punkte. Erkennt die
 * `### Counter N: <Titel>`-Header aus dem Devil's-Advocate-System-Prompt.
 * Tolerant: ohne erkennbare Header bleibt counters leer und die Card
 * rendert nur den Volltext. Reine Hilfsfunktion (kein State).
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
    // Body = alles bis zum nächsten Counter-Header bzw. bis zur nächsten
    // Section (##), N1: nicht kürzen.
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
  // N1: Volltext nicht kürzen.
  const text = str(data.text) ?? '';
  const verdictRaw = str(data.verdict);
  const verdict: CounterVerdict =
    verdictRaw && (COUNTER_VERDICTS as readonly string[]).includes(verdictRaw)
      ? (verdictRaw as CounterVerdict)
      : 'weak-evidence';
  // unfalsifiable: explizit aus der Payload ODER aus dem Verdict abgeleitet.
  const unfalsifiable = data.unfalsifiable === true || verdict === 'unfalsifiable';
  const counterEvidenceCount =
    num(data.counterEvidenceCount) ?? num(data.counterCount) ?? 0;

  // Ohne Text UND ohne Counter → nichts zu zeigen (kein Throw).
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

  // Akzent: rot bei unfalsifiable (Red-Flag), warn bei weak-evidence,
  // neutral-info sonst. Token-bind.
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
      {/* Header: Titel + Verdict-Pill. */}
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

      {/* Red-Flag-Banner: nur wenn These nicht falsifizierbar. */}
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

      {/* Counter-Punkte einzeln, falls erkennbar; sonst Volltext (N1). */}
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
// run-cockpit — Owner-Fix (2026-05-28).
// Aggregierte Master-Surface: Phase-Stepper + Sub-Workstream-Liste collapsed-
// default + naechste-Phase-Hint + Token/Cost-Counter. Loest die 3 simultanen
// Emit-Stellen (sub-workstreams + iterate-pipeline + iterate-version) im
// Strom ab; die Legacy-Cards bleiben emittiert, werden aber im Renderer
// suppressed (siehe RunCockpitRegistryProvider + useRunCockpitActive).
//
// Mobile-first: 375px-tauglich, keine horizontalen Overflows. Touch-Targets
// >= 44px. Token-only (var(--ink), var(--sheet-*), var(--line-*), var(--a-*)).
// ---------------------------------------------------------------------------

/** Phasen-Reihenfolge des Cockpits. */
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

/** Default-Hint pro Phase — kann durch Payload.nextStepHint ueberschrieben werden. */
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

/** Status-Dot Farbe per Status. */
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
  // Mount: registriert Coord im Registry → die 3 Legacy-Cards (sub-workstreams,
  // iterate-pipeline, iterate-version) supprimieren sich solange diese Card lebt.
  useRunCockpitRegistration(coordKey);

  const [subsCollapsed, setSubsCollapsed] = useState<boolean>(true);

  const activeIdx = props.phaseIndex - 1; // 1-basiert → 0-basiert

  // Cost-Counter: cents → € mit 2 Nachkommastellen wenn vorhanden.
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
        // mobile-first: keine horizontalen Overflows
        maxWidth: '100%',
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    >
      {/* Header: Titel + Aktive-Phase-Anzeige + Token/Cost-Counter rechts */}
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

      {/* Phase-Stepper: kompakte horizontale Pill-Sequenz, mobile-first wrap. */}
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

      {/* Sub-Workstreams-Sektion: collapsed-default. */}
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

      {/* „Was kommt als naechstes"-Hint.
          Befund 3 (Owner 2026-05-29): „auch wieder ein Hintergrund der unnötig
          ist". Der Hint war ein --sheet-2-gefüllter, gerahmter Block INNERHALB
          der --sheet-1-Card → Background-on-Background-Box. Rams-Fix: Füllung +
          Rahmen-Rechteck raus, stattdessen nur eine Hairline-Trennung oben +
          der Brand-Pfeil als einziges Highlight. Flach geschichtet statt
          Box-in-Box. */}
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
  // Beide Pflichtfelder — sonst koennen wir weder Suppression koordinieren
  // noch sinnvoll rendern (Coord-Key haengt an ihnen).
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

  // Wenn phaseIndex fehlt: aus phase ableiten (1-basiert).
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
// A4 (2026-05-29, Opus 4.8) — Merge-Offer-Surface.
//
// Schliesst den Accumulation-Loop: die zusammengesetzte Arbeit aller
// erfolgreichen Steps liegt im Run-Branch `lazing/run/prun-…`. Diese Card ist
// der EINZIGE Owner-sichtbare Pfad, der ihn per Klick in den Live-Checkout
// bringt (R3 Human-Gate — NIE automatisch).
//
//   [Diff ansehen]   → POST /api/workstreams/[id]/merge-run {preview:true}
//                       (read-only — Datei-Liste + Stat, KEIN Merge).
//   [In Live mergen] → POST /api/workstreams/[id]/merge-run {}
//                       (die EINZIGE Schreib-Aktion → nach Erfolg resolved).
//   [Verwerfen]      → rein lokal (kein Schreib-Call).
//
// SECURITY: kein Secret in der Payload — nur Run-/Datei-Metadaten.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Self-Learning Workflow-Recording (2026-06-03, Slice 1) — Recurrence-Nudge.
// Erscheint, wenn der Repetition-Detektor erkennt, dass dieser Ablauf
// strukturell schon ≥3× so lief. Owner-gated: EIN Button speichert ihn als
// wiederverwendbares Flow-Template (POST /api/flow/from-workstream = C3-Pfad,
// derselbe wie der „Als Prozess speichern"-Button auf der Flow-Graph-Card).
// Kein Auto-Save. SECURITY: kein Secret in der Payload.
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
// image-gen (2026-06-03) — selbst-fahrendes, ANIMIERTES Bild-Lade-Surface.
// Owner-Befund: das alte /image blockierte ~30–90 s (Proxy-Timeout → „Fehler,
// kein Bild") + zeigte nur statischen Toast. Jetzt: SOFORT ein Shimmer-Surface,
// die Karte startet den Job (async), pollt /api/imagegen/status, swappt das Bild
// rein (wie Codex). Bei Erfolg → lazyos:image-gen-done-Event → ChatShell
// persistiert die <surface:document>-Bild-Bubble. Bei Fehler → Retry inline.
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
      // jobId aus sessionStorage wiederverwenden (Re-Mount/Reload kein Doppel-Job).
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
      // Poll bis done/error (max ~4 min).
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
          // Persistieren: ChatShell ersetzt diese Karte durch die Bild-Bubble.
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

  // done → Bild-Bubble (bis ChatShell den swap macht; nahtlos identisch).
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

  // starting / generating → animierter Shimmer (wie Codex).
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
  // Diff-Preview: zusätzliche Dateien, die der Server beim preview liefert
  // (überschreibt die optimistische Payload-Liste, falls vorhanden).
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

  // --- resolved state: Merge erfolgreich -----------------------------------
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
        {/* Schreib-Aktion — die EINZIGE. Brand-Akzent nur hier (Jobs/Rams). */}
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
        {/* read-only Diff-Preview. */}
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
        {/* rein lokal — kein Schreib-Call. */}
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
// R4 (2026-05-29) — Decision-Brief (prompt variant=decision-brief).
//
// Surface-Manifestation-Strategie §7.3: eine Entscheidung aus Kommunikation/
// Meeting/Chat als bestätigbares Objekt — was wurde gesagt, von wem, Quelle,
// Confidence, Konsequenz, Optionen. event-only-Verhalten (Rule 4 „Evidence
// not equal Decision"): Klick spielt strukturiert zurück, ohne zusätzliches
// Reply-Routing-Duplikat.
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
    // Default: Bestätigen/Ablehnen.
    options.push({ id: 'confirm', label: 'Bestätigen', recommended: true });
    options.push({ id: 'reject', label: 'Ablehnen' });
  }
  const rawBehavior = (data as { behavior?: unknown }).behavior;
  const eventOnly = rawBehavior !== 'reply-and-event'; // Default: event-only.
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
    // event-only: kein zusätzliches Reply-Routing-Duplikat. Im Default-Modus
    // (event-only) emittieren wir KEINE Reply-Bubble — die strukturierte
    // Entscheidung wird allein über den data-chosen-State sichtbar. Nur im
    // explizit angeforderten reply-and-event-Modus geht eine Reply raus.
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
// A3/R7 (2026-05-29) — Project-Truth-Surface (langlebiger Lese-Anker).
//
// Surface-Manifestation-Strategie §7.2: zeigt die aktuell gesicherte
// Projektwahrheit ÜBER Runs hinweg — Vision, Decisions, Beliefs,
// Open-Unknowns, Widersprüche. EINE Card pro Workspace (idempotent via
// subKey='project-truth'). NICHT interaktiv (Lese-Anker), aber collapsibel.
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
  // Leerer Anker → nichts rendern (kein leerer Rahmen).
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

      {/* Decisions sind immer sichtbar (der wichtigste Anker). */}
      <ProjectTruthSection
        title="Decisions"
        items={decisions}
        testId="project-truth-decisions"
      />

      {/* Beliefs ebenfalls direkt sichtbar. */}
      <ProjectTruthSection
        title="Beliefs"
        items={beliefs}
        testId="project-truth-beliefs"
      />

      {/* Open-Unknowns direkt sichtbar (offene Punkte sind handlungsleitend). */}
      <ProjectTruthSection
        title="Open Unknowns"
        items={openUnknowns}
        testId="project-truth-open-unknowns"
        accent="var(--a-warn, #FFD60A)"
      />

      {/* Widersprüche nur im ausgeklappten Detail (rotes Akzent). */}
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
    // Sub-Plan 3 · Cluster-Merges (2026-05-01) — kanonische Ziele
    case 'workflow':
      return renderWorkflow(data);
    case 'prompt':
      return renderPrompt(data);
    case 'agent-step':
      return renderAgentStep(data);
    // BACKPORT-03 (2026-05-23) — Plan-First V2 Surfaces.
    case 'subplan':
      return renderSubplan(data);
    // BACKPORT-02 (2026-05-23) — Subagent-Fleet-View.
    case 'subagent-fleet':
      return renderSubagentFleet(data);
    // ACL5-B (2026-05-24) — Credential-Request-Surface.
    // SECURITY: Surface-Payload KEIN secret; Secret nur via POST /api/connectors/[provider]/credential.
    case 'credential-request':
      return renderCredentialRequest(data);
    // ACL5-E (2026-05-24) — Connector-Call-Preview-Surface.
    // Approve-Action → POST /api/connectors/invoke. Kein secret im Payload.
    case 'connector-call-preview':
      return renderConnectorCallPreview(data);
    // P1-#5 (2026-05-25) — Connector-Onboarding-Progress-Surface.
    // Shows workstreamId / planId / stepCount / status for dispatched onboarding SOP.
    // TODO(Wave-3): render a real progress card; for now fall through to null.
    case 'onboarding-progress':
      return null;
    // A1 (2026-05-25) — Permission-Setup-Surface.
    // SECURITY: no secret fields. PATCH route is auth-gated.
    case 'permission-setup':
      return renderPermissionSetup(data);
    // Flow Studio P3 (2026-05-27) — visuelle Flow-Graph-Surface (custom-SVG).
    // Reines Rendering; Live-Wiring (flow_steps/plan-step-Status) folgt spaeter.
    case 'flow-graph':
      return renderFlowGraph(data);
    // Self-Learning Workflow-Recording (2026-06-03, Slice 1) — Recurrence-Nudge.
    case 'flow-recurrence':
      return renderFlowRecurrence(data);
    // Bild-Generierung (2026-06-03) — selbst-fahrendes animiertes Lade-Surface.
    case 'image-gen':
      return renderImageGen(data);
    // Flow Studio P-now (2026-05-27) — Tool-Kopplungs-Surface.
    // SECURITY: Surface-Payload KEIN secret; Secret nur via CredentialRequestCard
    // → POST /api/connectors/[provider]/credential. „Flow starten" → POST
    // /api/flow/[flowId]/run {workspaceId}.
    case 'flow-coupling':
      return renderFlowCoupling(data);
    // Stream X1 (2026-05-28) — Einmaliger LIVE-Mode-Warn-Surface.
    // Owner-Quittung wird in workspace_beliefs (topic='live-warn-acked')
    // gespeichert. Payload-Schema: { workspaceId }.
    case 'live-warn':
      return renderLiveWarn(data);
    // E4 — Devil's-Advocate / Counter-Evidence (P13, 2026-05-27). Eigene
    // Card NACH der Synthesis (gated), NICHT in den Synthesis-Stream
    // gemischt. Rotes Flag wenn These nicht falsifizierbar.
    case 'counter-evidence':
      return renderCounterEvidence(data);
    // Owner-Fix Run-Cockpit (2026-05-28) — aggregierte Master-Surface, die
    // die simultane Emission von sub-workstreams + iterate-pipeline +
    // iterate-version zu einer EINEN verfolgbaren Card buendelt. Mount
    // registriert den Coord-Key im RunCockpitRegistry → die 3 Legacy-Cards
    // supprimieren sich solange die Cockpit-Card im Strom lebt.
    case 'run-cockpit':
      return renderRunCockpit(data);
    // Slice C (2026-05-29) — Discovery-Phase VOR Plan-Decompose.
    // SECURITY: kein secret in der Payload; WebFetch nur auf vom Owner explizit
    // genannte öffentliche URLs (N2 unberührt).
    case 'discovery':
      return renderDiscovery(data);
    // A4 (2026-05-29) — Merge-Offer-Surface (klickbarer Operator-Merge-Gate).
    // „In Live mergen" → POST /api/workstreams/[id]/merge-run {} ist die
    // EINZIGE Schreib-Aktion (R3 Human-Gate). „Diff ansehen" ist read-only.
    // SECURITY: kein Secret in der Payload.
    case 'merge-offer':
      return renderMergeOffer(data);
    // A3/R7 (2026-05-29) — Project-Truth-Surface (langlebiger Lese-Anker).
    // Bündelt Vision/Decisions/Beliefs/Open-Unknowns/Widersprüche; NICHT-
    // interaktiv, collapsibel. SECURITY: kein Secret in der Payload.
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
// Manifestation-Layer-Helper (Owner-Wunsch 2026-05-30)
// ---------------------------------------------------------------------------
//
// Owner-Wunsch (verbatim-nah): „Surface/Manifestation-Layer-Helper oder so, der
// ggf. korrigiert oder wenn etwas nicht visualisiert wird, dass man direkt neues
// Surface generieren drücken kann mit einem Icon Magic-Stift was weiß ich?!"
//
// `renderSurfaceOrHelper` ist die EINE Stelle, die der Render-Pfad
// (surface-text-render.tsx) am Nicht-Render-Punkt aufruft. Sie versucht das
// normale Rendering und ersetzt den alten nackten Tag-Text-Fallback durch die
// Magic-Wand-Affordanz (`SurfaceHelperAffordance`), sobald NICHTS Sichtbares
// herauskam — die drei realen Nicht-Render-Fälle:
//
//   • render-null   — `renderSurface(kind, data)` gab `null` zurück (Payload
//                     unvollständig/leer, oder ein noch-nicht-implementierter
//                     Kind wie 'onboarding-progress').
//   • parse-error   — `data === null` signalisiert, dass das Surface-JSON
//                     nicht geparst werden konnte (Caller setzt data=null).
//   • unknown-kind  — der Kind ist nicht in der SURFACE_KINDS-Whitelist.
//
// Additiv & minimal-invasiv: bestehende Renderpfade sind unberührt — diese
// Funktion wird NUR im else-Zweig (Nicht-Render) der beiden renderChatText-
// Varianten aufgerufen.

import { SurfaceHelperAffordance } from './SurfaceHelperAffordance';

function isKnownSurfaceKind(kind: string): kind is SurfaceKind {
  return (SURFACE_KINDS as readonly string[]).includes(kind);
}

/**
 * Rendert ein Surface — und bei Nicht-Render die Magic-Wand-Affordanz statt
 * des nackten Tag-Texts. `data === null` wird als parse-error interpretiert
 * (der Caller setzt data=null, wenn JSON.parse scheiterte).
 *
 * @param kind  der (ggf. unbekannte) Surface-Kind als roher String
 * @param data  geparste Payload, oder `null` bei Parse-Fehler
 * @param raw   der rohe `<surface:…>…</surface:…>`-Tag (Kontext für Re-Gen)
 */
export function renderSurfaceOrHelper(
  kind: string,
  data: unknown,
  raw: string,
): ReactNode {
  // (c) unknown-kind — nicht whitelisted.
  if (!isKnownSurfaceKind(kind)) {
    return (
      <SurfaceHelperAffordance reason="unknown-kind" kind={kind} raw={raw} />
    );
  }
  // (b) parse-error — Caller signalisiert via data === null.
  if (data === null) {
    return (
      <SurfaceHelperAffordance reason="parse-error" kind={kind} raw={raw} />
    );
  }
  // Normaler Pfad.
  let rendered: ReactNode = null;
  try {
    rendered = renderSurface(kind, data);
  } catch {
    rendered = null;
  }
  if (rendered != null) return rendered;
  // (a) render-null — Renderer gab nichts Sichtbares zurück.
  return <SurfaceHelperAffordance reason="render-null" kind={kind} raw={raw} />;
}
