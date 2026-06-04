'use client';

/**
 * ExtraFoldersRepeater — Onboarding-Repeater für ZUSÄTZLICHE Projekt-Ordner.
 *
 * Owner-Leitprinzip (verbatim): „Diese Ordner gehören zu diesem Projekt"
 * (Multi-Repo: ein Workspace, mehrere Ordner — z.B. CRM-Git + Website-Git = EIN
 * Projekt). Der ERSTE Pfad (Primary) bleibt der bestehende „Custom path"-Input
 * im Onboarding-Workspace-Step — dieser Repeater fügt nur WEITERE Roots hinzu,
 * je ro/rw. So bleibt das bestehende „erster Pfad = primary"-Verhalten intakt.
 *
 * Diese Komponente ist controlled: der Parent hält `value`/`onChange`. Beim
 * Workspace-Anlegen werden diese Extra-Roots nach der Workspace-Erstellung an
 * POST /api/workspaces/[id]/fs-roots gespiegelt (Integrator-Notiz, FS-1).
 *
 * Stil: laz.ing Design Manifest v1.0 — Pitch-Black, brand-gradient nur auf der
 * primären Aktion, 240ms cubic-bezier. Kein Hex direkt in TSX. Keine Emojis.
 */

import { useState, type CSSProperties } from 'react';

export interface ExtraRoot {
  absPath: string;
  access: 'ro' | 'rw';
}

interface Props {
  value: ExtraRoot[];
  onChange: (next: ExtraRoot[]) => void;
  disabled?: boolean;
}

export function ExtraFoldersRepeater({
  value,
  onChange,
  disabled = false,
}: Props): React.JSX.Element {
  const [draft, setDraft] = useState('');

  const add = (): void => {
    const absPath = draft.trim();
    if (absPath.length === 0) return;
    onChange([...value, { absPath, access: 'rw' }]);
    setDraft('');
  };

  const remove = (idx: number): void => {
    onChange(value.filter((_, i) => i !== idx));
  };

  const toggle = (idx: number): void => {
    onChange(
      value.map((r, i) =>
        i === idx ? { ...r, access: r.access === 'rw' ? 'ro' : 'rw' } : r,
      ),
    );
  };

  return (
    <div style={wrapStyle} data-test="extra-folders-repeater">
      <span style={labelStyle}>More folders for this project (optional)</span>
      <p style={hintStyle}>
        Does another folder belong here — e.g.&nbsp;a second repo? Add it here.
      </p>

      {value.length > 0 ? (
        <ul style={listStyle} data-test="extra-folders-list">
          {value.map((root, idx) => (
            <li key={`${root.absPath}-${idx}`} style={rowStyle} data-test={`extra-folder-row-${idx}`}>
              <span style={pathStyle} title={root.absPath}>
                {root.absPath}
              </span>
              <span style={controlsStyle}>
                <button
                  type="button"
                  onClick={() => toggle(idx)}
                  style={accessToggleStyle(root.access)}
                  disabled={disabled}
                  data-test={`extra-folder-access-${idx}`}
                  data-access={root.access}
                >
                  {root.access === 'rw' ? 'Read/write' : 'Read-only'}
                </button>
                <button
                  type="button"
                  onClick={() => remove(idx)}
                  style={removeStyle}
                  disabled={disabled}
                  data-test={`extra-folder-remove-${idx}`}
                  aria-label={`Remove ${root.absPath}`}
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <div style={addRowStyle}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder="/path/to/second-repo"
          style={inputStyle}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={disabled}
          data-test="extra-folder-input"
        />
        <button
          type="button"
          onClick={add}
          style={addBtnStyle(draft.trim().length > 0 && !disabled)}
          disabled={disabled || draft.trim().length === 0}
          data-test="extra-folder-add"
        >
          Add
        </button>
      </div>
    </div>
  );
}

// ---- Styles (Pitch-Black + brand-gradient only on the add action) ----

const wrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  marginTop: 14,
};

const labelStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--ink, #f5f5f5)',
};

const hintStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--ink-3, #6b6b6b)',
};

const listStyle: CSSProperties = {
  listStyle: 'none',
  margin: '4px 0 0',
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
  padding: '8px 10px',
  borderRadius: 10,
  background: 'var(--sheet-2, #0e0e0e)',
  border: '0.5px solid var(--line-2, #1f1f1f)',
};

const pathStyle: CSSProperties = {
  fontFamily: 'var(--font-mono, ui-monospace)',
  fontSize: 12,
  color: 'var(--ink, #f5f5f5)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
  flex: 1,
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
    fontSize: 11,
    fontWeight: 500,
    padding: '4px 9px',
    borderRadius: 999,
    color: isRw ? 'var(--ink, #f5f5f5)' : 'var(--ink-3, #6b6b6b)',
    background: isRw
      ? 'color-mix(in oklab, var(--a-now, #c9ff4d) 8%, var(--sheet-2, #0e0e0e))'
      : 'var(--sheet-2, #0e0e0e)',
    border: '0.5px solid var(--line-2, #1f1f1f)',
    transition: 'background 240ms cubic-bezier(0.16, 1, 0.3, 1)',
  };
}

const removeStyle: CSSProperties = {
  appearance: 'none',
  cursor: 'pointer',
  fontSize: 11,
  fontWeight: 500,
  padding: '4px 9px',
  borderRadius: 999,
  color: 'var(--ink-3, #6b6b6b)',
  background: 'transparent',
  border: '0.5px solid var(--line-2, #1f1f1f)',
  transition: 'color 240ms cubic-bezier(0.16, 1, 0.3, 1)',
};

const addRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginTop: 4,
};

const inputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: 'var(--font-mono, ui-monospace)',
  fontSize: 12,
  padding: '8px 10px',
  borderRadius: 8,
  color: 'var(--ink, #f5f5f5)',
  background: 'var(--sheet-2, #0e0e0e)',
  border: '0.5px solid var(--line-2, #1f1f1f)',
  outline: 'none',
};

function addBtnStyle(enabled: boolean): CSSProperties {
  return {
    appearance: 'none',
    cursor: enabled ? 'pointer' : 'default',
    fontSize: 12,
    fontWeight: 600,
    padding: '8px 12px',
    borderRadius: 8,
    whiteSpace: 'nowrap',
    color: enabled ? 'var(--sheet, #070707)' : 'var(--ink-3, #6b6b6b)',
    background: enabled ? 'var(--a-now, #c9ff4d)' : 'var(--sheet-2, #0e0e0e)',
    border: '0.5px solid var(--line-2, #1f1f1f)',
    transition: 'background 240ms cubic-bezier(0.16, 1, 0.3, 1)',
  };
}

export default ExtraFoldersRepeater;
