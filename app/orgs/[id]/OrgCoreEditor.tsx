'use client';

/**
 * OrgCoreEditor — Name, Description, Type, Parent-Org editierbar.
 *
 * Sichtbar im Overview-Tab. Auto-Save bei Blur. Type-Wechsel aktualisiert
 * sofort die Org-Sortierung im Workspace-Switcher.
 */

import { useState, useTransition, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  orgId: string;
  initial: {
    name: string;
    description: string;
    type: string;
    parentId: string | null;
  };
  canEdit: boolean;
  parentOptions: Array<{ id: string; name: string }>;
}

const TYPES: Array<{ id: string; label: string; hint: string }> = [
  { id: 'company', label: 'Company', hint: 'Eigene Firma / Holding-Dach' },
  { id: 'client', label: 'Kunde', hint: 'Externer Kunde mit eigenem Workspace' },
  { id: 'product', label: 'Eigenprodukt', hint: 'Eigenes Produkt der Holding' },
  { id: 'tool', label: 'Werkzeug', hint: 'Internes Tool / Experiment' },
  { id: 'archived', label: 'Archiviert', hint: 'Read-only, nicht aktiv' },
  { id: 'private', label: 'Privat', hint: 'Persönlich, außerhalb Firma' },
];

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export function OrgCoreEditor({
  orgId,
  initial,
  canEdit,
  parentOptions,
}: Props): React.JSX.Element {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [type, setType] = useState(initial.type);
  const [parentId, setParentId] = useState<string>(initial.parentId ?? '');
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const save = async (patch: Record<string, unknown>): Promise<void> => {
    setStatus('saving');
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error((j.message as string) ?? `HTTP ${res.status}`);
      }
      setStatus('saved');
      startTransition(() => router.refresh());
      window.setTimeout(() => setStatus('idle'), 1200);
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div style={wrapStyle}>
      <Field label="Name" hint="Anzeige-Name in TopNav-Switcher und überall">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (name.trim() !== initial.name && name.trim().length >= 2) {
              void save({ name: name.trim() });
            }
          }}
          maxLength={120}
          disabled={!canEdit}
          style={inputStyle}
        />
      </Field>

      <Field label="Beschreibung" hint="Kurzbeschreibung — Was ist das?">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => {
            if (description !== initial.description) {
              void save({ description: description.trim() || null });
            }
          }}
          rows={3}
          maxLength={2000}
          disabled={!canEdit}
          placeholder="z.B. Kunde — App + Webseite — Energie-Handwerk in Sachsen"
          style={textareaStyle}
        />
      </Field>

      <Field
        label="Typ"
        hint="Bestimmt Sortierung + Bedeutung. Kunde → externer Auftrag, Eigenprodukt → eigenes Projekt der Firma."
      >
        <select
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            void save({ type: e.target.value });
          }}
          disabled={!canEdit}
          style={selectStyle}
        >
          {TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label} — {t.hint}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Übergeordnete Organisation"
        hint="Container-Hierarchie. Kunden hängen typischerweise unter der Holding."
      >
        <select
          value={parentId}
          onChange={(e) => {
            const v = e.target.value;
            setParentId(v);
            void save({ parentId: v || null });
          }}
          disabled={!canEdit}
          style={selectStyle}
        >
          <option value="">— keine (Top-Level) —</option>
          {parentOptions
            .filter((p) => p.id !== orgId)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
      </Field>

      <div style={statusBarStyle}>
        <span style={statusPillStyle(status)}>
          {status === 'idle' && 'bereit'}
          {status === 'saving' && 'speichert …'}
          {status === 'saved' && 'gespeichert'}
          {status === 'error' && (errorMsg ?? 'Fehler')}
        </span>
        <span style={hintStyle}>
          Änderungen werden beim Verlassen des Feldes automatisch gespeichert.
        </span>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
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
  gap: 22,
  padding: 'clamp(16px, 3vw, 28px)',
  borderRadius: 14,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet-2) 80%, transparent)',
  width: '100%',
  maxWidth: 760,
  minWidth: 0,
  boxSizing: 'border-box',
};

const fieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
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
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--ink-3)',
};

const inputStyle: CSSProperties = {
  width: '100%',
  maxWidth: '100%',
  padding: '10px 12px',
  fontSize: 14,
  fontFamily: 'inherit',
  borderRadius: 10,
  border: '0.5px solid var(--line-2)',
  background: 'var(--sheet)',
  color: 'var(--ink)',
  outline: 'none',
  boxSizing: 'border-box',
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  resize: 'vertical',
  fontFamily: 'inherit',
  fontSize: 13,
  lineHeight: 1.55,
};

const selectStyle: CSSProperties = {
  ...inputStyle,
  appearance: 'none',
};

const statusBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  flexWrap: 'wrap',
  paddingTop: 8,
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
    fontSize: 10,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    padding: '3px 10px',
    borderRadius: 999,
    border: `0.5px solid ${color}`,
    color,
  };
}

const hintStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--ink-3)',
};
