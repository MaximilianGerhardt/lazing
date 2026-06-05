/**
 * Shared styles for the sub-chat messenger UI (external + internal).
 * ONLY laz.ing design tokens (app/globals.css :root) — no foreign hex values,
 * no emojis. Mobile-first, Apple/iMessage/WhatsApp standards.
 * Gathering-Intelligence goal (2026-06-02).
 */

import type { CSSProperties } from 'react';

export const shell: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100dvh',
  background: 'var(--sheet, #070707)',
  color: 'var(--ink, #F5F5F7)',
  fontFamily: 'var(--font-sans, -apple-system, system-ui, sans-serif)',
};

export const header: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: 'max(12px, env(safe-area-inset-top)) 12px 11px',
  borderBottom: '0.5px solid var(--line-2)',
  flexShrink: 0,
  background: 'color-mix(in oklab, var(--sheet) 85%, transparent)',
  backdropFilter: 'saturate(180%) blur(20px)',
  WebkitBackdropFilter: 'saturate(180%) blur(20px)',
};

export const headerBtn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 44,
  height: 44,
  marginLeft: -12,
  borderRadius: 999,
  color: 'var(--ink-2)',
  textDecoration: 'none',
  flexShrink: 0,
};

export const headerTitle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 16,
  fontWeight: 600,
  letterSpacing: '-0.01em',
  color: 'var(--ink)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const headerSub: CSSProperties = {
  fontSize: 11,
  color: 'var(--ink-3)',
  flexShrink: 0,
  fontWeight: 500,
};

export const feed: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '14px 12px 8px',
  WebkitOverflowScrolling: 'touch',
};

export const dateSep: CSSProperties = {
  alignSelf: 'center',
  margin: '10px 0 8px',
  padding: '3px 10px',
  borderRadius: 999,
  background: 'var(--sheet-2, #0E0E0F)',
  border: '0.5px solid var(--line-2)',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--ink-3)',
  letterSpacing: '0.01em',
};

export const rowMine: CSSProperties = { display: 'flex', justifyContent: 'flex-end', marginTop: 2 };
export const rowTheirs: CSSProperties = { display: 'flex', justifyContent: 'flex-start', marginTop: 2 };

export const bubbleBase: CSSProperties = {
  maxWidth: '84%',
  minWidth: 0,
  padding: '8px 12px 6px',
  borderRadius: 18,
  fontSize: 15,
  lineHeight: 1.42,
  position: 'relative',
};
export const bubbleMine: CSSProperties = {
  ...bubbleBase,
  background: 'var(--a-now, #2E6FF2)',
  color: 'var(--on-accent)',
  borderBottomRightRadius: 6,
};
export const bubbleTheirs: CSSProperties = {
  ...bubbleBase,
  background: 'var(--sheet-3, #141416)',
  border: '0.5px solid var(--line-2)',
  color: 'var(--ink)',
  borderBottomLeftRadius: 6,
};

export const authorLabel: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--ink-2)',
  marginBottom: 3,
  fontWeight: 600,
};

export const msgText: CSSProperties = { whiteSpace: 'pre-wrap', wordBreak: 'break-word' };

export const metaRow: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  marginTop: 2,
};
export const metaTimeMine: CSSProperties = { fontSize: 10.5, color: 'var(--on-accent-2)', fontVariantNumeric: 'tabular-nums' };
export const metaTimeTheirs: CSSProperties = { fontSize: 10.5, color: 'var(--ink-3)', fontVariantNumeric: 'tabular-nums' };

/* ---- Delivery/read checks (only on OWN messages, in the accent bubble) ---- */
export const tickWrap: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  marginLeft: 4,
  lineHeight: 0,
  flexShrink: 0,
};
// "sent" — dimmed like the timestamp on the accent bubble.
export const tickSent: CSSProperties = {
  color: 'var(--on-accent-2)',
};
// "read" — full accent contrast (brighter than sent).
export const tickRead: CSSProperties = {
  color: 'var(--on-accent)',
};

/* ---- Attachments ---- */
export const attachImg: CSSProperties = {
  display: 'block',
  width: '100%',
  maxWidth: 'min(280px, 100%)',
  height: 'auto',
  maxHeight: 280,
  borderRadius: 12,
  marginTop: 2,
  marginBottom: 4,
  objectFit: 'contain',
  cursor: 'pointer',
  background: 'var(--sheet-2, #0E0E0F)',
};

export const fileCard: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '9px 11px',
  marginTop: 4,
  marginBottom: 4,
  borderRadius: 12,
  background: 'color-mix(in oklab, var(--ink) 8%, transparent)',
  textDecoration: 'none',
  color: 'inherit',
  maxWidth: 260,
};
export const fileCardIcon: CSSProperties = {
  flexShrink: 0,
  width: 34,
  height: 34,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 9,
  background: 'color-mix(in oklab, var(--ink) 10%, transparent)',
};
export const fileCardName: CSSProperties = {
  fontSize: 13.5,
  fontWeight: 600,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
export const fileCardMeta: CSSProperties = { fontSize: 11, opacity: 0.65, marginTop: 1 };

export const centered: CSSProperties = {
  display: 'flex',
  flex: 1,
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
  padding: 24,
  color: 'var(--ink-2)',
  fontSize: 14,
};

/* ---- Composer ----
 * NOTE (Phase 2 SP-5): the bottom inset is intentionally NOT set here. It is
 * owned by the `.subchat-composer` CSS class (app/components.css) so it can be
 * raised to clear the global bottom tab bar on the internal sub-chat
 * (`.subchat-composer--with-tabbar`) and reset under `body.kb-open` — neither
 * of which an inline style can express. The base class restores the same
 * `max(8px, env(safe-area-inset-bottom))` the external view always had. */
export const composerWrap: CSSProperties = {
  flexShrink: 0,
  borderTop: '0.5px solid var(--line-2)',
  padding: '8px 10px',
  background: 'color-mix(in oklab, var(--sheet) 85%, transparent)',
};

export const stagedRow: CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
  marginBottom: 8,
};
export const stagedItem: CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: 6,
  paddingRight: 26,
  borderRadius: 10,
  background: 'var(--sheet-3, #141416)',
  border: '0.5px solid var(--line-2)',
  maxWidth: 200,
};
export const stagedThumb: CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 7,
  objectFit: 'cover',
  flexShrink: 0,
  background: 'var(--sheet-2, #0E0E0F)',
};
export const stagedName: CSSProperties = {
  fontSize: 12,
  color: 'var(--ink-2)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxWidth: 110,
};
export const stagedRemove: CSSProperties = {
  position: 'absolute',
  top: 2,
  right: 2,
  width: 20,
  height: 20,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 999,
  border: 'none',
  background: 'var(--sheet, #070707)',
  color: 'var(--ink-2)',
  cursor: 'pointer',
  padding: 0,
};

export const composerInputRow: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-end',
  gap: 8,
};
export const attachBtn: CSSProperties = {
  flexShrink: 0,
  width: 44,
  height: 44,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 999,
  border: 'none',
  background: 'transparent',
  color: 'var(--ink-2)',
  cursor: 'pointer',
  padding: 0,
};
export const composerInput: CSSProperties = {
  flex: 1,
  resize: 'none',
  background: 'var(--sheet-2, #0E0E0F)',
  border: '0.5px solid var(--line-2)',
  borderRadius: 20,
  padding: '10px 14px',
  color: 'var(--ink)',
  fontSize: 16, // >=16px prevents iOS auto-zoom on focus
  lineHeight: 1.4,
  maxHeight: 120,
  outline: 'none',
  fontFamily: 'inherit',
};
export const sendBtn: CSSProperties = {
  flexShrink: 0,
  width: 44,
  height: 44,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: '50%',
  border: 'none',
  background: 'var(--a-now, #2E6FF2)',
  color: 'var(--on-accent)',
  cursor: 'pointer',
  padding: 0,
  transition: 'opacity 0.15s',
};
export const sendBtnDisabled: CSSProperties = {
  ...sendBtn,
  opacity: 0.4,
  cursor: 'default',
};

export const footerNotice: CSSProperties = {
  fontSize: 11,
  color: 'var(--ink-3)',
  textAlign: 'center',
  padding: '7px 16px max(8px, env(safe-area-inset-bottom))',
  lineHeight: 1.4,
};

/* ---- Image button (lightbox trigger in the thread) ---- */
export const imgBtnReset: CSSProperties = {
  display: 'block',
  border: 'none',
  background: 'transparent',
  padding: 0,
  margin: 0,
  cursor: 'zoom-in',
  width: 'fit-content',
  maxWidth: '100%',
  lineHeight: 0,
  minHeight: 44,
};

/* ---- Typing indicator (ephemeral "typing …" bubble at the feed end) ---- */
export const typingBubble: CSSProperties = {
  ...bubbleTheirs,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '11px 14px',
};
export const typingDot: CSSProperties = {
  display: 'inline-block',
  width: 6,
  height: 6,
  borderRadius: 999,
  background: 'var(--ink-3)',
};

/* ---- Lightbox (full-screen image view) ---- */
export const lbBackdrop: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  background: 'color-mix(in oklab, var(--sheet) 96%, transparent)',
  height: '100dvh',
  paddingTop: 'env(safe-area-inset-top)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  touchAction: 'none',
  overscrollBehavior: 'contain',
};
export const lbClose: CSSProperties = {
  position: 'absolute',
  top: 'max(10px, env(safe-area-inset-top))',
  right: 10,
  width: 44,
  height: 44,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 999,
  border: 'none',
  background: 'color-mix(in oklab, var(--ink) 10%, transparent)',
  color: 'var(--ink)',
  cursor: 'pointer',
  padding: 0,
  zIndex: 2,
};
export const lbStage: CSSProperties = {
  flex: 1,
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 0,
  padding: '0 8px',
};
export const lbImage: CSSProperties = {
  maxWidth: '100%',
  maxHeight: '100%',
  width: 'auto',
  height: 'auto',
  objectFit: 'contain',
  borderRadius: 8,
  userSelect: 'none',
  WebkitUserSelect: 'none',
  // The image carries the drag/tap gestures (swipe + close) — pointer-events MUST
  // stay active. Native image drag is suppressed via draggable={false}.
  touchAction: 'none',
};
export const lbCaption: CSSProperties = {
  flexShrink: 0,
  width: '100%',
  textAlign: 'center',
  padding: '10px 16px max(12px, env(safe-area-inset-bottom))',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 3,
};
export const lbCaptionName: CSSProperties = {
  fontSize: 12,
  color: 'var(--ink-2)',
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
export const lbCaptionCounter: CSSProperties = {
  fontSize: 11,
  color: 'var(--ink-3)',
  fontVariantNumeric: 'tabular-nums',
};

/* ---- Attachment-source popover (camera / photos / file above the attach button) ---- */
export const sourcePopover: CSSProperties = {
  position: 'absolute',
  bottom: 'calc(100% + 8px)',
  left: 0,
  zIndex: 30,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: 6,
  borderRadius: 14,
  background: 'var(--sheet-3, #141416)',
  border: '0.5px solid var(--line-2)',
  boxShadow: '0 12px 32px color-mix(in oklab, var(--sheet) 60%, transparent)',
  minWidth: 168,
};
export const sourceItem: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  minHeight: 44,
  padding: '0 10px',
  borderRadius: 9,
  border: 'none',
  background: 'transparent',
  color: 'var(--ink)',
  fontSize: 14,
  fontWeight: 500,
  cursor: 'pointer',
  textAlign: 'left',
  fontFamily: 'inherit',
};
export const sourceItemIcon: CSSProperties = {
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--ink-2)',
};

/* ---- Per-file upload progress (progress mode) ---- */
export const stagedProgressTrack: CSSProperties = {
  position: 'absolute',
  left: 6,
  right: 26,
  bottom: 4,
  height: 3,
  borderRadius: 999,
  background: 'color-mix(in oklab, var(--ink) 12%, transparent)',
  overflow: 'hidden',
};
export const stagedProgressBar: CSSProperties = {
  height: '100%',
  background: 'var(--a-now, #2E6FF2)',
  borderRadius: 999,
  transition: 'width 0.15s ease-out',
};
export const stagedError: CSSProperties = {
  fontSize: 11,
  color: 'var(--ink-3)',
  marginTop: 2,
};

/* ---- Voice recording (mic) ---- */
export const micBtn: CSSProperties = {
  flexShrink: 0,
  width: 44,
  height: 44,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 999,
  border: 'none',
  background: 'transparent',
  color: 'var(--ink-2)',
  cursor: 'pointer',
  padding: 0,
  touchAction: 'none',
};
export const micBtnActive: CSSProperties = {
  ...micBtn,
  color: 'var(--a-now, #2E6FF2)',
  background: 'color-mix(in oklab, var(--a-now) 16%, transparent)',
};
export const voicePill: CSSProperties = {
  alignSelf: 'flex-start',
  margin: '0 0 8px',
  padding: '4px 12px',
  borderRadius: 999,
  background: 'var(--sheet-3, #141416)',
  border: '0.5px solid var(--line-2)',
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--ink-3)',
};

/* ---- Voice message: recording pill (live timer) ---- */
export const recPill: CSSProperties = {
  alignSelf: 'flex-start',
  margin: '0 0 8px',
  padding: '4px 12px',
  borderRadius: 999,
  background: 'color-mix(in oklab, var(--a-now) 16%, transparent)',
  border: '0.5px solid var(--line-2)',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--a-now, #2E6FF2)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontVariantNumeric: 'tabular-nums',
};

/* ---- Staged audio chip (duration instead of filename) ---- */
export const stagedAudioMeta: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--ink-2)',
  fontVariantNumeric: 'tabular-nums',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
};

/* ---- Audio player in the thread (native controls, token frame) ---- */
export const audioCard: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 8px',
  marginTop: 4,
  marginBottom: 4,
  borderRadius: 12,
  background: 'color-mix(in oklab, var(--ink) 8%, transparent)',
  maxWidth: 'min(280px, 100%)',
};
export const audioCardIcon: CSSProperties = {
  flexShrink: 0,
  width: 30,
  height: 30,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 8,
  background: 'color-mix(in oklab, var(--ink) 10%, transparent)',
  color: 'var(--ink-2)',
};
export const audioPlayer: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 36,
  maxWidth: '100%',
};
