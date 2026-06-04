'use client';

/**
 * SourceChipRow — container for multiple SourceChips.
 *
 * P11 (2026-05-01). Loads the full audit row for the given `auditId`
 * (sourceChunksJson, priorOutputsJson) and renders a compact
 * chip row from it directly in the surface (synthesis card in the chat,
 * SniperInjectCard in the workstream detail). Max 5 chips visible, the rest behind "+N more".
 *
 * Rules (see MEMORY "KEINE Overlays"):
 *   - drawer with quote snippet renders INLINE below the row
 *   - no modal, no floating overlay
 *   - clicking "+N more" links to /reasoning-audit/[id] (detail page) instead
 *     of expanding a large list
 */

import { useEffect, useState, type CSSProperties } from 'react';
import Link from 'next/link';

import { SourceChip, type SourceKind } from './source-chip';

interface ChunkLike {
  id?: string;
  sourceType?: string;
  sourceId?: string;
  text?: string;
  similarity?: number;
}

interface PriorOutputLike {
  phase?: string;
  hash?: string;
  text?: string;
}

export interface AuditRowLike {
  id: string;
  workstreamId?: string | null;
  sourceChunks?: ChunkLike[] | null;
  priorOutputs?: PriorOutputLike[] | null;
  userCorrections?: unknown;
}

interface SourceChipRowProps {
  /** Loads the full audit row via GET /api/reasoning-audit/[id]. */
  auditId?: string;
  /** Already-loaded row — skips the fetch. */
  auditRow?: AuditRowLike;
  /** Max chips visible (default 5). */
  maxVisible?: number;
  /** When truthy → "+N more" as a link to the reasoning-audit detail. */
  detailHref?: string;
}

interface NormalizedItem {
  key: string;
  kind: SourceKind;
  ref: string;
  similarity?: number;
  snippet: string;
}

const SNIPPET_LEN = 300;
const FETCH_LRU = new Map<string, AuditRowLike>();

function snippet(text: string | undefined, n = SNIPPET_LEN): string {
  if (typeof text !== 'string' || text.length === 0) return '—';
  if (text.length <= n) return text;
  return text.slice(0, n - 1).trimEnd() + '…';
}

export function normalizeAuditSources(row: AuditRowLike): NormalizedItem[] {
  return normalize(row);
}

export type { NormalizedItem };

function normalize(row: AuditRowLike): NormalizedItem[] {
  const out: NormalizedItem[] = [];

  const chunks = Array.isArray(row.sourceChunks) ? row.sourceChunks : [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const sourceType = typeof c.sourceType === 'string' ? c.sourceType : 'rag';
    const sourceId =
      typeof c.sourceId === 'string'
        ? c.sourceId
        : typeof c.id === 'string'
          ? c.id
          : `chunk-${i}`;
    out.push({
      key: `rag-${i}-${sourceId}`,
      kind: 'rag',
      ref: `${sourceType}:${sourceId}`,
      similarity: typeof c.similarity === 'number' ? c.similarity : undefined,
      snippet: snippet(c.text),
    });
  }

  const priors = Array.isArray(row.priorOutputs) ? row.priorOutputs : [];
  for (let i = 0; i < priors.length; i++) {
    const p = priors[i];
    const phase = typeof p.phase === 'string' ? p.phase : 'unknown';
    const hash = typeof p.hash === 'string' ? p.hash : `${i}`;
    out.push({
      key: `prior-${i}-${hash}`,
      kind: 'prior-output',
      ref: `phase:${phase}:${hash.slice(0, 8)}`,
      snippet: snippet(p.text),
    });
  }

  return out;
}

export function SourceChipRow({
  auditId,
  auditRow,
  maxVisible = 5,
  detailHref,
}: SourceChipRowProps): React.JSX.Element | null {
  // Derive the initial state directly from props/cache — avoids the
  // setState-in-effect cascade (react-hooks/set-state-in-effect).
  const initialRow: AuditRowLike | null =
    auditRow ?? (auditId ? (FETCH_LRU.get(auditId) ?? null) : null);
  const [row, setRow] = useState<AuditRowLike | null>(initialRow);
  const [error, setError] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);

  useEffect(() => {
    if (auditRow) return;
    if (!auditId) return;
    // A cache hit was already consumed via initialRow. If row is still null
    // and the cache now has an entry (e.g. because a
    // sibling loaded the value), the next re-render through
    // the state setter below is enough — we only set on a network result.
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(
          `/api/reasoning-audit/${encodeURIComponent(auditId)}`,
          { cache: 'no-store', credentials: 'same-origin' },
        );
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const j = (await res.json()) as AuditRowLike;
        if (!cancelled) {
          FETCH_LRU.set(auditId, j);
          setRow(j);
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
  }, [auditId, auditRow]);

  if (error) {
    return (
      <div style={errStyle} data-testid="source-chip-row-error">
        Quellen nicht ladbar: {error}
      </div>
    );
  }
  if (!row) {
    return null;
  }

  const items = normalize(row);
  if (items.length === 0) return null;

  const visible = items.slice(0, maxVisible);
  const hidden = items.length - visible.length;
  const href =
    detailHref ?? (row.id ? `/reasoning-audit/${row.id}` : undefined);
  const openItem = visible.find((i) => i.key === openKey) ?? null;

  return (
    <div style={wrapStyle} data-testid="source-chip-row">
      <div style={rowStyle}>
        <span style={leadStyle}>Quellen:</span>
        {visible.map((item) => (
          <SourceChip
            key={item.key}
            kind={item.kind}
            ref={item.ref}
            similarity={item.similarity}
            active={openKey === item.key}
            onClick={(): void => {
              setOpenKey((cur) => (cur === item.key ? null : item.key));
            }}
          />
        ))}
        {hidden > 0 && href ? (
          <Link href={href} style={moreStyle} data-testid="source-chip-more">
            +{hidden} weitere
          </Link>
        ) : null}
      </div>

      {openItem ? (
        <div style={drawerStyle} data-testid="source-chip-drawer">
          <div style={drawerHeaderStyle}>
            <span style={drawerKindStyle}>
              {openItem.kind === 'rag'
                ? 'RAG-Chunk'
                : openItem.kind === 'prior-output'
                  ? 'Vorherige Phase'
                  : 'Memory'}
            </span>
            <span style={drawerRefStyle}>{openItem.ref}</span>
            {typeof openItem.similarity === 'number' ? (
              <span style={drawerSimStyle}>
                {Math.round(openItem.similarity * 100)}% match
              </span>
            ) : null}
          </div>
          <p style={drawerSnippetStyle}>{openItem.snippet}</p>
          {href ? (
            <Link href={href} style={drawerLinkStyle}>
              Vollen Audit-Trail öffnen →
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ────────────────────────────── Styles ──────────────────────────────

const wrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  marginTop: 12,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 6,
};

const leadStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--ink-3)',
  marginRight: 4,
};

const moreStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-2)',
  textDecoration: 'none',
  padding: '3px 10px',
  borderRadius: 999,
  border: '0.5px dashed var(--line-2)',
};

const drawerStyle: CSSProperties = {
  padding: '10px 12px',
  borderRadius: 8,
  border: '0.5px solid var(--line-2)',
  background: 'var(--sheet)',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const drawerHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
};

const drawerKindStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--ink-3)',
};

const drawerRefStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-2)',
  wordBreak: 'break-all',
};

const drawerSimStyle: CSSProperties = {
  marginLeft: 'auto',
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--ink-3)',
  fontVariantNumeric: 'tabular-nums',
};

const drawerSnippetStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.55,
  color: 'var(--ink)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const drawerLinkStyle: CSSProperties = {
  alignSelf: 'flex-start',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--a-now)',
  textDecoration: 'none',
  letterSpacing: '0.04em',
  marginTop: 2,
};

const errStyle: CSSProperties = {
  marginTop: 8,
  padding: '6px 10px',
  borderRadius: 8,
  border: '0.5px solid var(--a-danger)',
  color: 'var(--a-danger)',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
};
