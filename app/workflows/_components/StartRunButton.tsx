'use client';

/**
 * StartRunButton — client component.
 *
 * Pattern 4 Wave 2.2 (2026-05-01).
 *
 * Sends POST /api/workflows with { workflowId } and navigates on success
 * to /workflows/runs/[runId]. Loading state dimmed via opacity, press
 * feedback via --press-scale.
 */

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { CSSProperties } from 'react';

interface StartRunButtonProps {
  workflowId: string;
  workflowLabel: string;
}

export function StartRunButton(props: StartRunButtonProps): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleClick = (): void => {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/workflows', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workflowId: props.workflowId }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
            detail?: string;
          };
          setError(data.detail ?? data.error ?? `HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as { run?: { id: string } };
        if (data.run?.id) {
          router.push(`/workflows/runs/${encodeURIComponent(data.run.id)}`);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <div style={wrapStyle}>
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        aria-label={`${props.workflowLabel} starten`}
        style={btnStyle(pending)}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLButtonElement).style.transform =
            'scale(var(--press-scale, 0.96))';
        }}
        onPointerUp={(e) => {
          (e.currentTarget as HTMLButtonElement).style.transform = '';
        }}
        onPointerCancel={(e) => {
          (e.currentTarget as HTMLButtonElement).style.transform = '';
        }}
      >
        {pending ? 'Starte…' : 'Run starten'}
      </button>
      {error ? <p style={errorStyle}>{error}</p> : null}
    </div>
  );
}

const wrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 6,
};

function btnStyle(pending: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '10px 18px',
    fontSize: 13,
    fontWeight: 600,
    background: 'var(--a-now)',
    color: 'var(--on-accent)',
    border: 'none',
    borderRadius: 'var(--radius-md, 10px)',
    cursor: pending ? 'wait' : 'pointer',
    opacity: pending ? 0.65 : 1,
    transition:
      'transform 120ms var(--spring-bouncy, ease), opacity 120ms ease',
  } as CSSProperties;
}

const errorStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--a-warn, #c08)',
  margin: 0,
  fontFamily: 'var(--font-mono)',
};
