'use client';

/**
 * InternalSubchat — interne Team-Sicht eines Workspace-Sub-Chats
 * (Gathering-Intelligence-Goal, 2026-06-02).
 *
 * Dünner Wrapper über der GETEILTEN Messenger-UI (SubchatThread + Composer) —
 * identische Optik wie die externe Sicht. Unterschiede: cookie-auth, Team-
 * Nachrichten rechts / Kunde links, Anhang-Upload über /api/cloud, und — im
 * Claude-Code-App-Stil — KI-Antwort-Vorschläge als Chips über dem Composer, wenn
 * die letzte Nachricht vom Kunden kam (Tap füllt den Composer). Keine Emojis.
 *
 * Realtime (P2 UI-RT, Verdict): authed `useEventStream` (bares
 * `/api/events/stream`, client-seitig auf `workspaceId` + `payload.subchatId`
 * gefiltert) treibt ein debounced `load()`-Refetch bei `subchat_message`.
 * Warm-Instance → Sub-Sekunden-Update. Cold/Multi-Instance (broadcast ist
 * per-Lambda) → 30s-Poll + Focus-Refetch als Korrektheits-Boden. Der Event-
 * Payload enthält nur eine 120-Zeichen-`preview` — die wird NIE als Nachricht
 * gerendert (N1): `load()` holt die autoritativen vollen Rows.
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

// Safety-Boden statt schnellem Primär-Poll: das Live-Event ist der schnelle
// Pfad (Sub-Sekunde auf der warmen Instanz), der 30s-Poll + Focus-Refetch ist
// der Multi-Instance-Korrektheits-Boden (broadcast ist per-Lambda, der SSE-
// Socket und der schreibende POST können auf verschiedenen Instanzen landen).
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

  // Question-Spinning (2026-06-03): angespinnte Fragen dieses Sub-Chats,
  // sequentiell-prominent über dem Composer. DB-autoritativ; Poll + Realtime.
  const questions = useSubchatQuestions(subchatId);

  // Lese-Wasserstand des GEGENPARTS (max lastReadTs aller userId !== viewer) aus
  // der GET-Antwort. Treibt die Lese-Haken auf EIGENEN Nachrichten in der UI:
  // eine eigene Nachricht gilt als gelesen, sobald createdAt <= recipientReadTs.
  const [recipientReadTs, setRecipientReadTs] = useState<number>(0);
  // Ephemerer Tipp-Indikator des Gegenparts ("Kunde schreibt …"), selbst-löschend
  // nach 4s (kein Stop-Event — passt zum transienten subchat_typing-Design).
  const [typingLabel, setTypingLabel] = useState<string | null>(null);
  const typingClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mount-Nonce zur Selbst-Echo-Unterdrückung des Tipp-Signals (sonst sähe der
  // Operator sein eigenes Tippen als „Team schreibt …").
  const clientIdRef = useRef<string>(Math.random().toString(36).slice(2));

  // Mark-read-Dedupe: nur POSTen, wenn der jüngste externe Zeitstempel
  // gegenüber dem letzten Read-POST vorgerückt ist (kein Spam pro Poll).
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
      // Subchat-Level-Wasserstand (ms epoch, 0 = niemand sonst hat gelesen).
      if (typeof data.recipientReadTs === 'number') setRecipientReadTs(data.recipientReadTs);
      setStatus('ok');
    } catch {
      setStatus('error');
    }
  }, [subchatId]);

  // Fire-and-forget Mark-read. Debounced über lastReadTsRef: nur posten, wenn
  // wir wirklich etwas Neues gesehen haben (lastMessage rückte vor). Nicht-fatal.
  const markReadRef = useRef(messages);
  markReadRef.current = messages;
  const markRead = useCallback(() => {
    const msgs = markReadRef.current;
    const last = msgs[msgs.length - 1];
    const ts = last ? last.createdAt : 0;
    // Nur posten, wenn (a) es überhaupt Nachrichten gibt und (b) der jüngste
    // Zeitstempel seit dem letzten Read-POST vorgerückt ist.
    if (ts <= lastReadTsRef.current) return;
    lastReadTsRef.current = ts;
    void fetch(`/api/subchats/${encodeURIComponent(subchatId)}/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
      credentials: 'same-origin',
    }).catch(() => {
      /* non-fatal: nächster Focus/Load versucht es erneut */
    });
  }, [subchatId]);

  // Debounced load() — koalesziert Event-Bursts (~250ms), keine neue Dependency.
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refetchSoon = useCallback(() => {
    if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    refetchTimerRef.current = setTimeout(() => {
      refetchTimerRef.current = null;
      void load();
    }, 250);
  }, [load]);

  // Ausgehendes Tipp-Signal: debounced (der Composer drosselt onTyping bereits
  // auf >=1/2s, SubchatComposer.tsx) → ephemerer POST an /typing (kein DB-Insert
  // serverseitig, nur broadcast an SSE-Subscriber). Best-effort, non-fatal.
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

  // Live-Refetch via SSE. Der Hook verwirft fremde Workspaces + replayte
  // Initial-Events selbst; wir guarden zusätzlich auf payload.subchatId.
  useEventStream({
    workspaceId,
    enabled: true,
    onEvent: (ev) => {
      const p = ev.payload as
        | { subchatId?: string; who?: string; fromClientId?: string }
        | undefined;
      if (p?.subchatId !== subchatId) return;
      if (ev.type === 'subchat_message') {
        // Neue Nachricht → autoritatives Re-Load (frischt auch recipientReadTs/
        // Haken auf) UND Mark-read (wir schauen gerade drauf). Tipp-Blase weg.
        refetchSoon();
        markRead();
        setTypingLabel(null);
        return;
      }
      if (ev.type === 'subchat_question' || ev.type === 'subchat_question_answer') {
        // Question-Spinning: neue/​beantwortete Frage → Fragen-Pille refetchen.
        void questions.refetch();
        return;
      }
      if (ev.type === 'subchat_typing') {
        // Eigenes Tipp-Echo unterdrücken (gleiche Mount-Nonce).
        if (p?.fromClientId === clientIdRef.current) return;
        // Nur fremdes Tippen anzeigen; selbst-löschend nach 4s (kein Stop-Event).
        setTypingLabel(`${p?.who?.trim() || 'Kunde'} schreibt …`);
        if (typingClearRef.current) clearTimeout(typingClearRef.current);
        typingClearRef.current = setTimeout(() => setTypingLabel(null), 4000);
      }
    },
  });

  // Initial-Load + 30s-Safety-Poll + Focus/Visibility-Refetch (Korrektheits-
  // Boden, falls das Live-Event auf einer anderen Lambda-Instanz landete).
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

  // Mark-read, sobald sich der Feed geändert hat und die letzte Nachricht vom
  // Kunden kam (wir haben sie gerade gesehen). Dedupe via lastReadTsRef.
  useEffect(() => {
    if (status !== 'ok') return;
    const last = messages[messages.length - 1];
    if (last && last.authorKind === 'external') markRead();
  }, [messages, status, markRead]);

  // Mark-read auch beim Fokussieren des Fensters (Operator schaut wieder rein).
  useEffect(() => {
    const onFocus = (): void => markRead();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [markRead]);

  // KI-Vorschläge, wenn die letzte Nachricht vom Kunden kam (einmal pro Message).
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

  // Schnelle Bild-Vorschau-URL (THUMB-Endpoint, 256px). Nur intern + member-gegated;
  // die Lightbox lädt weiterhin die vollen Bytes via mediaUrl.
  const thumbUrl = useCallback(
    (a: UiAttachment) =>
      `/api/subchats/${encodeURIComponent(subchatId)}/thumb/${encodeURIComponent(a.artifactId)}`,
    [subchatId],
  );

  // Progress-Uploader (UI-MSG-Kontrakt): wrappt /api/cloud in XMLHttpRequest,
  // um upload.onprogress (0..100) zu bekommen. Liefert das hochgeladene
  // Artefakt als UiAttachment zurück, oder wirft.
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

  // Progress-Mode-Send: der Composer hat bereits hochgeladen und reicht die
  // fertigen Artefakte; wir posten nur noch Text + attachments und re-laden.
  const onSendUploaded = useCallback(
    async (text: string, attachments: UiAttachment[]) => {
      setBusy(true);
      setSuggestions([]);
      try {
        // Optimistischer Echo (2026-06-03): auch MIT Anhängen sofort anzeigen,
        // damit die gesendete Nachricht nie „leer"/verzögert wirkt. load()
        // ersetzt danach durch die autoritative Server-Liste.
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
        /* Poll/Live-Event holt es nach */
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

      {/* D2 (2026-06-03): klarer Channel-Hinweis — Subchats sind Kunde↔Team
          (KEIN KI-Antworter); die KI schlägt Antworten vor + speist den
          Hauptchat. Behebt den Erwartungs-Mismatch „Chat antwortet nicht". */}
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
