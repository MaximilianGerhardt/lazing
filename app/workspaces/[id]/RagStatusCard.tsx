'use client';

/**
 * RAG-Status-Card im Workspace-Detail.
 *
 * Zeigt:
 *   - Total Chunks + Tokens
 *   - Source-Type-Breakdown (file/chat/ticket/work-product)
 *   - Last-Indexed (relative)
 *   - Circuit-Open-Warnung wenn gesetzt
 *   - „Re-Index"-Button (POST /api/rag/index)
 *
 * Apple-Pure: keine Spam-Cards, eine sauber strukturierte Sektion.
 */

import { useEffect, useState, type CSSProperties } from 'react';

interface SourceTypeStats {
  type: string;
  count: number;
  tokens: number;
}

interface RagStatus {
  workspaceId: string;
  totalChunks: number;
  totalTokens: number;
  sourceTypes: SourceTypeStats[];
  lastIndexedAt: number | null;
  circuitOpen: boolean;
  failedRuns: number;
}

interface Props {
  workspaceId: string;
}

function relTime(ts: number | null): string {
  if (!ts) return '–';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'gerade eben';
  if (m < 60) return `vor ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `vor ${h} h`;
  const d = Math.floor(h / 24);
  return `vor ${d} d`;
}

export function RagStatusCard({ workspaceId }: Props): React.JSX.Element {
  const [status, setStatus] = useState<RagStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [reindexing, setReindexing] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = async (): Promise<void> => {
    try {
      const r = await fetch(
        `/api/rag/status?workspaceId=${encodeURIComponent(workspaceId)}`,
        { cache: 'no-store', credentials: 'same-origin' },
      );
      if (!r.ok) {
        setError(`status ${r.status}`);
        return;
      }
      const j = (await r.json()) as RagStatus;
      setStatus(j);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchStatus();
  }, [workspaceId]);

  const reindex = async (): Promise<void> => {
    setReindexing(true);
    setInfo(null);
    setError(null);
    try {
      const r = await fetch('/api/rag/index', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, sources: 'all' }),
      });
      const j = (await r.json()) as {
        ok?: boolean;
        indexed?: number;
        skipped?: number;
        error?: string;
        hint?: string;
      };
      if (!r.ok || !j.ok) {
        throw new Error(j.hint ?? j.error ?? `HTTP ${r.status}`);
      }
      setInfo(`Indexiert: ${j.indexed} · Skipped: ${j.skipped ?? 0}`);
      void fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReindexing(false);
    }
  };

  return (
    <section style={cardStyle} aria-label="RAG-Index-Status">
      <header style={headerStyle}>
        <span style={pillStyle}>RAG</span>
        <strong style={titleStyle}>Workspace-Kontext-Index</strong>
        {status?.circuitOpen ? (
          <span style={warnPillStyle} title="Indexer pausiert nach 3+ Fehlläufen — manueller Reset nötig">
            Circuit offen
          </span>
        ) : null}
      </header>

      {loading ? (
        <p style={leadStyle}>Lade Status…</p>
      ) : !status ? (
        <p style={errStyle}>{error ?? 'Status nicht erreichbar'}</p>
      ) : status.totalChunks === 0 ? (
        <p style={leadStyle}>
          Noch nicht indexiert. Klick „Index starten", damit Plan-Lead-Prompts den
          Workspace-Kontext nutzen können (lokal via @huggingface/transformers).
        </p>
      ) : (
        <>
          <div style={metricRowStyle}>
            <span style={metricStyle}>
              <span style={metricNumStyle}>{status.totalChunks.toLocaleString()}</span>
              <span style={metricLabelStyle}>Chunks</span>
            </span>
            <span style={metricStyle}>
              <span style={metricNumStyle}>{(status.totalTokens / 1000).toFixed(1)}k</span>
              <span style={metricLabelStyle}>Tokens</span>
            </span>
            <span style={metricStyle}>
              <span style={metricNumStyle}>{relTime(status.lastIndexedAt)}</span>
              <span style={metricLabelStyle}>Letztes Update</span>
            </span>
          </div>

          {status.sourceTypes.length > 0 ? (
            <ul style={typeListStyle}>
              {status.sourceTypes.map((t) => (
                <li key={t.type} style={typeItemStyle}>
                  <span style={typeNameStyle}>{t.type}</span>
                  <span style={typeCountStyle}>{t.count} Chunks</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}

      <div style={footerStyle}>
        <button
          type="button"
          onClick={() => void reindex()}
          disabled={reindexing || loading}
          style={ctaStyle(reindexing)}
        >
          {reindexing ? 'Indexiere…' : status?.totalChunks === 0 ? 'Index starten' : 'Re-Index'}
        </button>
        <span style={hintStyle}>
          Auto-Index: alle 30 min via systemd-timer
        </span>
      </div>

      {info ? <div style={infoStyle}>{info}</div> : null}
      {error && status ? (
        <div style={{ ...errStyle, display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg
            width={13}
            height={13}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable={false}
          >
            <path d="M6 6 L18 18 M18 6 L6 18" />
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
  border: '0.5px solid var(--line-2)',
  background: 'var(--sheet-2)',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  maxWidth: 760,
};
const headerStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10 };
const pillStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  padding: '2px 10px',
  borderRadius: 999,
  border: '0.5px solid var(--ink-3)',
  color: 'var(--ink-3)',
};
const titleStyle: CSSProperties = { fontSize: 15, color: 'var(--ink)', letterSpacing: '-0.005em' };
const leadStyle: CSSProperties = { margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--ink-2)' };
const warnPillStyle: CSSProperties = {
  marginLeft: 'auto',
  padding: '2px 10px',
  borderRadius: 999,
  border: '0.5px solid var(--a-danger, #c84545)',
  color: 'var(--a-danger, #c84545)',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
};
const metricRowStyle: CSSProperties = { display: 'flex', gap: 24, flexWrap: 'wrap' };
const metricStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 };
const metricNumStyle: CSSProperties = {
  fontSize: 22,
  fontFamily: 'var(--font-sans)',
  fontWeight: 500,
  color: 'var(--ink)',
  fontVariantNumeric: 'tabular-nums',
  letterSpacing: '-0.01em',
};
const metricLabelStyle: CSSProperties = {
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--ink-3)',
};
const typeListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  margin: 0,
  padding: 0,
  listStyle: 'none',
};
const typeItemStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  fontSize: 12,
  color: 'var(--ink-2)',
  fontFamily: 'var(--font-mono)',
  paddingBottom: 4,
  borderBottom: '0.5px solid var(--line-3, rgba(0,0,0,0.06))',
};
const typeNameStyle: CSSProperties = { color: 'var(--ink-2)' };
const typeCountStyle: CSSProperties = { color: 'var(--ink-3)', fontVariantNumeric: 'tabular-nums' };
const footerStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' };
function ctaStyle(pending: boolean): CSSProperties {
  return {
    appearance: 'none',
    padding: '10px 18px',
    borderRadius: 10,
    border: '0.5px solid var(--ink-3)',
    background: 'var(--sheet)',
    color: 'var(--ink)',
    fontSize: 13,
    fontWeight: 500,
    cursor: pending ? 'wait' : 'pointer',
    opacity: pending ? 0.6 : 1,
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
  border: '0.5px solid var(--ink-3)',
  color: 'var(--ink-2)',
  fontSize: 12,
};
const errStyle: CSSProperties = {
  padding: '8px 12px',
  borderRadius: 8,
  border: '0.5px solid var(--a-danger, #c84545)',
  color: 'var(--a-danger, #c84545)',
  fontSize: 12,
};
