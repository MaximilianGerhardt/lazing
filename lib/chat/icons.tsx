/**
 * Monochrome icons used inside chat tool-cards.
 *
 * Same visual language as `lib/nav/icons.tsx`: 1.6 stroke, rounded,
 * `currentColor` so they inherit the accent from the parent.
 */

import type { JSX } from 'react';

interface IconProps {
  size?: number;
  className?: string;
}

const BASE_PROPS = {
  xmlns: 'http://www.w3.org/2000/svg' as const,
  fill: 'none' as const,
  viewBox: '0 0 24 24' as const,
  stroke: 'currentColor' as const,
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
  focusable: false as const,
};

export function IconFile({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

export function IconFilePen({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
      <path d="M14 3v5h5" />
      <path d="M18 13l4 4-4 4h-4v-4z" />
    </svg>
  );
}

export function IconTerminal({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <path d="M4 6l4 6-4 6" />
      <path d="M12 18h8" />
    </svg>
  );
}

export function IconSearch({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}

export function IconGlobe({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a13 13 0 0 1 0 18" />
      <path d="M12 3a13 13 0 0 0 0 18" />
    </svg>
  );
}

export function IconWrench({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <path d="M14.7 6.3a3.5 3.5 0 0 1 4.6 4.6l-2.5-.6-1.5 1.5.6 2.5a3.5 3.5 0 0 1-4.6-4.6l2.5.6 1.5-1.5z" />
      <path d="M7 11l-4 4a2 2 0 1 0 3 3l4-4" />
    </svg>
  );
}

export function IconCheck({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <path d="M5 12l4 4 10-10" />
    </svg>
  );
}

export function IconX({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <path d="M6 6l12 12" />
      <path d="M18 6l-12 12" />
    </svg>
  );
}

export function IconShield({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <path d="M12 3l8 3v6a9 9 0 0 1-8 9 9 9 0 0 1-8-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

export function IconChevronDown({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function IconMic({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
      <path d="M8 21h8" />
    </svg>
  );
}

export function IconMicActive({ size = 16, className }: IconProps): JSX.Element {
  // Active-State: 3 animierte Audio-Bars statt Mikro. Sofort sichtbar
  // dass aufgenommen wird. Animation kommt aus .lazyos-mic-bar CSS.
  return (
    <svg
      width={size}
      height={size}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable={false}
    >
      <rect className="lazyos-mic-bar lazyos-mic-bar--1" x="4" y="9" width="3" height="6" rx="1.5" />
      <rect className="lazyos-mic-bar lazyos-mic-bar--2" x="10.5" y="5" width="3" height="14" rx="1.5" />
      <rect className="lazyos-mic-bar lazyos-mic-bar--3" x="17" y="9" width="3" height="6" rx="1.5" />
    </svg>
  );
}

export function IconPaperclip({ size = 18, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <path d="M21.4 11.6 12 21a5.5 5.5 0 0 1-7.8-7.8l9.4-9.4a3.5 3.5 0 0 1 5 5L9.2 18.2a1.5 1.5 0 0 1-2.1-2.1L16 7.2" />
    </svg>
  );
}

export function IconPlus({ size = 18, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

export function IconImage({ size = 18, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="M21 16l-5-5-6 6" />
    </svg>
  );
}

export function IconCamera({ size = 18, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <path d="M4 8a2 2 0 0 1 2-2h1.5l1-2h5l1 2H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

export function IconArrowUp({ size = 16, className }: IconProps): JSX.Element {
  // Apple-Messages-style send-arrow: clean, rounded.
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </svg>
  );
}

export function IconSpinner({ size = 14, className }: IconProps): JSX.Element {
  // Animation driven by the caller (keyframes `lazyos-spin`, see ToolStepCard).
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable={false}
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeOpacity="0.2"
        strokeWidth="1.6"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Dispatch tool-name → icon. Names come from Claude Code CLI:
 * Read, Write, Edit, Bash, Grep, Glob, WebFetch, WebSearch, Task, …
 */
export function iconForTool(name: string): (p: IconProps) => JSX.Element {
  const n = name.toLowerCase();
  if (n === 'read') return IconFile;
  if (n === 'write' || n === 'edit' || n === 'multiedit') return IconFilePen;
  if (n === 'bash' || n === 'shell' || n === 'terminal') return IconTerminal;
  if (n === 'grep' || n === 'glob' || n === 'search') return IconSearch;
  if (n === 'webfetch' || n === 'websearch' || n === 'fetch') return IconGlobe;
  return IconWrench;
}
