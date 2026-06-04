'use client';

/**
 * AttachWorkspaceCard — Phase OS.2
 *
 * Lets founder/admin assign workspaces to this org that currently have no
 * org (or belong to another one where the user also has rights).
 *
 * Flow:
 *   1. Fetch /api/workspaces (all known workspaces).
 *   2. Filter: organizationId !== this.orgId AND archived !== true.
 *   3. Click on a workspace → PATCH /api/workspaces/[id] with { organizationId }.
 *   4. On 403 → inline hint "missing rights".
 *   5. Success → router.refresh().
 */

import { useEffect, useMemo, useState, useTransition, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';

import { dispatchWorkspaceDataChange } from '@/lib/nav/hooks';

interface ApiWorkspace {
  id: string;
  label: string;
  organizationId: string | null;
  archived: boolean;
  organization?: { id: string; name: string } | null;
}

export function AttachWorkspaceCard({
  orgId,
  orgName,
  canAttach,
}: {
  orgId: string;
  orgName: string;
  canAttach: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<ApiWorkspace[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    void fetch('/api/workspaces')
      .then((r) => r.json())
      .then((data: { workspaces?: ApiWorkspace[] }) => {
        if (cancelled) return;
        setWorkspaces(Array.isArray(data.workspaces) ? data.workspaces : []);
        setLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, loaded]);

  const candidates = useMemo(
    () =>
      workspaces.filter(
        (w) => !w.archived && w.organizationId !== orgId,
      ),
    [workspaces, orgId],
  );

  const attach = async (wsId: string) => {
    setPending(wsId);
    setErrorMsg(null);
    try {
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(wsId)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ organizationId: orgId }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErrorMsg(body.hint ?? body.error ?? `HTTP ${res.status}`);
        setPending(null);
        return;
      }
      // Optimistic: remove from the candidate list.
      setWorkspaces((cur) =>
        cur.map((w) => (w.id === wsId ? { ...w, organizationId: orgId } : w)),
      );
      setPending(null);
      startTransition(() => router.refresh());
      dispatchWorkspaceDataChange();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPending(null);
    }
  };

  if (!canAttach) {
    return null;
  }

  return (
    <div style={{ marginTop: 24 }}>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={addBtnStyle}
        >
          + Workspace hinzufügen
        </button>
      ) : (
        <div style={panelStyle}>
          <div style={panelHeaderStyle}>
            <strong style={{ color: 'var(--ink)' }}>
              Workspace zu „{orgName}" hinzufügen
            </strong>
            <button
              type="button"
              onClick={() => setOpen(false)}
              style={closeBtnStyle}
              aria-label="Schliessen"
            >
              ×
            </button>
          </div>
          {!loaded ? (
            <div style={emptyStyle}>lädt …</div>
          ) : candidates.length === 0 ? (
            <div style={emptyStyle}>
              Keine Workspaces verfügbar — alle Workspaces gehören bereits zu
              dieser Org oder sind archiviert.
            </div>
          ) : (
            <div style={listStyle}>
              {candidates.map((w) => {
                const isPending = pending === w.id;
                const currentOrgLabel = w.organization?.name ?? null;
                return (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => void attach(w.id)}
                    disabled={isPending || pending !== null}
                    style={itemStyle(isPending)}
                  >
                    <span style={itemMainStyle}>
                      <span style={{ color: 'var(--ink)' }}>{w.label}</span>
                      <span style={itemIdStyle}>{w.id}</span>
                    </span>
                    <span style={itemMetaStyle}>
                      {currentOrgLabel ? (
                        <span style={{ color: 'var(--ink-3)' }}>
                          aus „{currentOrgLabel}" verschieben
                        </span>
                      ) : (
                        <span style={{ color: 'var(--a-now)' }}>
                          frei zuordnen
                        </span>
                      )}
                      {isPending ? (
                        <span style={{ color: 'var(--ink-3)' }}>…</span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {errorMsg ? <div style={errStyle}>{errorMsg}</div> : null}
        </div>
      )}
    </div>
  );
}

const addBtnStyle: CSSProperties = {
  appearance: 'none',
  background: 'transparent',
  border: '0.5px dashed var(--line-2)',
  borderRadius: 12,
  padding: '12px 18px',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--ink-2)',
  cursor: 'pointer',
};

const panelStyle: CSSProperties = {
  border: '0.5px solid var(--line-2)',
  borderRadius: 14,
  padding: 18,
  background: 'color-mix(in oklab, var(--sheet-2) 80%, transparent)',
  maxWidth: 760,
};

const panelHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 14,
};

const closeBtnStyle: CSSProperties = {
  appearance: 'none',
  background: 'transparent',
  border: 'none',
  fontSize: 22,
  lineHeight: 1,
  color: 'var(--ink-3)',
  cursor: 'pointer',
};

const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const itemMainStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  alignItems: 'flex-start',
};

const itemIdStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--ink-3)',
};

const itemMetaStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
};

function itemStyle(pending: boolean): CSSProperties {
  return {
    appearance: 'none',
    background: 'transparent',
    border: '0.5px solid var(--line-2)',
    borderRadius: 10,
    padding: '12px 14px',
    fontSize: 13,
    color: 'var(--ink-2)',
    cursor: pending ? 'wait' : 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    textAlign: 'left',
    opacity: pending ? 0.6 : 1,
  };
}

const emptyStyle: CSSProperties = {
  color: 'var(--ink-3)',
  fontSize: 13,
  padding: '8px 0',
};

const errStyle: CSSProperties = {
  marginTop: 12,
  padding: '10px 12px',
  borderRadius: 8,
  border: '0.5px solid var(--a-danger)',
  color: 'var(--a-danger)',
  fontSize: 12,
};
