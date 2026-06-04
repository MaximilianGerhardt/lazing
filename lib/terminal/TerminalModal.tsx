'use client';

/**
 * TerminalModal — Vollbild-Modal mit ttyd-Iframe pro Workspace.
 *
 * Architektur (2026-04-25 Re-Pivot von xterm.js → ttyd):
 *
 *   Browser PWA  ──cookie──>  Next.js (CF-Tunnel)
 *                                │
 *                                │  rewrite /terminal/* → http://127.0.0.1:4203/terminal/*
 *                                ▼
 *                         lazyos-ttyd.service (Port 4203)
 *                                │
 *                                │  exec lazyos-ttyd-launch.sh ?ws=<id>
 *                                ▼
 *                         tmux attach lazyos-ws-<workspaceId>
 *
 * Vorteile gegenueber dem alten xterm.js-Setup:
 *   - Voller WebSocket-Bidirectional-Stream — kein Polling mehr
 *   - Mobile-Tastatur funktioniert sauber (ttyd kennt iOS/Android-Quirks)
 *   - Copy-Paste, Maus-Selection, Resize alles eingebaut
 *   - tmux-Multiplex bleibt erhalten (mehrere Verbindungen sehen die gleiche Pane)
 *
 * Esc oder Klick außerhalb schließt das Modal (Esc innerhalb des Iframes
 * wird vom Terminal selbst gefangen und nicht propagiert).
 */

import { useEffect, useRef, type CSSProperties } from 'react';

import { IconClose } from '@/lib/nav/icons';

interface Props {
  workspaceId: string;
  workspaceLabel: string;
  onClose: () => void;
  /**
   * Optional: direktes tmux-Session-Target. Hat Priorität über workspaceId
   * im launch-Skript (siehe `?session=`-Pfad in lazyos-ttyd-launch.sh).
   * Use-Case: "Terminal-Claude live" attached an `main`, wo der CLI-Agent
   * läuft, statt an die Workspace-Default-Session.
   */
  sessionName?: string;
  /**
   * Optional: read-only Mode (nur in Kombination mit sessionName).
   * Verhindert versehentliches Mit-Tippen während ein Agent arbeitet.
   * Default false → User kann mit-tippen.
   */
  readOnly?: boolean;
}

export function TerminalModal({
  workspaceId,
  workspaceLabel,
  onClose,
  sessionName,
  readOnly,
}: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Esc von ausserhalb schliesst (innerhalb des Iframes wird Esc nicht hierher
  // propagiert — geht direkt in den Terminal-Buffer).
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // ttyd-URL: same-origin via /terminal-Rewrite (next.config.ts).
  // session= hat Priorität über ws= im launch-Skript.
  const src = sessionName
    ? `/terminal/?session=${encodeURIComponent(sessionName)}${readOnly ? '&ro=1' : ''}`
    : `/terminal/?ws=${encodeURIComponent(workspaceId)}`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Terminal"
      style={backdropStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={frameStyle} onClick={(e) => e.stopPropagation()}>
        <header style={headerStyle}>
          <span style={titleStyle}>
            <span aria-hidden style={dotStyle()} />{' '}
            {sessionName
              ? `Terminal · ${sessionName}`
              : `Terminal · ${workspaceLabel}`}
            {readOnly ? (
              <span
                aria-label="Read-Only"
                style={{
                  marginLeft: 8,
                  padding: '1px 6px',
                  borderRadius: 4,
                  fontSize: 10,
                  letterSpacing: 0.5,
                  background: 'var(--sheet-2)',
                  color: 'var(--ink-3)',
                  border: '0.5px solid var(--line-2)',
                }}
              >
                RO
              </span>
            ) : null}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Terminal schließen"
            style={closeBtnStyle}
          >
            <IconClose size={18} />
          </button>
        </header>
        <iframe
          ref={iframeRef}
          src={src}
          title={
            sessionName
              ? `Terminal · ${sessionName}`
              : `Terminal · ${workspaceLabel}`
          }
          style={iframeStyle}
          // ttyd needs same-origin postMessage + scripts. allow-forms damit
          // Login-Token-Submits durchgehen. NICHT allow-top-navigation, sonst
          // koennte das Iframe das PWA wegnavigieren.
          sandbox="allow-scripts allow-same-origin allow-forms allow-clipboard-write allow-clipboard-read"
        />
      </div>
    </div>
  );
}

const backdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'color-mix(in oklab, var(--sheet) 85%, transparent)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  zIndex: 100,
  display: 'flex',
  alignItems: 'stretch',
  justifyContent: 'stretch',
  // 2026-04-26: safe-area-inset fuer iOS-PWA-Notch.
  // Vorher: clamp(12px,...) — Header verschwand hinter der Notch,
  // Close-Button war nicht erreichbar.
  paddingTop: 'max(env(safe-area-inset-top), clamp(12px, 3vw, 28px))',
  paddingRight: 'max(env(safe-area-inset-right), clamp(12px, 3vw, 28px))',
  paddingBottom: 'max(env(safe-area-inset-bottom), clamp(12px, 3vw, 28px))',
  paddingLeft: 'max(env(safe-area-inset-left), clamp(12px, 3vw, 28px))',
};

const frameStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  borderRadius: 14,
  background: 'var(--sheet)',
  border: '0.5px solid var(--line-2)',
  boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
  overflow: 'hidden',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '10px 14px',
  borderBottom: '0.5px solid var(--line-2)',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--ink-2)',
  background: 'color-mix(in oklab, var(--sheet-2) 85%, transparent)',
};

const titleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

function dotStyle(): CSSProperties {
  return {
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: 'var(--a-now)',
    boxShadow: '0 0 6px var(--a-now)',
  };
}

const closeBtnStyle: CSSProperties = {
  background: 'var(--sheet-2)',
  border: '0.5px solid var(--line-2)',
  color: 'var(--ink-2)',
  cursor: 'pointer',
  // Min 44×44 fuer iOS-Tap-Target (Apple HIG)
  minWidth: 44,
  minHeight: 44,
  padding: 8,
  borderRadius: 8,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};

const iframeStyle: CSSProperties = {
  flex: 1,
  width: '100%',
  border: 'none',
  background: 'var(--sheet)',
  minHeight: 0,
};
