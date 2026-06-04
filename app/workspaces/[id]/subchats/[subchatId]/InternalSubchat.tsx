'use client';

/**
 * InternalSubchat — internal team view of a workspace sub-chat
 * (Gathering-Intelligence-Goal, 2026-06-02).
 *
 * Thin wrapper over the SHARED messenger UI (SubchatThread + Composer) —
 * identical look to the external view. Differences: cookie auth, team
 * messages on the right / customer on the left, attachment upload via /api/cloud,
 * and — in the Claude-Code-app style — AI reply suggestions as chips above the
 * composer when the last message came from the customer (tap fills the composer).
 * No emojis.
 *
 * Realtime (P2 UI-RT, Verdict): authed `useEventStream` (bare
 * `/api/events/stream`, filtered client-side on `workspaceId` + `payload.subchatId`)
 * drives a debounced `load()` refetch on `subchat_message`.
 * Warm instance → sub-second update. Cold/multi-instance (broadcast is
 * per-Lambda) → 30s poll + focus refetch as a correctness floor. The event
 * payload contains only a 120-character `preview` — which is NEVER rendered as a
 * message (N1): `load()` fetches the authoritative full rows.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

import { SubchatThread } from '@/lib/subchats/ui/SubchatThread';
import { SubchatComposer } from '@/lib/subchats/ui/SubchatComposer';
import type { Uploader } from '@/lib/subchats/ui/SubchatComposer';
import { Lightbox } from '@/lib/subchats/ui/Lightbox';
import type { LightboxImage } from '@/lib/subchats/ui/Lightbox';
import { IconBack } from '@/lib/subchats/ui/icons';
import type { UiAttachment, UiMessage } from '@/lib/subchats/ui/types';
import * as s from '@/lib/subchats/ui/styles';
import { useEventStream } from '@/lib/chat/useEventStream';
import { useSubchatQuestions } from '@/lib/subchats/ui/useSubchatQuestions';
import { SubchatQuestionsPill } from '@/lib/subchats/ui/SubchatQuestionsPill';

// Safety floor instead of a fast primary poll: the live event is the fast
// path (sub-second on the warm instance), the 30s poll + focus refetch is
// the multi-instance correctness floor (broadcast is per-Lambda, the SSE
// socket and the writing POST can land on different instances).
const POLL_MS = 30000;

export function InternalSubchat({
  subchatId,
  workspaceId,
}: {
  subchatId: string;
  workspaceId: string;
}): React.ReactElement {
  const [title, setTitle] = useState('Sub-Chat');
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [loadingSuggest, setLoadingSuggest] = useState(false);
  const [seed, setSeed] = useState<{ text: string; nonce: number }>({ text: '', nonce: 0 });
  const [lb, setLb] = useState<{ images: LightboxImage[]; index: number } | null>(null);
  const lastSuggestForRef = useRef<string | null>(null);

  // Question-Spinning (2026-06-03): spun-up questions of this sub-chat,
  // sequentially prominent above the composer. DB-authoritative; poll + realtime.
  const questions = useSubchatQuestions(subchatId);

  // Read watermark of the COUNTERPART (max lastReadTs of all userId !== viewer)
  // from the GET response. Drives the read ticks on OWN messages in the UI:
  // an own message counts as read once createdAt <= recipientReadTs.
  const [recipientReadTs, setRecipientReadTs] = useState<number>(0);
  // Ephemeral typing indicator of the counterpart ("Kunde schreibt …"), self-clearing
  // after 4s (no stop event — matches the transient subchat_typing design).
  const [typingLabel, setTypingLabel] = useState<string | null>(null);
  const typingClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mount nonce for self-echo suppression of the typing signal (otherwise the
  // operator would see their own typing as „Team schreibt …").
  const clientIdRef = useRef<string>(Math.random().toString(36).slice(2));

  // Mark-read dedupe: only POST when the most recent external timestamp
  // has advanced past the last read POST (no spam per poll).
  const lastReadTsRef = useRef<number>(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/subchats/${encodeURIComponent(subchatId)}/messages`, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      if (!res.ok) {
        setStatus('error');
        return;
      }
      const data = (await res.json()) as {
        subchat: { title: string };
        messages: UiMessage[];
        recipientReadTs?: number;
      };
      setTitle(data.subchat.title);
      setMessages(data.messages);
      // Subchat-level watermark (ms epoch, 0 = nobody else has read).
      if (typeof data.recipientReadTs === 'number') setRecipientReadTs(data.recipientReadTs);
      setStatus('ok');
    } catch {
      setStatus('error');
    }
  }, [subchatId]);

  // Fire-and-forget mark-read. Debounced via lastReadTsRef: only post when
  // we have actually seen something new (lastMessage advanced). Non-fatal.
  const markReadRef = useRef(messages);
  markReadRef.current = messages;
  const markRead = useCallback(() => {
    const msgs = markReadRef.current;
    const last = msgs[msgs.length - 1];
    const ts = last ? last.createdAt : 0;
    // Only post when (a) there are any messages at all and (b) the most recent
    // timestamp has advanced since the last read POST.
    if (ts <= lastReadTsRef.current) return;
    lastReadTsRef.current = ts;
    void fetch(`/api/subchats/${encodeURIComponent(subchatId)}/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
      credentials: 'same-origin',
    }).catch(() => {
      /* non-fatal: next focus/load tries again */
    });
  }, [subchatId]);

  // Debounced load() — coalesces event bursts (~250ms), no new dependency.
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refetchSoon = useCallback(() => {
    if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    refetchTimerRef.current = setTimeout(() => {
      refetchTimerRef.current = null;
      void load();
    }, 250);
  }, [load]);

  // Outgoing typing signal: debounced (the composer already throttles onTyping
  // to >=1/2s, SubchatComposer.tsx) → ephemeral POST to /typing (no DB insert
  // server-side, only broadcast to SSE subscribers). Best-effort, non-fatal.
  const emitTyping = useCallback(() => {
    void fetch(`/api/subchats/${encodeURIComponent(subchatId)}/typing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ who: 'Team', clientId: clientIdRef.current }),
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => {
      /* non-fatal */
    });
  }, [subchatId]);

  // Live refetch via SSE. The hook discards foreign workspaces + replayed
  // initial events itself; we additionally guard on payload.subchatId.
  useEventStream({
    workspaceId,
    enabled: true,
    onEvent: (ev) => {
      const p = ev.payload as
        | { subchatId?: string; who?: string; fromClientId?: string }
        | undefined;
      if (p?.subchatId !== subchatId) return;
      if (ev.type === 'subchat_message') {
        // New message → authoritative re-load (also refreshes recipientReadTs/
        // ticks) AND mark-read (we are looking at it right now). Typing bubble gone.
        refetchSoon();
        markRead();
        setTypingLabel(null);
        return;
      }
      if (ev.type === 'subchat_question' || ev.type === 'subchat_question_answer') {
        // Question-Spinning: new/answered question → refetch the questions pill.
        void questions.refetch();
        return;
      }
      if (ev.type === 'subchat_typing') {
        // Suppress own typing echo (same mount nonce).
        if (p?.fromClientId === clientIdRef.current) return;
        // Only show foreign typing; self-clearing after 4s (no stop event).
        setTypingLabel(`${p?.who?.trim() || 'Kunde'} schreibt …`);
        if (typingClearRef.current) clearTimeout(typingClearRef.current);
        typingClearRef.current = setTimeout(() => setTypingLabel(null), 4000);
      }
    },
  });

  // Initial load + 30s safety poll + focus/visibility refetch (correctness
  // floor in case the live event landed on a different Lambda instance).
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), POLL_MS);
    const onFocus = (): void => {
      void load();
    };
    const onVisibility = (): void => {
      if (!document.hidden) void load();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(t);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
      if (typingClearRef.current) clearTimeout(typingClearRef.current);
    };
  }, [load]);

  // Mark-read as soon as the feed has changed and the last message came from
  // the customer (we just saw it). Dedupe via lastReadTsRef.
  useEffect(() => {
    if (status !== 'ok') return;
    const last = messages[messages.length - 1];
    if (last && last.authorKind === 'external') markRead();
  }, [messages, status, markRead]);

  // Mark-read also when focusing the window (operator looks in again).
  useEffect(() => {
    const onFocus = (): void => markRead();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [markRead]);

  // AI suggestions when the last message came from the customer (once per message).
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last || last.authorKind !== 'external') {
      setSuggestions([]);
      return;
    }
    if (lastSuggestForRef.current === last.id) return;
    lastSuggestForRef.current = last.id;
    setLoadingSuggest(true);
    setSuggestions([]);
    void fetch(`/api/subchats/${encodeURIComponent(subchatId)}/suggest`, { method: 'POST' })
      .then((r) => (r.ok ? r.json() : { suggestions: [] }))
      .then((d: { suggestions?: string[] }) =>
        setSuggestions(Array.isArray(d.suggestions) ? d.suggestions.slice(0, 3) : []),
      )
      .catch(() => setSuggestions([]))
      .finally(() => setLoadingSuggest(false));
  }, [messages, subchatId]);

  const mediaUrl = useCallback(
    (a: UiAttachment) => `/api/cloud/${encodeURIComponent(a.artifactId)}`,
    [],
  );

  // Fast image preview URL (THUMB endpoint, 256px). Internal + member-gated only;
  // the lightbox still loads the full bytes via mediaUrl.
  const thumbUrl = useCallback(
    (a: UiAttachment) =>
      `/api/subchats/${encodeURIComponent(subchatId)}/thumb/${encodeURIComponent(a.artifactId)}`,
    [subchatId],
  );

  // Progress uploader (UI-MSG contract): wraps /api/cloud in XMLHttpRequest
  // to get upload.onprogress (0..100). Returns the uploaded
  // artifact as a UiAttachment, or throws.
  const uploader: Uploader = useCallback(
    (file, onProgress) =>
      new Promise<UiAttachment>((resolve, reject) => {
        const fd = new FormData();
        fd.append('workspace', workspaceId);
        fd.append('file', file);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/cloud');
        xhr.withCredentials = true;
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const j = JSON.parse(xhr.responseText) as {
                artifact?: { id: string; filename: string; mime: string; bytes: number };
              };
              const a = j.artifact;
              if (!a?.id) {
                reject(new Error('no artifact'));
                return;
              }
              resolve({
                artifactId: a.id,
                filename: a.filename,
                mime: a.mime,
                bytes: a.bytes,
                kind: a.mime.startsWith('image/') ? 'image' : 'file',
              });
            } catch {
              reject(new Error('bad response'));
            }
          } else {
            reject(new Error('upload failed'));
          }
        };
        xhr.onerror = () => reject(new Error('network'));
        xhr.send(fd);
      }),
    [workspaceId],
  );

  // Progress-mode send: the composer has already uploaded and hands over the
  // finished artifacts; we only post text + attachments and re-load.
  const onSendUploaded = useCallback(
    async (text: string, attachments: UiAttachment[]) => {
      setBusy(true);
      setSuggestions([]);
      try {
        // Optimistic echo (2026-06-03): show immediately even WITH attachments,
        // so the sent message never feels „leer"/delayed. load()
        // afterwards replaces it with the authoritative server list.
        if (text || attachments.length > 0) {
          setMessages((m) => [
            ...m,
            { id: `tmp-${Date.now()}`, authorKind: 'internal', authorName: 'Team', content: text, attachments, createdAt: Date.now() },
          ]);
        }
        await fetch(`/api/subchats/${encodeURIComponent(subchatId)}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: text, attachments }),
        });
        await load();
      } catch {
        /* poll/live event catches it up */
      } finally {
        setBusy(false);
      }
    },
    [subchatId, load],
  );

  const suggestSlot =
    loadingSuggest || suggestions.length > 0 ? (
      <div style={suggestRow}>
        <span style={suggestLabel}>{loadingSuggest ? 'KI denkt' : 'Vorschläge'}</span>
        {suggestions.map((sg, i) => (
          <button
            key={i}
            type="button"
            style={suggestChip}
            onClick={() => setSeed((p) => ({ text: sg, nonce: p.nonce + 1 }))}
            title="In den Composer übernehmen"
          >
            {sg.length > 90 ? sg.slice(0, 90) + '…' : sg}
          </button>
        ))}
      </div>
    ) : null;

  return (
    <div style={s.shell}>
      <header style={s.header}>
        <a href={`/workspaces/${encodeURIComponent(workspaceId)}/subchats`} style={s.headerBtn} aria-label="Zurück">
          <IconBack size={22} />
        </a>
        <div style={s.headerTitle}>{title}</div>
        <div style={s.headerSub}>Team-Sicht</div>
      </header>

      {/* D2 (2026-06-03): clear channel hint — subchats are customer↔team
          (NOT an AI responder); the AI suggests replies + feeds the
          main chat. Fixes the expectation mismatch „Chat antwortet nicht". */}
      <div
        style={{
          padding: '8px clamp(12px, 4vw, 20px)',
          fontSize: 12,
          lineHeight: 1.45,
          color: 'var(--ink-3)',
          borderBottom: '0.5px solid var(--line-2)',
          background: 'var(--sheet-1)',
        }}
      >
        Kundenkanal — du antwortest (die KI schlägt vor, sobald der Kunde
        schreibt).{' '}
        <a
          href={`/?ws=${encodeURIComponent(workspaceId)}`}
          style={{ color: 'var(--a-now)', textDecoration: 'none', fontWeight: 500 }}
        >
          Frag den Hauptchat, was hier besprochen wurde →
        </a>
      </div>

      <SubchatThread
        messages={messages}
        isMine={(m) => m.authorKind === 'internal'}
        theirLabelFallback="Kunde"
        mediaUrl={mediaUrl}
        thumbUrl={thumbUrl}
        emptyText={status === 'error' ? 'Konnte den Sub-Chat nicht laden.' : 'Noch keine Nachrichten.'}
        onImageClick={(images, index) => setLb({ images, index })}
        typingLabel={typingLabel}
        recipientReadTs={recipientReadTs}
      />

      <SubchatComposer
        placeholder="Antwort an den Kunden"
        busy={busy}
        topSlot={
          <>
            <SubchatQuestionsPill
              open={questions.openForViewer}
              onAnswerOption={(qId, optionId) => void questions.answer(qId, { optionId })}
              onAnswerFreeText={(qId, text) => void questions.answer(qId, { freeText: text })}
              onSpin={(text, options) => void questions.spin(text, options)}
              onSuggestAi={() => questions.suggestAi()}
              onSpinAi={(text, options) => void questions.spin(text, options, true)}
            />
            {suggestSlot}
          </>
        }
        seed={seed}
        onTyping={emitTyping}
        uploader={uploader}
        onSendUploaded={onSendUploaded}
        enableVoice={true}
        enableVoiceMessage={false}
      />

      {lb ? (
        <Lightbox
          images={lb.images}
          index={lb.index}
          onIndexChange={(i) => setLb((cur) => (cur ? { ...cur, index: i } : cur))}
          onClose={() => setLb(null)}
        />
      ) : null}
    </div>
  );
}

const suggestRow: CSSProperties = {
  display: 'flex',
  gap: 6,
  alignItems: 'center',
  paddingBottom: 8,
  overflowX: 'auto',
};
const suggestLabel: CSSProperties = {
  fontSize: 10,
  color: 'var(--ink-3)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  flexShrink: 0,
};
const suggestChip: CSSProperties = {
  flexShrink: 0,
  maxWidth: 260,
  textAlign: 'left',
  background: 'var(--sheet-3, #141416)',
  border: '0.5px solid var(--line-2)',
  borderRadius: 14,
  padding: '7px 12px',
  color: 'var(--ink)',
  fontSize: 13,
  lineHeight: 1.35,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

export default InternalSubchat;
