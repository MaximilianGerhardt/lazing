'use client';

/**
 * SniperInjectCard — Mid-Course-Correction-UI im Workstream-Detail.
 *
 * Sichtbar während Workstream `status='active'`. User schreibt eine
 * Korrektur, klickt Senden, lazyOS hängt sie als `user-correction`-
 * Comment ans Master-Ticket. Lead-V2/V3 lesen den Thread und integrieren
 * die Korrektur in die nächste Iteration.
 *
 * Visual: bewusst klar als "Sniper" gelabelt — Power-Aktion, nicht
 * normaler Comment.
 */

import { useEffect, useRef, useState, useTransition, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';

import { SourceChipRow } from '@/lib/chat/source-chip-row';

interface Props {
  workstreamId: string;
  status: string;
}

interface PauseStatus {
  isPaused: boolean;
  remainingMs: number;
  after: string | null;
  phase?: 'idle' | 'lead-v1' | 'roast' | 'v2-spawn';
}

export function SniperInjectCard({ workstreamId, status }: Props): React.JSX.Element | null {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pause, setPause] = useState<PauseStatus>({
    isPaused: false,
    remainingMs: 0,
    after: null,
  });

  // P11 (2026-05-01): letzte Reasoning-Audit-ID für SourceChipRow.
  // Lädt 1× nach Mount + bei Phase-Change. Fail-soft.
  const [lastAuditId, setLastAuditId] = useState<string | null>(null);

  // Sub-Plan 03 — Pattern 4c: useRef-Cleanup gegen Interval-Leak.
  // Live-Pause-Polling alle 1s während Workstream aktiv ist.
  const intervalRef = useRef<number | null>(null);
  useEffect(() => {
    if (status !== 'active') return;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch(
          `/api/workstreams/${encodeURIComponent(workstreamId)}/pause-status`,
          { cache: 'no-store', credentials: 'same-origin' },
        );
        if (!res.ok) return;
        const j = (await res.json()) as PauseStatus;
        if (!cancelled) setPause(j);
      } catch {
        /* offline → keep state */
      }
    };
    void tick();
    intervalRef.current = window.setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [workstreamId, status]);

  // P11 — letzte Audit-Row holen für Source-Chips. Re-fetch bei Phase-Change
  // (also wenn nächste V_n läuft) und einmal beim Mount.
  useEffect(() => {
    if (status !== 'active') return;
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(
          `/api/reasoning-audit?workstreamId=${encodeURIComponent(workstreamId)}`,
          { cache: 'no-store', credentials: 'same-origin' },
        );
        if (!res.ok) return;
        const j = (await res.json()) as { rows: Array<{ id: string }> };
        const top = Array.isArray(j.rows) && j.rows.length > 0 ? j.rows[0]?.id : null;
        if (!cancelled && typeof top === 'string') {
          setLastAuditId(top);
        }
      } catch {
        /* fail-soft */
      }
    };
    void load();
    return (): void => {
      cancelled = true;
    };
  }, [workstreamId, status, pause.after, pause.phase]);

  // Sub-Plan 03 — Pattern 4c: Sniper-Progress-Pill v_n / 5.
  // Ableiten der aktuellen Iteration aus pause.after (v2/v3/v4) +
  // pause.phase (lead-v1/roast). Wenn nichts greift: aktuell V1.
  const currentIteration = ((): number => {
    if (pause.after === 'v4') return 5;
    if (pause.after === 'v3') return 4;
    if (pause.after === 'v2') return 3;
    if (pause.phase === 'roast' || pause.phase === 'v2-spawn') return 2;
    return 1;
  })();
  const progressDots: string = Array.from({ length: 5 }, (_, i) =>
    i + 1 < currentIteration ? '●' : i + 1 === currentIteration ? '◉' : '○',
  ).join('');

  if (status !== 'active') return null;

  const send = async (): Promise<void> => {
    const trimmed = message.trim();
    if (trimmed.length < 2) return;
    setPending(true);
    setInfo(null);
    setError(null);
    try {
      const res = await fetch(
        `/api/workstreams/${encodeURIComponent(workstreamId)}/inject`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: trimmed }),
        },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { hint?: string; error?: string };
        throw new Error(j.hint ?? j.error ?? `HTTP ${res.status}`);
      }
      setMessage('');
      setInfo('Korrektur eingeworfen. Wird in der nächsten Iteration berücksichtigt.');
      window.setTimeout(() => setInfo(null), 5000);
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Cmd/Ctrl + Enter sendet
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void send();
    }
  };

  return (
    <section style={cardStyle} aria-label="Sniper-Hook · Mid-Course-Correction">
      <div style={headerStyle}>
        <span style={pillStyle}>Sniper</span>
        <strong style={titleStyle}>Im Flug korrigieren</strong>
        <span style={progressPillStyle} title={`Iteration ${currentIteration} von 5`}>
          {progressDots} V{currentIteration}/5
        </span>
        {pause.isPaused ? (
          <span style={countdownPillStyle}>
            Pause-Window {Math.ceil(pause.remainingMs / 1000)}s
            {pause.after === 'v2' ? ' · vor V3' : ''}
            {pause.after === 'v3' ? ' · vor V4' : ''}
            {pause.after === 'v4' ? ' · vor V5' : ''}
          </span>
        ) : null}
      </div>
      {lastAuditId ? (
        <SourceChipRow auditId={lastAuditId} maxVisible={5} />
      ) : null}

      <p style={leadStyle}>
        {pause.isPaused
          ? 'Pause läuft — du hast genau jetzt das beste Fenster. Die nächste Iteration startet mit deiner Korrektur als höchste Priorität.'
          : pause.phase === 'roast'
            ? 'Roast läuft gerade — Korrektur jetzt landet sicher in V2. Lead-V2 liest deinen Hinweis genauso wie die Roaster-Punkte.'
            : pause.phase === 'lead-v1'
              ? 'Lead schreibt V1. Du kannst schon jetzt eine Anforderung nachschieben — sie wird im nächsten Pause-Window berücksichtigt.'
              : 'Der Schwarm denkt durch. Tipp deine Korrektur jetzt — sie wird in der nächsten Pause-Phase gelesen und höher gewichtet als Roaster-Punkte.'}
      </p>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={onKey}
        placeholder='z.B. "Webhook MUSS HMAC-signiert sein" oder "Plan ignoriert Kunde X" …'
        rows={3}
        maxLength={4000}
        style={textareaStyle}
        disabled={pending}
      />
      <div style={footerStyle}>
        <button
          type="button"
          onClick={() => void send()}
          disabled={pending || message.trim().length < 2}
          style={ctaStyle(pending, message.trim().length < 2)}
        >
          {pending ? 'Wird geladen …' : 'Korrektur einwerfen'}
        </button>
        <span style={hintStyle}>Cmd/Ctrl+Enter sendet · max 4000 Zeichen</span>
      </div>
      {info ? <div style={infoStyle}>{info}</div> : null}
      {error ? (
        <div style={errStyle}>
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
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
          <span>{error}</span>
        </div>
      ) : null}
    </section>
  );
}

const cardStyle: CSSProperties = {
  marginTop: 24,
  padding: 'clamp(16px, 2.5vw, 24px)',
  borderRadius: 14,
  border: '0.5px solid var(--a-now)',
  background: 'color-mix(in oklab, var(--a-now) 5%, var(--sheet-2))',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  maxWidth: 760,
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const pillStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  padding: '2px 10px',
  borderRadius: 999,
  border: '0.5px solid var(--a-now)',
  color: 'var(--a-now)',
};

const titleStyle: CSSProperties = {
  fontSize: 15,
  color: 'var(--ink)',
  letterSpacing: '-0.005em',
};

const leadStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.55,
  color: 'var(--ink-2)',
};

const textareaStyle: CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  fontSize: 14,
  fontFamily: 'var(--font-sans)',
  borderRadius: 10,
  border: '0.5px solid var(--line-2)',
  background: 'var(--sheet)',
  color: 'var(--ink)',
  outline: 'none',
  resize: 'vertical',
  minHeight: 80,
  boxSizing: 'border-box',
};

const footerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  flexWrap: 'wrap',
};

function ctaStyle(pending: boolean, disabled: boolean): CSSProperties {
  return {
    appearance: 'none',
    padding: '10px 18px',
    borderRadius: 10,
    border: 'none',
    background: 'var(--a-now)',
    color: 'var(--sheet)',
    fontSize: 13,
    fontWeight: 500,
    cursor: pending ? 'wait' : 'pointer',
    opacity: pending || disabled ? 0.6 : 1,
  };
}

const hintStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-3)',
};

const infoStyle: CSSProperties = {
  padding: '8px 12px',
  borderRadius: 8,
  border: '0.5px solid var(--a-clientb)',
  color: 'var(--a-clientb)',
  fontSize: 12,
};

const errStyle: CSSProperties = {
  padding: '8px 12px',
  borderRadius: 8,
  border: '0.5px solid var(--a-danger)',
  color: 'var(--a-danger)',
  fontSize: 12,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

const progressPillStyle: CSSProperties = {
  marginLeft: 'auto',
  padding: '4px 10px',
  borderRadius: 999,
  border: '0.5px solid var(--line-2)',
  background: 'var(--sheet)',
  color: 'var(--ink-2)',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.02em',
  fontVariantNumeric: 'tabular-nums',
};

const countdownPillStyle: CSSProperties = {
  padding: '4px 12px',
  borderRadius: 999,
  border: '0.5px solid var(--a-now)',
  background: 'var(--a-now)',
  color: 'var(--sheet)',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  fontVariantNumeric: 'tabular-nums',
  animation: 'sniper-pulse 1s ease-in-out infinite',
};

