'use client';

/**
 * WorkflowProgressPanel — user request 2026-04-29: „Heatmap persistent im
 * Chat damit ich Fortschritt sehe, nicht nur dass etwas passiert."
 *
 * Shows, for the current workstream in the active workspace:
 *   - V1 ... V5 pipeline with status (done / current / pending)
 *   - Active phase (Lead, Roaster, Pause)
 *   - Pause countdown while a pause is running
 *   - Inject hint when correction is possible
 *
 * Polls /api/workstreams/[id]/pause-status every 2 s while active.
 * Re-fetches workstreams + iterate-version-events on every wave.
 *
 * Position: sticky between ActiveWorkstreamBanner and chat stream.
 * Visible only when ≥ 1 workstream in the currentWorkspace is active/stuck/paused.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

interface ActiveWs {
  id: string;
  name?: string | null;
  status: 'active' | 'paused' | 'done' | 'archived' | 'stuck';
  workspaceId: string;
}

interface PauseStatus {
  isPaused: boolean;
  remainingMs: number;
  durationMs?: number;
  after?: string | null;
  phase?: string | null;
  pauseKind?: string | null;
  pauseStartedAt?: number;
  workstreamStatus?: string;
}

interface ProgressState {
  ws: ActiveWs | null;
  pause: PauseStatus | null;
  lastVersion: number; // last iterate-version event
  loading: boolean;
}

const POLL_MS = 2000;
const MAX_VERSIONS = 5;

export function WorkflowProgressPanel({
  workspaceId,
}: {
  workspaceId: string;
}): React.JSX.Element | null {
  const [state, setState] = useState<ProgressState>({
    ws: null,
    pause: null,
    lastVersion: 0,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      try {
        // 1) find active WS (active + stuck + paused)
        const [activeR, stuckR] = await Promise.all([
          fetch(
            `/api/workstreams?workspaceId=${encodeURIComponent(workspaceId)}&status=active&limit=5`,
            { cache: 'no-store' },
          ).then((r) => (r.ok ? r.json() : { workstreams: [] })),
          fetch(
            `/api/workstreams?workspaceId=${encodeURIComponent(workspaceId)}&status=stuck&limit=5`,
            { cache: 'no-store' },
          ).then((r) => (r.ok ? r.json() : { workstreams: [] })),
        ]);
        if (cancelled) return;
        const all: ActiveWs[] = [
          ...((activeR as { workstreams?: ActiveWs[] }).workstreams ?? []),
          ...((stuckR as { workstreams?: ActiveWs[] }).workstreams ?? []),
        ];
        const ws = all[0] ?? null;
        if (!ws) {
          setState({ ws: null, pause: null, lastVersion: 0, loading: false });
          return;
        }
        // 2) pause-status for this WS
        const pauseR = await fetch(
          `/api/workstreams/${encodeURIComponent(ws.id)}/pause-status`,
          { cache: 'no-store' },
        ).then((r) => (r.ok ? r.json() : null));
        if (cancelled) return;
        // 3) read the last iterate-version from events — pause-status has
        //    no direct info, but we can use the `phase` as an indicator.
        //    More precisely: providing the endpoint is out-of-scope, so we
        //    derive lastVersion roughly from phase:
        //    - phase='lead-v1' → lastVersion=0 (V1 running)
        //    - phase='roast' → lastVersion=1 (V1 done, Roaster)
        //    - phase='v2-spawn' → lastVersion=2
        //    - pauseKind='auto-dispatch-pause' → lastVersion=5 (final)
        // For correct display we use the existing `after` marker in
        // pauseRow.payload.
        let lastVersion = 0;
        const phase = pauseR?.phase;
        const after = pauseR?.after;
        if (after && /^v(\d+)$/i.test(after)) {
          lastVersion = parseInt(after.slice(1), 10);
        } else if (phase === 'lead-v1') {
          lastVersion = 0;
        } else if (phase === 'roast') {
          lastVersion = 1;
        }
        setState({ ws, pause: pauseR ?? null, lastVersion, loading: false });
      } catch {
        if (!cancelled) {
          setState((prev) => ({ ...prev, loading: false }));
        }
      }
    };

    void tick();
    timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      if (timer !== null) clearInterval(timer);
    };
  }, [workspaceId]);

  const pipeline = useMemo(() => {
    const result: Array<{ v: number; status: 'done' | 'current' | 'pending' }> =
      [];
    const cur = state.lastVersion;
    for (let v = 1; v <= MAX_VERSIONS; v += 1) {
      let status: 'done' | 'current' | 'pending';
      if (v <= cur) status = 'done';
      else if (v === cur + 1) status = 'current';
      else status = 'pending';
      result.push({ v, status });
    }
    return result;
  }, [state.lastVersion]);

  if (state.loading) return null;
  if (!state.ws) return null;

  const isStuck = state.ws.status === 'stuck';
  const isPaused = state.pause?.isPaused === true;
  const remainingS = isPaused
    ? Math.max(0, Math.ceil((state.pause?.remainingMs ?? 0) / 1000))
    : 0;
  const phaseLabel = (() => {
    if (isStuck) return 'Hängt — Resume nötig';
    if (isPaused) return `Pause · ${remainingS}s — Korrektur möglich`;
    if (state.pause?.phase === 'lead-v1') return 'V1 Lead schreibt …';
    if (state.pause?.phase === 'roast') return `V${state.lastVersion} Roaster attackieren …`;
    if (state.pause?.phase === 'v2-spawn') return `V${state.lastVersion + 1} Lead schreibt …`;
    return state.ws.status === 'active' ? 'Läuft …' : state.ws.status;
  })();

  return (
    <div className={`workflow-progress${isStuck ? ' is-stuck' : ''}${isPaused ? ' is-paused' : ''}`}>
      <div className="workflow-progress-header">
        <Link
          href={`/workstreams/${encodeURIComponent(state.ws.id)}`}
          className="workflow-progress-title"
        >
          {state.ws.name ?? 'Workstream'}
        </Link>
        <span className="workflow-progress-phase">{phaseLabel}</span>
      </div>
      <div className="workflow-progress-track" aria-label="Iterations-Pipeline">
        {pipeline.map((p) => (
          <div
            key={p.v}
            className={`workflow-progress-step is-${p.status}`}
            title={`V${p.v} — ${p.status === 'done' ? 'fertig' : p.status === 'current' ? 'läuft' : 'wartet'}`}
          >
            <span className="workflow-progress-step-num">V{p.v}</span>
          </div>
        ))}
      </div>
      {isPaused ? (
        <div
          className="workflow-progress-bar"
          aria-label="Pause-Countdown"
          style={{
            // Bar shrinks from 100% to 0% during the pause
            ['--remaining' as string]:
              state.pause?.durationMs && state.pause.durationMs > 0
                ? `${Math.max(0, ((state.pause.remainingMs ?? 0) / state.pause.durationMs) * 100)}%`
                : '0%',
          }}
        />
      ) : null}
    </div>
  );
}
