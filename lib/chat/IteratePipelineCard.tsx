'use client';

/**
 * IteratePipelineCard — Sub-Plan 04 Wave 2 (2026-04-29).
 *
 * One living card per workstream during the iterate loop V1...V5.
 * Polls /api/workstreams/[id]/pause-status:
 *   - currentVersion: V1...V5 track
 *   - phase: lead-v1 | roast | v2-spawn
 *   - isPaused + remainingMs: sniper-pause pill with countdown
 *   - isFinal: hides itself when the plan is done — the following
 *     ConsensusActionCard then takes over the rest.
 *
 * Inject field inline: the user writes a correction, it gets integrated
 * into the next V_n+1.
 *
 * Wave 3.3 — Refactored: inline styles → CSS classes + token bind.
 */

import { memo, useEffect, useState } from 'react';

import { IntentPill } from '@/lib/ui/pil';
import type { WorkstreamIntent } from '@/lib/workstreams/intent-classifier';

interface Props {
  workstreamId: string;
  workspaceId: string;
  workstreamName?: string;
  /** Hard-Cap der iterate-Wellen (default 5). */
  maxVersion?: number;
  /**
   * 2026-05-01 — Optional intent marker. Bug-fix iterates look
   * different from idea iterates (roast).
   */
  intent?: WorkstreamIntent;
}

interface PauseStatus {
  isPaused: boolean;
  remainingMs: number;
  after: string | null;
  phase: string;
  pauseKind?: string | null;
  currentVersion: number;
  isFinal: boolean;
  masterState: string | null;
  workstreamStatus: string;
}

const TICK_MS = 1500;
const MAX_DEFAULT = 5;

function IteratePipelineCardImpl({
  workstreamId,
  workspaceId: _workspaceId,
  workstreamName,
  maxVersion = MAX_DEFAULT,
  intent,
}: Props) {
  const [status, setStatus] = useState<PauseStatus | null>(null);
  const [injectText, setInjectText] = useState('');
  const [injectPending, setInjectPending] = useState(false);
  const [injectFlash, setInjectFlash] = useState<string | null>(null);

  // Polling
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    async function tick(): Promise<void> {
      try {
        const res = await fetch(
          `/api/workstreams/${encodeURIComponent(workstreamId)}/pause-status`,
          { credentials: 'same-origin', cache: 'no-store' },
        );
        if (!res.ok) return;
        const data = (await res.json()) as PauseStatus;
        if (cancelled) return;
        setStatus(data);
      } catch {
        /* offline-tolerant */
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(tick, TICK_MS);
        }
      }
    }
    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [workstreamId]);

  // When the plan is done: the card hides itself — ConsensusActionCard takes
  // the baton. We return null instead of rendering a "done" card,
  // because otherwise two cards (iterate + consensus) would stack on top of each other.
  if (status?.isFinal) return null;

  const v = status?.currentVersion ?? 0;
  const isPaused = status?.isPaused ?? false;
  const remainingMs = status?.remainingMs ?? 0;
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const phase = status?.phase ?? 'idle';

  const phaseLabel = phaseToLabel(phase, v, maxVersion, isPaused);

  async function submitInject(): Promise<void> {
    const text = injectText.trim();
    if (!text || injectPending) return;
    setInjectPending(true);
    setInjectFlash(null);
    try {
      const res = await fetch(
        `/api/workstreams/${encodeURIComponent(workstreamId)}/inject`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: text }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg =
          typeof body?.error === 'string'
            ? body.error
            : `HTTP ${res.status}`;
        setInjectFlash(`Fehler: ${msg}`);
        return;
      }
      setInjectText('');
      setInjectFlash('Eingang. Wird in der nächsten Welle integriert.');
      window.setTimeout(() => setInjectFlash(null), 4000);
    } catch (err) {
      setInjectFlash(
        `Fehler: ${err instanceof Error ? err.message : 'unbekannt'}`,
      );
    } finally {
      setInjectPending(false);
    }
  }

  return (
    <div className="srf-iterate">
      <div className="srf-iterate__header">
        <Dot variant={isPaused ? 'warn' : 'ok'} pulse={!isPaused} />
        <span className="srf-iterate__title">
          Plan läuft{workstreamName ? ` · ${workstreamName}` : ''}
        </span>
        {intent ? <IntentPill intent={intent} /> : null}
        {isPaused ? (
          <span className="srf-iterate__chip srf-iterate__chip--pause">
            Sniper-Pause · {seconds}s — du kannst eingreifen
          </span>
        ) : (
          <span className="srf-iterate__chip srf-iterate__chip--run">
            {phaseLabel}
          </span>
        )}
      </div>
      <Track currentVersion={v} maxVersion={maxVersion} />
      <div className="srf-iterate__hint">
        {isPaused
          ? 'Schreib eine Korrektur — sie landet in V' +
            (v + 1) +
            '. Sonst läuft V' +
            (v + 1) +
            ' automatisch an.'
          : v === 0
            ? 'Lead-Agent erstellt V1 …'
            : `Roaster prüft V${v}, V${v + 1} kommt nach 25 s Pause.`}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submitInject();
        }}
        className="srf-iterate__form"
      >
        <input
          type="text"
          value={injectText}
          onChange={(e) => setInjectText(e.target.value)}
          placeholder="Korrektur, Klärung oder neuer Aspekt …"
          className="srf-iterate__input"
          disabled={injectPending}
        />
        <button
          type="submit"
          className="srf-iterate__btn"
          disabled={injectPending || injectText.trim().length === 0}
        >
          {injectPending ? '…' : 'In nächste Welle'}
        </button>
      </form>
      {injectFlash ? (
        <div className="srf-iterate__flash">{injectFlash}</div>
      ) : null}
    </div>
  );
}

function phaseToLabel(
  phase: string,
  version: number,
  maxVersion: number,
  isPaused: boolean,
): string {
  if (isPaused) return `Pause vor V${version + 1}`;
  if (phase === 'lead-v1') return 'V1 wird geschrieben';
  if (phase === 'roast') return `Roast V${version}`;
  if (version === 0) return 'V1 wird geschrieben';
  if (version >= maxVersion) return `V${maxVersion} läuft (final)`;
  return `V${version} fertig · V${version + 1} kommt`;
}

function Track({
  currentVersion,
  maxVersion,
}: {
  currentVersion: number;
  maxVersion: number;
}) {
  const cells = Array.from({ length: maxVersion }, (_, i) => i + 1);
  return (
    <div className="srf-iterate__track">
      {cells.map((n) => {
        const variant: 'done' | 'current' | 'pending' =
          n < currentVersion
            ? 'done'
            : n === currentVersion
              ? 'current'
              : 'pending';
        const cls =
          variant === 'pending'
            ? 'srf-iterate__cell'
            : `srf-iterate__cell srf-iterate__cell--${variant}`;
        return (
          <div key={n} className={cls}>
            <span className="srf-iterate__cell-label">V{n}</span>
          </div>
        );
      })}
    </div>
  );
}

function Dot({
  variant,
  pulse = false,
}: {
  variant: 'ok' | 'warn' | 'critical';
  pulse?: boolean;
}) {
  const cls =
    `srf-iterate__dot srf-iterate__dot--${variant}` +
    (pulse ? ' srf-iterate__dot--pulse' : '');
  return <span aria-hidden className={cls} />;
}

// Sub-Plan E (2026-04-30) — React.memo. Props are completely primitive.
function iteratePipelinePropsEqual(prev: Props, next: Props): boolean {
  return (
    prev.workstreamId === next.workstreamId &&
    prev.workspaceId === next.workspaceId &&
    prev.workstreamName === next.workstreamName &&
    prev.maxVersion === next.maxVersion &&
    prev.intent === next.intent
  );
}

export const IteratePipelineCard = memo(
  IteratePipelineCardImpl,
  iteratePipelinePropsEqual,
);
