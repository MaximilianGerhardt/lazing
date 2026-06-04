'use client';

/**
 * ManualOverrideControls — client.
 *
 * Pattern 4 Wave 2.2 (2026-05-01).
 *
 * One button per transition. POST → /api/workflows/runs/[runId] with
 * { targetState }. Refresh on success via router.refresh().
 *
 * On 409 (manualOverride='forbid') the response is rendered as a red inline
 * message.
 */

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { CSSProperties } from 'react';

interface Transition {
  to: string;
  label: string;
}

interface Props {
  runId: string;
  transitions: ReadonlyArray<Transition>;
}

export function ManualOverrideControls(props: Props): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [pendingTarget, setPendingTarget] = useState<string | null>(null);

  const trigger = (targetState: string): void => {
    setError(null);
    setPendingTarget(targetState);
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/workflows/runs/${encodeURIComponent(props.runId)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ targetState }),
          },
        );
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
            detail?: string;
          };
          setError(data.detail ?? data.error ?? `HTTP ${res.status}`);
          return;
        }
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPendingTarget(null);
      }
    });
  };

  if (props.transitions.length === 0) {
    return (
      <p style={hintStyle}>
        Keine Transitions definiert — der State ist terminal oder hat
        ausschließlich Code-getriebene Wechsel.
      </p>
    );
  }

  return (
    <div style={wrapStyle}>
      <ul style={listStyle}>
        {props.transitions.map((t) => {
          const isPending = pending && pendingTarget === t.to;
          return (
            <li key={`${t.to}-${t.label}`}>
              <button
                type="button"
                onClick={() => trigger(t.to)}
                disabled={pending}
                style={btnStyle(isPending)}
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
                <span style={btnLabelStyle}>{t.label}</span>
                <span style={btnTargetStyle}>
                  → {t.to === '__terminal__' ? 'Ende' : t.to}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {error ? <p style={errorStyle}>{error}</p> : null}
    </div>
  );
}

const wrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const listStyle: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
};

const hintStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--ink-3)',
  margin: 0,
};

function btnStyle(pendingThis: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 2,
    padding: '10px 14px',
    fontSize: 13,
    color: 'var(--ink)',
    background: 'var(--sheet-2)',
    border: '0.5px solid var(--line-2)',
    borderRadius: 'var(--radius-md, 10px)',
    cursor: pendingThis ? 'wait' : 'pointer',
    opacity: pendingThis ? 0.65 : 1,
    transition:
      'transform 120ms var(--spring-bouncy, ease), border-color 120ms ease',
    minWidth: 160,
    textAlign: 'left',
  };
}

const btnLabelStyle: CSSProperties = {
  fontWeight: 500,
  color: 'var(--ink)',
};

const btnTargetStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-3)',
};

const errorStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--a-warn, #c08)',
  margin: 0,
  fontFamily: 'var(--font-mono)',
};
