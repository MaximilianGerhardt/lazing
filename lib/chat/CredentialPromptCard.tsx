'use client';

/**
 * CredentialPromptCard — a surface card in the chat: the AI asks for a key.
 *
 * Emitted when the lead agent finds that an API key is missing
 * (e.g. Stripe, Supabase). Instead of sending the user to /workspaces/[id]/?tab=credentials,
 * they can type the value directly here — a POST goes to
 * /api/workspaces/<ws>/credentials, encrypted storage. The plaintext does
 * NOT land in the chat history.
 *
 * Schema:
 *   {"workspaceId":"…","name":"STRIPE_SECRET_KEY","description":"…","docsUrl":"…"}
 *
 * Wave 4.2 (2026-05-01): inline styles → CSS classes `.srf-cred__*` (token-bind).
 */

import { useState } from 'react';

import { useSurfaceAction } from './SurfaceActionContext';

interface Props {
  workspaceId: string;
  name: string;
  description?: string;
  docsUrl?: string;
}

export function CredentialPromptCard({
  workspaceId,
  name,
  description,
  docsUrl,
}: Props) {
  const { reply } = useSurfaceAction();
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (value.length === 0) return;
    setSubmitting(true);
    setError(null);
    // iOS-Polish E.9: subtle haptics hint on submit (PWA)
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(10);
    }
    try {
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/credentials`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name,
            value,
            description: description ?? undefined,
          }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message ?? body.error ?? `HTTP ${res.status}`);
        return;
      }
      setDone(true);
      setValue('');
      // The AI only gets the hint that the key was saved — NOT
      // the plaintext. It can then read it via server-side tools.
      reply(`Key ${name} ist im Workspace ${workspaceId} hinterlegt (verschlüsselt). Bitte hole ihn über die Server-API.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <article
        className="srf-cred"
        data-state="done"
        aria-label="Credential gespeichert"
      >
        <div
          className="srf-cred__kicker"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M5 12.5l4 4 10-10" />
          </svg>
          Hinterlegt
        </div>
        <div className="srf-cred__title">
          <code className="srf-cred__code">{name}</code>
        </div>
        <p className="srf-cred__desc">
          Verschlüsselt im Workspace gespeichert. Du kannst ihn unter{' '}
          <a
            href={`/workspaces/${encodeURIComponent(workspaceId)}?tab=credentials`}
            className="srf-cred__link"
          >
            Credentials-Tab
          </a>{' '}
          managen oder revealen.
        </p>
      </article>
    );
  }

  return (
    <article className="srf-cred" aria-label={`Bitte ${name} eingeben`}>
      <div className="srf-cred__kicker">KEY-ANFRAGE</div>
      <div className="srf-cred__title">
        <code className="srf-cred__code">{name}</code>
      </div>
      {description ? <p className="srf-cred__desc">{description}</p> : null}
      {docsUrl ? (
        <p className="srf-cred__meta">
          Doku:{' '}
          <a
            href={docsUrl}
            target="_blank"
            rel="noreferrer"
            className="srf-cred__link"
          >
            {docsUrl}
          </a>
        </p>
      ) : null}

      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={`Wert für ${name}`}
        className="srf-cred__input"
        autoComplete="off"
        spellCheck={false}
      />

      {error ? <div className="srf-cred__error">{error}</div> : null}

      <div className="srf-cred__actions">
        <span className="srf-cred__hint">
          Encrypted Storage · Klartext landet NICHT im Chat
        </span>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting || value.length === 0}
          className="srf-cred__submit"
        >
          {submitting ? 'speichert …' : 'Hinterlegen'}
        </button>
      </div>
    </article>
  );
}
