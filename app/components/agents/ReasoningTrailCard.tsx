'use client';

/**
 * ReasoningTrailCard — Pattern 5 Welle 4 (2026-05-01).
 *
 * Zeigt die letzten Reasoning-Audit-Rows eines Workstreams als Liste.
 * Pro Row: Phase, Role, claim_text-Preview, Status-Badge, Cost, Timestamp.
 *
 * Verified-Status-Badges:
 *   NULL          → grau   "unverified"
 *   'ok'          → grün   "verifiziert"
 *   'drift'       → gelb   "drift"
 *   'fabricated'  → rot    "halluziniert"
 *
 * Click auf Row öffnet /reasoning-audit/[id] (Detail-Page, Server-Component).
 *
 * Surface-Library-konform: keine Overlays/Modals, inline-style nach lazyOS-
 * Konvention (SniperInjectCard als Vorlage).
 */

import { useEffect, useState, type CSSProperties } from 'react';
import Link from 'next/link';

interface AuditRow {
  id: string;
  ts: number;
  workstreamId: string | null;
  phase: string;
  role: string;
  llmModel: string;
  claimText: string;
  verifiedStatus: string | null;
  verifiedNote: string | null;
  costCents: number;
}

interface Props {
  workstreamId: string;
  /** Optional: Limit der angezeigten Rows. Default 10. */
  limit?: number;
}

interface ApiResponse {
  rows: AuditRow[];
}

export function ReasoningTrailCard({
  workstreamId,
  limit = 10,
}: Props): React.JSX.Element {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(
          `/api/reasoning-audit?workstreamId=${encodeURIComponent(workstreamId)}`,
          { cache: 'no-store', credentials: 'same-origin' },
        );
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const j = (await res.json()) as ApiResponse;
        if (!cancelled) {
          setRows(j.rows.slice(0, limit));
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };
    void load();
    return (): void => {
      cancelled = true;
    };
  }, [workstreamId, limit]);

  return (
    <section style={cardStyle} aria-label="Reasoning-Trail · Audit-Log">
      <header style={headerStyle}>
        <span style={pillStyle}>Audit</span>
        <strong style={titleStyle}>Quellen &amp; Reasoning</strong>
        {rows ? (
          <span style={countPillStyle}>{rows.length} Einträge</span>
        ) : null}
      </header>
      <p style={leadStyle}>
        Was haben Lead/Roaster/Synthesis behauptet? Klick auf einen Eintrag für
        die volle Quellen-Liste und manuelle Drift-Verifikation.
      </p>

      {error ? (
        <div style={errStyle}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
            style={{ flexShrink: 0 }}
          >
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
          <span>{error}</span>
        </div>
      ) : rows === null ? (
        <div style={skeletonStyle}>Lade Audit-Trail …</div>
      ) : rows.length === 0 ? (
        <div style={emptyStyle}>
          Noch keine Reasoning-Audit-Rows für diesen Workstream.
        </div>
      ) : (
        <ul style={listStyle}>
          {rows.map((r) => (
            <li key={r.id} style={rowItemStyle}>
              <Link href={`/reasoning-audit/${r.id}`} style={rowLinkStyle}>
                <div style={rowTopStyle}>
                  <span style={phasePillStyle}>{r.phase}</span>
                  <span style={roleStyle}>{r.role}</span>
                  <StatusBadge status={r.verifiedStatus} />
                  <span style={tsStyle}>{formatTs(r.ts)}</span>
                </div>
                <p style={claimStyle}>{truncate(r.claimText, 200)}</p>
                <div style={rowFooterStyle}>
                  <span style={modelStyle}>{r.llmModel}</span>
                  <span style={costStyle}>
                    {(r.costCents / 100).toFixed(3)}€
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StatusBadge({
  status,
}: {
  status: string | null;
}): React.JSX.Element {
  if (status === null || status === undefined) {
    return (
      <span style={badgeStyle('unverified')} title="Noch nicht verifiziert">
        unverified
      </span>
    );
  }
  if (status === 'ok') {
    return (
      <span style={badgeStyle('ok')} title="Re-Spawn-Output stimmt überein">
        verifiziert
      </span>
    );
  }
  if (status === 'drift') {
    return (
      <span
        style={badgeStyle('drift')}
        title="Output divergiert vom Original — Hebel: Re-Spawn klärt Fakten"
      >
        drift (Hebel)
      </span>
    );
  }
  if (status === 'fabricated') {
    return (
      <span
        style={badgeStyle('fabricated')}
        title="Output kollabiert vollständig — Halluzinations-Verdacht"
      >
        halluziniert
      </span>
    );
  }
  return (
    <span style={badgeStyle('unverified')} title={status}>
      {status}
    </span>
  );
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

function formatTs(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  const d = new Date(ts);
  const now = Date.now();
  const diffMs = now - ts;
  if (diffMs < 60_000) return 'gerade eben';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h`;
  if (diffMs < 7 * 86_400_000) return `${Math.floor(diffMs / 86_400_000)}d`;
  return d.toISOString().slice(0, 10);
}

// ────────────────────────────── Styles ──────────────────────────────

const cardStyle: CSSProperties = {
  marginTop: 24,
  padding: 'clamp(16px, 2.5vw, 24px)',
  borderRadius: 14,
  border: '0.5px solid var(--line-2)',
  background: 'var(--sheet-2)',
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
  border: '0.5px solid var(--ink-3)',
  color: 'var(--ink-2)',
};

const titleStyle: CSSProperties = {
  fontSize: 15,
  color: 'var(--ink)',
  letterSpacing: '-0.005em',
};

const countPillStyle: CSSProperties = {
  marginLeft: 'auto',
  padding: '4px 10px',
  borderRadius: 999,
  border: '0.5px solid var(--line-2)',
  background: 'var(--sheet)',
  color: 'var(--ink-3)',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  fontVariantNumeric: 'tabular-nums',
};

const leadStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.55,
  color: 'var(--ink-2)',
};

const listStyle: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const rowItemStyle: CSSProperties = {
  border: '0.5px solid var(--line-2)',
  borderRadius: 10,
  background: 'var(--sheet)',
  overflow: 'hidden',
};

const rowLinkStyle: CSSProperties = {
  display: 'block',
  padding: '10px 14px',
  textDecoration: 'none',
  color: 'inherit',
};

const rowTopStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  marginBottom: 6,
};

const phasePillStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  padding: '2px 8px',
  borderRadius: 999,
  border: '0.5px solid var(--line-2)',
  color: 'var(--ink-2)',
};

const roleStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-3)',
};

const tsStyle: CSSProperties = {
  marginLeft: 'auto',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-3)',
  fontVariantNumeric: 'tabular-nums',
};

const claimStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--ink)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const rowFooterStyle: CSSProperties = {
  marginTop: 6,
  display: 'flex',
  gap: 12,
  alignItems: 'center',
};

const modelStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--ink-3)',
  letterSpacing: '0.02em',
};

const costStyle: CSSProperties = {
  marginLeft: 'auto',
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--ink-3)',
  fontVariantNumeric: 'tabular-nums',
};

const skeletonStyle: CSSProperties = {
  padding: '12px 14px',
  borderRadius: 8,
  border: '0.5px dashed var(--line-2)',
  color: 'var(--ink-3)',
  fontSize: 12,
  fontFamily: 'var(--font-mono)',
};

const emptyStyle: CSSProperties = {
  padding: '12px 14px',
  borderRadius: 8,
  border: '0.5px dashed var(--line-2)',
  color: 'var(--ink-3)',
  fontSize: 12,
};

const errStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  padding: '8px 12px',
  borderRadius: 8,
  border: '0.5px solid var(--a-danger)',
  color: 'var(--a-danger)',
  fontSize: 12,
};

type BadgeKind = 'unverified' | 'ok' | 'drift' | 'fabricated';

function badgeStyle(kind: BadgeKind): CSSProperties {
  const palette: Record<
    BadgeKind,
    { fg: string; bg: string; border: string }
  > = {
    unverified: {
      fg: 'var(--ink-3)',
      bg: 'transparent',
      border: 'var(--line-2)',
    },
    ok: {
      fg: '#1f9d55',
      bg: 'color-mix(in oklab, #1f9d55 12%, var(--sheet))',
      border: '#1f9d55',
    },
    drift: {
      fg: '#c98a00',
      bg: 'color-mix(in oklab, #c98a00 12%, var(--sheet))',
      border: '#c98a00',
    },
    fabricated: {
      fg: '#c0392b',
      bg: 'color-mix(in oklab, #c0392b 14%, var(--sheet))',
      border: '#c0392b',
    },
  };
  const p = palette[kind];
  return {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    padding: '2px 8px',
    borderRadius: 999,
    border: `0.5px solid ${p.border}`,
    color: p.fg,
    background: p.bg,
  };
}
