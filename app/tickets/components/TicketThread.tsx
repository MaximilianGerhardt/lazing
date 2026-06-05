/**
 * TicketThread — Slack-like discussion for a ticket (Paperclip style).
 *
 * Difference from TicketTimeline:
 *   - avatars per comment (TMC glyph:  for users, agent initials for
 *     agent:*,  for system)
 *   - `commented` events prominent as "message bubbles"
 *   - status changes / approvals as subtle inline notices
 *   - work products as inline cards
 *   - mentions (`@max`, `@agent:senior-dev`, `@demo-client`) are
 *     highlighted (pill style)
 *
 * Server component (no own state) — receives events props from the page.
 */

import type { CSSProperties, ReactNode } from 'react';
import type { LazyEvent } from '@/lib/events/types';
import { renderMarkdown } from '@/lib/chat/markdown-mini';

interface Props {
  events: LazyEvent[];
}

const INLINE_EVENT_LABELS: Partial<Record<LazyEvent['eventType'], string>> = {
  created: 'hat das Ticket angelegt',
  updated: 'hat das Ticket aktualisiert',
  status_changed: 'hat den Status geändert',
  closed: 'hat das Ticket geschlossen',
  reopened: 'hat das Ticket wieder geöffnet',
  assigned: 'hat zugewiesen',
  review_request: 'hat Review angefordert',
  approval_requested: 'hat Freigabe angefragt',
  approved: 'hat freigegeben',
  rejected: 'hat abgelehnt',
  executed: 'hat ausgeführt',
  test_result: 'Test-Ergebnis eingetragen',
  work_product_attached: 'hat ein Work-Product angehängt',
  work_product_status_changed: 'Work-Product-Status geändert',
  work_product_superseded: 'Work-Product ersetzt',
  fix_agent_triggered: 'Fix-Agent gestartet',
  error_logged: 'Fehler protokolliert',
  user_feedback: 'Feedback abgegeben',
};

export function TicketThread({ events }: Props) {
  if (events.length === 0) {
    return (
      <p style={{ color: 'var(--ink-3)', fontSize: 13, padding: '14px 0' }}>
        Noch keine Diskussion. Unten anfangen.
      </p>
    );
  }

  return (
    <ol style={listStyle}>
      {events.map((ev) => {
        if (ev.eventType === 'commented') {
          return <CommentEntry key={ev.id} ev={ev} />;
        }
        return <InlineEntry key={ev.id} ev={ev} />;
      })}
    </ol>
  );
}

function CommentEntry({ ev }: { ev: LazyEvent }) {
  const text = typeof ev.payload?.text === 'string' ? ev.payload.text : '';
  const actor = ev.actor ?? 'system';
  const { label: actorLabel, avatar, accent } = actorMeta(actor);
  // SP-11: intent/target ride in the existing `commented` payload (free JSON).
  const intent =
    ev.payload?.intent === 'instruction' || ev.payload?.intent === 'question'
      ? ev.payload.intent
      : null;
  const target =
    typeof ev.payload?.target === 'string' ? ev.payload.target : null;

  return (
    <li style={commentItemStyle}>
      <div style={avatarWrapStyle}>
        <span
          style={{ ...avatarStyle, color: accent, borderColor: accent }}
          aria-hidden="true"
        >
          {avatar}
        </span>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={bubbleHeaderStyle}>
          <span style={{ fontWeight: 500, color: 'var(--ink)' }}>{actorLabel}</span>
          {intent ? <IntentBadge intent={intent} target={target} /> : null}
          <span style={timestampStyle}>{formatTime(ev.createdAt)}</span>
        </div>
        <div style={bubbleStyle}>
          <CommentBody text={text} />
        </div>
      </div>
    </li>
  );
}

/**
 * SP-11: shows whether a comment is an "Anweisung" (instruction) or "Frage"
 * (question) — the handoff signal carried in the `commented` payload. A plain
 * note renders no badge (default). Optionally names the handoff target.
 */
function IntentBadge({
  intent,
  target,
}: {
  intent: 'instruction' | 'question';
  target: string | null;
}) {
  const isInstruction = intent === 'instruction';
  const accent = isInstruction ? 'var(--a-now)' : 'var(--a-warn)';
  const label = isInstruction ? 'Anweisung' : 'Frage';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 7px',
        borderRadius: 999,
        fontSize: 10,
        fontFamily: 'var(--font-mono)',
        fontWeight: 600,
        letterSpacing: '0.04em',
        color: accent,
        background: `color-mix(in oklab, ${accent} 14%, transparent)`,
        border: `0.5px solid color-mix(in oklab, ${accent} 40%, transparent)`,
      }}
    >
      {label}
      {target ? <span style={{ opacity: 0.7 }}>→ @{target}</span> : null}
    </span>
  );
}

function InlineEntry({ ev }: { ev: LazyEvent }) {
  const label = INLINE_EVENT_LABELS[ev.eventType] ?? ev.eventType;
  const actor = ev.actor ?? 'system';
  const { label: actorLabel } = actorMeta(actor);
  const extra = renderInlineExtra(ev);

  return (
    <li style={inlineItemStyle}>
      <span style={inlineDotStyle} aria-hidden="true" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={inlineTextStyle}>
          <b style={{ fontWeight: 500, color: 'var(--ink-2)' }}>{actorLabel}</b>{' '}
          {label}
          {extra ? <> · {extra}</> : null}
        </span>
        <span style={inlineTimestampStyle}>{formatTime(ev.createdAt)}</span>
      </div>
    </li>
  );
}

function renderInlineExtra(ev: LazyEvent): ReactNode {
  const p = ev.payload ?? {};
  if (ev.eventType === 'status_changed') {
    const prev = typeof p.previousStatus === 'string' ? p.previousStatus : null;
    const next = typeof p.status === 'string' ? p.status : null;
    if (prev && next) return <code style={codeStyle}>{prev} → {next}</code>;
    if (next) return <code style={codeStyle}>{next}</code>;
  }
  if (ev.eventType === 'work_product_attached') {
    const title = typeof p.title === 'string' ? p.title : null;
    if (title) return <em style={{ color: 'var(--ink-2)' }}>„{title}"</em>;
  }
  if (ev.eventType === 'error_logged') {
    const msg = typeof p.message === 'string' ? p.message : null;
    if (msg) return <code style={codeErrStyle}>{msg.slice(0, 120)}</code>;
  }
  if (ev.eventType === 'created' || ev.eventType === 'updated') {
    const title = typeof p.title === 'string' ? p.title : null;
    if (title) return <em style={{ color: 'var(--ink-2)' }}>„{title}"</em>;
  }
  return null;
}

function CommentBody({ text }: { text: string }) {
  if (!text) return null;
  // SP-11: @mentions are the human↔agent handoff channel — render them as pills
  // (reactivating MentionPill + parseMentions), not escaped inline code. We
  // split the body on mention tokens; non-mention segments keep full Markdown
  // (## headlines, lists, ```code, **bold**) via markdown-mini, mention tokens
  // become pills. (Block-level Markdown across a mention boundary is rare in
  // conversational notes; legible mentions win — task SP-11 §6.)
  const parts = parseMentions(text);
  // Fast path: no mentions ⇒ single Markdown render (unchanged behaviour).
  if (parts.every((p) => p.kind === 'text')) {
    return (
      <div style={commentBodyStyle}>{renderMarkdown(text, 'cmt')}</div>
    );
  }
  return (
    <div style={commentBodyStyle}>
      {parts.map((part, i) =>
        part.kind === 'mention' ? (
          <MentionPill key={`m-${i}`} raw={part.text} />
        ) : (
          <span key={`t-${i}`}>{renderMarkdown(part.text, `cmt-${i}`)}</span>
        ),
      )}
    </div>
  );
}

const commentBodyStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.55,
  color: 'var(--ink)',
};

function MentionPill({ raw }: { raw: string }) {
  const accent = raw.startsWith('@agent:')
    ? 'var(--a-now)'
    : raw === '@max' || raw === '@chairman'
      ? 'var(--a-warn)'
      : 'var(--ink-2)';
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 6px',
        borderRadius: 4,
        fontSize: 12,
        fontFamily: 'var(--font-mono)',
        background: `color-mix(in oklab, ${accent} 18%, transparent)`,
        color: accent,
        fontWeight: 500,
      }}
    >
      {raw}
    </span>
  );
}

interface Part {
  kind: 'text' | 'mention';
  text: string;
}

function parseMentions(body: string): Part[] {
  const re = /(@[a-zA-Z0-9_.-]+(?::[a-zA-Z0-9_.-]+)?)/g;
  const out: Part[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m.index > last) {
      out.push({ kind: 'text', text: body.slice(last, m.index) });
    }
    out.push({ kind: 'mention', text: m[1] });
    last = m.index + m[1].length;
  }
  if (last < body.length) {
    out.push({ kind: 'text', text: body.slice(last) });
  }
  return out;
}

function actorMeta(actor: string): {
  label: string;
  avatar: string;
  accent: string;
} {
  if (actor === 'system') {
    return { label: 'System', avatar: 'SY', accent: 'var(--ink-3)' };
  }
  if (actor.startsWith('user:')) {
    const name = actor.slice(5);
    return {
      label: name === 'max' ? 'Max' : name,
      avatar: name.slice(0, 1).toUpperCase() || 'U',
      accent: 'var(--a-warn)',
    };
  }
  if (actor.startsWith('agent:')) {
    const role = actor.slice(6);
    return {
      label: prettyAgentRole(role),
      avatar: agentInitials(role),
      accent: 'var(--a-now)',
    };
  }
  return { label: actor, avatar: '?', accent: 'var(--ink-3)' };
}

function prettyAgentRole(role: string): string {
  return role
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

function agentInitials(role: string): string {
  const parts = role.split(/[-_]/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return role.slice(0, 2).toUpperCase();
}

function formatTime(ts: number): string {
  try {
    const d = new Date(ts);
    const now = Date.now();
    const diffMin = Math.round((now - ts) / 60_000);
    if (diffMin < 1) return 'gerade eben';
    if (diffMin < 60) return `vor ${diffMin} min`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `vor ${diffHr} h`;
    return d.toLocaleString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(ts);
  }
}

// ---- Styles ----

const listStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};

const commentItemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  padding: '6px 0',
};

const avatarWrapStyle: CSSProperties = {
  flexShrink: 0,
  paddingTop: 2,
};

const avatarStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 30,
  height: 30,
  borderRadius: 8,
  fontSize: 11,
  fontWeight: 600,
  fontFamily: 'var(--font-mono)',
  letterSpacing: 0,
  background: 'var(--sheet-2)',
  border: '0.5px solid',
};

const bubbleHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  marginBottom: 4,
  fontSize: 13,
};

const timestampStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--ink-4)',
  letterSpacing: '0.02em',
};

const bubbleStyle: CSSProperties = {
  // No border — deliberately text-oriented like Slack. Only the avatar + name
  // provide structure. This improves readability in long threads.
};

const inlineItemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '4px 0 4px 34px',
  fontSize: 12,
};

const inlineDotStyle: CSSProperties = {
  width: 4,
  height: 4,
  borderRadius: 2,
  background: 'var(--ink-4)',
  display: 'inline-block',
  flexShrink: 0,
  marginLeft: -20,
};

const inlineTextStyle: CSSProperties = {
  color: 'var(--ink-3)',
  flex: 1,
  minWidth: 0,
};

const inlineTimestampStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--ink-4)',
  letterSpacing: '0.02em',
};

const codeStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  padding: '1px 5px',
  borderRadius: 3,
  background: 'var(--sheet-3)',
  color: 'var(--ink-2)',
};

const codeErrStyle: CSSProperties = {
  ...codeStyle,
  color: 'var(--a-danger)',
};
