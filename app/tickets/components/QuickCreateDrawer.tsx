'use client';

/**
 * QuickCreateDrawer — Floating-Action-Button + slide-up drawer.
 *
 * Posts to `/api/tickets` with same-origin cookie auth. Onsuccess:
 *  - closes drawer
 *  - calls `router.refresh()` so the server component re-fetches
 *  - navigates to the new detail page (optional, via `autoOpen` prop)
 */

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { TicketStatus } from '@/lib/events/types';
import type { Workspace } from '@/lib/nav/types';

interface Props {
  workspaces: readonly Workspace[];
  defaultWorkspaceId?: string;
  /** When true (default), redirects to the new ticket's detail page. */
  autoOpen?: boolean;
  /**
   * Open the drawer on first mount. Used by the `/tickets?open=1` deep-link
   * (the "Neues Ticket" primary button and the `/tickets/new` redirect target)
   * so the visible create button actually opens the working create flow.
   */
  initialOpen?: boolean;
}

interface FormState {
  workspaceId: string;
  title: string;
  body: string;
  prio: string;
  status: TicketStatus;
  assignee: string;
  due: string;
  tags: string;
}

const EMPTY_FORM = (defaultWorkspaceId: string): FormState => ({
  workspaceId: defaultWorkspaceId,
  title: '',
  body: '',
  prio: 'P2',
  status: 'open',
  assignee: '',
  due: '',
  tags: '',
});

export function QuickCreateDrawer({
  workspaces,
  defaultWorkspaceId = 'lazyos',
  autoOpen = true,
  initialOpen = false,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(initialOpen);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialWorkspaceId =
    workspaces.find((w) => w.id === defaultWorkspaceId)?.id ??
    workspaces[0]?.id ??
    'lazyos';
  const [form, setForm] = useState<FormState>(() => EMPTY_FORM(initialWorkspaceId));
  const titleRef = useRef<HTMLInputElement>(null);
  const formId = useId();

  // Focus the title field when the drawer opens.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => titleRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Honour the `?open=1` deep-link even when this client component instance is
  // preserved across a soft navigation (e.g. clicking "Neues Ticket" while
  // already on /tickets) — in that case `useState(initialOpen)` does not re-run,
  // so we open via effect. Then strip the param from the URL so a refresh or
  // browser-back does not re-open the drawer. History replace only — no nav.
  useEffect(() => {
    if (!initialOpen) return;
    setOpen(true);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (url.searchParams.has('open')) {
      url.searchParams.delete('open');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  }, [initialOpen]);

  // Cmd+N / Ctrl+N opens the drawer from anywhere on the page.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  const close = useCallback(() => {
    if (!submitting) setOpen(false);
  }, [submitting]);

  const onSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setError(null);
      setSubmitting(true);

      try {
        const body: Record<string, unknown> = {
          workspaceId: form.workspaceId,
          title: form.title.trim(),
          status: form.status,
        };
        if (form.body.trim()) body.body = form.body.trim();
        if (form.prio.trim()) body.prio = form.prio.trim();
        if (form.assignee.trim()) body.assignee = form.assignee.trim();
        if (form.due.trim()) body.due = form.due.trim();
        const tags = form.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
        if (tags.length) body.tags = tags;

        const res = await fetch('/api/tickets', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(
            payload?.issues?.[0]?.message ??
              payload?.message ??
              payload?.error ??
              `HTTP ${res.status}`,
          );
        }

        const data = (await res.json()) as {
          ticket: { id: string };
          url: string;
        };

        setForm(EMPTY_FORM(form.workspaceId));
        setOpen(false);
        setSubmitting(false);

        if (autoOpen && data?.url) {
          router.push(data.url);
        } else {
          router.refresh();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unbekannter Fehler');
        setSubmitting(false);
      }
    },
    [autoOpen, form, router],
  );

  return (
    <>
      <button
        type="button"
        aria-label="Neues Ticket anlegen (Cmd/Ctrl + N)"
        onClick={() => setOpen(true)}
        className="fab"
        style={{
          position: 'fixed',
          right: 'max(20px, env(safe-area-inset-right))',
          bottom: 'max(24px, env(safe-area-inset-bottom))',
          width: 56,
          height: 56,
          borderRadius: 28,
          background: 'var(--a-now)',
          color: 'var(--sheet)',
          fontSize: 28,
          fontWeight: 300,
          lineHeight: 1,
          border: 'none',
          boxShadow:
            '0 12px 30px rgba(255,159,10,0.28), 0 4px 10px rgba(0,0,0,0.4)',
          cursor: 'pointer',
          zIndex: 40,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        +
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${formId}-title`}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            backdropFilter: 'blur(6px)',
            zIndex: 50,
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <form
            onSubmit={onSubmit}
            style={{
              width: '100%',
              maxWidth: 560,
              background: 'var(--sheet-2)',
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              border: '0.5px solid var(--line-2)',
              borderBottom: 'none',
              padding: '20px 20px 32px',
              display: 'grid',
              gap: 12,
              maxHeight: '92vh',
              overflowY: 'auto',
              paddingBottom:
                'calc(32px + env(safe-area-inset-bottom))',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <h2
                id={`${formId}-title`}
                style={{
                  fontSize: 18,
                  fontWeight: 500,
                  letterSpacing: '-0.01em',
                  color: 'var(--ink)',
                  margin: 0,
                  flex: 1,
                }}
              >
                Neues Ticket
              </h2>
              <button
                type="button"
                onClick={close}
                aria-label="Schliessen"
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--ink-2)',
                  fontSize: 22,
                  cursor: 'pointer',
                  padding: 4,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </div>

            <Field label="Workspace">
              <select
                value={form.workspaceId}
                onChange={(e) =>
                  setForm((f) => ({ ...f, workspaceId: e.target.value }))
                }
                style={inputStyle}
              >
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Titel" required>
              <input
                ref={titleRef}
                required
                maxLength={200}
                value={form.title}
                onChange={(e) =>
                  setForm((f) => ({ ...f, title: e.target.value }))
                }
                style={inputStyle}
                placeholder="Was soll passieren?"
              />
            </Field>

            <Field label="Beschreibung (Markdown, optional)">
              <textarea
                value={form.body}
                onChange={(e) =>
                  setForm((f) => ({ ...f, body: e.target.value }))
                }
                rows={4}
                maxLength={20000}
                style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--font-sans)' }}
                placeholder="Kontext, Akzeptanzkriterien, Links…"
              />
            </Field>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Field label="Prio">
                <select
                  value={form.prio}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, prio: e.target.value }))
                  }
                  style={inputStyle}
                >
                  <option value="">—</option>
                  <option value="P0">P0</option>
                  <option value="P1">P1</option>
                  <option value="P2">P2</option>
                  <option value="P3">P3</option>
                </select>
              </Field>
              <Field label="Status">
                <select
                  value={form.status}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      status: e.target.value as TicketStatus,
                    }))
                  }
                  style={inputStyle}
                >
                  <option value="open">Offen</option>
                  <option value="wait">Wartet</option>
                  <option value="danger">Kritisch</option>
                  <option value="done">Erledigt</option>
                </select>
              </Field>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Field label="Zuständig">
                <input
                  value={form.assignee}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, assignee: e.target.value }))
                  }
                  maxLength={80}
                  style={inputStyle}
                  placeholder="max / claude / …"
                />
              </Field>
              <Field label="Fällig">
                <input
                  value={form.due}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, due: e.target.value }))
                  }
                  maxLength={40}
                  style={inputStyle}
                  placeholder="z.B. 28.04."
                />
              </Field>
            </div>

            <Field label="Tags (komma-separiert)">
              <input
                value={form.tags}
                onChange={(e) =>
                  setForm((f) => ({ ...f, tags: e.target.value }))
                }
                style={inputStyle}
                placeholder="ui, api, bug"
              />
            </Field>

            {error ? (
              <div
                role="alert"
                style={{
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: 'rgba(255,69,58,0.1)',
                  border: '0.5px solid var(--a-danger)',
                  color: 'var(--a-danger)',
                  fontSize: 13,
                }}
              >
                {error}
              </div>
            ) : null}

            <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
              <button
                type="button"
                onClick={close}
                disabled={submitting}
                style={secondaryBtnStyle}
              >
                Abbrechen
              </button>
              <button
                type="submit"
                disabled={submitting || form.title.trim().length === 0}
                style={{
                  ...primaryBtnStyle,
                  opacity:
                    submitting || form.title.trim().length === 0 ? 0.6 : 1,
                }}
              >
                {submitting ? 'Speichere…' : 'Ticket anlegen'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: 'var(--ink-3)',
        }}
      >
        {label}
        {required ? ' *' : ''}
      </span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  background: 'var(--sheet-3)',
  border: '0.5px solid var(--line-2)',
  color: 'var(--ink)',
  fontSize: 14,
  borderRadius: 8,
  padding: '10px 12px',
  width: '100%',
  fontFamily: 'var(--font-sans)',
};

const primaryBtnStyle: React.CSSProperties = {
  flex: 1,
  padding: '12px 16px',
  background: 'var(--a-now)',
  color: 'var(--sheet)',
  border: 'none',
  borderRadius: 10,
  fontSize: 14,
  fontWeight: 500,
  cursor: 'pointer',
  letterSpacing: '-0.005em',
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: '12px 16px',
  background: 'transparent',
  color: 'var(--ink-2)',
  border: '0.5px solid var(--line-2)',
  borderRadius: 10,
  fontSize: 14,
  cursor: 'pointer',
};
