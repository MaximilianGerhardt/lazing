'use client';

/**
 * SubWorkstreamsCard — Sprint C (2026-04-29).
 *
 * Tree view of all sub-workstreams under a master. Polls
 * `/api/workstreams/[id]/sub-workstreams` every 2s. Per row:
 *   role icon · model badge · live token counter · status pill · cost cents
 *
 * Clicking a row jumps to the tmux session via `/sessions/[name]` —
 * the ttyd live view lives there.
 *
 * No overlays, no modals — the card is part of the chat stream.
 *
 * Wave 3.2 — Refactored: inline styles → CSS classes + token bind.
 */

import Link from 'next/link';
import { memo, useEffect, useState } from 'react';

interface Props {
  masterWorkstreamId: string;
  workspaceId: string;
}

interface SubWorkstream {
  id: string;
  parentWorkstreamId: string | null;
  role: string | null;
  name: string;
  status: 'active' | 'paused' | 'done' | 'archived' | 'stuck';
  tmuxSessionId: string | null;
  tokensIn: number;
  tokensOut: number;
  costCentsAggregated: number;
  createdAt: number;
  updatedAt: number;
}

interface ApiResponse {
  parentId: string;
  subs: SubWorkstream[];
  totals: {
    tokensIn: number;
    tokensOut: number;
    costCents: number;
    running: number;
    done: number;
    failed: number;
  };
}

// P1-2 Fix (2026-04-29): adaptive polling.
//   - Default tick every ~4s (instead of 2s) is enough for live token updates.
//   - When all sub-agents are in an end state: reduce to 30s (no more
//     burn, just heartbeat).
//   - When the tab is in the background: wait 5s and check again,
//     this way we avoid 1 request every 4s per hidden tab.
const POLL_INTERVAL_ACTIVE_MS = 4000;
const POLL_INTERVAL_IDLE_MS = 30000;
const POLL_INTERVAL_HIDDEN_MS = 5000;

function SubWorkstreamsCardImpl({
  masterWorkstreamId,
  workspaceId: _workspaceId,
}: Props) {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    async function tick(): Promise<void> {
      if (cancelled) return;
      // Page-visibility gate: do not poll when the tab is hidden.
      if (typeof document !== 'undefined' && document.hidden) {
        timer = window.setTimeout(tick, POLL_INTERVAL_HIDDEN_MS);
        return;
      }
      let nextDelay = POLL_INTERVAL_ACTIVE_MS;
      try {
        const res = await fetch(
          `/api/workstreams/${encodeURIComponent(masterWorkstreamId)}/sub-workstreams`,
          { cache: 'no-store', credentials: 'same-origin' },
        );
        if (!res.ok) {
          if (!cancelled) setError(`HTTP ${res.status}`);
          return;
        }
        const json = (await res.json()) as ApiResponse;
        if (cancelled) return;
        setData(json);
        setError(null);
        // Adaptive backoff: no more live sub → 30s.
        if ((json.totals?.running ?? 0) === 0) {
          nextDelay = POLL_INTERVAL_IDLE_MS;
        }
      } catch {
        /* offline-tolerant */
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(tick, nextDelay);
        }
      }
    }
    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [masterWorkstreamId]);

  if (!data && !error) {
    return (
      <div className="srf-subws" aria-label="Sub-Workstreams werden geladen">
        <div className="srf-subws__header">
          <span className="srf-subws__title">Sub-Workstreams</span>
          <span className="srf-subws__meta">lädt...</span>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="srf-subws" aria-label="Sub-Workstreams nicht verfügbar">
        <div className="srf-subws__header">
          <span className="srf-subws__title">Sub-Workstreams</span>
          <span className="srf-subws__meta srf-subws__meta--err">
            {error ?? 'offline'}
          </span>
        </div>
      </div>
    );
  }

  if (data.subs.length === 0) {
    return (
      <div className="srf-subws" aria-label="Keine Sub-Workstreams">
        <div className="srf-subws__header">
          <span className="srf-subws__title">Sub-Workstreams</span>
          <span className="srf-subws__meta">noch keine Sub-Agents gespawnt</span>
        </div>
      </div>
    );
  }

  const { subs, totals } = data;
  const totalTokens = totals.tokensIn + totals.tokensOut;
  const totalEur = (totals.costCents / 100).toFixed(2);

  return (
    <div className="srf-subws" aria-label="Sub-Workstreams Tree">
      <div className="srf-subws__header">
        <span className="srf-subws__title">Sub-Workstreams · {subs.length}</span>
        <span className="srf-subws__meta">
          {totals.running > 0 ? (
            <>
              <span className="srf-subws__running-dot" aria-hidden /> {totals.running} live
              {' · '}
            </>
          ) : null}
          {totalTokens.toLocaleString('de-DE')} Tokens
          {' · '}€ {totalEur}
        </span>
      </div>
      <ul className="srf-subws__list">
        {subs.map((sub) => (
          <SubRow key={sub.id} sub={sub} />
        ))}
      </ul>
    </div>
  );
}

function SubRow({ sub }: { sub: SubWorkstream }) {
  const role = sub.role ?? 'sub';
  const icon = roleIcon(role);
  const subStatus = inferSubStatus(sub);
  const tokens = sub.tokensIn + sub.tokensOut;
  const eur = (sub.costCentsAggregated / 100).toFixed(3);

  const inner = (
    <span className="srf-subws__row-inner">
      <span className="srf-subws__role-icon" aria-hidden>
        {icon}
      </span>
      <span className="srf-subws__role-label">{role}</span>
      <span className="srf-subws__meta">
        {tokens > 0
          ? `${tokens.toLocaleString('de-DE')} tok · €${eur}`
          : '—'}
      </span>
      <span
        className={`srf-subws__pill srf-subws__pill--${subStatus}`}
        aria-label={`Status ${subStatus}`}
      >
        {subStatus}
      </span>
    </span>
  );

  if (sub.tmuxSessionId) {
    // /sessions is the list page; the query param highlights the row.
    return (
      <li className="srf-subws__row">
        <Link
          href={`/sessions?focus=${encodeURIComponent(sub.tmuxSessionId)}`}
          className="srf-subws__link"
          title={`tmux: ${sub.tmuxSessionId}`}
        >
          {inner}
        </Link>
      </li>
    );
  }

  return (
    <li className="srf-subws__row">
      <span className="srf-subws__link srf-subws__link--static">{inner}</span>
    </li>
  );
}

function inferSubStatus(
  sub: SubWorkstream,
): 'pending' | 'running' | 'done' | 'failed' | 'stuck' {
  // Heuristic from the DB state: tokens=0 + active + recent updatedAt = running.
  // tokens=0 + active + older = pending. tokens>0 + active = running.
  // status='done' = done. status='paused' = failed. status='stuck' = stuck.
  if (sub.status === 'done') return 'done';
  if (sub.status === 'stuck') return 'stuck';
  if (sub.status === 'paused') return 'failed';
  if (sub.tokensIn + sub.tokensOut > 0) return 'running';
  // active with 0 tokens — pending or just started.
  return 'pending';
}

function roleIcon(role: string): string {
  if (role.startsWith('iterate-lead')) return '◐';
  if (role.startsWith('iterate-roaster')) return '◇';
  if (role === 'iterate-resume-lead' || role === 'iterate-resume-roaster')
    return '↻';
  if (role === 'tier-spawn') return '◈';
  if (role === 'synthesis') return '◆';
  if (role === 'auto-dispatch-senior-dev') return '▦';
  if (role === 'auto-dispatch-code-reviewer') return '▥';
  if (role === 'auto-dispatch-critic') return '!';
  if (role === 'cross-roast') return '×';
  if (role === 'sub-plan-sniper') return '◎';
  return '○';
}

// Sub-Plan E (2026-04-30) — React.memo. Both props primitive.
function subWorkstreamsPropsEqual(prev: Props, next: Props): boolean {
  return (
    prev.masterWorkstreamId === next.masterWorkstreamId &&
    prev.workspaceId === next.workspaceId
  );
}

export const SubWorkstreamsCard = memo(
  SubWorkstreamsCardImpl,
  subWorkstreamsPropsEqual,
);
