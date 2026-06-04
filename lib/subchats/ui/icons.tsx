/**
 * Sub-chat messenger icons — plain SVG glyphs (currentColor, 1.8px stroke,
 * close to Apple/SF Symbols). NO emojis (owner directive 2026-06-02).
 * Shared by the external + internal sub-chat view.
 */

import type { CSSProperties } from 'react';

interface IconProps {
  size?: number;
  style?: CSSProperties;
}

function svgProps(size: number, style?: CSSProperties) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    style,
  };
}

export function IconBack({ size = 24, style }: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(size, style)}>
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

export function IconSend({ size = 20, style }: IconProps): React.JSX.Element {
  // Upward arrow (composer send, Codex/iMessage style).
  return (
    <svg {...svgProps(size, style)}>
      <path d="M12 19V5" />
      <path d="M6 11l6-6 6 6" />
    </svg>
  );
}

export function IconAttach({ size = 22, style }: IconProps): React.JSX.Element {
  // Paperclip.
  return (
    <svg {...svgProps(size, style)}>
      <path d="M21.44 11.05l-8.49 8.49a5 5 0 0 1-7.07-7.07l8.49-8.49a3.5 3.5 0 0 1 4.95 4.95l-8.49 8.49a2 2 0 0 1-2.83-2.83l7.78-7.78" />
    </svg>
  );
}

export function IconFile({ size = 22, style }: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(size, style)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

export function IconDownload({ size = 18, style }: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(size, style)}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  );
}

export function IconClose({ size = 16, style }: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(size, style)}>
      <path d="M18 6L6 18" />
      <path d="M6 6l12 12" />
    </svg>
  );
}

export function IconCamera({ size = 22, style }: IconProps): React.JSX.Element {
  // Camera body + lens + viewfinder bump (photo capture).
  return (
    <svg {...svgProps(size, style)}>
      <path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L19 6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

export function IconImage({ size = 22, style }: IconProps): React.JSX.Element {
  // Gallery/photo frame (media library).
  return (
    <svg {...svgProps(size, style)}>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="9" cy="9" r="2" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}

export function IconMic({ size = 22, style }: IconProps): React.JSX.Element {
  // Microphone capsule + stand (voice dictation).
  return (
    <svg {...svgProps(size, style)}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

export function IconStop({ size = 18, style }: IconProps): React.JSX.Element {
  // Filled square = stop recording (release push-to-record / cancel affordance).
  return (
    <svg {...svgProps(size, style)}>
      <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconPlay({ size = 18, style }: IconProps): React.JSX.Element {
  // Play triangle (audio player start).
  return (
    <svg {...svgProps(size, style)}>
      <path d="M8 5.5l11 6.5-11 6.5z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconPause({ size = 18, style }: IconProps): React.JSX.Element {
  // Pause (audio player pause).
  return (
    <svg {...svgProps(size, style)}>
      <rect x="7" y="5" width="3.5" height="14" rx="1.2" fill="currentColor" stroke="none" />
      <rect x="13.5" y="5" width="3.5" height="14" rx="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconZoomOut({ size = 20, style }: IconProps): React.JSX.Element {
  // Magnifier with minus (lightbox zoom-out; optional affordance).
  return (
    <svg {...svgProps(size, style)}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
      <path d="M8 11h6" />
    </svg>
  );
}

export function IconCheck({ size = 14, style }: IconProps): React.JSX.Element {
  // Single check = delivered/sent.
  return (
    <svg {...svgProps(size, style)}>
      <path d="M5 12.5l4.2 4.2L19 7" />
    </svg>
  );
}

export function IconCheckDouble({ size = 16, style }: IconProps): React.JSX.Element {
  // Double check = read. Two offset checks (WhatsApp standard).
  return (
    <svg {...svgProps(size, style)}>
      <path d="M2 12.5l4 4L14.5 8" />
      <path d="M9 16.5l1 1L22 6" />
    </svg>
  );
}
