'use client';

/**
 * StagedAttachmentsBar — fixed attachment preview ABOVE the composer.
 * ------------------------------------------------------------------
 * Owner hard requirement (2026-05-26): a selected file is NOT
 * sent immediately, but sits as a preview above the input (WhatsApp/
 * Telegram style), stays there until send OR × — meanwhile the user
 * can type text to go with it. Multiple attachments are stackable.
 *
 * Design: Manifest v1.0 — pitch-black, `var(--token, #fallback)`,
 * 240ms cubic-bezier, no emojis (SVG glyphs).
 */

import type { CSSProperties } from 'react';
import type { StagedAttachment } from './attachment-message';

export interface StagedAttachmentsBarProps {
  attachments: readonly StagedAttachment[];
  /** Remove an attachment (×). */
  onRemove: (id: string) => void;
  /** Optional: an upload is still running (spinner chip). */
  uploadingName?: string | null;
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function extLabel(mime: string, filename: string): string {
  const ext = filename.split('.').pop();
  if (ext && ext.length <= 5) return ext.toUpperCase();
  return (mime.split('/').pop() ?? 'FILE').toUpperCase().slice(0, 5);
}

export function StagedAttachmentsBar({
  attachments,
  onRemove,
  uploadingName,
}: StagedAttachmentsBarProps): React.JSX.Element | null {
  if (attachments.length === 0 && !uploadingName) return null;

  return (
    <div style={barStyle} aria-label="Angehängte Dateien">
      {attachments.map((a) => {
        const isImage = a.mime.startsWith('image/');
        return (
          <div key={a.id} style={chipStyle} role="group" title={a.filename}>
            {isImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={a.thumbnailUrl || a.previewUrl}
                alt={a.filename}
                style={thumbStyle}
                loading="lazy"
              />
            ) : (
              <span style={fileTileStyle} aria-hidden>
                <span style={fileExtStyle}>{extLabel(a.mime, a.filename)}</span>
              </span>
            )}
            <span style={metaStyle}>
              <span style={nameStyle}>{a.filename}</span>
              <span style={subStyle}>{formatBytes(a.bytes)}</span>
            </span>
            <button
              type="button"
              style={removeBtnStyle}
              aria-label={`Anhang entfernen: ${a.filename}`}
              title="Entfernen"
              onClick={() => onRemove(a.id)}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        );
      })}

      {uploadingName ? (
        <div style={uploadingChipStyle} aria-live="polite">
          <span style={spinnerStyle} aria-hidden />
          <span style={nameStyle}>{uploadingName}</span>
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------- Styles --------------------------- */

const barStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  padding: '8px 4px 0',
  maxWidth: 860,
  margin: '0 auto',
  width: '100%',
};

const chipStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: 6,
  paddingRight: 4,
  borderRadius: 12,
  background: 'var(--sheet-2, #0E0E0F)',
  border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
  maxWidth: 240,
};

const thumbStyle: CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 8,
  objectFit: 'cover',
  flexShrink: 0,
  display: 'block',
};

const fileTileStyle: CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 8,
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'color-mix(in oklab, var(--a-now, #C9FF4D) 12%, transparent)',
  color: 'var(--a-now, #C9FF4D)',
};

const fileExtStyle: CSSProperties = {
  fontSize: 9,
  fontFamily: 'var(--font-mono, ui-monospace)',
  fontWeight: 700,
  letterSpacing: '0.04em',
};

const metaStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  minWidth: 0,
  flex: 1,
};

const nameStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--ink, #F5F5F7)',
  fontFamily: 'var(--font-sans, system-ui)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: 150,
};

const subStyle: CSSProperties = {
  fontSize: 10,
  color: 'var(--ink-3, #636366)',
  fontFamily: 'var(--font-mono, ui-monospace)',
};

const removeBtnStyle: CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  flexShrink: 0,
  width: 26,
  height: 26,
  borderRadius: 7,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--ink-3, #636366)',
  transition: 'color 240ms cubic-bezier(0.16, 1, 0.3, 1)',
};

const uploadingChipStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 12px',
  borderRadius: 12,
  background: 'var(--sheet-2, #0E0E0F)',
  border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
};

const spinnerStyle: CSSProperties = {
  width: 14,
  height: 14,
  borderRadius: '50%',
  border: '2px solid var(--line-2, rgba(255,255,255,0.12))',
  borderTopColor: 'var(--a-now, #C9FF4D)',
  animation: 'chat-session-spin 0.7s linear infinite',
  flexShrink: 0,
};
