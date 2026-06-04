'use client';

/**
 * PermissionSetupCard — Permission-Setup Surface (A1, 2026-05-25).
 *
 * Shown ONCE when an agent run needs tools but no permission mode has been set
 * for the workspace. Presents three options with clear effect descriptions:
 *
 *   FreeRein   — agents work fully autonomously (incl. file writes, isolated in the worktree)
 *   Lane       — read + limited writes (architect/coder), no Bash
 *   Ask        — suggestions/plan only — you approve every action
 *
 * On click: PATCH /api/permission/[workspaceId]/mode — persists the choice.
 * Card transitions to "gesetzt: <mode>" — never shown again for this workspace.
 *
 * Design: Pitch-Black, min 13px body, primary action per mode, no emojis,
 * laz.ing brand-gradient on the selected option highlight only.
 *
 * Security: no secret fields, no tool calls from this component.
 * The PATCH route enforces auth + membership.
 */

import { useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PermissionModeChoice = 'freerein' | 'lane' | 'ask';

export interface PermissionSetupCardProps {
  /** Workspace to configure. Required. */
  workspaceId: string;
  /** Optional: if a mode is already set, show the "already set" confirmation state. */
  initialMode?: PermissionModeChoice | null;
}

// ---------------------------------------------------------------------------
// Mode metadata
// ---------------------------------------------------------------------------

interface ModeOption {
  value: PermissionModeChoice;
  label: string;
  description: string;
  detailLines: string[];
}

const MODE_OPTIONS: ModeOption[] = [
  {
    value: 'freerein',
    label: 'FreeRein',
    description: 'Agenten arbeiten voll selbstständig',
    detailLines: [
      'Datei-Lesen, Datei-Schreiben und Shell-Befehle erlaubt',
      'Alle Writes laufen isoliert im Git-Worktree (nie direkt auf den Live-Stand)',
      'Merge in den Hauptbaum bleibt ein separater, manueller Schritt',
    ],
  },
  {
    value: 'lane',
    label: 'Lane',
    description: 'Lesen + begrenzte Writes, kein Bash',
    detailLines: [
      'Lesen, Suchen, Globbing immer erlaubt',
      'Schreiben und Editieren nur fuer Rollen architect und coder',
      'Kein Bash — keine Shell-Befehle, kein Netzwerk-Zugriff',
    ],
  },
  {
    value: 'ask',
    label: 'Ask',
    description: 'Nur Vorschlaege/Plan — du gibst jede Aktion frei',
    detailLines: [
      'Agent erstellt einen Plan, fuehrt aber nichts aus',
      'Du genehmigst jeden Schritt einzeln',
      'Maximale Kontrolle — ideal fuer den Einstieg',
    ],
  },
];

const MODE_LABELS: Record<PermissionModeChoice, string> = {
  freerein: 'FreeRein',
  lane: 'Lane',
  ask: 'Ask',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PermissionSetupCard({
  workspaceId,
  initialMode,
}: PermissionSetupCardProps) {
  const [selected, setSelected] = useState<PermissionModeChoice | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedMode, setSavedMode] = useState<PermissionModeChoice | null>(initialMode ?? null);
  const [error, setError] = useState<string | null>(null);

  const handleSelect = (mode: PermissionModeChoice): void => {
    setSelected(mode);
    setError(null);
  };

  const handleSave = async (): Promise<void> => {
    if (!selected) return;
    setSaving(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/permission/${encodeURIComponent(workspaceId)}/mode`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: selected }),
        },
      );

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        setError(body.message ?? body.error ?? `HTTP ${res.status}`);
        return;
      }

      setSavedMode(selected);
      setSelected(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // ── Done / already-set state ──────────────────────────────────────────────
  if (savedMode) {
    const label = MODE_LABELS[savedMode] ?? savedMode;
    return (
      <article className="perm-setup" data-state="done" aria-label="Permission-Modus gesetzt">
        <div className="perm-setup__kicker">Agent-Modus</div>
        <div className="perm-setup__title">Gesetzt: {label}</div>
        <p className="perm-setup__desc">
          Dieser Workspace verwendet den Modus <strong>{label}</strong>.
          Der Modus kann jederzeit in den Einstellungen geaendert werden.
        </p>
      </article>
    );
  }

  // ── Setup state ───────────────────────────────────────────────────────────
  return (
    <article className="perm-setup" aria-label="Agenten-Berechtigung einrichten">
      <div className="perm-setup__kicker">Einmalige Einrichtung</div>
      <div className="perm-setup__title">Wie sollen Agenten in diesem Workspace arbeiten?</div>
      <p className="perm-setup__desc">
        Dieser Workspace hat noch keinen Agenten-Modus. Waehle, welche Aktionen
        Agenten selbststaendig ausfuehren duerfen.
      </p>

      <div className="perm-setup__options" role="radiogroup" aria-label="Modus waehlen">
        {MODE_OPTIONS.map((opt) => {
          const isActive = selected === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={isActive}
              className={`perm-setup__option${isActive ? ' perm-setup__option--active' : ''}`}
              onClick={() => handleSelect(opt.value)}
            >
              <div className="perm-setup__opt-label">{opt.label}</div>
              <div className="perm-setup__opt-desc">{opt.description}</div>
              <ul className="perm-setup__opt-detail" aria-label={`Details fuer ${opt.label}`}>
                {opt.detailLines.map((line, i) => (
                  <li key={i} className="perm-setup__opt-detail-item">
                    {line}
                  </li>
                ))}
              </ul>
            </button>
          );
        })}
      </div>

      {error ? (
        <div className="perm-setup__error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="perm-setup__actions">
        <span className="perm-setup__hint">
          Diese Einstellung gilt fuer den gesamten Workspace und gilt sofort.
          Writes laufen immer isoliert im Worktree.
        </span>
        <button
          type="button"
          className="perm-setup__submit"
          disabled={!selected || saving}
          onClick={() => void handleSave()}
        >
          {saving ? 'Wird gespeichert ...' : selected ? `${MODE_LABELS[selected]} festlegen` : 'Modus waehlen'}
        </button>
      </div>
    </article>
  );
}
