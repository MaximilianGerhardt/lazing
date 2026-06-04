/**
 * Monochrome inline SVG icons for the primary nav.
 *
 * Sized via CSS `currentColor` — stroke/fill inherit, so a single file
 * per icon covers every accent-scope. Using SVG (not unicode) to keep
 * the visual weight consistent across Windows/Android/macOS renderers
 * and to support fine stroke-widths the glyph font cannot deliver.
 */

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

export function IconHamburger({
  size = 20,
  className,
}: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h10" />
    </svg>
  );
}

/**
 * IconClose — iOS-style "xmark.circle.fill": filled X-circle with a
 * subtle-grey background. On iOS-native (UIKit/SwiftUI) this is the
 * default gesture for modal dismiss. We use var(--sheet-3) for the
 * background (fits dark+light) and var(--ink-2) for the X.
 */
export function IconClose({
  size = 20,
  className,
}: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable={false}
    >
      <circle cx="12" cy="12" r="11" fill="var(--sheet-3)" />
      <path
        d="M8 8 L16 16 M16 8 L8 16"
        stroke="var(--ink-2)"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

export function IconTerminal({
  size = 18,
  className,
}: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3" />
      <path d="M13 15h4" />
    </svg>
  );
}

export function IconGear({
  size = 18,
  className,
}: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

export function IconChevronDown({
  size = 14,
  className,
}: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/**
 * Overflow — three horizontal dots (Apple "more" / ellipsis.circle).
 * Introduced 2026-05-30 (top-bar reduction): carries the desktop ••• menu
 * with all secondary actions, so the bar shows only 3-4 primary targets +
 * 1 health dot. Filled dots (fill) instead of stroke, because ••• at a
 * 1.6px stroke looks visually too thin on pitch-black.
 */
export function IconOverflow({
  size = 18,
  className,
}: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      focusable={false}
    >
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}

export function IconChevronRight({
  size = 14,
  className,
}: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/**
 * Apple-SF-Symbol-Style Nav-Icons (2026-04-30, Sub-Plan Polish-Fix).
 * Alle SVG, currentColor, 1.6 stroke. KEINE Unicode-Glyphs mehr — die
 * brachen das Apple-Pure-Design auf Mobile.
 */

// chat — bubble.left
export function IconChat({
  size = 18,
  className,
}: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <path d="M21 11.5a8.4 8.4 0 0 1-3.9 7.1L17 21l-3.5-2.2a8.5 8.5 0 1 1 7.5-7.3z" />
    </svg>
  );
}

// inbox — tray
export function IconInbox({
  size = 18,
  className,
}: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <path d="M3 13l2.5-7h13L21 13" />
      <path d="M3 13v6a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6" />
      <path d="M3 13h5l1.5 2h5L16 13h5" />
    </svg>
  );
}

// workstreams — flow / square.stack.3d.up
export function IconWorkstreams({
  size = 18,
  className,
}: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
    </svg>
  );
}

// tickets — text.alignleft / list.bullet.rectangle
export function IconTickets({
  size = 18,
  className,
}: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9h10" />
      <path d="M7 13h10" />
      <path d="M7 17h6" />
    </svg>
  );
}

// orgs active — circle
export function IconOrgActive({
  size = 18,
  className,
}: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
    </svg>
  );
}

// orgs manage — rectangle.grid.2x2
export function IconOrgManage({
  size = 18,
  className,
}: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
    </svg>
  );
}

// skills — sparkles
export function IconSkills({
  size = 18,
  className,
}: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <path d="M12 3v4" />
      <path d="M12 17v4" />
      <path d="M5 12H3" />
      <path d="M21 12h-2" />
      <path d="M7 7l-2-2" />
      <path d="M19 19l-2-2" />
      <path d="M7 17l-2 2" />
      <path d="M19 5l-2 2" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

// sessions — play.circle
export function IconSessions({
  size = 18,
  className,
}: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.5v7L16 12z" fill="currentColor" stroke="none" />
    </svg>
  );
}

// routines — arrow.triangle.2.circlepath
export function IconRoutines({
  size = 18,
  className,
}: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

// observatory — heart (Heartbeat-Status)
export function IconObservatory({
  size = 18,
  className,
}: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <path d="M12 21s-7-4.5-9.5-9A5 5 0 0 1 12 6a5 5 0 0 1 9.5 6c-2.5 4.5-9.5 9-9.5 9z" />
    </svg>
  );
}

// calendar — calendar
export function IconCalendar({
  size = 18,
  className,
}: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
      <path d="M8 3v4" />
      <path d="M16 3v4" />
    </svg>
  );
}

// how — questionmark.circle
export function IconHow({
  size = 18,
  className,
}: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 1 1 3.7 2.2c-0.7 0.4-1.2 1-1.2 1.8v0.5" />
      <circle cx="12" cy="17" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * P4-SPINE (2026-06-02): two glyph replacements for the OrgSwitcher scope
 * spine. Both match BASE_PROPS (24×24 viewBox, currentColor, 1.6 stroke,
 * round caps). They replace the last two unicode-as-UI characters in the
 * Kunde popover (the "" check + the "└" branch elbow) — same reasoning as
 * the 2026-04-30 nav-icon sweep: glyph fonts render inconsistently across
 * renderers and cannot deliver the fine stroke the Apple-pure design wants.
 */

// check — current-row affordance (replaces the "" glyph). Default 14 to
// match the row text; inherits currentColor (the row sets var(--a-now)).
export function IconCheck({
  size = 14,
  className,
}: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <path d="M5 12.5l4 4 10-10" />
    </svg>
  );
}

// subtree / child indicator — quiet corner-elbow (replaces the "└" glyph).
// Decorative-only (aria-hidden inherited from BASE_PROPS); default size 12 so
// it reads smaller than the row text. NOT a chevron — a branch elbow that
// says "nested under the row above".
export function IconSubtree({
  size = 12,
  className,
}: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <path d="M8 4v8.5a3 3 0 0 0 3 3h5" />
    </svg>
  );
}

/** IconLayers — gestapelte Ebenen (Design-Library / Token & Komponenten). */
export function IconLayers({
  size = 18,
  className,
}: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...BASE_PROPS}>
      <path d="M12 3 3 8l9 5 9-5-9-5z" />
      <path d="M3 13l9 5 9-5" />
    </svg>
  );
}

/**
 * Monogrammed "L" wordmark-mark — the first letter of lazyOS as a
 * rounded block that carries the ambient accent-glow. Sits to the left
 * of the "lazyOS" wordmark.
 */
export function LazyMark({
  size = 22,
  className,
}: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable={false}
    >
      <rect
        x="2"
        y="2"
        width="20"
        height="20"
        rx="6"
        fill="currentColor"
        opacity="0.14"
      />
      <rect
        x="2"
        y="2"
        width="20"
        height="20"
        rx="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        opacity="0.35"
      />
      <path
        d="M8 6.5v11h8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
