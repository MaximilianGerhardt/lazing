'use client';

import type { ReactNode } from 'react';

export type PillVariant =
  | 'north'
  | 'clientb'
  | 'own'
  | 'private'
  | 'claude'
  | 'codex'
  | 'error';

export interface PillProps {
  /** Visual variant. Defaults to 'north' (primary bank context). */
  variant?: PillVariant;
  /** Visible content, typically the context label. */
  children: ReactNode;
  /**
   * When provided, the pill renders as an interactive <button> with a
   * focus-visible ring. When omitted, the pill is a semantically inert
   * <span> — a mere status indicator.
   */
  onClick?: () => void;
  /** Extra className appended after the variant class. */
  className?: string;
  /**
   * Accessible label. Required conceptually for the interactive variant;
   * when absent we fall back to the rendered children.
   */
  ariaLabel?: string;
}

const VARIANT_CLASS: Record<PillVariant, string> = {
  north: 'pill',
  clientb: 'pill mu',
  own: 'pill ow',
  private: 'pill pr',
  claude: 'pill cl',
  codex: 'pill cx',
  error: 'pill err',
};

function classNames(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * PIL-01 Context Pill.
 *
 * Seven color variants map 1:1 to the CSS classes in `app/components.css`
 * (section G · PIL). Static pills render as <span>; providing `onClick`
 * promotes the element to a proper <button> with keyboard semantics and
 * a focus-visible ring — no synthesised role, no tabindex hacks.
 */
export function Pill({
  variant = 'north',
  children,
  onClick,
  className,
  ariaLabel,
}: PillProps): React.JSX.Element {
  const variantClass = VARIANT_CLASS[variant];
  const merged = classNames(variantClass, className);

  if (onClick) {
    return (
      <button
        type="button"
        className={merged}
        onClick={onClick}
        aria-label={ariaLabel}
      >
        {children}
      </button>
    );
  }

  // Static pill: ambient status marker. No interactive semantics —
  // screen readers will read the text content. `aria-label` is applied
  // only if the consumer explicitly supplied one.
  return (
    <span className={merged} aria-label={ariaLabel}>
      {children}
    </span>
  );
}

export default Pill;
