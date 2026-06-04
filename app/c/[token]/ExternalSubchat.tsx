'use client';

/**
 * ExternalSubchat — public, mobile-first messenger page for external guests
 * (customers) who access a workspace sub-chat via a share token (no login)
 * (gathering-intelligence goal, 2026-06-02).
 *
 * Thin wrapper over the SHARED messenger UI (SubchatThread + Composer) —
 * identical look/behavior to the internal view, only with token-gated
 * transport (load/post/upload/media). The AI is INVISIBLE here. Every message
 * (incl. attachments: photos/media/documents) flows server-side into the
 * workspace RAG. Subtle transparency notice (GDPR/trust). No emojis.
 */

import { useCallback, useEffect, useState, type CSSProperties } from 'react';

import { SubchatThread } from '@/lib/subchats/ui/SubchatThread';
import { SubchatComposer } from '@/lib/subchats/ui/SubchatComposer';
import type { UiAttachment, UiMessage } from '@/lib/subchats/ui/types';
import * as s from '@/lib/subchats/ui/styles';

// Realtime now runs primarily over the token-gated SSE endpoint
// (`…/stream`). The poll remains only as a SLOW fallback (SSE drop / proxy
// without SSE) — down from 4s to 20s, saves load + battery on the customer phone.
const SLOW_POLL_MS = 20000;
const nameKey = (token: string): string => `lazyos.subchat.name.${token}`;

export function ExternalSubchat({ token }: { token: string }): React.ReactElement {
  const [title, setTitle] = useState('Projekt-Chat');
  const [notice, setNotice] = useState('');
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [name, setName] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [status, setStatus] = useState<'loading' | 'ok' | 'invalid'>('loading');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      const n = window.localStorage.getItem(nameKey(token));
      if (n) setName(n);
    } catch {
      /* ignore */
    }
  }, [token]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/subchats/external/${encodeURIComponent(token)}`, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      if (!res.ok) {
        setStatus('invalid');
        return;
      }
      const data = (await res.json()) as {
        subchat: { title: string };
        messages: UiMessage[];
        notice?: string;
      };
      setTitle(data.subchat.title);
      setNotice(data.notice ?? '');
      setMessages(data.messages);
      setStatus('ok');
    } catch {
      setStatus('invalid');
    }
  }, [token]);

  useEffect(() => {
    void load();
    // Primary: token-gated SSE → reload on every subchat_message/typing ping
    // (render/sanitize logic stays in the GET). The browser EventSource
    // reconnects on drops by itself.
    let es: EventSource | null = null;
    try {
      es = new EventSource(
        `/api/subchats/external/${encodeURIComponent(token)}/stream`,
      );
      es.onmessage = () => {
        void load();
      };
      // onerror: no handling needed — EventSource reconnects automatically;
      // the slow poll catches the gap anyway.
    } catch {
      /* EventSource not available → pure poll fallback */
    }
    const slowPoll = window.setInterval(() => void load(), SLOW_POLL_MS);
    const onVis = (): void => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      es?.close();
      window.clearInterval(slowPoll);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [load, token]);

  const saveName = useCallback(() => {
    const n = nameInput.trim().slice(0, 60);
    if (n.length < 1) return;
    try {
      window.localStorage.setItem(nameKey(token), n);
    } catch {
      /* ignore */
    }
    setName(n);
  }, [nameInput, token]);

  const mediaUrl = useCallback(
    (a: UiAttachment, variant: 'inline' | 'download') =>
      `/api/subchats/external/${encodeURIComponent(token)}/media/${encodeURIComponent(a.artifactId)}` +
      (variant === 'download' ? '?download=1' : ''),
    [token],
  );

  const onSend = useCallback(
    async (text: string, files: File[]) => {
      setBusy(true);
      try {
        const attachments: UiAttachment[] = [];
        for (const f of files) {
          const fd = new FormData();
          fd.append('file', f);
          const r = await fetch(`/api/subchats/external/${encodeURIComponent(token)}/upload`, {
            method: 'POST',
            body: fd,
          });
          if (r.ok) {
            const a = (await r.json()) as UiAttachment;
            attachments.push({
              artifactId: a.artifactId,
              filename: a.filename,
              mime: a.mime,
              bytes: a.bytes,
              kind: a.kind,
            });
          }
        }
        if (files.length === 0 && text) {
          setMessages((m) => [
            ...m,
            { id: `tmp-${Date.now()}`, authorKind: 'external', authorName: name, content: text, createdAt: Date.now() },
          ]);
        }
        await fetch(`/api/subchats/external/${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, content: text, attachments }),
        });
        await load();
      } catch {
        /* the poll picks it up later */
      } finally {
        setBusy(false);
      }
    },
    [token, name, load],
  );

  if (status === 'invalid') {
    return (
      <div style={s.shell}>
        <div style={s.centered}>
          <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--ink)' }}>Link ungültig oder abgelaufen</div>
          <div style={{ fontSize: 14, color: 'var(--ink-2)', marginTop: 8 }}>
            Bitte frag deinen Ansprechpartner nach einem neuen Link.
          </div>
        </div>
      </div>
    );
  }

  if (status === 'ok' && !name) {
    return (
      <div style={s.shell}>
        <div style={s.centered}>
          <div style={{ fontSize: 19, fontWeight: 600, color: 'var(--ink)', letterSpacing: '-0.02em' }}>{title}</div>
          <div style={{ fontSize: 14, color: 'var(--ink-2)', margin: '10px 0 18px' }}>Wie heißt du?</div>
          <input
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveName();
            }}
            placeholder="Dein Name"
            autoFocus
            style={nameInputStyle}
          />
          <button type="button" onClick={saveName} style={primaryBtn} disabled={nameInput.trim().length < 1}>
            Chat öffnen
          </button>
          {notice ? <div style={s.footerNotice}>{notice}</div> : null}
        </div>
      </div>
    );
  }

  return (
    <div style={s.shell}>
      <header style={s.header}>
        <div style={s.headerTitle}>{title}</div>
        <div style={s.headerSub}>laz.ing</div>
      </header>

      <SubchatThread
        messages={messages}
        isMine={(m) => m.authorKind === 'external'}
        theirLabelFallback="Team"
        mediaUrl={mediaUrl}
        emptyText="Schreib die erste Nachricht."
      />

      <SubchatComposer onSend={onSend} placeholder="Nachricht" busy={busy} />
      {notice ? <div style={s.footerNotice}>{notice}</div> : null}
    </div>
  );
}

const nameInputStyle: CSSProperties = {
  width: '100%',
  maxWidth: 320,
  background: 'var(--sheet-2, #0E0E0F)',
  border: '0.5px solid var(--line-2)',
  borderRadius: 12,
  padding: '12px 14px',
  color: 'var(--ink)',
  fontSize: 16,
  outline: 'none',
  textAlign: 'center',
};
const primaryBtn: CSSProperties = {
  marginTop: 12,
  width: '100%',
  maxWidth: 320,
  background: 'var(--a-now, #2E6FF2)',
  color: '#fff',
  border: 'none',
  borderRadius: 12,
  padding: '12px',
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
};

export default ExternalSubchat;
