'use client';

/**
 * SubchatThread — shared message feed (external + internal).
 * Apple/WhatsApp standards: date separators, speech bubbles (own right/accent,
 * others left), author label in the group chat, timestamps, inline attachments
 * (image as preview to open, file as a card with download), auto-scroll.
 * No emojis. Only laz.ing tokens. Gathering-Intelligence goal (2026-06-02).
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
  /** Optional: small, fast preview URL for an IMAGE (THUMB endpoint).
   *  If undefined → inline <img> uses mediaUrl(a,'inline') as before (back-compat,
   *  external view). Lightbox ALWAYS loads mediaUrl(a,'inline') (full bytes). */
  thumbUrl?: (a: UiAttachment) => string;
  emptyText: string;
  /** When set: an image tap opens the lightbox (across ALL thread images) instead of _blank. */
  onImageClick?: (images: LightboxImage[], index: number) => void;
  /** e.g. "client is typing …"; renders an ephemeral typing bubble at the feed end when truthy. */
  typingLabel?: string | null;
  /**
   * Subchat-wide recipient read-watermark (ms epoch). Drives delivery/read checks
   * ONLY on OWN messages: an own message counts as read once
   * `createdAt <= recipientReadTs`. Undefined ⇒ NO checks (back-compat: external view).
   */
  recipientReadTs?: number;
}): React.ReactElement {
  const feedRef = useRef<HTMLDivElement>(null);
  const lastId = messages.length > 0 ? messages[messages.length - 1].id : '';

  // Auto-scroll to the end on a new message (WhatsApp standard). typingLabel in
  // the deps so the typing indicator stays in view when it appears.
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, lastId, typingLabel]);

  // All image attachments of the thread in render order → lightbox can swipe across
  // the entire conversation. Map artifactId→global index for O(1) lookup.
  const { threadImages, imageIndex } = useMemo(() => {
    const imgs: LightboxImage[] = [];
    const idx = new Map<string, number>();
    for (const m of messages) {
      for (const a of m.attachments ?? []) {
        if (a.kind === 'image') {
          idx.set(a.artifactId, imgs.length);
          // N1: take filename/url unchanged (no truncation).
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
        // WhatsApp grouping: consecutive messages from the same
        // sender (within 5 min, same day) move closer together; the
        // sender name appears only once at the top of the group.
        const prev = i > 0 ? messages[i - 1] : null;
        const grouped =
          !showDay &&
          !!prev &&
          prev.authorKind === m.authorKind &&
          (prev.authorName || '') === (m.authorName || '') &&
          m.createdAt - prev.createdAt < GROUP_WINDOW_MS;
        // Bubble tail only at the END of a same-sender run (iMessage/WhatsApp):
        // this message is the last of its run when the NEXT one breaks the run.
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
        // Tail radius only at the run end; non-tail bubbles stay fully rounded (18)
        // at the respective corner. Do NOT mutate exported style objects.
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
                  // Belt-and-suspenders: even if the server does (not yet) round-trip
                  // kind:'audio', mime:audio/* renders as a player (Bundle-A boundary).
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
                        // inline-flex + minHeight 44: guarantees a >=44px-tall
                        // tap area around the (block) image, even if imgBtnReset
                        // has display:block. Box fills the bubble width.
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
