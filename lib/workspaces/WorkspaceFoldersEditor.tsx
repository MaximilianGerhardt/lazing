'use client';

/**
 * WorkspaceFoldersEditor — der Editor „Welche Ordner gehören zu diesem Projekt?"
 *
 * Owner-Leitprinzip (verbatim): „Das System vereinfacht und führt komplizierte
 * Prozesse automatisch aus, der Nutzer muss gar nicht darüber nachdenken."
 * → Der Nutzer sagt NUR „diese Ordner gehören zu diesem Projekt". Er konfiguriert
 *   NIEMALS Sandbox/Sicherheit/Deny-Liste — das bleibt unsichtbar (FS-3..FS-5).
 *
 * Surface:
 *   - Headline nutzer-orientiert (NICHT „Sandbox-Roots konfigurieren").
 *   - Liste der Roots: Pfad · ro/rw-Toggle · Remove.
 *   - Der primäre Root trägt ein „primär"-Badge und ist NICHT löschbar.
 *   - Ein „Ordner hinzufügen"-Input (absoluter Pfad).
 *   - Optimistic UI gegen /api/workspaces/[id]/fs-roots.
 *
 * Stil: laz.ing Design Manifest v1.0 — Pitch-Black #070707, SF Pro Display,
 * brand-gradient (--a-now) NUR auf aktivem Marker, 240ms cubic-bezier. Kein
 * Hex direkt in TSX (nur var(--token, #fallback)). Keine Emojis. Vorbild:
 * lib/chat/EnginePill.tsx.
 */

import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
} from 'react';

export interface FsRoot {
  id: string;
  workspaceId: string;
  absPath: string;
  role: 'primary' | 'repo' | 'dir';
  access: 'ro' | 'rw';
  isGit: boolean;
  githubRepoId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface Props {
  workspaceId: string;
  /** Optional: vorab geladene Roots (SSR/Test). Sonst per fetch geladen. */
  initialRoots?: FsRoot[];
  /** Optional: fetch-Override für Tests. Default = globaler fetch. */
  fetchImpl?: typeof fetch;
}

export function WorkspaceFoldersEditor({
  workspaceId,
  initialRoots,
  fetchImpl,
}: Props): React.JSX.Element {
  const doFetch = fetchImpl ?? fetch;
  const [roots, setRoots] = useState<FsRoot[]>(initialRoots ?? []);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<boolean>(initialRoots != null);

  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/fs-roots`;

  // Mount: Roots laden (nur wenn nicht vorab übergeben).
  useEffect(() => {
    if (initialRoots != null) return;
    let cancelled = false;
    void doFetch(base)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { roots?: FsRoot[] } | null) => {
        if (cancelled) return;
        if (j?.roots) setRoots(j.roots);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
    // base ist von workspaceId abgeleitet; doFetch ist stabil.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const addRoot = useCallback(async () => {
    const absPath = draft.trim();
    setError(null);
    if (!absPath.startsWith('/')) {
      setError('Bitte einen absoluten Pfad angeben (beginnt mit „/").');
      return;
    }
    setAdding(true);
    try {
      const res = await doFetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ absPath, access: 'rw' }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(j?.message ?? 'Konnte den Ordner nicht hinzufügen.');
        return;
      }
      const j = (await res.json()) as { root?: FsRoot };
      if (j.root) {
        setRoots((prev) => [...prev, j.root as FsRoot]);
        setDraft('');
      }
    } catch {
      setError('Netzwerkfehler — bitte erneut versuchen.');
    } finally {
      setAdding(false);
    }
  }, [base, draft, doFetch]);

  const toggleAccess = useCallback(
    async (root: FsRoot) => {
      const next: 'ro' | 'rw' = root.access === 'rw' ? 'ro' : 'rw';
      // Optimistic.
      setRoots((prev) =>
        prev.map((r) => (r.id === root.id ? { ...r, access: next } : r)),
      );
      try {
        // Re-add toggelt access (POST ist idempotent über UNIQUE(ws,absPath) +
        // Update-on-conflict im Repo, FS-1). Integrator kann das auf PATCH heben.
        const res = await doFetch(base, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ absPath: root.absPath, access: next, role: root.role }),
        });
        if (!res.ok) throw new Error('toggle failed');
      } catch {
        // Rollback bei Fehler.
        setRoots((prev) =>
          prev.map((r) => (r.id === root.id ? { ...r, access: root.access } : r)),
        );
        setError('Konnte den Zugriff nicht ändern.');
      }
    },
    [base, doFetch],
  );

  const removeRoot = useCallback(
    async (root: FsRoot) => {
      if (root.role === 'primary') return; // primär ist nicht löschbar.
      const prev = roots;
      setRoots((cur) => cur.filter((r) => r.id !== root.id)); // optimistic.
      try {
        const res = await doFetch(`${base}/${encodeURIComponent(root.id)}`, {
          method: 'DELETE',
        });
        if (!res.ok) throw new Error('delete failed');
      } catch {
        setRoots(prev); // rollback.
        setError('Konnte den Ordner nicht entfernen.');
      }
    },
    [base, roots, doFetch],
  );

  return (
    <section style={sectionStyle} data-test="ws-folders-editor">
      <header style={headerStyle}>
        <h2 style={titleStyle}>Welche Ordner gehören zu diesem Projekt?</h2>
        <p style={leadStyle}>
          Ein Projekt kann aus mehreren Ordnern bestehen — z.&nbsp;B. das CRM und die
          Website. Alles, was hier steht, gehört zusammen.
        </p>
      </header>

      <ul style={listStyle} data-test="ws-folders-list">
        {roots.map((root) => (
          <li key={root.id} style={rowStyle} data-test={`ws-folder-row-${root.id}`}>
            <span style={pathWrapStyle}>
              <span style={pathStyle} title={root.absPath}>
                {root.absPath}
              </span>
              {root.role === 'primary' ? (
                <span style={primaryBadgeStyle} data-test="ws-folder-primary-badge">
                  primär
                </span>
              ) : null}
            </span>

            <span style={controlsStyle}>
              <button
                type="button"
                onClick={() => void toggleAccess(root)}
                style={accessToggleStyle(root.access)}
                data-test={`ws-folder-access-${root.id}`}
                data-access={root.access}
                aria-label={
                  root.access === 'rw'
                    ? 'Schreibrecht — tippen für Nur-Lesen'
                    : 'Nur-Lesen — tippen für Schreibrecht'
                }
              >
                {root.access === 'rw' ? 'Schreiben' : 'Nur lesen'}
              </button>

              {root.role === 'primary' ? (
                <span style={removeSpacerStyle} aria-hidden />
              ) : (
                <button
                  type="button"
                  onClick={() => void removeRoot(root)}
                  style={removeStyle}
                  data-test={`ws-folder-remove-${root.id}`}
                  aria-label={`${root.absPath} entfernen`}
                >
                  Entfernen
                </button>
              )}
            </span>
          </li>
        ))}
        {loaded && roots.length === 0 ? (
          <li style={emptyStyle} data-test="ws-folders-empty">
            Noch kein Ordner. Füge unten den ersten hinzu.
          </li>
        ) : null}
      </ul>

      <div style={addRowStyle}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !adding) void addRoot();
          }}
          placeholder="/path/to/my-project"
          style={inputStyle}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          data-test="ws-folder-input"
          disabled={adding}
        />
        <button
          type="button"
          onClick={() => void addRoot()}
          style={addBtnStyle(draft.trim().length > 0 && !adding)}
          disabled={adding || draft.trim().length === 0}
          data-test="ws-folder-add"
        >
          {adding ? 'Hinzufügen…' : 'Ordner hinzufügen'}
        </button>
      </div>

      {error ? (
        <p style={errorStyle} role="alert" data-test="ws-folders-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

// ---- Styles (Pitch-Black + brand-gradient only on the primary marker) ----

const sectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  padding: 20,
  borderRadius: 16,
  background: 'var(--sheet-1, #0b0b0b)',
  border: '0.5px solid var(--line-2, #1f1f1f)',
  fontFamily: "var(--font-sans, 'SF Pro Display', system-ui)",
  color: 'var(--ink, #f5f5f5)',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 17,
  fontWeight: 600,
  letterSpacing: '-0.01em',
  color: 'var(--ink, #f5f5f5)',
};

const leadStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--ink-3, #6b6b6b)',
};

const listStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '10px 12px',
  borderRadius: 12,
  background: 'var(--sheet-2, #0e0e0e)',
  border: '0.5px solid var(--line-2, #1f1f1f)',
};

const pathWrapStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 10,
  minWidth: 0,
  flex: 1,
};

const pathStyle: CSSProperties = {
  fontFamily: 'var(--font-mono, ui-monospace)',
  fontSize: 13,
  color: 'var(--ink, #f5f5f5)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  letterSpacing: '-0.01em',
};

const primaryBadgeStyle: CSSProperties = {
  flexShrink: 0,
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  padding: '3px 8px',
  borderRadius: 999,
  // brand-gradient NUR hier (aktiver/ausgezeichneter Marker = der primäre Root).
  color: 'var(--sheet, #070707)',
  background: 'var(--a-now, #c9ff4d)',
};

const controlsStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  flexShrink: 0,
};

function accessToggleStyle(access: 'ro' | 'rw'): CSSProperties {
  const isRw = access === 'rw';
  return {
    appearance: 'none',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500,
    padding: '5px 10px',
    borderRadius: 999,
    color: isRw ? 'var(--ink, #f5f5f5)' : 'var(--ink-3, #6b6b6b)',
    background: isRw
      ? 'color-mix(in oklab, var(--a-now, #c9ff4d) 8%, var(--sheet-2, #0e0e0e))'
      : 'var(--sheet-2, #0e0e0e)',
    border: '0.5px solid var(--line-2, #1f1f1f)',
    transition:
      'background 240ms cubic-bezier(0.16, 1, 0.3, 1), color 240ms cubic-bezier(0.16, 1, 0.3, 1)',
  };
}

const removeStyle: CSSProperties = {
  appearance: 'none',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 500,
  padding: '5px 10px',
  borderRadius: 999,
  color: 'var(--ink-3, #6b6b6b)',
  background: 'transparent',
  border: '0.5px solid var(--line-2, #1f1f1f)',
  transition: 'color 240ms cubic-bezier(0.16, 1, 0.3, 1)',
};

const removeSpacerStyle: CSSProperties = {
  display: 'inline-block',
  width: 1,
};

const emptyStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--ink-3, #6b6b6b)',
  padding: '10px 12px',
};

const addRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const inputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: 'var(--font-mono, ui-monospace)',
  fontSize: 13,
  padding: '9px 12px',
  borderRadius: 10,
  color: 'var(--ink, #f5f5f5)',
  background: 'var(--sheet-2, #0e0e0e)',
  border: '0.5px solid var(--line-2, #1f1f1f)',
  outline: 'none',
};

function addBtnStyle(enabled: boolean): CSSProperties {
  return {
    appearance: 'none',
    cursor: enabled ? 'pointer' : 'default',
    fontSize: 13,
    fontWeight: 600,
    padding: '9px 14px',
    borderRadius: 10,
    whiteSpace: 'nowrap',
    color: enabled ? 'var(--sheet, #070707)' : 'var(--ink-3, #6b6b6b)',
    // primäre Aktion → brand-gradient nur wenn aktiv.
    background: enabled ? 'var(--a-now, #c9ff4d)' : 'var(--sheet-2, #0e0e0e)',
    border: '0.5px solid var(--line-2, #1f1f1f)',
    transition: 'background 240ms cubic-bezier(0.16, 1, 0.3, 1)',
  };
}

const errorStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: 'var(--a-danger, #FF453A)',
};

export default WorkspaceFoldersEditor;
