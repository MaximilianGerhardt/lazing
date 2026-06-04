'use client';

/**
 * CredentialsManager — Vercel-style verschluesselter Key-Manager.
 *
 * Liste mit masked-preview, Add-Form (NAME=VALUE, optional Description),
 * Reveal-Button (zeigt Klartext + setzt last_revealed_at) + Loeschen.
 * Die KI im Chat kann via <surface:credential-prompt> einen neuen Key
 * anfordern; das Form unten erfaellt den gleichen Endpoint.
 */

import { useEffect, useState, useTransition, type CSSProperties } from 'react';

interface CredListItem {
  id: string;
  name: string;
  preview: string;
  description: string | null;
  createdAt: number;
  updatedAt: number;
  lastRevealedAt: number | null;
}

interface Props {
  workspaceId: string;
}

export function CredentialsManager({ workspaceId }: Props) {
  const [credentials, setCredentials] = useState<CredListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const [revealedValue, setRevealedValue] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [, startTransition] = useTransition();

  const reload = async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/credentials`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message ?? body.error ?? `HTTP ${res.status}`);
        setCredentials([]);
        return;
      }
      const data = (await res.json()) as { credentials: CredListItem[] };
      setCredentials(data.credentials);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const reveal = async (credId: string): Promise<void> => {
    if (revealedId === credId && revealedValue !== null) {
      // Toggle off — verstecke wieder
      setRevealedId(null);
      setRevealedValue(null);
      return;
    }
    try {
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/credentials?reveal=${encodeURIComponent(credId)}`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message ?? body.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as {
        credential: { id: string; value: string };
      };
      setRevealedId(credId);
      setRevealedValue(data.credential.value);
      // 30s timeout — automatisch wieder verstecken
      window.setTimeout(() => {
        setRevealedId((cur) => (cur === credId ? null : cur));
        setRevealedValue(null);
      }, 30_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (credId: string): Promise<void> => {
    if (!window.confirm('Diesen Credential wirklich löschen?')) return;
    try {
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/credentials/${encodeURIComponent(credId)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message ?? body.error ?? `HTTP ${res.status}`);
        return;
      }
      startTransition(() => void reload());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div style={wrapStyle}>
      <div style={headerStyle}>
        <div>
          <h3 style={titleStyle}>Credentials</h3>
          <p style={leadStyle}>
            Pro-Workspace verschlüsselte Key-Value-Speicherung. Keys liegen
            AES-256-GCM-encrypted in der DB, Klartext-Reveal nur on-demand
            (30 Sekunden Auto-Hide). Niemals im Chat-Verlauf, niemals im
            Code-Repo.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          style={addBtnStyle}
        >
          {showForm ? 'Abbrechen' : '+ Neuer Key'}
        </button>
      </div>

      {showForm ? (
        <CreateForm
          workspaceId={workspaceId}
          onCreated={() => {
            setShowForm(false);
            void reload();
          }}
          onError={setError}
        />
      ) : null}

      {error ? <div style={errorStyle}>{error}</div> : null}

      {loading ? (
        <div style={metaStyle}>laden …</div>
      ) : credentials.length === 0 ? (
        <div style={emptyStyle}>
          Noch keine Credentials in diesem Workspace. Lege oben einen an —
          gängige Keys: STRIPE_SECRET_KEY, SUPABASE_SERVICE_KEY, RESEND_API_KEY.
        </div>
      ) : (
        <ul style={listStyle}>
          {credentials.map((c) => {
            const isRevealed = revealedId === c.id && revealedValue !== null;
            return (
              <li key={c.id} style={rowStyle}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <code style={nameStyle}>{c.name}</code>
                  {c.description ? (
                    <div style={descStyle}>{c.description}</div>
                  ) : null}
                  <div style={previewRowStyle}>
                    {isRevealed ? (
                      <code style={revealedStyle}>{revealedValue}</code>
                    ) : (
                      <code style={previewStyle}>{c.preview}</code>
                    )}
                    <span style={timestampStyle}>
                      aktualisiert{' '}
                      {new Date(c.updatedAt).toLocaleDateString('de-DE')}
                    </span>
                  </div>
                </div>
                <div style={actionsStyle}>
                  <button
                    type="button"
                    onClick={() => void reveal(c.id)}
                    style={revealBtnStyle}
                  >
                    {isRevealed ? 'Verstecken' : 'Klartext'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(c.id)}
                    style={deleteBtnStyle}
                    aria-label="Credential löschen"
                    title="Credential löschen"
                  >
                    ×
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function CreateForm({
  workspaceId,
  onCreated,
  onError,
}: {
  workspaceId: string;
  onCreated: () => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (): Promise<void> => {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) {
      onError('Name muss UPPER_SNAKE_CASE sein, z.B. STRIPE_SECRET_KEY');
      return;
    }
    if (value.length === 0) {
      onError('Value darf nicht leer sein');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/credentials`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name,
            value,
            description: description.trim() || undefined,
          }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        onError(body.message ?? body.error ?? `HTTP ${res.status}`);
        return;
      }
      onCreated();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={formStyle}>
      <div style={formRowStyle}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase())}
          placeholder="STRIPE_SECRET_KEY"
          style={inputMonoStyle}
          maxLength={128}
        />
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="sk_live_…"
          style={inputMonoStyle}
        />
      </div>
      <input
        type="text"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Beschreibung (optional)"
        style={inputStyle}
        maxLength={500}
      />
      <button
        type="button"
        onClick={() => void submit()}
        disabled={submitting}
        style={submitBtnStyle}
      >
        {submitting ? 'speichert …' : 'Speichern'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const wrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 24,
  padding: 'clamp(20px, 3vw, 36px)',
  borderRadius: 16,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet-2) 80%, transparent)',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 16,
  flexWrap: 'wrap',
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 'clamp(20px, 2.6vw, 28px)',
  fontWeight: 500,
  letterSpacing: '-0.02em',
  color: 'var(--ink)',
};

const leadStyle: CSSProperties = {
  marginTop: 8,
  fontSize: 14,
  color: 'var(--ink-2)',
  lineHeight: 1.55,
  maxWidth: 640,
};

const addBtnStyle: CSSProperties = {
  padding: '10px 18px',
  borderRadius: 999,
  border: '0.5px solid var(--ink)',
  background: 'var(--ink)',
  color: 'var(--sheet)',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const formStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: 16,
  borderRadius: 12,
  border: '0.5px solid var(--a-now)',
  background: 'color-mix(in oklab, var(--a-now) 6%, var(--sheet-2))',
};

const formRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
  gap: 8,
};

const inputStyle: CSSProperties = {
  padding: '10px 14px',
  borderRadius: 10,
  background: 'var(--sheet)',
  border: '0.5px solid var(--line-2)',
  color: 'var(--ink)',
  fontSize: 14,
  fontFamily: 'var(--font-sans)',
  outline: 'none',
};

const inputMonoStyle: CSSProperties = {
  ...inputStyle,
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
};

const submitBtnStyle: CSSProperties = {
  padding: '10px 18px',
  borderRadius: 10,
  border: 'none',
  background: 'var(--a-now)',
  color: 'var(--sheet)',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  alignSelf: 'flex-start',
};

const errorStyle: CSSProperties = {
  padding: '10px 14px',
  borderRadius: 10,
  border: '0.5px solid color-mix(in srgb, var(--a-danger) 40%, var(--line-2))',
  background: 'color-mix(in oklab, var(--a-danger) 8%, transparent)',
  color: 'var(--ink)',
  fontSize: 13,
};

const emptyStyle: CSSProperties = {
  padding: 24,
  textAlign: 'center',
  border: '0.5px dashed var(--line-2)',
  borderRadius: 12,
  color: 'var(--ink-3)',
  fontSize: 14,
  lineHeight: 1.5,
};

const listStyle: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 14,
  padding: 14,
  borderRadius: 12,
  border: '0.5px solid var(--line-2)',
  background: 'var(--sheet-2)',
  flexWrap: 'wrap',
};

const nameStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--ink)',
  letterSpacing: '0.02em',
};

const descStyle: CSSProperties = {
  marginTop: 4,
  fontSize: 12,
  color: 'var(--ink-3)',
};

const previewRowStyle: CSSProperties = {
  marginTop: 8,
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  flexWrap: 'wrap',
};

const previewStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--ink-3)',
  letterSpacing: '0.04em',
};

const revealedStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--a-now)',
  padding: '3px 8px',
  borderRadius: 6,
  background: 'color-mix(in oklab, var(--a-now) 12%, transparent)',
  wordBreak: 'break-all',
  maxWidth: '100%',
};

const timestampStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--ink-4)',
};

const actionsStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
};

const revealBtnStyle: CSSProperties = {
  padding: '6px 12px',
  borderRadius: 999,
  border: '0.5px solid var(--line-2)',
  background: 'transparent',
  color: 'var(--ink-2)',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  cursor: 'pointer',
};

const deleteBtnStyle: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 999,
  border: '0.5px solid var(--line-2)',
  background: 'transparent',
  color: 'var(--ink-3)',
  fontSize: 16,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const metaStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-3)',
};
