'use client';

import { useEffect, useState, type CSSProperties } from 'react';

import { Lightbox } from '@/lib/subchats/ui/Lightbox';

export interface DocumentProps {
  /**
   * Artifact-ID (ART-<ULID>). OPTIONAL: ein vom Agent referenziertes
   * Dokument (z.B. `<surface:document>{filename,mime,workspace}</surface:document>`)
   * hat keine ID — dann rendern wir eine reine Datei-Karte ohne
   * Download-/Preview-Aktionen (es gibt kein Artefakt zum Streamen).
   */
  id?: string | null;
  filename: string;
  mime: string;
  bytes?: number;
  pages?: number | null;
  workspace?: string;
  workspaceLabel?: string;
  /** Nur wenn `id` vorhanden — sonst kein Stream-Endpoint. */
  downloadUrl?: string;
  previewUrl?: string;
  thumbnailUrl?: string;
  createdBy?: string;
  createdAt?: string;
  /** Wenn `true`, blendet die Preview-Modal-Logik aus. */
  noPreview?: boolean;
}

const MIME_LABEL: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/png': 'PNG',
  'image/jpeg': 'JPG',
  'image/webp': 'WEBP',
  'image/gif': 'GIF',
  'image/svg+xml': 'SVG',
  'application/zip': 'ZIP',
  'application/json': 'JSON',
  'text/plain': 'TXT',
  'text/markdown': 'MD',
  'text/csv': 'CSV',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'DOCX',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
};

function mimeLabel(mime: string, filename: string): string {
  if (MIME_LABEL[mime]) return MIME_LABEL[mime];
  const ext = filename.split('.').pop();
  return (ext ?? 'FILE').toUpperCase().slice(0, 6);
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Robuster Download-Trigger.
 *
 * Browsergeschmack ist beim `<a download>` Attribut inkonsistent — vor
 * allem iOS Safari ignoriert es und navigiert stattdessen. Wir holen die
 * Datei daher als Blob, packen sie in eine ObjectURL und triggern dann
 * eine künstliche `<a>`-Navigation. Das funktioniert auf allen Plattformen
 * weil der Browser bei einem Blob-URL nicht weiß WAS für ein Doc das war
 * — der `download`-Hint zwingt ihn dann zum Save-Dialog.
 *
 * Fallback: wenn fetch fehlschlägt (z.B. Auth abgelaufen), öffnen wir die
 * URL im neuen Tab — der Server sendet `Content-Disposition: attachment`
 * für /api/cloud/<id>, der Browser-PDF-Viewer zeigt zumindest einen
 * Save-Dialog.
 */
async function triggerDownload(url: string, filename: string): Promise<void> {
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename || 'download';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // Object-URL nach kurzer Zeit freigeben (Browser hat downloaded)
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  } catch (err) {
    // Fallback — neue Tab triggert serverseitiges Content-Disposition.
    console.warn('[doc-download] blob-path failed, falling back', err);
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/**
 * DOC-01 Document-Card — WhatsApp/Telegram-Style.
 *
 * Selbst-gestyled über Inline-Styles + Manifest-v1.0-Tokens
 * (`var(--token, #fallback)`). KEINE externen CSS-Klassen — die
 * `lazyos-doc-card__*`-Klassen existierten nie im Stylesheet, daher
 * rendert die alte Variante komplett ungestyled.
 *
 * Zwei Modi:
 *   1) Bild (mime image/*) → großes abgerundetes Inline-Thumbnail,
 *      Tap → Lightbox (Vollbild). WhatsApp-Bild-Bubble.
 *   2) Dokument (PDF/Doc/…) → kompakte Datei-Karte mit Icon-Tile +
 *      Name + Größe/Pages, Tap → Preview-Modal (PDF inline) oder Download.
 *
 * ID-tolerant: ohne `id` (Agent-Referenz) rendern wir nur die Datei-Karte
 * ohne Download/Preview-Aktionen — es gibt kein Artefakt zum Streamen.
 */
export function Document(props: DocumentProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [imgError, setImgError] = useState(false);
  const ext = mimeLabel(props.mime, props.filename);
  const isPdf = props.mime === 'application/pdf';
  const isImage = props.mime.startsWith('image/');
  const inlineSafe = isPdf || isImage || props.mime === 'text/plain';

  // Ein referenziertes Dokument (Agent-Surface) ohne ID hat keine
  // Stream-Endpoints. Alle id-abhängigen URLs sind dann undefined.
  const hasArtifact = typeof props.id === 'string' && props.id.length > 0;
  const downloadUrl =
    props.downloadUrl ?? (hasArtifact ? `/api/cloud/${props.id}` : undefined);
  const previewUrl =
    props.previewUrl ?? (hasArtifact ? `/api/cloud/${props.id}/preview` : undefined);
  const thumbnailUrl =
    props.thumbnailUrl ??
    (hasArtifact ? `/api/cloud/${props.id}/thumb` : undefined);

  const coverSrc = isImage ? previewUrl : thumbnailUrl;
  const showImageCover = isImage && !!coverSrc && !imgError;

  const handleOpen = (): void => {
    if (props.noPreview || !previewUrl) return;
    if (inlineSafe) {
      setOpen(true);
    } else if (downloadUrl) {
      window.open(downloadUrl, '_blank', 'noopener,noreferrer');
    }
  };

  // ----- Modus 1: Bild-Bubble (WhatsApp-Style) -----
  if (showImageCover && previewUrl) {
    return (
      <div style={imageWrapStyle} role="group">
        <button
          type="button"
          style={imageButtonStyle}
          onClick={handleOpen}
          aria-label={`Bild öffnen: ${props.filename}`}
          title={props.filename}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={coverSrc}
            alt={props.filename}
            style={imageCoverStyle}
            loading="lazy"
            onError={() => setImgError(true)}
          />
          <span style={imageMetaOverlayStyle} aria-hidden>
            {typeof props.bytes === 'number' && props.bytes > 0
              ? formatBytes(props.bytes)
              : ext}
          </span>
        </button>
        {open && !props.noPreview ? (
          // 2026-06-03 (Owner-Feedback „Fullscreen nicht optimal"): Bilder im
          // echten Lightbox (Pinch-Zoom/Swipe/Spring, „komplett ansehen") statt
          // im generischen PreviewModal. PDFs/Text laufen weiter über das Modal
          // (Modus 2 unten). Single-Image → images:[{url,filename}], index 0.
          <Lightbox
            images={[{ url: previewUrl, filename: props.filename }]}
            index={0}
            onIndexChange={() => {}}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </div>
    );
  }

  // ----- Modus 2: Datei-Karte (Telegram-Style) -----
  const interactive = hasArtifact && !props.noPreview;
  return (
    <div style={cardStyle} role="group">
      <button
        type="button"
        style={cardBodyStyle}
        onClick={interactive ? handleOpen : undefined}
        disabled={!interactive}
        aria-label={interactive ? `Öffnen: ${props.filename}` : props.filename}
        title={props.filename}
      >
        <span style={iconTileStyle} aria-hidden>
          <FileGlyph />
          <span style={iconExtStyle}>{ext}</span>
        </span>
        <span style={cardMetaStyle}>
          <span style={filenameStyle} title={props.filename}>
            {props.filename}
          </span>
          <span style={subStyle}>
            {typeof props.bytes === 'number' && props.bytes > 0 ? (
              <span>{formatBytes(props.bytes)}</span>
            ) : null}
            {typeof props.pages === 'number' && props.pages > 0 ? (
              <>
                <span aria-hidden> · </span>
                <span>
                  {props.pages} {props.pages === 1 ? 'Seite' : 'Seiten'}
                </span>
              </>
            ) : null}
            {props.workspaceLabel ? (
              <>
                <span aria-hidden> · </span>
                <span style={wsStyle}>{props.workspaceLabel}</span>
              </>
            ) : null}
          </span>
        </span>
      </button>

      {hasArtifact && downloadUrl ? (
        <button
          type="button"
          style={downloadBtnStyle}
          aria-label={`Download ${props.filename}`}
          title="Speichern"
          onClick={(e) => {
            e.stopPropagation();
            void triggerDownload(downloadUrl, props.filename);
          }}
        >
          <DownloadGlyph />
        </button>
      ) : null}

      {open && !props.noPreview && previewUrl ? (
        <PreviewModal
          title={props.filename}
          src={previewUrl}
          downloadUrl={downloadUrl}
          mime={props.mime}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

/* --------------------------- Glyphs --------------------------- */

function FileGlyph(): React.JSX.Element {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

function DownloadGlyph(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 4v12" />
      <path d="M6 12l6 6 6-6" />
      <path d="M4 20h16" />
    </svg>
  );
}

/* --------------------------- Preview Modal --------------------------- */

interface PreviewModalProps {
  title: string;
  src: string;
  downloadUrl?: string;
  mime: string;
  onClose: () => void;
}

function PreviewModal({
  title,
  src,
  downloadUrl,
  mime,
  onClose,
}: PreviewModalProps): React.JSX.Element {
  // Esc-Key schließt — Standard-A11y.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Vorschau ${title}`}
      style={modalBackdropStyle}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={modalPanelStyle}>
        <div style={modalHeadStyle}>
          <div style={modalTitleStyle}>{title}</div>
          <div style={modalHeadActionsStyle}>
            <a
              href={src}
              target="_blank"
              rel="noopener noreferrer"
              style={modalBtnStyle}
              title="Im neuen Tab öffnen"
            >
              Neuer Tab
            </a>
            {downloadUrl ? (
              <button
                type="button"
                onClick={() => {
                  void triggerDownload(downloadUrl, title);
                }}
                style={modalBtnStyle}
                title="Speichern"
              >
                Download
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              style={modalCloseStyle}
              aria-label="Schließen"
            >
              <CloseGlyph />
            </button>
          </div>
        </div>
        <div style={modalBodyStyle}>
          {mime === 'application/pdf' ? (
            <object
              data={src}
              type="application/pdf"
              style={modalFrameStyle}
              aria-label={title}
            >
              <embed src={src} type="application/pdf" style={modalFrameStyle} />
              <div style={modalFallbackStyle}>
                Dein Browser zeigt PDFs nicht inline an.{' '}
                <a
                  href={src}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={modalBtnStyle}
                >
                  Im neuen Tab öffnen
                </a>
              </div>
            </object>
          ) : mime.startsWith('image/') ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt={title} style={modalImgStyle} />
          ) : (
            <div style={modalFallbackStyle}>
              Vorschau für {mime} nicht verfügbar.{' '}
              {downloadUrl ? (
                <button
                  type="button"
                  onClick={() => {
                    void triggerDownload(downloadUrl, title);
                  }}
                  style={modalBtnStyle}
                >
                  Download
                </button>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CloseGlyph(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/* --------------------------- Styles (Manifest v1.0 tokens) --------------------------- */

const TRANSITION = 'background 240ms cubic-bezier(0.16, 1, 0.3, 1), border-color 240ms cubic-bezier(0.16, 1, 0.3, 1)';

// ----- Image bubble -----
const imageWrapStyle: CSSProperties = {
  display: 'inline-block',
  maxWidth: 'min(320px, 100%)',
};

const imageButtonStyle: CSSProperties = {
  appearance: 'none',
  border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
  padding: 0,
  margin: 0,
  cursor: 'zoom-in',
  display: 'block',
  position: 'relative',
  borderRadius: 16,
  overflow: 'hidden',
  background: 'var(--sheet-2, #0E0E0F)',
  lineHeight: 0,
  width: '100%',
};

const imageCoverStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  height: 'auto',
  maxHeight: 360,
  objectFit: 'cover',
};

const imageMetaOverlayStyle: CSSProperties = {
  position: 'absolute',
  right: 8,
  bottom: 8,
  padding: '3px 8px',
  borderRadius: 10,
  fontSize: 11,
  fontFamily: 'var(--font-mono, ui-monospace)',
  fontWeight: 600,
  letterSpacing: '0.02em',
  color: 'var(--ink, #F5F5F7)',
  background: 'color-mix(in oklab, var(--sheet, #070707) 62%, transparent)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  pointerEvents: 'none',
};

// ----- File card -----
const cardStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  maxWidth: 'min(380px, 100%)',
  padding: 8,
  borderRadius: 14,
  background: 'var(--sheet-2, #0E0E0F)',
  border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
};

const cardBodyStyle: CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  flex: 1,
  minWidth: 0,
  padding: 4,
  borderRadius: 10,
  textAlign: 'left',
  color: 'var(--ink, #F5F5F7)',
  transition: TRANSITION,
};

const iconTileStyle: CSSProperties = {
  flexShrink: 0,
  width: 44,
  height: 44,
  borderRadius: 10,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 1,
  background: 'color-mix(in oklab, var(--a-now, #C9FF4D) 12%, transparent)',
  color: 'var(--a-now, #C9FF4D)',
};

const iconExtStyle: CSSProperties = {
  fontSize: 8,
  fontFamily: 'var(--font-mono, ui-monospace)',
  fontWeight: 700,
  letterSpacing: '0.06em',
};

const cardMetaStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
  flex: 1,
};

const filenameStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
  color: 'var(--ink, #F5F5F7)',
  fontFamily: 'var(--font-sans, system-ui)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const subStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--ink-3, #636366)',
  fontFamily: 'var(--font-mono, ui-monospace)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const wsStyle: CSSProperties = {
  color: 'var(--ink-2, #A1A1A6)',
};

const downloadBtnStyle: CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  flexShrink: 0,
  width: 36,
  height: 36,
  borderRadius: 9,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--ink-2, #A1A1A6)',
  transition: TRANSITION,
};

// ----- Modal / Lightbox -----
const modalBackdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 200,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 'max(16px, env(safe-area-inset-top)) 16px',
  background: 'color-mix(in oklab, var(--sheet, #070707) 86%, transparent)',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
};

const modalPanelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: 'min(920px, 100%)',
  maxHeight: '90vh',
  borderRadius: 18,
  overflow: 'hidden',
  background: 'var(--sheet-2, #0E0E0F)',
  border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
  boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
};

const modalHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '12px 14px',
  borderBottom: '0.5px solid var(--line, rgba(255,255,255,0.06))',
};

const modalTitleStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--ink, #F5F5F7)',
  fontFamily: 'var(--font-sans, system-ui)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  minWidth: 0,
};

const modalHeadActionsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexShrink: 0,
};

const modalBtnStyle: CSSProperties = {
  appearance: 'none',
  cursor: 'pointer',
  textDecoration: 'none',
  fontSize: 12,
  fontWeight: 500,
  padding: '6px 10px',
  borderRadius: 8,
  color: 'var(--ink-2, #A1A1A6)',
  background: 'transparent',
  border: '0.5px solid var(--line-2, rgba(255,255,255,0.12))',
  fontFamily: 'var(--font-sans, system-ui)',
  transition: TRANSITION,
};

const modalCloseStyle: CSSProperties = {
  appearance: 'none',
  cursor: 'pointer',
  width: 30,
  height: 30,
  borderRadius: 8,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--ink-2, #A1A1A6)',
  background: 'transparent',
  border: 'none',
};

const modalBodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'auto',
  background: 'var(--sheet, #070707)',
};

const modalFrameStyle: CSSProperties = {
  width: '100%',
  height: '80vh',
  border: 'none',
};

const modalImgStyle: CSSProperties = {
  maxWidth: '100%',
  maxHeight: '90vh',
  objectFit: 'contain',
  display: 'block',
};

const modalFallbackStyle: CSSProperties = {
  padding: 32,
  fontSize: 13,
  color: 'var(--ink-2, #A1A1A6)',
  fontFamily: 'var(--font-sans, system-ui)',
  textAlign: 'center',
};
