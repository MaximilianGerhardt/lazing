'use client';

/**
 * CreateSkillForm — Inline-Form für neue User-Skills.
 *
 * Minimaler Editor: Name, Focus-Prompt, Tier-Pref, Effort, Default-Count.
 * Server-Side-Auth läuft via Cookie (Middleware), der Form sendet plain
 * fetch ohne extra Header.
 */

import { useState, useTransition, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';

const TIERS = ['opus', 'sonnet', 'haiku'] as const;
const EFFORTS = ['xhigh', 'high', 'medium', 'low'] as const;

export function CreateSkillForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [focusPrompt, setFocusPrompt] = useState('');
  const [preferTier, setPreferTier] =
    useState<(typeof TIERS)[number]>('sonnet');
  const [defaultEffort, setDefaultEffort] =
    useState<(typeof EFFORTS)[number]>('medium');
  const [defaultCount, setDefaultCount] = useState(1);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={openBtnStyle}
      >
        + Eigenen Skill anlegen
      </button>
    );
  }

  const submit = async (): Promise<void> => {
    setError(null);
    if (name.trim().length < 2) {
      setError('Name zu kurz (>= 2 Zeichen).');
      return;
    }
    if (focusPrompt.trim().length < 10) {
      setError('Focus-Prompt zu kurz (>= 10 Zeichen).');
      return;
    }
    try {
      const res = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          focusPrompt: focusPrompt.trim(),
          preferTier,
          defaultEffort,
          defaultCount,
          description: description.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message || body.error || `HTTP ${res.status}`);
        return;
      }
      // reset
      setName('');
      setFocusPrompt('');
      setDescription('');
      setOpen(false);
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section style={formStyle}>
      <header style={formHeaderStyle}>
        <h3 style={formTitleStyle}>Neuer Skill</h3>
        <button
          type="button"
          onClick={() => setOpen(false)}
          style={closeBtnStyle}
          aria-label="Schließen"
        >
          <svg
            width={16}
            height={16}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable={false}
          >
            <path d="M6 6 L18 18 M18 6 L6 18" />
          </svg>
        </button>
      </header>

      <label style={labelStyle}>
        <span>Name</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="z.B. Demo Fitness-Tonalität"
          style={inputStyle}
          maxLength={64}
        />
      </label>

      <label style={labelStyle}>
        <span>Focus-Prompt</span>
        <textarea
          value={focusPrompt}
          onChange={(e) => setFocusPrompt(e.target.value)}
          placeholder="Worauf soll der Agent fokussieren? (Mind. 10 Zeichen)"
          rows={3}
          style={textareaStyle}
          maxLength={2000}
        />
      </label>

      <div style={rowStyle}>
        <label style={{ ...labelStyle, flex: 1 }}>
          <span>Bevorzugter Tier</span>
          <select
            value={preferTier}
            onChange={(e) =>
              setPreferTier(e.target.value as (typeof TIERS)[number])
            }
            style={selectStyle}
          >
            {TIERS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>

        <label style={{ ...labelStyle, flex: 1 }}>
          <span>Default Effort</span>
          <select
            value={defaultEffort}
            onChange={(e) =>
              setDefaultEffort(e.target.value as (typeof EFFORTS)[number])
            }
            style={selectStyle}
          >
            {EFFORTS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </label>

        <label style={{ ...labelStyle, width: 110 }}>
          <span>Default Count</span>
          <input
            type="number"
            min={1}
            max={8}
            value={defaultCount}
            onChange={(e) => setDefaultCount(Number(e.target.value))}
            style={inputStyle}
          />
        </label>
      </div>

      <label style={labelStyle}>
        <span>Beschreibung (optional)</span>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Kurze Notiz für die Übersicht"
          style={inputStyle}
          maxLength={200}
        />
      </label>

      {error ? <div style={errorStyle}>{error}</div> : null}

      <div style={actionRowStyle}>
        <button
          type="button"
          onClick={() => setOpen(false)}
          style={cancelBtnStyle}
          disabled={isPending}
        >
          Abbrechen
        </button>
        <button
          type="button"
          onClick={() => {
            void submit();
          }}
          style={submitBtnStyle}
          disabled={isPending}
        >
          {isPending ? '…' : 'Anlegen'}
        </button>
      </div>
    </section>
  );
}

const openBtnStyle: CSSProperties = {
  marginTop: 28,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '8px 16px',
  borderRadius: 999,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--a-now) 12%, transparent)',
  color: 'var(--a-now)',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  cursor: 'pointer',
};

const formStyle: CSSProperties = {
  marginTop: 28,
  padding: 18,
  borderRadius: 14,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet-2) 80%, transparent)',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const formHeaderStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};

const formTitleStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 500,
  color: 'var(--ink)',
  letterSpacing: '-0.005em',
};

const closeBtnStyle: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--ink-3)',
  cursor: 'pointer',
  fontSize: 16,
  padding: 4,
};

const labelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 12,
  color: 'var(--ink-2)',
};

const inputStyle: CSSProperties = {
  padding: '8px 10px',
  borderRadius: 8,
  background: 'var(--sheet)',
  border: '0.5px solid var(--line-2)',
  color: 'var(--ink)',
  fontSize: 14,
  fontFamily: 'var(--font-sans)',
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  resize: 'vertical',
  minHeight: 60,
};

const selectStyle: CSSProperties = {
  ...inputStyle,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  gap: 10,
  flexWrap: 'wrap',
};

const errorStyle: CSSProperties = {
  padding: '8px 12px',
  borderRadius: 8,
  background: 'color-mix(in srgb, var(--a-danger) 10%, transparent)',
  border: '0.5px solid color-mix(in srgb, var(--a-danger) 30%, var(--line-2))',
  color: 'var(--ink)',
  fontSize: 12,
};

const actionRowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  justifyContent: 'flex-end',
};

const cancelBtnStyle: CSSProperties = {
  padding: '8px 14px',
  borderRadius: 8,
  border: '0.5px solid var(--line-2)',
  background: 'transparent',
  color: 'var(--ink-2)',
  fontSize: 13,
  cursor: 'pointer',
};

const submitBtnStyle: CSSProperties = {
  padding: '8px 18px',
  borderRadius: 8,
  border: '0.5px solid var(--ink)',
  background: 'var(--ink)',
  color: 'var(--sheet)',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
};
