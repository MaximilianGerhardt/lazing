import * as React from 'react';

export type TeammateVariant = 'lead' | 'standard' | 'add';

export type TeammateStatusVariant = 'live' | 'idle' | 'eta';

export interface TeammateStats {
  /**
   * Counter line, e.g. "12 Checks heute".
   * If the string starts with a number token (digits optionally separated by
   * spaces / non-breaking spaces / dots) that leading number is wrapped in
   * <b> to match the CSS (`.tm .stt b { color: var(--ink); }`).
   */
  counter?: string;
  /** Status label, e.g. "läuft", "ready", "~ 2 min". */
  status?: string;
  /**
   * 'live' → green pulse dot (class `liv`)
   * 'idle' → neutral dim label
   * 'eta'  → dim monospace ETA label
   * Default: 'idle'.
   */
  statusVariant?: TeammateStatusVariant;
}

export interface TeammateProps {
  variant?: TeammateVariant;
  /** Avatar glyph — single symbol ("︎") or initials ("AR"). */
  avatarGlyph?: string;
  /** When true, paints the avatar glyph with --a-now (class `.av.n`). */
  avatarAccent?: boolean;
  /** Primary name / headline, e.g. "Lena K. · Legal". */
  name?: string;
  /** Secondary role / discipline line. */
  role?: string;
  /** Short tag chips (renders via <i>). */
  tags?: string[];
  /** Optional counter + status footer. */
  stats?: TeammateStats;
  /** When set, the card renders as a <button> and forwards clicks. */
  onClick?: () => void;
  className?: string;
}

function classNames(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * Split a counter string so the leading numeric token gets wrapped in <b>.
 * Example: "12 Checks heute" → ["12", " Checks heute"]
 *          "1 234 Leads"     → ["1 234", " Leads"]
 *          "Marketplace · 9" → [null, "Marketplace · 9"] (no leading number)
 *
 * SSR-safe: no DOM / window access.
 */
function splitLeadingNumber(value: string): {
  numeric: string | null;
  rest: string;
} {
  // Leading digits, possibly grouped by ' ', ' ' (U+00A0), ',' or '.'.
  const match = value.match(/^(\d[\d\u00A0 .,]*?\d|\d)(\s*)(.*)$/u);
  if (!match) return { numeric: null, rest: value };
  const [, numeric, gap, rest] = match;
  return { numeric, rest: `${gap}${rest}` };
}

function CounterLine({ counter }: { counter: string }): React.JSX.Element {
  const { numeric, rest } = splitLeadingNumber(counter);
  if (numeric === null) {
    return <span>{counter}</span>;
  }
  return (
    <span>
      <b>{numeric}</b>
      {rest}
    </span>
  );
}

/**
 * TMC-01 Teammate Card.
 *
 * Three variants:
 *  - 'standard' (default) — plain teammate tile
 *  - 'lead'               — highlighted hero tile (subtle --a-now wash)
 *  - 'add'                — dashed "add skill" tile
 *
 * Semantics:
 *  - Non-clickable card → <article>.
 *  - Clickable card (onClick set) → <button type="button"> with card styling,
 *    so keyboard activation (Enter / Space) works natively. We keep the
 *    `.tm` / `.tm.lead` / `.tm.add` classes on the button — CSS targets the
 *    class, not the element.
 */
export function Teammate({
  variant = 'standard',
  avatarGlyph,
  avatarAccent = false,
  name,
  role,
  tags,
  stats,
  onClick,
  className,
}: TeammateProps): React.JSX.Element {
  const variantClass =
    variant === 'lead' ? 'lead' : variant === 'add' ? 'add' : null;

  const rootClass = classNames('tm', variantClass, className);

  const avatar =
    avatarGlyph !== undefined ? (
      <div
        className={classNames('av', avatarAccent && 'n')}
        aria-hidden="true"
      >
        {avatarGlyph}
      </div>
    ) : null;

  const nameNode = name ? <div className="nm">{name}</div> : null;
  const roleNode = role ? <div className="ro">{role}</div> : null;

  const tagsNode =
    tags && tags.length > 0 ? (
      <div className="tags">
        {tags.map((tag, index) => (
          // Tags are typically short codes like "§25a"; if the caller passes
          // duplicates we still need a stable key, so combine value+index.
          <i key={`${tag}-${index}`}>{tag}</i>
        ))}
      </div>
    ) : null;

  const statsNode = (() => {
    if (!stats) return null;
    const { counter, status, statusVariant = 'idle' } = stats;
    if (!counter && !status) return null;

    return (
      <div className="stt">
        {counter ? <CounterLine counter={counter} /> : <span />}
        {status ? (
          <span className={classNames(statusVariant === 'live' && 'liv')}>
            {status}
          </span>
        ) : null}
      </div>
    );
  })();

  const children = (
    <>
      {avatar}
      {nameNode}
      {roleNode}
      {tagsNode}
      {statsNode}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={rootClass}
        onClick={onClick}
        // aria-label fallback for cards that are purely glyph/icon (add-tile).
        aria-label={name ?? (variant === 'add' ? 'Skill hinzufügen' : undefined)}
      >
        {children}
      </button>
    );
  }

  return <article className={rootClass}>{children}</article>;
}

export default Teammate;
