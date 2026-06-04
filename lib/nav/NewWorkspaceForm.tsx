'use client';

/**
 * NewWorkspaceForm — Apple-Pure Inline-Form für Workspace-Create.
 *
 * 2026-05-03 · User-Befund:
 *   "ich kann keinen neuen workspace innerhalb einer organisation erstellen.
 *    plane das aus, dass ich nicht nur welche auswählen sondern auch
 *    erstellen kann!"
 *
 * Render-Modi:
 *   - Inline im WorkspaceSwitcher-Popover (Mode-Toggle list↔create)
 *   - Inline-Card auf /orgs/[id]/page.tsx (Org-Detail)
 *
 * Felder (in dieser Reihenfolge):
 *   1. Label (auto-focus, max 64)
 *   2. Type-Pill-Choice (Produkt / Kunde / Tool / Sonstig)
 *   3. Context-Group (max 32, frei text — z.B. CRM / Web / Mobile)
 *   4. Sensitivity-Toggle (off=low, on=high)
 *
 * Submit:
 *   - POST /api/workspaces
 *   - 201 → onSuccess(workspace) + dispatchWorkspaceDataChange()
 *   - 409 id-taken → Inline-Hint, Form bleibt offen
 *   - andere 4xx/5xx → generischer Inline-Hint
 *
 * Anti-Pattern check (Memory-Pin " KEINE Overlays"):
 *   Diese Komponente ist KEIN Modal. Sie rendert inline im Caller-Container.
 *   Das Caller-Element (Popover oder Page-Section) ist verantwortlich für
 *   die räumliche Einbettung.
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';

import { dispatchWorkspaceDataChange } from './hooks';
import type { Workspace } from './types';

/** Whitelist gespiegelt aus app/api/workspaces/route.ts. */
type FormType = 'product' | 'client' | 'tool' | 'default';
/** ACL-3: Credential-Isolation Werte. */
type CredentialIsolation = 'inherit' | 'isolated';

interface TypeChoice {
  value: FormType;
  label: string;
  hint: string;
}

const TYPE_CHOICES: readonly TypeChoice[] = [
  { value: 'product', label: 'Produkt', hint: 'Eigenes Produkt / SaaS' },
  { value: 'client', label: 'Kunde', hint: 'Mandant / Kundenprojekt' },
  { value: 'tool', label: 'Tool', hint: 'Internes Werkzeug / Skript' },
  { value: 'default', label: 'Sonstig', hint: 'Sonstiger Kontext' },
];

const LABEL_MAX = 64;
const CONTEXT_MAX = 32;
const LABEL_MIN = 2;

export interface NewWorkspaceFormProps {
  /** Org in die der WS angelegt wird. Pflicht. */
  defaultOrgId: string;
  /** Optional Vorgabe Context-Group (z.B. „CRM" wenn vom Caller bekannt). */
  defaultContextGroup?: string;
  /**
   * ACL-3: Vorausgewählter Credential-Isolation-Wert. Wenn nicht gesetzt,
   * wird der aus dem Org-Type abgeleitete Wert vom Server genutzt. Im
   * Formular zeigen wir 'inherit' als visuellen Default (kann überschrieben
   * werden). Caller kann 'isolated' vorbelegen, z.B. wenn der User bereits
   * Org-Type 'client' gewählt hat.
   */
  defaultCredentialIsolation?: CredentialIsolation;
  /** Callback wenn Anlegen erfolgreich. Liefert die neue Workspace-Row. */
  onSuccess: (workspace: Pick<
    Workspace,
    'id' | 'label' | 'organizationId' | 'workspaceType' | 'contextGroup' | 'sensitivity' | 'credentialIsolation'
  >) => void;
  /** Callback wenn User abbricht (Esc / Cancel-Button). */
  onCancel: () => void;
  /** Optional: Variant für räumliches Layout. Default „popover" (kompakt). */
  variant?: 'popover' | 'card';
}

interface ApiSuccess {
  workspace: {
    id: string;
    label: string;
    organizationId: string;
    workspaceType: string;
    contextGroup: string | null;
    sensitivity: 'low' | 'normal' | 'high';
    credentialIsolation: 'inherit' | 'isolated';
  };
}

interface ApiError {
  error: string;
  hint?: string;
  message?: string;
}

export function NewWorkspaceForm({
  defaultOrgId,
  defaultContextGroup = '',
  defaultCredentialIsolation = 'inherit',
  onSuccess,
  onCancel,
  variant = 'popover',
}: NewWorkspaceFormProps): React.JSX.Element {
  const formId = useId();
  const labelId = `${formId}-label`;
  const contextId = `${formId}-context`;
  const sensitivityId = `${formId}-sensitivity`;
  const isolationId = `${formId}-isolation`;
  const errorId = `${formId}-error`;

  const labelInputRef = useRef<HTMLInputElement>(null);

  const [labelValue, setLabelValue] = useState('');
  const [type, setType] = useState<FormType>('default');
  const [contextGroup, setContextGroup] = useState(defaultContextGroup);
  const [highSensitivity, setHighSensitivity] = useState(false);
  const [credentialIsolation, setCredentialIsolation] = useState<CredentialIsolation>(
    defaultCredentialIsolation,
  );
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Auto-Focus on mount.
  useEffect(() => {
    labelInputRef.current?.focus();
  }, []);

  // ESC schließt.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !submitting) {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, submitting]);

  const labelTrim = labelValue.trim();
  const canSubmit = useMemo(
    () => labelTrim.length >= LABEL_MIN && !submitting,
    [labelTrim, submitting],
  );

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setErrorMsg(null);

    const ctxTrimmed = contextGroup.trim().slice(0, CONTEXT_MAX);

    try {
      const res = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          label: labelTrim.slice(0, LABEL_MAX),
          organizationId: defaultOrgId,
          workspaceType: type,
          contextGroup: ctxTrimmed.length > 0 ? ctxTrimmed : undefined,
          sensitivity: highSensitivity ? 'high' : 'low',
          credentialIsolation,
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as ApiSuccess;
        dispatchWorkspaceDataChange();
        onSuccess({
          id: data.workspace.id,
          label: data.workspace.label,
          organizationId: data.workspace.organizationId,
          workspaceType: data.workspace.workspaceType,
          contextGroup: data.workspace.contextGroup,
          sensitivity: data.workspace.sensitivity,
          credentialIsolation: data.workspace.credentialIsolation,
        });
        return;
      }

      const errBody = (await res.json().catch(() => null)) as ApiError | null;
      if (res.status === 409) {
        setErrorMsg(
          errBody?.message ??
            'Eine Workspace-ID mit diesem Label existiert bereits. Bitte Label ändern.',
        );
      } else if (res.status === 403) {
        setErrorMsg(
          errBody?.hint ??
            'Du bist kein Mitglied dieser Organisation.',
        );
      } else {
        setErrorMsg(
          errBody?.hint ??
            errBody?.error ??
            `Anlegen fehlgeschlagen (HTTP ${res.status}).`,
        );
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const rootClass =
    variant === 'card'
      ? 'new-ws-form new-ws-form--card'
      : 'new-ws-form new-ws-form--popover';

  return (
    <form
      onSubmit={handleSubmit}
      className={rootClass}
      aria-label="Neuen Workspace anlegen"
      noValidate
    >
      <div className="new-ws-form__field">
        <label htmlFor={labelId} className="new-ws-form__label">
          Name
        </label>
        <input
          ref={labelInputRef}
          id={labelId}
          type="text"
          value={labelValue}
          onChange={(e) => setLabelValue(e.target.value)}
          maxLength={LABEL_MAX}
          autoComplete="off"
          spellCheck={false}
          required
          className="new-ws-form__input"
          placeholder="z.B. Demo Fitness Backend"
          disabled={submitting}
          aria-describedby={errorMsg ? errorId : undefined}
          data-testid="new-ws-label"
        />
      </div>

      <div className="new-ws-form__field">
        <span className="new-ws-form__label" id={`${formId}-type-label`}>
          Typ
        </span>
        <div
          className="new-ws-form__pills"
          role="radiogroup"
          aria-labelledby={`${formId}-type-label`}
        >
          {TYPE_CHOICES.map((choice) => {
            const active = type === choice.value;
            return (
              <button
                key={choice.value}
                type="button"
                role="radio"
                aria-checked={active}
                className={`new-ws-form__pill${active ? ' is-active' : ''}`}
                onClick={() => setType(choice.value)}
                disabled={submitting}
                title={choice.hint}
                data-testid={`new-ws-type-${choice.value}`}
              >
                {choice.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="new-ws-form__field">
        <label htmlFor={contextId} className="new-ws-form__label">
          Kontext <span className="new-ws-form__hint">optional</span>
        </label>
        <input
          id={contextId}
          type="text"
          value={contextGroup}
          onChange={(e) => setContextGroup(e.target.value)}
          maxLength={CONTEXT_MAX}
          autoComplete="off"
          spellCheck={false}
          className="new-ws-form__input"
          placeholder="z.B. CRM, Web, Mobile …"
          disabled={submitting}
          data-testid="new-ws-context"
        />
        <div className="new-ws-form__caption">
          Gruppiert mehrere Workspaces einer Org unter einem Sub-Header.
          Frei wählbar.
        </div>
      </div>

      <div className="new-ws-form__field new-ws-form__field--row">
        <label htmlFor={sensitivityId} className="new-ws-form__label">
          Vertraulich
        </label>
        <button
          id={sensitivityId}
          type="button"
          role="switch"
          aria-checked={highSensitivity}
          className={`new-ws-form__toggle${highSensitivity ? ' is-on' : ''}`}
          onClick={() => setHighSensitivity((v) => !v)}
          disabled={submitting}
          data-testid="new-ws-sensitivity"
        >
          <span className="new-ws-form__toggle-knob" aria-hidden="true" />
          <span className="new-ws-form__toggle-text">
            {highSensitivity ? 'an' : 'aus'}
          </span>
        </button>
      </div>

      {/* ACL-3: Credential-Isolation */}
      <div
        className="new-ws-form__field"
        role="radiogroup"
        aria-labelledby={isolationId}
      >
        <span id={isolationId} className="new-ws-form__label">
          Credential-Isolation
        </span>
        <div className="new-ws-form__pills">
          <button
            type="button"
            role="radio"
            aria-checked={credentialIsolation === 'isolated'}
            className={`new-ws-form__pill${credentialIsolation === 'isolated' ? ' is-active' : ''}`}
            onClick={() => setCredentialIsolation('isolated')}
            disabled={submitting}
            title="Eigene Credentials, kein Org-Fallback (externer Kunde)"
            data-testid="new-ws-isolation-isolated"
          >
            Isoliert (externer Kunde)
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={credentialIsolation === 'inherit'}
            className={`new-ws-form__pill${credentialIsolation === 'inherit' ? ' is-active' : ''}`}
            onClick={() => setCredentialIsolation('inherit')}
            disabled={submitting}
            title="Darf Org-Credentials nutzen (intern/eigen)"
            data-testid="new-ws-isolation-inherit"
          >
            Vererbt (intern/eigen)
          </button>
        </div>
        <div className="new-ws-form__caption">
          Isoliert: eigene Credentials, kein Org-Fallback.
          Vererbt: darf Org-Credentials nutzen.
        </div>
      </div>

      {errorMsg ? (
        <div
          id={errorId}
          role="alert"
          className="new-ws-form__error"
          data-testid="new-ws-error"
        >
          {errorMsg}
        </div>
      ) : null}

      <div className="new-ws-form__actions">
        <button
          type="button"
          onClick={onCancel}
          className="new-ws-form__btn new-ws-form__btn--ghost"
          disabled={submitting}
        >
          Abbrechen
        </button>
        <button
          type="submit"
          className="new-ws-form__btn new-ws-form__btn--primary"
          disabled={!canSubmit}
          data-testid="new-ws-submit"
        >
          {submitting ? 'Lege an …' : 'Anlegen'}
        </button>
      </div>
    </form>
  );
}

export default NewWorkspaceForm;
