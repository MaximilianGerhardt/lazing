'use client';

/**
 * BugFixSwarmCard — Sprint H (2026-04-30).
 *
 * User-Beschwerde 2026-04-30 (verbatim):
 *   „Bug rein, der labert da rum, statt selber zu fixen... Auch hier hätte
 *   ich mir eine Swarming-Analyse gewünscht — 2-3 Modelle wenn die nichts
 *   finden oder konsens haben weiter. Aber auch am besten parallel."
 *
 * Phasen-Visualisierung:
 *   1. Diagnose      — 3 Avatars parallel (senior-dev + code-reviewer + critic)
 *                      mit Live-Status-Pill (running/done/failed). Jede
 *                      Diagnose collapsible: Hypothesis + File:Line + Reproducer.
 *   2. Konsens       — Pill „Konsens" oder „Disagreement". Bei Disagreement:
 *                      die 3 Hypothesen als QuickChoice-Buttons.
 *   3. Fix           — Live-Status („senior-dev fixt …" → „committed: SHA").
 *   4. Root-Cause    — collapsible Section: „Was war es? / Was hat es gebrochen?
 *                      / Wie verhindern wir das?".
 *
 * Polling: /api/bugs/swarm/[id] alle 2s während running, dann 30s.
 *
 * Welle 4.4 (2026-05-01): Inline-Styles → CSS-Klassen `.srf-bugfix__*` (Token-bind).
 *   Dynamische Pill-Akzente via [data-phase] / [data-status] auf den Pills,
 *   --pill-accent als CSS-Custom-Prop.
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
 * Phase 5.5 Sweep-Daten für UI (Sprint H+ · 2026-05-03).
 * Backend-Shape spiegelt SweepResult aus lib/agents/pattern-sweep.ts —
 * UI-Card zeigt Aggregate, keine Detail-Listen.
 */
interface SweepShape {
  status: Status;
  patternMatchCount: number;
  callerCount: number;
  highRiskCallerCount: number;
  suggestedTestCount: number;
  /** Wenn re-plan getriggert wurde, hier ist die Anzahl. */
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
  /** Phase 5.5 — Pattern-Sweep + Caller-Graph (Sprint H+ · 2026-05-03). */
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

  // Polling: 2s während running, 30s sonst.
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
    // state.phase als Dep wäre instabil — wir nutzen den Wert beim Schedule
    // und akzeptieren bis zu 30s Latenz beim Phasenwechsel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swarmId]);

  const toggleRole = useCallback((role: Role) => {
    setOpenRoles((prev) => ({ ...prev, [role]: !prev[role] }));
  }, []);

  const handleHypothesisChoice = useCallback(
    (id: string, label: string) => {
      // Bei Disagreement: User wählt eine der 3 Hypothesen → Server triggert
      // Fix-Spawn auf Basis dieser Wahl. Wir reden via reply() in den Chat,
      // damit die Wahl im Verlauf sichtbar ist.
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


      {/* Phase 1: Diagnose */}
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

      {/* Phase 2: Konsens */}
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

      {/* Phase 2.5: Sweep + Caller-Graph (Sprint H+ · 2026-05-03) */}
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
 * SweepSection — Phase 5.5 Visualisierung.
 *
 * Display-Logik (per User-Wunsch 2026-05-03):
 *   - 0 patternMatches + 0 high-risk-Caller -> grüner Check, "kein zusätzliches Risiko"
 *   - patternMatches > 0 -> "X potenzielle Pattern-Wiederholungen — werden im selben Fix mitgenommen"
 *   - high-risk Caller > 0 -> orange Warning "Y Caller könnten brechen — Re-Plan"
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
// Phase-Stepper (Welle 5 lib/ui/pip · 2026-05-01)
// 8-Phasen-Pipeline-Visualisierung. Mappt das bestehende 4-Phasen-State
// (diagnose/consensus/fix/rootcause) auf die granulareren 8 Phasen der
// neuen Bug-Fix-Pipeline. Backwards-compat: bei alten Bug-Swarms ohne
// Pipeline-Daten zeigen wir nur die ersten 4 Steps.
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
 * Mappt das bestehende 4-Phasen-State auf die 8-Phasen-Pipeline.
 * Alle Steps vor der aktuellen Phase werden als 'done' markiert,
 * die aktuelle als 'running', alle danach als 'pending'.
 *
 * Failure: alle bisherigen done bleiben done, aktuelle wird failed.
 * Disagreement: critic ist der Decision-Point → critic=running.
 */
export function buildStepperSteps(currentPhase: Phase): StepperStep[] {
  // Mapping vom alten 4-Phasen-Modell auf den 8-Phasen-Stepper.
  // diagnose       → analyze + hypothesize laufen
  // consensus      → plan ist done, critic ist running
  // disagreement   → plan done, critic blocking auf User-Wahl
  // fix            → fix läuft, critic done
  // rootcause      → verify läuft (root-cause = post-fix-analyse, mappt
  //                   am ehesten auf verify in der neuen Taxonomie)
  // done           → audit done
  // failed         → letzter aktiver Step failed

  const phaseToActiveStep: Record<Phase, StepKey | 'done-all'> = {
    diagnose: 'hypothesize',
    consensus: 'critic',
    disagreement: 'critic',
    sweep: 'sweep',
    fix: 'fix',
    rootcause: 'verify',
    done: 'done-all',
    failed: 'audit', // letzter Step wird unten markiert
  };

  const activeStep = phaseToActiveStep[currentPhase];
  const failed = currentPhase === 'failed';

  // detect ist immer done (sonst wäre die Card nicht da).
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
  // Mobile-Fix 2026-05-28: Owner-Direktive „Swarm Übersicht mobil gebrochen".
  // Auf ≤ 640px wird der Stepper zu einem horizontalen Scroll-Snap-Row. Damit
  // die laufende Phase sichtbar bleibt, scrollen wir das aktive Chip nach jeder
  // Status-Änderung sanft in den View. Auf Desktop ist das ein No-Op weil
  // overflow:visible ist (scrollIntoView wirkt nur auf scroll-Container).
  const stepperRef = useRef<HTMLDivElement | null>(null);
  const activeIdx = steps.findIndex((s) => s.status === 'running');
  useEffect(() => {
    if (activeIdx < 0) return;
    const container = stepperRef.current;
    if (!container) return;
    // Nur scrollen wenn der Container überhaupt scrollbar ist (= Mobile).
    if (container.scrollWidth <= container.clientWidth) return;
    const child = container.children[activeIdx] as HTMLElement | undefined;
    if (!child) return;
    // Sanftes Scroll-into-View — Inline:center stoppt am Snap-Point.
    try {
      child.scrollIntoView({
        behavior: 'smooth',
        inline: 'center',
        block: 'nearest',
      });
    } catch {
      // Ältere Engines fallen still zurück.
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
