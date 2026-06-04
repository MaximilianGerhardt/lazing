'use client';

/**
 * WorkspaceEditor — Client-Form fuer Workspace-Mutation.
 *
 * Edits werden direkt PATCH'ed, kein "Speichern"-Button-noetig:
 * onBlur fuer Text-Felder, onChange fuer Selects. Status-Pille zeigt
 * "gespeichert" / "speichert..." / "Fehler" sehr kurz.
 *
 * Notes ist Markdown-Langform — Mini-CLAUDE.md fuer den Workspace.
 * "KI-Auto-Beschreibung"-Button ruft /api/workspaces/[id]/auto-describe
 * auf (kommt im naechsten Commit) und ueberschreibt notes mit einer
 * Synthese aus Tickets+Workstreams+Events.
 */

import { useEffect, useMemo, useState, useTransition, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';

import { dispatchWorkspaceDataChange } from '@/lib/nav/hooks';

interface Workspace {
  id: string;
  label: string;
  description: string;
  notes: string;
  sensitivity: string;
  notesSource: string | null;
  notesUpdatedAt: number | null;
  organizationId: string | null;
  /** Phase OS.4 — server-resolved Org-Vorschlag (oder null). */
  orgSuggestion: { orgId: string; reason: string } | null;
}

interface OrgOption {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export function WorkspaceEditor({
  workspace,
}: {
  workspace: Workspace;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [label, setLabel] = useState(workspace.label);
  const [description, setDescription] = useState(workspace.description);
  const [notes, setNotes] = useState(workspace.notes);
  const [sensitivity, setSensitivity] = useState(workspace.sensitivity);
  const [organizationId, setOrganizationId] = useState<string | null>(
    workspace.organizationId,
  );
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [orgsLoaded, setOrgsLoaded] = useState(false);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/orgs')
      .then((r) => (r.ok ? r.json() : { orgs: [] }))
      .then((data: { orgs?: OrgOption[] }) => {
        if (cancelled) return;
        setOrgs(Array.isArray(data.orgs) ? data.orgs : []);
        setOrgsLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setOrgsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const orgItems = useMemo(() => buildOrgHierarchy(orgs), [orgs]);

  const suggestion = useMemo(() => {
    if (organizationId !== null) return null;
    if (!orgsLoaded) return null;
    const s = workspace.orgSuggestion;
    if (!s) return null;
    const match = orgs.find((o) => o.id === s.orgId);
    if (!match) return null;
    return { orgId: s.orgId, name: match.name, reason: s.reason };
  }, [organizationId, orgs, orgsLoaded, workspace.orgSuggestion]);

  const save = async (patch: Record<string, unknown>): Promise<void> => {
    setStatus('saving');
    setErrorMsg(null);
    try {
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspace.id)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setStatus('error');
        setErrorMsg(body.message ?? body.error ?? `HTTP ${res.status}`);
        return;
      }
      setStatus('saved');
      // Cache-Invalidation für Server-Components (WorkspacesList, OrgDetail).
      startTransition(() => router.refresh());
      // Cache-Invalidation für Client-State (TopNav-Switcher, MobileDrawer):
      // routerRefresh greift nur Server-Components, nicht useWorkspaces().
      dispatchWorkspaceDataChange();
      window.setTimeout(() => setStatus('idle'), 1400);
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const lastUpdate = workspace.notesUpdatedAt
    ? new Date(workspace.notesUpdatedAt).toLocaleString('de-DE', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : null;

  return (
    <div style={wrapStyle}>
      <Field label="Label" hint="Kurzname in TopBar + Listen">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => {
            if (label.trim() !== workspace.label && label.trim().length > 0) {
              void save({ label: label.trim() });
            }
          }}
          maxLength={120}
          style={inputStyle}
        />
      </Field>

      <Field label="Beschreibung" hint="1-Satz-Zusammenfassung — erscheint im Hero oben">
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => {
            if (description !== workspace.description) {
              void save({ description: description.trim() });
            }
          }}
          maxLength={240}
          placeholder="z.B. Drop-Shipping-CRM für Demo PV"
          style={inputStyle}
        />
      </Field>

      <Field
        label="Notizen (Markdown)"
        hint="Mini-CLAUDE.md für diesen Workspace. Wird vom Chat als Kontext genutzt. Markdown — Headlines, Listen, Code-Blocks."
      >
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => {
            if (notes !== workspace.notes) {
              void save({ notes });
            }
          }}
          maxLength={50_000}
          placeholder={`# ${workspace.label}\n\n## Was hier passiert\n- Auftraege ...\n- Stakeholder ...\n\n## Konventionen\n- ...`}
          rows={14}
          style={textareaStyle}
        />
        {lastUpdate ? (
          <div style={metaStyle}>
            zuletzt {workspace.notesSource === 'ai-summary' ? 'KI-' : ''}aktualisiert: {lastUpdate}
          </div>
        ) : null}
      </Field>

      <Field label="Sensitivity" hint="Wie schutzbedürftig sind Daten in diesem Workspace">
        <select
          value={sensitivity}
          onChange={(e) => {
            setSensitivity(e.target.value);
            void save({ sensitivity: e.target.value });
          }}
          style={selectStyle}
        >
          <option value="low">low — Standard</option>
          <option value="normal">normal — Kunde / Projekt</option>
          <option value="high">high — privat / sensibel</option>
        </select>
      </Field>

      <Field
        label="Organisation"
        hint="Welcher Org gehört dieser Workspace? Bestimmt PDF-Branding, Abrechnung und welche Mitglieder Zugriff bekommen."
      >
        <select
          value={organizationId ?? ''}
          onChange={(e) => {
            const v = e.target.value === '' ? null : e.target.value;
            setOrganizationId(v);
            void save({ organizationId: v });
          }}
          disabled={!orgsLoaded}
          style={selectStyle}
        >
          <option value="">— keine Org (entkoppelt) —</option>
          {orgItems.map((item) => (
            <option key={item.id} value={item.id}>
              {item.indentedLabel}
            </option>
          ))}
        </select>
        {!orgsLoaded ? (
          <div style={metaStyle}>lädt Orgs …</div>
        ) : orgItems.length === 0 ? (
          <div style={metaStyle}>
            Keine Orgs verfügbar — du bist in keiner Org Mitglied.
          </div>
        ) : null}
        {suggestion ? (
          <div style={suggestionStyle}>
            <span style={{ color: 'var(--ink-3)' }}>
              Vorschlag: <strong style={{ color: 'var(--ink-2)' }}>{suggestion.name}</strong> ·{' '}
              {suggestion.reason}
            </span>
            <button
              type="button"
              onClick={() => {
                setOrganizationId(suggestion.orgId);
                void save({ organizationId: suggestion.orgId });
              }}
              style={suggestionBtnStyle}
            >
              übernehmen
            </button>
          </div>
        ) : null}
      </Field>

      <div style={statusBarStyle}>
        <span style={statusPillStyle(status)}>
          {status === 'idle' && 'bereit'}
          {status === 'saving' && 'speichert …'}
          {status === 'saved' && 'gespeichert'}
          {status === 'error' && (errorMsg ?? 'Fehler')}
        </span>
        <span style={statusHintStyle}>Änderungen werden beim Verlassen des Feldes automatisch gespeichert.</span>
      </div>
    </div>
  );
}

/**
 * Sortiert die Orgs hierarchisch (parent vor children) und liefert pro Eintrag
 * ein eingerücktes Label. Top-Level zuerst, dann Children sortiert.
 *
 * Wichtig: keine Endlos-Schleife bei Cycles — wir tracken `seen`.
 */
function buildOrgHierarchy(
  orgs: OrgOption[],
): Array<{ id: string; indentedLabel: string }> {
  if (orgs.length === 0) return [];
  const byParent = new Map<string | null, OrgOption[]>();
  for (const o of orgs) {
    const key = o.parentId ?? null;
    const list = byParent.get(key) ?? [];
    list.push(o);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }
  const result: Array<{ id: string; indentedLabel: string }> = [];
  const seen = new Set<string>();
  // Roots = orgs whose parent is missing in the visible set.
  const visibleIds = new Set(orgs.map((o) => o.id));
  const roots = orgs.filter(
    (o) => !o.parentId || !visibleIds.has(o.parentId),
  );
  roots.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const walk = (node: OrgOption, depth: number): void => {
    if (seen.has(node.id) || depth > 6) return;
    seen.add(node.id);
    const indent = depth === 0 ? '' : `${'  '.repeat(depth)}└ `;
    result.push({ id: node.id, indentedLabel: `${indent}${node.name}` });
    const children = byParent.get(node.id) ?? [];
    for (const c of children) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  // Falls Cycles → Reste hinten dranhängen ohne Indent.
  for (const o of orgs) {
    if (!seen.has(o.id)) {
      result.push({ id: o.id, indentedLabel: `${o.name} (orphan)` });
      seen.add(o.id);
    }
  }
  return result;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={fieldStyle}>
      <label style={fieldLabelStyle}>{label}</label>
      {hint ? <p style={fieldHintStyle}>{hint}</p> : null}
      {children}
    </div>
  );
}

const wrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 28,
  padding: 'clamp(20px, 3vw, 36px)',
  borderRadius: 16,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet-2) 80%, transparent)',
  maxWidth: 880,
};

const fieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const fieldLabelStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--ink-2)',
};

const fieldHintStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: 'var(--ink-3)',
  lineHeight: 1.5,
  letterSpacing: '-0.005em',
};

const inputStyle: CSSProperties = {
  padding: '12px 14px',
  borderRadius: 10,
  background: 'var(--sheet)',
  border: '0.5px solid var(--line-2)',
  color: 'var(--ink)',
  fontSize: 15,
  fontFamily: 'var(--font-sans)',
  letterSpacing: '-0.005em',
  outline: 'none',
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
  lineHeight: 1.6,
  resize: 'vertical',
  minHeight: 240,
};

const selectStyle: CSSProperties = {
  ...inputStyle,
  appearance: 'none',
};

const metaStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.04em',
  color: 'var(--ink-3)',
};

const suggestionStyle: CSSProperties = {
  marginTop: 6,
  padding: '8px 12px',
  borderRadius: 8,
  border: '0.5px dashed var(--line-2)',
  background: 'color-mix(in oklab, var(--a-now) 4%, transparent)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  fontSize: 12,
};

const suggestionBtnStyle: CSSProperties = {
  appearance: 'none',
  background: 'transparent',
  border: '0.5px solid var(--a-now)',
  borderRadius: 6,
  padding: '4px 10px',
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--a-now)',
  cursor: 'pointer',
};

const statusBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  flexWrap: 'wrap',
  paddingTop: 12,
  borderTop: '0.5px dashed var(--line-2)',
};

function statusPillStyle(status: SaveStatus): CSSProperties {
  const color =
    status === 'saved'
      ? 'var(--a-clientb)'
      : status === 'error'
        ? 'var(--a-danger)'
        : status === 'saving'
          ? 'var(--a-now)'
          : 'var(--ink-3)';
  return {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    padding: '4px 10px',
    borderRadius: 999,
    border: `0.5px solid ${color}`,
    color,
  };
}

const statusHintStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--ink-3)',
};
