'use client';

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';

import { Pill } from '@/lib/ui/pil';
import { useCurrentWorkspace, useWorkspaces } from '@/lib/nav/hooks';

interface SessionRow {
  uuid: string;
  workspaceId: string | null;
  projectSlug: string;
  path: string;
  lastActivity: number;
  bytes: number;
  turnCount: number;
  lastPrompt: string | null;
  contextTotal?: number;
  contextFillPct?: number;
  active?: boolean;
}

const COLLAPSED_PER_GROUP = 3;

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'gerade eben';
  if (diff < 3_600_000) return `vor ${Math.floor(diff / 60_000)} Min`;
  if (diff < 86_400_000) return `vor ${Math.floor(diff / 3_600_000)} h`;
  const days = Math.floor(diff / 86_400_000);
  if (days === 1) return 'gestern';
  return `vor ${days} Tagen`;
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export function SessionsList(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resumingUuid, setResumingUuid] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const { workspaces } = useWorkspaces();
  const currentWorkspace = useCurrentWorkspace();
  const router = useRouter();

  const toggleGroup = useCallback((wsId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(wsId)) next.delete(wsId);
      else next.add(wsId);
      return next;
    });
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const resp = await fetch('/api/sessions?limit=200', { cache: 'no-store' });
      if (!resp.ok) {
        setError(`HTTP ${resp.status}`);
        return;
      }
      const json = (await resp.json()) as { sessions?: SessionRow[] };
      setSessions(Array.isArray(json.sessions) ? json.sessions : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const wsLabel = useCallback(
    (id: string | null): string => {
      if (!id) return '(kein Workspace)';
      const match = workspaces.find((w) => w.id === id);
      return match?.label ?? id;
    },
    [workspaces],
  );

  const wsAccent = useCallback(
    (id: string | null): 'north' | 'clientb' | 'own' | 'private' | 'claude' | 'codex' | 'error' => {
      if (!id) return 'own';
      const match = workspaces.find((w) => w.id === id);
      return match?.accent ?? 'own';
    },
    [workspaces],
  );

  // Group by workspace
  const grouped = useMemo(() => {
    if (!sessions) return null;
    const groups = new Map<string, SessionRow[]>();
    for (const s of sessions) {
      const key = s.workspaceId ?? '__unknown__';
      const arr = groups.get(key) ?? [];
      arr.push(s);
      groups.set(key, arr);
    }
    return Array.from(groups.entries()).sort((a, b) => {
      // Aktuellen workspace zuerst, dann sortiert nach latest-activity
      if (a[0] === currentWorkspace.id) return -1;
      if (b[0] === currentWorkspace.id) return 1;
      const latestA = Math.max(...a[1].map((s) => s.lastActivity));
      const latestB = Math.max(...b[1].map((s) => s.lastActivity));
      return latestB - latestA;
    });
  }, [sessions, currentWorkspace.id]);

  const handleResume = useCallback(
    async (session: SessionRow): Promise<void> => {
      // Pseudo-Workspaces (`(root)`, `(tmp)`, `(home-dev)`) entsprechen keinem
      // echten lazyOS-Workspace. In dem Fall resumen wir die Session in den
      // gerade aktiven Workspace — Max landet im Chat genau dort.
      const isPseudo =
        !session.workspaceId || session.workspaceId.startsWith('(');
      const targetWs = isPseudo ? currentWorkspace.id : session.workspaceId!;
      setResumingUuid(session.uuid);
      try {
        const resp = await fetch(`/api/sessions/${session.uuid}/resume`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId: targetWs }),
        });
        if (!resp.ok) {
          const txt = await resp.text();
          setError(`Resume fehlgeschlagen: ${txt.slice(0, 200)}`);
          setResumingUuid(null);
          return;
        }
        router.push('/');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setResumingUuid(null);
      }
    },
    [currentWorkspace.id, router],
  );

  if (error) {
    return (
      <div style={errStyle}>
        Fehler beim Laden: {error}
        <button type="button" onClick={load} style={{ marginLeft: 12 }}>
          Nochmal
        </button>
      </div>
    );
  }
  if (!sessions) {
    return <div style={emptyStyle}>Lade Sessions …</div>;
  }
  if (sessions.length === 0) {
    return (
      <div style={emptyStyle}>
        Keine Claude-Code-Sessions gefunden. Starte eine im Chat oder im Terminal —
        sie erscheinen beim nächsten Refresh hier.
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1100, display: 'flex', flexDirection: 'column', gap: 40 }}>
      {grouped?.map(([wsId, rows]) => {
        const isExpanded = expandedGroups.has(wsId);
        const visibleRows = isExpanded
          ? rows
          : rows.slice(0, COLLAPSED_PER_GROUP);
        const hiddenCount = rows.length - visibleRows.length;
        return (
        <section key={wsId} aria-label={`Workspace ${wsLabel(wsId === '__unknown__' ? null : wsId)}`}>
          <header style={groupHeaderStyle}>
            {wsId !== '__unknown__' ? (
              <Pill variant={wsAccent(wsId)}>{wsLabel(wsId)}</Pill>
            ) : (
              <span style={{ color: 'var(--ink-3)', fontSize: 13 }}>
                ({wsLabel(null)})
              </span>
            )}
            <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>
              {rows.length} Session{rows.length === 1 ? '' : 's'}
            </span>
          </header>
          <ul style={listStyle}>
            {visibleRows.map((s) => {
              const ctxPct = s.contextFillPct ?? 0;
              const ctxColor =
                ctxPct > 80
                  ? 'var(--a-danger)'
                  : ctxPct > 60
                    ? 'var(--a-warn)'
                    : 'var(--a-now)';
              return (
              <li key={s.uuid} style={itemStyle}>
                <div style={itemMainStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {s.active ? (
                      <span
                        style={activeBadgeStyle}
                        title="Aktuell aktive Session dieses Workspaces"
                      >
                        aktiv
                      </span>
                    ) : null}
                    <code style={uuidStyle}>{s.uuid.slice(0, 8)}</code>
                    <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>
                      · {s.turnCount} Turn{s.turnCount === 1 ? '' : 's'}
                    </span>
                    {s.contextFillPct !== undefined && s.contextFillPct > 0 ? (
                      <span
                        title={`${(s.contextTotal ?? 0).toLocaleString('de')} / 1.000.000 tokens`}
                        style={{
                          ...ctxBadgeStyle,
                          color: ctxColor,
                          borderColor: ctxColor,
                        }}
                      >
                        {ctxPct}% CTX
                      </span>
                    ) : null}
                    <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>
                      · {formatBytes(s.bytes)}
                    </span>
                    <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>
                      · {formatRelative(s.lastActivity)}
                    </span>
                  </div>
                  {s.lastPrompt ? (
                    <div style={promptStyle} title={s.lastPrompt}>
                      „{s.lastPrompt}"
                    </div>
                  ) : null}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button
                    type="button"
                    onClick={() => handleResume(s)}
                    disabled={resumingUuid !== null}
                    style={resumingUuid === s.uuid ? resumeBtnLoadingStyle : resumeBtnStyle}
                  >
                    {resumingUuid === s.uuid ? 'Lade …' : 'Fortsetzen →'}
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!confirm(`Session ${s.uuid.slice(0, 8)} archivieren?`)) return;
                      const resp = await fetch(`/api/sessions/${s.uuid}`, { method: 'DELETE' });
                      if (resp.ok) {
                        await load();
                      } else {
                        const text = await resp.text();
                        setError(`Archivieren fehlgeschlagen: ${text.slice(0, 200)}`);
                      }
                    }}
                    aria-label="Session archivieren"
                    title="Session archivieren (verschiebt JSONL nach /archived)"
                    style={archiveBtnStyle}
                  >
                    Archivieren
                  </button>
                </div>
              </li>
              );
            })}
          </ul>
          {hiddenCount > 0 || isExpanded ? (
            <button
              type="button"
              onClick={() => toggleGroup(wsId)}
              style={toggleBtnStyle}
            >
              {isExpanded
                ? `Weniger anzeigen (${visibleRows.length})`
                : `Alle ${rows.length} anzeigen · +${hiddenCount} weitere`}
            </button>
          ) : null}
        </section>
        );
      })}
    </div>
  );
}

const errStyle: CSSProperties = {
  padding: 14,
  borderRadius: 'var(--radius-md, 10px)',
  background: 'color-mix(in oklab, var(--a-danger) 10%, transparent)',
  border: '1px solid var(--a-danger)',
  color: 'var(--ink)',
  fontSize: 14,
  maxWidth: 720,
};

const emptyStyle: CSSProperties = {
  padding: 40,
  textAlign: 'center',
  color: 'var(--ink-2)',
  fontSize: 15,
  background: 'color-mix(in oklab, var(--sheet-2) 60%, transparent)',
  borderRadius: 'var(--radius-md, 10px)',
  border: '1px dashed var(--line-2)',
  maxWidth: 720,
};

const groupHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  marginBottom: 14,
};

const listStyle: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const itemStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 16,
  padding: 14,
  borderRadius: 'var(--radius-md, 10px)',
  background: 'color-mix(in oklab, var(--sheet-2) 75%, transparent)',
  border: '0.5px solid var(--line-2)',
  flexWrap: 'wrap',
};

const itemMainStyle: CSSProperties = {
  flex: '1 1 400px',
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const uuidStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--ink-2)',
  padding: '2px 6px',
  background: 'color-mix(in oklab, var(--sheet-3) 90%, transparent)',
  borderRadius: 4,
};

const promptStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--ink-2)',
  fontStyle: 'italic',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxWidth: '100%',
};

const activeBadgeStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  padding: '2px 8px',
  borderRadius: 'var(--radius-pill, 999px)',
  background: 'var(--a-now)',
  color: 'var(--sheet)',
};

const resumeBtnStyle: CSSProperties = {
  padding: '8px 16px',
  borderRadius: 'var(--radius-pill, 999px)',
  border: '0.5px solid var(--a-now)',
  background: 'color-mix(in oklab, var(--a-now) 15%, transparent)',
  color: 'var(--a-now)',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const resumeBtnLoadingStyle: CSSProperties = {
  ...resumeBtnStyle,
  opacity: 0.55,
  cursor: 'progress',
};

const archiveBtnStyle: CSSProperties = {
  padding: '8px 14px',
  borderRadius: 'var(--radius-pill, 999px)',
  border: '0.5px solid var(--line-2)',
  background: 'transparent',
  color: 'var(--ink-3)',
  fontSize: 12,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const toggleBtnStyle: CSSProperties = {
  marginTop: 12,
  padding: '8px 16px',
  borderRadius: 'var(--radius-pill, 999px)',
  border: '0.5px dashed var(--line-2)',
  background: 'transparent',
  color: 'var(--ink-2)',
  fontSize: 12,
  fontFamily: 'var(--font-mono)',
  letterSpacing: '0.02em',
  cursor: 'pointer',
  width: '100%',
  textAlign: 'center',
};

const ctxBadgeStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  padding: '2px 7px',
  borderRadius: 4,
  border: '0.5px solid',
  letterSpacing: '0.04em',
};
