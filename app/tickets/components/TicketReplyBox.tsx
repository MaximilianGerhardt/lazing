'use client';

/**
 * TicketReplyBox — comment input with @-autocomplete.
 *
 * Slack style:
 *   - textarea with auto-grow
 *   - `@` opens the mention menu: @max, @chairman, @agent:<role>, @<workspace>
 *   - Enter (without Shift) submits
 *   - after submit: router.refresh() so the new event lands in the thread
 *
 * No server-side mention parser here — that lives later in
 * lib/comments/mentions.ts (Phase D from the plan file). For the UI MVP
 * the pure UX affordance is enough.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';

import { useWorkspaces } from '@/lib/nav/hooks';

interface Props {
  ticketId: string;
}

const AGENT_ROLES = [
  'senior-dev',
  'code-reviewer',
  'critic',
  'product-owner',
  'db-architect',
  'ux-analyst',
  'email-copywriter',
  'compliance-advisor',
  'research-sparring',
];

const USER_MENTIONS = ['max', 'chairman'];

interface MentionCandidate {
  value: string;
  hint: string;
  kind: 'user' | 'agent' | 'workspace';
}

export function TicketReplyBox({ ticketId }: Props) {
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const router = useRouter();
  const { workspaces } = useWorkspaces();

  // ---- mention-detection ----
  const mentionQuery = useMemo(() => {
    const ta = taRef.current;
    if (!ta) return null;
    const caret = ta.selectionStart ?? value.length;
    const upTo = value.slice(0, caret);
    const m = upTo.match(/@([a-zA-Z0-9_.:-]*)$/);
    if (!m) return null;
    return { query: m[1].toLowerCase(), caret, start: caret - m[0].length };
  }, [value]);

  const candidates = useMemo<MentionCandidate[]>(() => {
    if (!mentionQuery) return [];
    const q = mentionQuery.query;
    const out: MentionCandidate[] = [];
    for (const u of USER_MENTIONS) {
      if (u.startsWith(q) || q.length === 0) {
        out.push({ value: `@${u}`, hint: 'Chairman · triggert Push', kind: 'user' });
      }
    }
    for (const r of AGENT_ROLES) {
      const full = `agent:${r}`;
      if (full.includes(q) || r.includes(q) || q.length === 0) {
        out.push({ value: `@${full}`, hint: `spawnt ${r}`, kind: 'agent' });
      }
    }
    for (const w of workspaces) {
      if (w.id.includes(q) || w.label.toLowerCase().includes(q) || q.length === 0) {
        out.push({ value: `@${w.id}`, hint: w.label, kind: 'workspace' });
      }
    }
    return out.slice(0, 8);
  }, [mentionQuery, workspaces]);

  const [activeIdx, setActiveIdx] = useState(0);
  useEffect(() => {
    setActiveIdx(0);
  }, [candidates.length]);

  const applyMention = useCallback(
    (c: MentionCandidate) => {
      if (!mentionQuery) return;
      const before = value.slice(0, mentionQuery.start);
      const after = value.slice(mentionQuery.caret);
      const next = `${before}${c.value} ${after}`;
      setValue(next);
      // restore caret just after inserted mention+space
      queueMicrotask(() => {
        const ta = taRef.current;
        if (!ta) return;
        const pos = before.length + c.value.length + 1;
        ta.focus();
        ta.setSelectionRange(pos, pos);
      });
    },
    [mentionQuery, value],
  );

  const submit = useCallback(async () => {
    const text = value.trim();
    if (text.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const resp = await fetch(`/api/tickets/${encodeURIComponent(ticketId)}/comment`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${resp.status}`);
      }
      setValue('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehler');
    } finally {
      setSubmitting(false);
    }
  }, [value, ticketId, submitting, router]);

  // auto-grow textarea
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = '0px';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [value]);

  const hasMentionMenu = candidates.length > 0;

  return (
    <div style={wrapStyle}>
      {hasMentionMenu ? (
        <div role="listbox" aria-label="Mention-Vorschläge" style={menuStyle}>
          {candidates.map((c, i) => {
            const active = i === activeIdx;
            return (
              <button
                key={c.value}
                type="button"
                role="option"
                aria-selected={active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyMention(c)}
                onMouseEnter={() => setActiveIdx(i)}
                style={{
                  ...menuItemStyle,
                  background: active
                    ? 'color-mix(in oklab, var(--a-now) 12%, transparent)'
                    : 'transparent',
                }}
              >
                <span style={{ ...kindBadgeStyle, color: kindColor(c.kind) }}>
                  {c.kind.toUpperCase()}
                </span>
                <span style={{ color: 'var(--ink)', fontWeight: 500 }}>{c.value}</span>
                <span style={{ color: 'var(--ink-3)', fontSize: 11, marginLeft: 'auto' }}>
                  {c.hint}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div style={inputRowStyle}>
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (hasMentionMenu) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIdx((i) => Math.min(candidates.length - 1, i + 1));
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIdx((i) => Math.max(0, i - 1));
                return;
              }
              if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
                const pick = candidates[activeIdx];
                if (pick) {
                  e.preventDefault();
                  applyMention(pick);
                  return;
                }
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setValue(value + ' ');
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Kommentar schreiben … @ für Mention"
          disabled={submitting}
          rows={1}
          style={textareaStyle}
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting || value.trim().length === 0}
          style={submitBtnStyle}
          aria-label="Kommentar senden"
        >
          {submitting ? '…' : 'Senden'}
        </button>
      </div>
      {error ? (
        <div role="alert" style={errorStyle}>
          {error}
        </div>
      ) : null}
      <div style={hintStyle}>
        Enter senden · Shift+Enter neue Zeile · @ für Mention · @max triggert Push
      </div>
    </div>
  );
}

function kindColor(k: 'user' | 'agent' | 'workspace'): string {
  if (k === 'user') return 'var(--a-warn)';
  if (k === 'agent') return 'var(--a-now)';
  return 'var(--ink-3)';
}

// ---- styles ----

const wrapStyle: CSSProperties = {
  position: 'relative',
  marginTop: 18,
  padding: '14px 14px 10px',
  borderRadius: 14,
  border: '0.5px solid var(--line-2)',
  background: 'var(--sheet-2)',
};

const inputRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-end',
  gap: 10,
};

const textareaStyle: CSSProperties = {
  flex: 1,
  minHeight: 36,
  maxHeight: 200,
  padding: '8px 10px',
  borderRadius: 10,
  border: '0.5px solid var(--line-2)',
  background: 'var(--sheet)',
  color: 'var(--ink)',
  fontSize: 14,
  lineHeight: 1.5,
  fontFamily: 'inherit',
  resize: 'none',
  outline: 'none',
};

const submitBtnStyle: CSSProperties = {
  padding: '8px 14px',
  borderRadius: 10,
  background: 'var(--ink)',
  color: 'var(--sheet)',
  border: 'none',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
  fontFamily: 'inherit',
  flexShrink: 0,
  minHeight: 36,
};

const hintStyle: CSSProperties = {
  marginTop: 8,
  fontSize: 11,
  color: 'var(--ink-4)',
  fontFamily: 'var(--font-mono)',
  letterSpacing: '0.02em',
};

const errorStyle: CSSProperties = {
  marginTop: 8,
  fontSize: 12,
  color: 'var(--a-danger)',
};

const menuStyle: CSSProperties = {
  position: 'absolute',
  bottom: 'calc(100% + 6px)',
  left: 12,
  right: 12,
  padding: 6,
  maxHeight: 260,
  overflowY: 'auto',
  borderRadius: 12,
  background: 'color-mix(in oklab, var(--sheet-2) 96%, transparent)',
  border: '0.5px solid var(--line-2)',
  boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  zIndex: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const menuItemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '9px 10px',
  borderRadius: 8,
  border: 'none',
  textAlign: 'left',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 13,
  color: 'var(--ink)',
  minHeight: 40,
};

const kindBadgeStyle: CSSProperties = {
  fontSize: 9,
  fontFamily: 'var(--font-mono)',
  letterSpacing: '0.1em',
  fontWeight: 600,
  width: 42,
  flexShrink: 0,
};
