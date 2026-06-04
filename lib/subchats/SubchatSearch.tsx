'use client';
/**
 * SubchatSearch — quiet, token-only search field over the sub-chat knowledge
 * (cross-workspace, member-gated via /api/subchats/search).
 * Mobile-first, no emojis, only :root tokens. NOT wired into ChatShell
 * (export-only; later mounting). Gathering-Intelligence goal (2026-06-02).
 */
import { useCallback, useRef, useState, type CSSProperties } from 'react';

interface SubchatSearchHit {
  subchatId: string; subchatTitle: string; workspaceId: string;
  workspaceLabel: string; snippet: string; similarity: number;
  deepLink: string; messageId: string;
}

function IconSearch({ size = 18 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

export function SubchatSearch({
  onOpenResult,
  placeholder = 'Sub-Chat-Wissen durchsuchen',
}: {
  /** Optional: Treffer-Tap-Handler (z.B. router.push). Default: window.location.assign(deepLink). */
  onOpenResult?: (hit: SubchatSearchHit) => void;
  placeholder?: string;
}): React.ReactElement {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SubchatSearchHit[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'empty' | 'error'>('idle');
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async (query: string) => {
    const trimmed = query.trim();
    if (trimmed.length < 2) { setHits([]); setState('idle'); return; }
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    setState('loading');
    try {
      const res = await fetch('/api/subchats/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q: trimmed, limit: 20 }),
        signal: ctl.signal,
        credentials: 'same-origin',
      });
      if (!res.ok) { setState('error'); setHits([]); return; }
      const data = (await res.json()) as { results?: SubchatSearchHit[] };
      const r = Array.isArray(data.results) ? data.results : [];
      setHits(r);
      setState(r.length === 0 ? 'empty' : 'idle');
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return;
      setState('error'); setHits([]);
    }
  }, []);

  const open = useCallback((hit: SubchatSearchHit) => {
    if (onOpenResult) onOpenResult(hit);
    else window.location.assign(hit.deepLink);
  }, [onOpenResult]);

  return (
    <div style={wrap}>
      <form style={field} onSubmit={(e) => { e.preventDefault(); void run(q); }}>
        <span style={fieldIcon}><IconSearch size={18} /></span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          style={input}
          inputMode="search"
          enterKeyHint="search"
        />
        <button type="submit" style={goBtn} aria-label="Suchen" disabled={state === 'loading'}>
          <IconSearch size={18} />
        </button>
      </form>

      {state === 'loading' ? <div style={note}>Suche läuft …</div> : null}
      {state === 'empty' ? <div style={note}>Keine Treffer.</div> : null}
      {state === 'error' ? <div style={note}>Suche fehlgeschlagen.</div> : null}

      {hits.length > 0 ? (
        <ul style={list}>
          {hits.map((h, i) => (
            <li key={`${h.messageId}-${i}`}>
              <button type="button" style={hitBtn} onClick={() => open(h)}>
                <span style={hitTop}>
                  <span style={hitTitle}>{h.subchatTitle}</span>
                  <span style={hitWs}>{h.workspaceLabel}</span>
                </span>
                <span style={hitSnippet}>{h.snippet}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
export default SubchatSearch;

/* ---- token-only styles (mobile-first, ≥44px targets) ---- */
const wrap: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, width: '100%' };
const field: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, minHeight: 44,
  padding: '0 8px 0 12px', borderRadius: 14, background: 'var(--sheet-2, #0E0E0F)',
  border: '0.5px solid var(--line-2)',
};
const fieldIcon: CSSProperties = { flexShrink: 0, display: 'inline-flex', color: 'var(--ink-3)' };
const input: CSSProperties = {
  flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none',
  color: 'var(--ink)', fontSize: 16, fontFamily: 'inherit', height: 44,
};
const goBtn: CSSProperties = {
  flexShrink: 0, width: 44, height: 44, display: 'flex', alignItems: 'center',
  justifyContent: 'center', borderRadius: 999, border: 'none', background: 'transparent',
  color: 'var(--ink-2)', cursor: 'pointer', padding: 0,
};
const note: CSSProperties = { fontSize: 13, color: 'var(--ink-3)', padding: '4px 4px' };
const list: CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 };
const hitBtn: CSSProperties = {
  width: '100%', minHeight: 44, textAlign: 'left', display: 'flex', flexDirection: 'column',
  gap: 4, padding: '10px 12px', borderRadius: 12, border: '0.5px solid var(--line-2)',
  background: 'var(--sheet-3, #141416)', color: 'var(--ink)', cursor: 'pointer', fontFamily: 'inherit',
};
const hitTop: CSSProperties = { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 };
const hitTitle: CSSProperties = {
  fontSize: 13.5, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden',
  textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
};
const hitWs: CSSProperties = { fontSize: 11, color: 'var(--ink-3)', flexShrink: 0, fontWeight: 500 };
const hitSnippet: CSSProperties = {
  fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.4,
  display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
};
