'use client';

/**
 * SubchatThread — geteilter Nachrichten-Feed (extern + intern).
 * Apple-/WhatsApp-Standards: Datums-Trenner, Sprechblasen (eigene rechts/Akzent,
 * fremde links), Autor-Label im Gruppenchat, Zeitstempel, Anhänge inline
 * (Bild als Vorschau zum Öffnen, Datei als Karte mit Download), Auto-Scroll.
 * Keine Emojis. Nur laz.ing-Tokens. Gathering-Intelligence-Goal (2026-06-02).
 */

import { useEffect, useMemo, useRef } from 'react';

import * as s from './styles';
import { IconCheck, IconCheckDouble, IconDownload, IconFile, IconMic } from './icons';
import type { LightboxImage } from './Lightbox';
import type { MediaUrlFn, UiAttachment, UiMessage } from './types';

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function formatDay(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const today = dayKey(now.getTime());
  const yest = dayKey(now.getTime() - 86_400_000);
  const k = dayKey(ts);
  if (k === today) return 'Heute';
  if (k === yest) return 'Gestern';
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}
function formatBytes(n: number): string {
  if (!n || n < 1024) return `${n || 0} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function SubchatThread({
  messages,
  isMine,
  theirLabelFallback,
  mediaUrl,
  thumbUrl,
  emptyText,
  onImageClick,
  typingLabel,
  recipientReadTs,
}: {
  messages: UiMessage[];
  isMine: (m: UiMessage) => boolean;
  theirLabelFallback: string;
  mediaUrl: MediaUrlFn;
  /** Optional: kleine, schnelle Vorschau-URL für ein BILD (THUMB-Endpoint).
   *  Wenn undefined → Inline-<img> nutzt mediaUrl(a,'inline') wie bisher (Back-Compat,
   *  externe Ansicht). Lightbox lädt IMMER mediaUrl(a,'inline') (volle Bytes). */
  thumbUrl?: (a: UiAttachment) => string;
  emptyText: string;
  /** Wenn gesetzt: Bild-Tap öffnet die Lightbox (über ALLE Thread-Bilder) statt _blank. */
  onImageClick?: (images: LightboxImage[], index: number) => void;
  /** z.B. "Kunde schreibt …"; rendert eine ephemere Tipp-Blase am Feed-Ende, wenn truthy. */
  typingLabel?: string | null;
  /**
   * Subchat-weiter Empfänger-Lese-Wasserstand (ms-Epoch). Treibt Liefer-/Lese-Haken
   * NUR auf EIGENEN Nachrichten: eine eigene Nachricht gilt als gelesen, sobald
   * `createdAt <= recipientReadTs`. Undefined ⇒ KEINE Haken (Back-Compat: externe Ansicht).
   */
  recipientReadTs?: number;
}): React.ReactElement {
  const feedRef = useRef<HTMLDivElement>(null);
  const lastId = messages.length > 0 ? messages[messages.length - 1].id : '';

  // Auto-Scroll ans Ende bei neuer Nachricht (WhatsApp-Standard). typingLabel in
  // den Deps, damit der Tipp-Indikator beim Erscheinen in Sicht bleibt.
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, lastId, typingLabel]);

  // Alle Bild-Anhänge des Threads in Render-Reihenfolge → Lightbox kann über die
  // gesamte Unterhaltung wischen. Map artifactId→globaler Index für O(1)-Lookup.
  const { threadImages, imageIndex } = useMemo(() => {
    const imgs: LightboxImage[] = [];
    const idx = new Map<string, number>();
    for (const m of messages) {
      for (const a of m.attachments ?? []) {
        if (a.kind === 'image') {
          idx.set(a.artifactId, imgs.length);
          // N1: filename/url unverändert übernehmen (keine Truncation).
          imgs.push({ url: mediaUrl(a, 'inline'), filename: a.filename });
        }
      }
    }
    return { threadImages: imgs, imageIndex: idx };
  }, [messages, mediaUrl]);

  if (messages.length === 0 && !typingLabel) {
    return (
      <div ref={feedRef} style={s.feed}>
        <div style={s.centered}>{emptyText}</div>
      </div>
    );
  }

  let prevDay = '';
  const GROUP_WINDOW_MS = 5 * 60 * 1000;
  return (
    <div ref={feedRef} style={s.feed}>
      {messages.map((m, i) => {
        const mine = isMine(m);
        const dk = dayKey(m.createdAt);
        const showDay = dk !== prevDay;
        prevDay = dk;
        const atts = m.attachments ?? [];
        // WhatsApp-Gruppierung: aufeinanderfolgende Nachrichten desselben
        // Absenders (innerhalb 5 Min, gleicher Tag) rücken enger zusammen; der
        // Absender-Name erscheint nur einmal oben in der Gruppe.
        const prev = i > 0 ? messages[i - 1] : null;
        const grouped =
          !showDay &&
          !!prev &&
          prev.authorKind === m.authorKind &&
          (prev.authorName || '') === (m.authorName || '') &&
          m.createdAt - prev.createdAt < GROUP_WINDOW_MS;
        // Bubble-Tail nur am ENDE eines Same-Sender-Laufs (iMessage/WhatsApp):
        // diese Nachricht ist die letzte ihres Laufs, wenn die NÄCHSTE den Lauf bricht.
        const next = i < messages.length - 1 ? messages[i + 1] : null;
        const nextDay = next ? dayKey(next.createdAt) : '';
        const tail =
          !next ||
          next.authorKind !== m.authorKind ||
          (next.authorName || '') !== (m.authorName || '') ||
          next.createdAt - m.createdAt >= GROUP_WINDOW_MS ||
          nextDay !== dk;
        const rowStyle = {
          ...(mine ? s.rowMine : s.rowTheirs),
          marginTop: grouped ? 2 : 8,
        };
        // Tail-Radius nur am Lauf-Ende; Nicht-Tail-Blasen bleiben voll gerundet (18)
        // an der jeweiligen Ecke. Exportierte Style-Objekte NICHT mutieren.
        const bubbleStyle = {
          ...(mine ? s.bubbleMine : s.bubbleTheirs),
          ...(mine
            ? { borderBottomRightRadius: tail ? 6 : 18 }
            : { borderBottomLeftRadius: tail ? 6 : 18 }),
        };
        return (
          <div key={m.id}>
            {showDay ? (
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <span style={s.dateSep}>{formatDay(m.createdAt)}</span>
              </div>
            ) : null}
            <div style={rowStyle}>
              <div style={bubbleStyle}>
                {!mine && !grouped ? <div style={s.authorLabel}>{m.authorName || theirLabelFallback}</div> : null}

                {atts.map((a) => {
                  // Belt-and-suspenders: auch wenn der Server kind:'audio' (noch)
                  // nicht round-trippt, rendert mime:audio/* als Player (Bundle-A-Grenze).
                  const isAudio = a.kind === 'audio' || a.mime.startsWith('audio/');
                  return isAudio ? (
                    <div key={a.artifactId} style={s.audioCard}>
                      <span style={s.audioCardIcon}>
                        <IconMic size={18} />
                      </span>
                      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                      <audio
                        src={mediaUrl(a, 'inline')}
                        controls
                        preload="metadata"
                        style={s.audioPlayer}
                        aria-label={`Sprachnachricht: ${a.filename}`}
                      />
                    </div>
                  ) : a.kind === 'image' ? (
                    onImageClick ? (
                      <button
                        key={a.artifactId}
                        type="button"
                        // inline-flex + minHeight 44: garantiert eine >=44px-hohe
                        // Tap-Fläche um das (Block-)Bild, auch wenn imgBtnReset
                        // display:block hat. Box füllt die Bubble-Breite.
                        style={{ ...s.imgBtnReset, display: 'flex', width: '100%', minHeight: 44 }}
                        onClick={() => onImageClick(threadImages, imageIndex.get(a.artifactId) ?? 0)}
                        aria-label={`Bild öffnen: ${a.filename}`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={thumbUrl ? thumbUrl(a) : mediaUrl(a, 'inline')}
                          alt={a.filename}
                          style={{ ...s.attachImg, objectFit: 'contain' }}
                          loading="lazy"
                          decoding="async"
                        />
                      </button>
                    ) : (
                      <a
                        key={a.artifactId}
                        href={mediaUrl(a, 'inline')}
                        target="_blank"
                        rel="noreferrer"
                        style={{ display: 'flex', width: '100%', minHeight: 44 }}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={thumbUrl ? thumbUrl(a) : mediaUrl(a, 'inline')}
                          alt={a.filename}
                          style={{ ...s.attachImg, objectFit: 'contain' }}
                          loading="lazy"
                          decoding="async"
                        />
                      </a>
                    )
                  ) : (
                    <a
                      key={a.artifactId}
                      href={mediaUrl(a, 'download')}
                      target="_blank"
                      rel="noreferrer"
                      style={s.fileCard}
                    >
                      <span style={s.fileCardIcon}>
                        <IconFile size={20} />
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <span style={s.fileCardName}>{a.filename}</span>
                        <span style={{ ...s.fileCardMeta, display: 'flex', alignItems: 'center', gap: 5 }}>
                          {formatBytes(a.bytes)} <IconDownload size={13} />
                        </span>
                      </span>
                    </a>
                  );
                })}

                {m.content ? <div style={s.msgText}>{m.content}</div> : null}

                <div style={s.metaRow}>
                  <span style={mine ? s.metaTimeMine : s.metaTimeTheirs}>{formatTime(m.createdAt)}</span>
                  {mine && recipientReadTs !== undefined ? (
                    (() => {
                      const read = m.createdAt <= recipientReadTs;
                      return (
                        <span
                          style={{ ...s.tickWrap, ...(read ? s.tickRead : s.tickSent) }}
                          role="img"
                          aria-label={read ? 'Gelesen' : 'Gesendet'}
                        >
                          {read ? <IconCheckDouble size={15} /> : <IconCheck size={13} />}
                        </span>
                      );
                    })()
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        );
      })}

      {typingLabel ? (
        <>
          <style>{TYPING_KEYFRAMES}</style>
          <div style={{ ...s.rowTheirs, marginTop: 8 }}>
            <div style={s.typingBubble} aria-label={typingLabel} role="status">
              <span style={{ ...s.typingDot, animation: 'lazSubchatTyping 1.2s ease-in-out infinite' }} />
              <span style={{ ...s.typingDot, animation: 'lazSubchatTyping 1.2s ease-in-out 0.2s infinite' }} />
              <span style={{ ...s.typingDot, animation: 'lazSubchatTyping 1.2s ease-in-out 0.4s infinite' }} />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

const TYPING_KEYFRAMES = `@keyframes lazSubchatTyping {
  0%, 60%, 100% { opacity: 0.32; transform: translateY(0); }
  30% { opacity: 1; transform: translateY(-2px); }
}`;

export default SubchatThread;
