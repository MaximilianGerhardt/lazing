'use client';

/**
 * ConsensusActionCard — Phase AC.3 (2026-04-26)
 *
 * Rendered below the synthesis bubble. Three modes depending on consensus:
 *   - strong: 30s countdown, stop button, then auto-POST start-dispatch
 *   - majority: "Los" button + "Outlier ansehen" link
 *   - disagreement: cluster listing + master link, no auto
 *
 * User wish verbatim 2026-04-26:
 *   "konsens ist konsens nur ausreisser ggf besprechen und quick start
 *    möglichkeit"
 *
 * Wave 3.5a (2026-05-01) — refactored: inline styles → CSS classes + token bind.
 *   Logic stays UNCHANGED. Layout migration only.
 */

import { memo, useEffect, useRef, useState } from 'react';

import { IntentPill } from '@/lib/ui/pil';
import type { WorkstreamIntent } from '@/lib/workstreams/intent-classifier';

import { IconChevronDown, IconChevronRight } from '../nav/icons';
import { useSurfaceAction } from './SurfaceActionContext';

export type ConsensusLevel = 'strong' | 'majority' | 'disagreement';

/**
 * Sub-Plan 04 (2026-04-29) — outliers inline instead of external.
 * User veto (verbatim): „Outlier ansehen führt zu Detail-Page mit zu viel Lärm.
 * Outlier müssen DIREKT in der Card sein."
 */
export interface OutlierCluster {
  cluster: string;
  summary: string;
}

/** Sub-Plan 05 (2026-04-29): sub-tickets inline in the card. */
export interface SubTicketLite {
  title: string;
  prio?: string;
}

interface Props {
  workstreamId: string;
  consensusLevel: ConsensusLevel;
  masterTicketId?: string;
  initialDispatched?: boolean;
  outliers?: OutlierCluster[];
  /** Sub-Plan 05 — sub-tickets list IN the card (collapsible). */
  subTickets?: SubTicketLite[];
  /** Sub-Plan 05 — plan markdown for the "ansehen" toggle. */
  planText?: string;
  /**
   * 2026-05-01 — optional intent marker. Makes idea consensus (roast→synthesis)
   * visually distinguishable from bug-fix consensus (disagreement → cluster).
   */
  intent?: WorkstreamIntent;
}

const COUNTDOWN_SECONDS = 30;

function ConsensusActionCardImpl({
  workstreamId,
  consensusLevel,
  masterTicketId,
  initialDispatched = false,
  outliers,
  subTickets,
  planText,
  intent,
}: Props) {
  const [secondsLeft, setSecondsLeft] = useState(COUNTDOWN_SECONDS);
  const [stopped, setStopped] = useState(false);
  const [dispatched, setDispatched] = useState(initialDispatched);
  const [completed, setCompleted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outliersExpanded, setOutliersExpanded] = useState(false);
  const [subTicketsExpanded, setSubTicketsExpanded] = useState(false);
  const [planExpanded, setPlanExpanded] = useState(false);
  const cancelledRef = useRef(false);

  // Sub-Plan 05 (2026-04-29) — reload persistence.
  // On mount, check whether the master ticket is already approved/executing/closed.
  // The surface-tag payload can be stale because the tag is only written once
  // at emit time. The server state is the single source of truth.
  // Fix 2026-04-30: additionally detect the `completed` state — when the master
  // is closed/executed, the card now shows a done banner, no
  // running banner anymore (UI bug report Demo Fitness).
  useEffect(() => {
    let aborted = false;
    let timer: number | null = null;
    async function probe(): Promise<void> {
      try {
        const res = await fetch(
          `/api/workstreams/${encodeURIComponent(workstreamId)}`,
          { credentials: 'same-origin' },
        );
        if (!res.ok) return;
        const json = (await res.json()) as {
          tickets?: Array<{ id: string; workflowState?: string | null }>;
        };
        if (aborted || cancelledRef.current) return;
        const master = (json.tickets ?? []).find((t) => t.id === masterTicketId);
        const ws = master?.workflowState ?? null;
        if (
          ws === 'approved' ||
          ws === 'executing' ||
          ws === 'executed' ||
          ws === 'closed'
        ) {
          setDispatched(true);
        }
        if (ws === 'closed' || ws === 'executed') {
          setCompleted(true);
        }
      } catch {
        /* offline-tolerant */
      }
    }
    void probe();
    // Re-poll every 15 s as long as dispatched but not completed
    timer = window.setInterval(() => {
      if (cancelledRef.current) return;
      void probe();
    }, 15_000);
    return () => {
      aborted = true;
      if (timer !== null) window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workstreamId, masterTicketId]);

  // Auto-countdown only on strong consensus + not stopped + not already dispatched.
  const shouldAutoCount =
    consensusLevel === 'strong' && !stopped && !dispatched;

  useEffect(() => {
    if (!shouldAutoCount) return;
    if (secondsLeft <= 0) return;
    const t = window.setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => window.clearTimeout(t);
  }, [shouldAutoCount, secondsLeft]);

  // At 0: trigger.
  useEffect(() => {
    if (!shouldAutoCount) return;
    if (secondsLeft > 0) return;
    void triggerDispatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft, shouldAutoCount]);

  async function triggerDispatch(): Promise<void> {
    if (pending || dispatched) return;
    setPending(true);
    setError(null);
    // iOS Polish E.9: subtle haptics hint on the "Los" click (PWA)
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(10);
    }
    try {
      const res = await fetch(
        `/api/workstreams/${encodeURIComponent(workstreamId)}/start-dispatch`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
        },
      );
      // Sub-Plan G (2026-04-30): 409 = lock already held. Another
      // parallel click / tab / auto-trigger is already underway. We mark
      // the card as dispatched (= disabled) and show the info — no
      // new spawn, no double pipeline run.
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          sinceMs?: number;
        };
        if (cancelledRef.current) return;
        const sinceSec = Math.max(0, Math.round((body.sinceMs ?? 0) / 1000));
        setDispatched(true);
        setError(
          sinceSec > 0
            ? `Dispatch läuft bereits (seit ${sinceSec}s)`
            : 'Dispatch läuft bereits',
        );
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`,
        );
      }
      if (cancelledRef.current) return;
      setDispatched(true);
    } catch (err) {
      if (cancelledRef.current) return;
      setError(err instanceof Error ? err.message : 'Fehler beim Start');
    } finally {
      if (!cancelledRef.current) setPending(false);
    }
  }

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const masterHref = masterTicketId
    ? `/tickets/${encodeURIComponent(masterTicketId)}`
    : undefined;

  // 2026-05-01 — Intent-Marker. Zentral hier definiert, in jedem
  // Header slot reused. NULL-safe: no intent, no render.
  const intentPill = intent ? <IntentPill intent={intent} /> : null;

  // ---- Render ----------------------------------------------------------
  // The dispatched state is branched per consensusLevel below (majority has
  // its own auto-dispatch banner with sub-count). Generic fallback only
  // for strong + disagreement.
  if (dispatched && consensusLevel !== 'majority') {
    return (
      <div className="srf-consensus">
        <div className="srf-consensus__header">
          <DotIcon variant="ok" />
          <span className="srf-consensus__title">Pipelines gestartet</span>
          {intentPill}
        </div>
        <div className="srf-consensus__body">
          Sub-Tickets laufen in eigenen Pipelines (senior-dev → reviewer →
          critic). Push wenn der Master fertig ist.
        </div>
        {masterHref ? (
          <a href={masterHref} className="srf-consensus__link">
            Master-Ticket ansehen →
          </a>
        ) : null}
      </div>
    );
  }

  if (consensusLevel === 'strong') {
    return (
      <div className="srf-consensus">
        <div className="srf-consensus__header">
          <DotIcon variant="ok" />
          <span className="srf-consensus__title">Konsens</span>
          {intentPill}
          {!stopped ? (
            <span className="srf-consensus__pill">
              Auto-Start in {secondsLeft}s
            </span>
          ) : (
            <span className="srf-consensus__pill srf-consensus__pill--stopped">
              Gestoppt
            </span>
          )}
        </div>
        <div className="srf-consensus__body">
          Alle Agents waren sich einig. Ich starte die Sub-Pipelines
          gleich automatisch — du musst nichts tun. Klick „Stop" wenn du
          erst draufschauen willst.
        </div>
        <div className="srf-consensus__btn-row">
          {!stopped ? (
            <>
              <button
                type="button"
                onClick={() => setStopped(true)}
                className="srf-consensus__btn-ghost"
              >
                Stop
              </button>
              <button
                type="button"
                onClick={() => void triggerDispatch()}
                disabled={pending}
                className="srf-consensus__btn-primary"
              >
                {pending ? '…' : 'Jetzt starten'}
              </button>
            </>
          ) : (
            <>
              {masterHref ? (
                <a
                  href={masterHref}
                  className="srf-consensus__btn-ghost srf-consensus__link-btn"
                >
                  Master ansehen
                </a>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  setStopped(false);
                  setSecondsLeft(COUNTDOWN_SECONDS);
                }}
                className="srf-consensus__btn-ghost"
              >
                Countdown reaktivieren
              </button>
              <button
                type="button"
                onClick={() => void triggerDispatch()}
                disabled={pending}
                className="srf-consensus__btn-primary"
              >
                {pending ? '…' : 'Jetzt starten'}
              </button>
            </>
          )}
        </div>
        {error ? <div className="srf-consensus__error">{error}</div> : null}
      </div>
    );
  }

  if (consensusLevel === 'majority') {
    const hasOutliers = (outliers ?? []).length > 0;
    const subs = subTickets ?? [];
    const subsCount = subs.length;
    if (dispatched) {
      if (completed) {
        return (
          <div className="srf-consensus">
            <div className="srf-consensus__header">
              <DotIcon variant="ok" />
              <span className="srf-consensus__title">Plan umgesetzt</span>
              {intentPill}
            </div>
            <div className="srf-consensus__body">
              {subsCount > 0
                ? `Alle ${subsCount} Sub-Tickets durchgelaufen (senior-dev → reviewer → critic). Master geschlossen.`
                : 'Sub-Pipelines fertig. Master geschlossen.'}
              {' '}Hinweis: Sub-Agents liefern Skizzen, kein Production-Code.
            </div>
            {masterHref ? (
              <a href={masterHref} className="srf-consensus__link">
                Master-Ticket ansehen →
              </a>
            ) : null}
          </div>
        );
      }
      return (
        <div className="srf-consensus">
          <div className="srf-consensus__header">
            <DotIcon variant="ok" />
            <span className="srf-consensus__title">Auto-Dispatch läuft</span>
            {intentPill}
          </div>
          <div className="srf-consensus__body">
            {subsCount > 0
              ? `${subsCount} Sub-Tickets spawnen autonom (25 s Sniper-Pause vor Spawn — du kannst noch eingreifen).`
              : 'Sub-Pipelines spawnen autonom.'}
          </div>
        </div>
      );
    }
    return (
      <div className="srf-consensus">
        <div className="srf-consensus__header">
          <DotIcon variant="warn" />
          <span className="srf-consensus__title">
            Plan fertig{subsCount > 0 ? ` · ${subsCount} Sub-Tickets bereit` : ''}
          </span>
          {intentPill}
        </div>
        <div className="srf-consensus__body">
          Klick „Los" — Sub-Tickets spawnen autonom (25 s Sniper-Pause vor
          Spawn, in der du noch eingreifen kannst).
        </div>
        <div className="srf-consensus__btn-row">
          <button
            type="button"
            onClick={() => void triggerDispatch()}
            disabled={pending}
            className="srf-consensus__btn-primary"
            autoFocus
          >
            {pending ? '…' : `Los — ${subsCount > 0 ? subsCount : ''} ${subsCount === 1 ? 'Sub spawnen' : 'Subs spawnen'}`}
          </button>
        </div>
        {/* Optionale Toggles — default zugeklappt, niedrige visuelle Last */}
        {(subsCount > 0 || planText || hasOutliers) ? (
          <div className="srf-consensus__toggles-row">
            {subsCount > 0 ? (
              <button
                type="button"
                className="srf-consensus__toggle"
                onClick={() => setSubTicketsExpanded((v) => !v)}
                aria-expanded={subTicketsExpanded}
              >
                {subTicketsExpanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}{' '}Subs ({subsCount})
              </button>
            ) : null}
            {planText ? (
              <button
                type="button"
                className="srf-consensus__toggle"
                onClick={() => setPlanExpanded((v) => !v)}
                aria-expanded={planExpanded}
              >
                {planExpanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}{' '}Plan
              </button>
            ) : null}
            {hasOutliers ? (
              <button
                type="button"
                className="srf-consensus__toggle"
                onClick={() => setOutliersExpanded((v) => !v)}
                aria-expanded={outliersExpanded}
              >
                {outliersExpanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}{' '}Outlier ({outliers!.length})
              </button>
            ) : null}
          </div>
        ) : null}
        {subTicketsExpanded && subsCount > 0 ? (
          <ul className="srf-consensus__outliers-list">
            {subs.map((s, i) => (
              <li key={i} className="srf-consensus__sub-item">
                <span className="srf-consensus__sub-prio">{s.prio ?? 'P2'}</span>
                <span className="srf-consensus__outliers-summary">{s.title}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {planExpanded && planText ? (
          <pre className="srf-consensus__plan-text">{planText.slice(0, 4000)}</pre>
        ) : null}
        {outliersExpanded && hasOutliers ? (
          <ul className="srf-consensus__outliers-list">
            {(outliers ?? []).map((o, i) => (
              <li key={i} className="srf-consensus__outliers-item">
                <span className="srf-consensus__outliers-cluster">{o.cluster}</span>
                <span className="srf-consensus__outliers-summary">{o.summary}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {error ? <div className="srf-consensus__error">{error}</div> : null}
      </div>
    );
  }

  // disagreement
  return (
    <DisagreementBlock
      outliers={outliers ?? []}
      outliersExpanded={outliersExpanded}
      setOutliersExpanded={setOutliersExpanded}
      intent={intent}
    />
  );
}

/**
 * Disagreement block — 2026-05-01 (Bug A · Demo Fitness user finding).
 *
 * Before: generic title "Disagreement" + body "the agents disagree
 * … reply directly in the chat". User quote (verbatim): „Diese Uneinigung ist
 * für mich als Nutzer (Mensch) nichtssagend".
 *
 * Now: concrete title with cluster count, the body names the WHAT question, each
 * cluster has a direct quick-choice button — a click sends a
 * cluster prioritization answer into the chat (via useSurfaceAction.reply),
 * which is passed to the next iterate-roast wave as a user correction.
 *
 * If no clusters are present (edge case): the fallback text stays
 * concrete ("Sub-Agents widersprechen sich") + points to the chat as the
 * reply channel.
 */
function DisagreementBlock({
  outliers,
  outliersExpanded,
  setOutliersExpanded,
  intent,
}: {
  outliers: OutlierCluster[];
  outliersExpanded: boolean;
  setOutliersExpanded: (next: boolean | ((v: boolean) => boolean)) => void;
  intent?: WorkstreamIntent;
}) {
  const { reply } = useSurfaceAction();
  const count = outliers.length;
  const hasClusters = count > 0;
  const title = hasClusters
    ? `Sub-Agents widersprechen sich · ${count} ${count === 1 ? 'Punkt' : 'Punkte'}`
    : 'Sub-Agents widersprechen sich';
  const body = hasClusters
    ? `Bitte entscheide, welcher dieser ${count} ${count === 1 ? 'Punkt' : 'Punkte'} priorisiert wird — der nächste Roast-Lauf richtet sich danach.`
    : 'Die Sub-Agents sind zu keinem klaren Schluss gekommen. Antworte unten im Chat mit der bevorzugten Richtung — der nächste Roast-Lauf greift sie auf.';

  function chooseCluster(c: OutlierCluster): void {
    if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(8);
    reply(`Priorisiere Cluster „${c.cluster}". Begründung: ${c.summary}`);
  }

  return (
    <div className="srf-consensus">
      <div className="srf-consensus__header">
        <DotIcon variant="critical" />
        <span className="srf-consensus__title">{title}</span>
        {intent ? <IntentPill intent={intent} /> : null}
      </div>
      <div className="srf-consensus__body">{body}</div>
      {hasClusters ? (
        <>
          <ul className="srf-consensus__cluster-choices">
            {outliers.map((o, i) => (
              <li key={i} className="srf-consensus__cluster-choice">
                <button
                  type="button"
                  className="srf-consensus__cluster-btn"
                  onClick={() => chooseCluster(o)}
                  aria-label={`Cluster „${o.cluster}" priorisieren`}
                >
                  <span className="srf-consensus__cluster-btn-cluster">
                    {o.cluster}
                  </span>
                  <span className="srf-consensus__cluster-btn-summary">
                    {o.summary}
                  </span>
                  <span className="srf-consensus__cluster-btn-cta" aria-hidden>
                    Priorisieren →
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="srf-consensus__outliers-wrap">
            <button
              type="button"
              className="srf-consensus__toggle"
              onClick={() => setOutliersExpanded((v) => !v)}
              aria-expanded={outliersExpanded}
            >
              {outliersExpanded ? (
                <>
                  <IconChevronDown size={12} />{' '}Details einklappen
                </>
              ) : (
                <>
                  <IconChevronRight size={12} />{' '}Details zu allen Clustern
                </>
              )}
            </button>
            {outliersExpanded ? (
              <ul className="srf-consensus__outliers-list">
                {outliers.map((o, i) => (
                  <li key={i} className="srf-consensus__outliers-item">
                    <span className="srf-consensus__outliers-cluster">{o.cluster}</span>
                    <span className="srf-consensus__outliers-summary">{o.summary}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

// ---- Atom: kleiner farbiger Dot ------------------------------------------
function DotIcon({ variant }: { variant: 'ok' | 'warn' | 'critical' }) {
  return (
    <span
      aria-hidden
      className={`srf-consensus__dot srf-consensus__dot--${variant}`}
    />
  );
}

// Sub-Plan E (2026-04-30) — React.memo. Re-renders of the card are expensive
// (polling loops, multi-second effects, JSX subtree). Equality check
// shallow for primitives + JSON.stringify for nested arrays/objects, because
// SurfaceRenderer creates new objects per parse pass — strict equality
// would otherwise never match. Conservative: when in doubt, prefer
// re-rendering over showing stale data.
function consensusActionPropsEqual(prev: Props, next: Props): boolean {
  return (
    prev.workstreamId === next.workstreamId &&
    prev.consensusLevel === next.consensusLevel &&
    prev.initialDispatched === next.initialDispatched &&
    prev.masterTicketId === next.masterTicketId &&
    prev.planText === next.planText &&
    prev.intent === next.intent &&
    JSON.stringify(prev.outliers ?? null) === JSON.stringify(next.outliers ?? null) &&
    JSON.stringify(prev.subTickets ?? null) === JSON.stringify(next.subTickets ?? null)
  );
}

export const ConsensusActionCard = memo(
  ConsensusActionCardImpl,
  consensusActionPropsEqual,
);
