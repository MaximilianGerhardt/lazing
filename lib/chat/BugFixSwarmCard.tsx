'use client';

/**
 * BugFixSwarmCard — Sprint H (2026-04-30).
 *
 * User complaint 2026-04-30 (verbatim):
 *   „Bug rein, der labert da rum, statt selber zu fixen... Auch hier hätte
 *   ich mir eine Swarming-Analyse gewünscht — 2-3 Modelle wenn die nichts
 *   finden oder konsens haben weiter. Aber auch am besten parallel."
 *
 * Phase visualization:
 *   1. Diagnose      — 3 avatars in parallel (senior-dev + code-reviewer + critic)
 *                      with a live status pill (running/done/failed). Each
 *                      diagnosis collapsible: hypothesis + file:line + reproducer.
 *   2. Konsens       — pill „Konsens" or „Disagreement". On disagreement:
 *                      the 3 hypotheses as QuickChoice buttons.
 *   3. Fix           — live status („senior-dev fixt …" → „committed: SHA").
 *   4. Root-Cause    — collapsible section: „Was war es? / Was hat es gebrochen?
 *                      / Wie verhindern wir das?".
 *
 * Polling: /api/bugs/swarm/[id] every 2s while running, then 30s.
 *
 * Wave 4.4 (2026-05-01): inline styles → CSS classes `.srf-bugfix__*` (token-bind).
 *   Dynamic pill accents via [data-phase] / [data-status] on the pills,
 *   --pill-accent as a CSS custom prop.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';

import { useSurfaceAction } from './SurfaceActionContext';
import { IconChevronDown, IconChevronRight, IconCheck } from '../nav/icons';

const ROLES = ['senior-dev', 'code-reviewer', 'critic'] as const;
type Role = (typeof ROLES)[number];

type Phase =
  | 'diagnose'
  | 'consensus'
  | 'disagreement'
  | 'sweep'
  | 'fix'
  | 'rootcause'
  | 'done'
  | 'failed';
type Status = 'pending' | 'running' | 'done' | 'failed';

/**
 * Phase 5.5 sweep data for the UI (Sprint H+ · 2026-05-03).
 * Backend shape mirrors SweepResult from lib/agents/pattern-sweep.ts —
 * the UI card shows aggregates, no detail lists.
 */
interface SweepShape {
  status: Status;
  patternMatchCount: number;
  callerCount: number;
  highRiskCallerCount: number;
  suggestedTestCount: number;
  /** If a re-plan was triggered, here is the count. */
  replanCount?: number;
}

interface DiagnosisShape {
  role: Role;
  status: Status;
  hypothesis?: string;
  file?: string;
  line?: number;
  reproducer?: string;
  confidence?: number;
  raw?: string;
}

interface RootCauseShape {
  what?: string;
  whatBroke?: string;
  prevention?: string;
}

interface SwarmStatusShape {
  swarmId: string;
  workspaceId: string;
  workstreamId: string;
  masterTicketId: string;
  bugDescription: string;
  phase: Phase;
  diagnoses: DiagnosisShape[];
  consensusFile?: string;
  consensusLine?: number;
  hypothesesForChoice?: Array<{ id: string; label: string; sublabel?: string }>;
  fixCommitSha?: string;
  fixSummary?: string;
  fixStatus?: Status;
  /** Phase 5.5 — pattern sweep + caller graph (Sprint H+ · 2026-05-03). */
  sweep?: SweepShape;
  rootCause?: RootCauseShape;
  startedAt?: number;
  finishedAt?: number;
}

interface Props {
  swarmId: string;
  workspaceId: string;
  workstreamId: string;
  masterTicketId: string;
  bugDescription: string;
}

const ACTIVE_TICK_MS = 2000;
const IDLE_TICK_MS = 30_000;

function isActivePhase(p: Phase): boolean {
  return p === 'diagnose' || p === 'sweep' || p === 'fix' || p === 'rootcause';
}

function BugFixSwarmCardImpl({
  swarmId,
  workspaceId,
  workstreamId,
  masterTicketId,
  bugDescription,
}: Props) {
  const { reply } = useSurfaceAction();

  const [state, setState] = useState<SwarmStatusShape>(() => ({
    swarmId,
    workspaceId,
    workstreamId,
    masterTicketId,
    bugDescription,
    phase: 'diagnose',
    diagnoses: ROLES.map((role) => ({ role, status: 'pending' })),
  }));
  const [openRoles, setOpenRoles] = useState<Record<Role, boolean>>({
    'senior-dev': false,
    'code-reviewer': false,
    critic: false,
  });
  const [openRootCause, setOpenRootCause] = useState(false);

  // Polling: 2s while running, 30s otherwise.
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    async function tick(): Promise<void> {
      try {
        const res = await fetch(
          `/api/bugs/swarm/${encodeURIComponent(swarmId)}`,
          { credentials: 'same-origin', cache: 'no-store' },
        );
        if (!res.ok) return;
        const data = (await res.json()) as SwarmStatusShape;
        if (cancelled) return;
        setState(data);
      } catch {
        /* offline-tolerant */
      } finally {
        if (!cancelled) {
          const intervalMs = isActivePhase(state.phase) ? ACTIVE_TICK_MS : IDLE_TICK_MS;
          timer = window.setTimeout(tick, intervalMs);
        }
      }
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
    // state.phase as a dep would be unstable — we use the value at schedule time
    // and accept up to 30s latency on a phase change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swarmId]);

  const toggleRole = useCallback((role: Role) => {
    setOpenRoles((prev) => ({ ...prev, [role]: !prev[role] }));
  }, []);

  const handleHypothesisChoice = useCallback(
    (id: string, label: string) => {
      // On disagreement: the user picks one of the 3 hypotheses → the server
      // triggers the fix spawn based on that choice. We speak into the chat via
      // reply() so the choice is visible in the history.
      reply(`Bug-Swarm: weiter mit Hypothese ${label}`);
      void fetch(`/api/bugs/swarm/${encodeURIComponent(swarmId)}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ chosenHypothesisId: id }),
      }).catch(() => undefined);
    },
    [reply, swarmId],
  );

  const phaseTitle = useMemo(() => phaseLabel(state.phase), [state.phase]);
  const stepperSteps = useMemo(() => buildStepperSteps(state.phase), [state.phase]);

  return (
    <div
      className="srf-bugfix"
      role="region"
      aria-label={`Bug-Fix-Swarm ${swarmId}`}
    >
      <div className="srf-bugfix__header">
        <span className="srf-bugfix__badge">Bug-Fix-Swarm</span>
        <h3 className="srf-bugfix__title">3 Modelle diagnostizieren parallel</h3>
        <p className="srf-bugfix__sub" title={bugDescription}>
          {trim(bugDescription, 180)}
        </p>
        <div
          className="srf-bugfix__phase-pill"
          data-phase={state.phase}
        >
          {phaseTitle}
        </div>
      </div>

      <PhaseStepper steps={stepperSteps} />


      {/* Phase 1: diagnosis */}
      <div className="srf-bugfix__section">
        <div className="srf-bugfix__section-header">1. Diagnose</div>
        <div className="srf-bugfix__diag-grid">
          {state.diagnoses.map((d) => (
            <DiagnosisRow
              key={d.role}
              diag={d}
              open={openRoles[d.role]}
              onToggle={() => toggleRole(d.role)}
            />
          ))}
        </div>
      </div>

      {/* Phase 2: consensus */}
      {(state.phase === 'consensus' ||
        state.phase === 'disagreement' ||
        state.phase === 'fix' ||
        state.phase === 'rootcause' ||
        state.phase === 'done') && (
        <div className="srf-bugfix__section">
          <div className="srf-bugfix__section-header">2. Konsens</div>
          {state.phase === 'disagreement' ? (
            <>
              <div className="srf-bugfix__disagreement-text">
                Die 3 Diagnose-Modelle widersprechen sich in der Root-Cause.
                Wähle die Hypothese, die der Fix-Spawn priorisieren soll —
                Klick startet den Fix sofort:
              </div>
              <div className="srf-bugfix__choice-grid">
                {(state.hypothesesForChoice ?? []).map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    className="srf-bugfix__choice-btn"
                    onClick={() => handleHypothesisChoice(h.id, h.label)}
                  >
                    <div className="srf-bugfix__choice-label">{h.label}</div>
                    {h.sublabel ? (
                      <div className="srf-bugfix__choice-sub">{h.sublabel}</div>
                    ) : null}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="srf-bugfix__consensus-ok">
              <span className="srf-bugfix__consensus-pill">Konsens</span>
              {state.consensusFile ? (
                <span className="srf-bugfix__consensus-file">
                  {state.consensusFile}
                  {state.consensusLine ? `:${state.consensusLine}` : ''}
                </span>
              ) : null}
            </div>
          )}
        </div>
      )}

      {/* Phase 2.5: sweep + caller graph (Sprint H+ · 2026-05-03) */}
      {state.sweep &&
        (state.phase === 'sweep' ||
          state.phase === 'fix' ||
          state.phase === 'rootcause' ||
          state.phase === 'done') && <SweepSection sweep={state.sweep} />}

      {/* Phase 3: Fix */}
      {(state.phase === 'fix' ||
        state.phase === 'rootcause' ||
        state.phase === 'done') && (
        <div className="srf-bugfix__section">
          <div className="srf-bugfix__section-header">3. Fix</div>
          <div className="srf-bugfix__fix-row">
            <span
              className="srf-bugfix__status-pill"
              data-status={state.fixStatus ?? 'pending'}
            >
              {fixStatusLabel(state.fixStatus ?? 'pending')}
            </span>
            {state.fixCommitSha ? (
              <a
                href={`#commit-${state.fixCommitSha}`}
                className="srf-bugfix__commit-link"
                onClick={(e) => {
                  e.preventDefault();
                  // Future: link to commit view in /workstreams/[id]
                }}
              >
                {state.fixCommitSha.slice(0, 8)}
              </a>
            ) : null}
            {state.fixSummary ? (
              <span className="srf-bugfix__fix-summary">
                {trim(state.fixSummary, 200)}
              </span>
            ) : null}
          </div>
        </div>
      )}

      {/* Phase 4: Root-Cause */}
      {state.phase === 'done' && state.rootCause && (
        <div className="srf-bugfix__section">
          <button
            type="button"
            className="srf-bugfix__rootcause-toggle"
            onClick={() => setOpenRootCause((v) => !v)}
            aria-expanded={openRootCause}
          >
            <span className="srf-bugfix__section-header">
              4. Wie konnte das passieren?
            </span>
            <span className="srf-bugfix__chevron">
              {openRootCause ? (
                <IconChevronDown size={12} />
              ) : (
                <IconChevronRight size={12} />
              )}
            </span>
          </button>
          {openRootCause && (
            <div className="srf-bugfix__rootcause-body">
              <RootCauseLine label="Was war es?" text={state.rootCause.what} />
              <RootCauseLine
                label="Was hat es gebrochen?"
                text={state.rootCause.whatBroke}
              />
              <RootCauseLine
                label="Wie verhindern wir das nächste Mal?"
                text={state.rootCause.prevention}
              />
            </div>
          )}
        </div>
      )}

      {state.phase === 'failed' && (
        <div className="srf-bugfix__failed">
          Swarm fehlgeschlagen. Ticket {masterTicketId} bleibt offen.
        </div>
      )}
    </div>
  );
}

export const BugFixSwarmCard = memo(
  BugFixSwarmCardImpl,
  (prev, next) =>
    prev.swarmId === next.swarmId &&
    prev.workspaceId === next.workspaceId &&
    prev.workstreamId === next.workstreamId &&
    prev.masterTicketId === next.masterTicketId &&
    prev.bugDescription === next.bugDescription,
);

// ---------------------------------------------------------------------------
// Sub-Components
// ---------------------------------------------------------------------------

function DiagnosisRow({
  diag,
  open,
  onToggle,
}: {
  diag: DiagnosisShape;
  open: boolean;
  onToggle: () => void;
}): ReactElement {
  const hasDetails =
    Boolean(diag.hypothesis) ||
    Boolean(diag.file) ||
    Boolean(diag.reproducer) ||
    Boolean(diag.raw);
  return (
    <div className="srf-bugfix__diag-row">
      <button
        type="button"
        className="srf-bugfix__diag-header"
        onClick={hasDetails ? onToggle : undefined}
        aria-expanded={open}
        disabled={!hasDetails}
      >
        <span className="srf-bugfix__diag-avatar">{avatarGlyph(diag.role)}</span>
        <span className="srf-bugfix__diag-role">{roleLabel(diag.role)}</span>
        <span
          className="srf-bugfix__status-pill"
          data-status={diag.status}
        >
          {statusLabel(diag.status)}
        </span>
        {hasDetails ? (
          <span className="srf-bugfix__chevron--small">
            {open ? (
              <IconChevronDown size={11} />
            ) : (
              <IconChevronRight size={11} />
            )}
          </span>
        ) : null}
      </button>
      {open && hasDetails ? (
        <div className="srf-bugfix__diag-body">
          {diag.hypothesis ? (
            <DetailLine label="Hypothese" text={diag.hypothesis} />
          ) : null}
          {diag.file ? (
            <DetailLine
              label="Datei"
              text={`${diag.file}${diag.line ? `:${diag.line}` : ''}`}
              mono
            />
          ) : null}
          {diag.reproducer ? (
            <DetailLine label="Reproducer" text={diag.reproducer} mono />
          ) : null}
          {typeof diag.confidence === 'number' ? (
            <DetailLine
              label="Confidence"
              text={`${Math.round(diag.confidence * 100)}%`}
            />
          ) : null}
          {diag.raw && !diag.hypothesis ? (
            <DetailLine label="Output" text={trim(diag.raw, 600)} mono />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DetailLine({
  label,
  text,
  mono,
}: {
  label: string;
  text: string;
  mono?: boolean;
}): ReactElement {
  return (
    <div className="srf-bugfix__detail-line">
      <span className="srf-bugfix__detail-label">{label}</span>
      <span
        className={
          mono
            ? 'srf-bugfix__detail-text srf-bugfix__detail-text--mono'
            : 'srf-bugfix__detail-text'
        }
      >
        {text}
      </span>
    </div>
  );
}

function RootCauseLine({
  label,
  text,
}: {
  label: string;
  text: string | undefined;
}): ReactElement | null {
  if (!text || text.trim().length === 0) return null;
  return (
    <div className="srf-bugfix__rootcause-line">
      <div className="srf-bugfix__rootcause-label">{label}</div>
      <div className="srf-bugfix__rootcause-text">{text}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trim(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function avatarGlyph(role: Role): string {
  switch (role) {
    case 'senior-dev':
      return 'S';
    case 'code-reviewer':
      return 'R';
    case 'critic':
      return 'C';
  }
}

function roleLabel(role: Role): string {
  switch (role) {
    case 'senior-dev':
      return 'senior-dev';
    case 'code-reviewer':
      return 'code-reviewer';
    case 'critic':
      return 'critic';
  }
}

function statusLabel(s: Status): string {
  switch (s) {
    case 'pending':
      return 'wartet';
    case 'running':
      return 'läuft';
    case 'done':
      return 'fertig';
    case 'failed':
      return 'fehler';
  }
}

function fixStatusLabel(s: Status): string {
  switch (s) {
    case 'pending':
      return 'wartet auf Konsens';
    case 'running':
      return 'senior-dev fixt …';
    case 'done':
      return 'committed';
    case 'failed':
      return 'fix fehlgeschlagen';
  }
}

function phaseLabel(p: Phase): string {
  switch (p) {
    case 'diagnose':
      return 'Phase 1 · Diagnose läuft';
    case 'consensus':
      return 'Phase 2 · Konsens erreicht';
    case 'disagreement':
      return 'Phase 2 · Disagreement — Wahl nötig';
    case 'sweep':
      return 'Phase 2.5 · Pattern-Sweep läuft';
    case 'fix':
      return 'Phase 3 · Fix läuft';
    case 'rootcause':
      return 'Phase 4 · Root-Cause-Analyse läuft';
    case 'done':
      return 'Fertig';
    case 'failed':
      return 'Fehlgeschlagen';
  }
}

/**
 * SweepSection — Phase 5.5 visualization.
 *
 * Display logic (per user request 2026-05-03):
 *   - 0 patternMatches + 0 high-risk callers -> green check, "no additional risk"
 *   - patternMatches > 0 -> "X potential pattern repetitions — co-fixed in the same fix"
 *   - high-risk callers > 0 -> orange warning "Y callers could break — re-plan"
 */
function SweepSection({ sweep }: { sweep: SweepShape }): ReactElement {
  const noRisk =
    sweep.patternMatchCount === 0 && sweep.highRiskCallerCount === 0;
  const hasHighRisk = sweep.highRiskCallerCount > 0;
  const tone: 'ok' | 'warn' | 'info' = noRisk
    ? 'ok'
    : hasHighRisk
    ? 'warn'
    : 'info';

  return (
    <div className="srf-bugfix__section srf-bugfix__sweep" data-tone={tone}>
      <div className="srf-bugfix__section-header">
        2.5 Pattern-Sweep + Caller-Graph
      </div>
      <div className="srf-bugfix__sweep-row">
        <span
          className="srf-bugfix__status-pill"
          data-status={sweep.status}
        >
          {statusLabel(sweep.status)}
        </span>
        {noRisk ? (
          <span className="srf-bugfix__sweep-text">
            Kein zusätzliches Risiko gefunden — Bug ist isoliert.
          </span>
        ) : null}
        {!noRisk && sweep.patternMatchCount > 0 ? (
          <span className="srf-bugfix__sweep-text">
            {sweep.patternMatchCount}{' '}
            {sweep.patternMatchCount === 1
              ? 'potenzielle Pattern-Wiederholung'
              : 'potenzielle Pattern-Wiederholungen'}{' '}
            gefunden — werden im selben Fix mitgenommen
          </span>
        ) : null}
        {hasHighRisk ? (
          <span className="srf-bugfix__sweep-warning">
            {sweep.highRiskCallerCount}{' '}
            {sweep.highRiskCallerCount === 1
              ? 'Caller könnte brechen'
              : 'Caller könnten brechen'}{' '}
            — Re-Plan ausgelöst
          </span>
        ) : null}
      </div>
      {sweep.suggestedTestCount > 0 ? (
        <div className="srf-bugfix__sweep-meta">
          {sweep.suggestedTestCount} neue Pattern-Test
          {sweep.suggestedTestCount === 1 ? '' : 's'} vorgeschlagen
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase stepper (Wave 5 lib/ui/pip · 2026-05-01)
// 8-phase pipeline visualization. Maps the existing 4-phase state
// (diagnose/consensus/fix/rootcause) onto the more granular 8 phases of the
// new bug-fix pipeline. Backwards-compat: for old bug swarms without
// pipeline data we only show the first 4 steps.
// ---------------------------------------------------------------------------

const STEPPER_PHASES = [
  { key: 'detect', label: 'Detect', short: '1' },
  { key: 'analyze', label: 'Analyze', short: '2' },
  { key: 'hypothesize', label: 'Hypothesize', short: '3' },
  { key: 'plan', label: 'Plan', short: '4' },
  { key: 'critic', label: 'Critic', short: '5' },
  { key: 'sweep', label: 'Sweep', short: '5.5' },
  { key: 'fix', label: 'Fix', short: '6' },
  { key: 'verify', label: 'Verify', short: '7' },
  { key: 'audit', label: 'Audit', short: '8' },
] as const;

type StepKey = (typeof STEPPER_PHASES)[number]['key'];
type StepStatus = 'pending' | 'running' | 'done' | 'failed';

interface StepperStep {
  key: StepKey;
  label: string;
  short: string;
  status: StepStatus;
}

/**
 * Maps the existing 4-phase state onto the 8-phase pipeline.
 * All steps before the current phase are marked 'done',
 * the current one 'running', everything after 'pending'.
 *
 * Failure: all previously done steps stay done, the current one becomes failed.
 * Disagreement: critic is the decision point → critic=running.
 */
export function buildStepperSteps(currentPhase: Phase): StepperStep[] {
  // Mapping from the old 4-phase model onto the 8-phase stepper.
  // diagnose       → analyze + hypothesize running
  // consensus      → plan is done, critic is running
  // disagreement   → plan done, critic blocking on the user choice
  // fix            → fix running, critic done
  // rootcause      → verify running (root-cause = post-fix analysis, maps
  //                   most closely to verify in the new taxonomy)
  // done           → audit done
  // failed         → last active step failed

  const phaseToActiveStep: Record<Phase, StepKey | 'done-all'> = {
    diagnose: 'hypothesize',
    consensus: 'critic',
    disagreement: 'critic',
    sweep: 'sweep',
    fix: 'fix',
    rootcause: 'verify',
    done: 'done-all',
    failed: 'audit', // last step is marked below
  };

  const activeStep = phaseToActiveStep[currentPhase];
  const failed = currentPhase === 'failed';

  // detect is always done (otherwise the card would not be here).
  return STEPPER_PHASES.map((s, idx) => {
    if (activeStep === 'done-all') {
      return { ...s, status: 'done' as StepStatus };
    }
    const activeIdx = STEPPER_PHASES.findIndex((p) => p.key === activeStep);
    if (idx < activeIdx) {
      return { ...s, status: 'done' as StepStatus };
    }
    if (idx === activeIdx) {
      return { ...s, status: failed ? ('failed' as StepStatus) : ('running' as StepStatus) };
    }
    return { ...s, status: 'pending' as StepStatus };
  });
}

/**
 * IconCross — failed-step mark (replaces the hardcoded „×" glyph in the
 * stepper badge). Inline & local (avoids a cross-file icon edit during the
 * glyph-sweep). Inherits currentColor + matches the 1.6 stroke / round-cap
 * weight of the shared nav icons; aria-hidden (decorative — the step's
 * data-status + label carry the semantics).
 */
function IconCross({ size = 12 }: { size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable={false}
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function PhaseStepper({ steps }: { steps: ReadonlyArray<StepperStep> }): ReactElement {
  // Mobile fix 2026-05-28: owner directive „Swarm Übersicht mobil gebrochen".
  // At ≤ 640px the stepper becomes a horizontal scroll-snap row. So that
  // the running phase stays visible, we gently scroll the active chip into
  // view after every status change. On desktop this is a no-op because
  // overflow:visible (scrollIntoView only affects scroll containers).
  const stepperRef = useRef<HTMLDivElement | null>(null);
  const activeIdx = steps.findIndex((s) => s.status === 'running');
  useEffect(() => {
    if (activeIdx < 0) return;
    const container = stepperRef.current;
    if (!container) return;
    // Only scroll if the container is scrollable at all (= mobile).
    if (container.scrollWidth <= container.clientWidth) return;
    const child = container.children[activeIdx] as HTMLElement | undefined;
    if (!child) return;
    // Gentle scroll into view — inline:center stops at the snap point.
    try {
      child.scrollIntoView({
        behavior: 'smooth',
        inline: 'center',
        block: 'nearest',
      });
    } catch {
      // Older engines fall back silently.
    }
  }, [activeIdx]);

  return (
    <div
      ref={stepperRef}
      className="srf-bugfix__phase-stepper"
      role="list"
      aria-label="Bug-Fix-Pipeline-Phasen"
    >
      {steps.map((step, idx) => (
        <div
          key={step.key}
          className="srf-bugfix__phase-step"
          data-status={step.status}
          role="listitem"
          aria-current={step.status === 'running' ? 'step' : undefined}
        >
          <div className="srf-bugfix__phase-step-num">
            {step.status === 'done' ? (
              <IconCheck size={12} />
            ) : step.status === 'failed' ? (
              <IconCross size={12} />
            ) : (
              step.short
            )}
          </div>
          <div className="srf-bugfix__phase-step-label">{step.label}</div>
          {idx < steps.length - 1 ? (
            <div className="srf-bugfix__phase-step-connector" aria-hidden="true" />
          ) : null}
        </div>
      ))}
    </div>
  );
}
