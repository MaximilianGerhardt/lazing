'use client';

import type { CSSProperties, ReactNode } from 'react';

export interface HeartbeatPulseProps {
  /** Primary value rendered at the core. Usually a small integer. */
  count: number | string;
  /** Tiny uppercase descriptor rendered under the count. */
  label?: string;
  /**
   * Square dimension in px. Defaults to 120 to match the canonical CSS,
   * but consumers can scale the pulse for denser dashboards.
   */
  size?: number;
  /**
   * Accessible label. HBT is a visual-only live indicator — screen
   * readers need a verbal equivalent (e.g. "8 Projekte aktiv"). When
   * omitted we fall back to a composition of count + label.
   */
  ariaLabel?: string;
  /** Extra className appended after `pulse-core`. */
  className?: string;
}

function classNames(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * HBT-01 Heartbeat Pulse.
 *
 * Radial gradient core with two expanding ripple rings driven entirely
 * by CSS (section L of `app/components.css`). Rendered as a live
 * `role="status"` region so assistive tech can announce the current
 * count — the visual beat alone would be inaccessible.
 */
export function HeartbeatPulse({
  count,
  label,
  size = 120,
  ariaLabel,
  className,
}: HeartbeatPulseProps): React.JSX.Element {
  // Default accessible label composition: "<count> <label>" — this is a
  // sensible fallback but the consumer is strongly encouraged to pass
  // a project-specific phrasing via `ariaLabel`.
  const resolvedAriaLabel =
    ariaLabel ?? (label ? `${count} ${label}` : `${count}`);

  // The canonical CSS hardcodes 120px — only emit an inline style when
  // the consumer wants a different dimension, keeping the DOM clean.
  const style: CSSProperties | undefined =
    size === 120
      ? undefined
      : { width: `${size}px`, height: `${size}px` };

  const smallNode: ReactNode = label ? <small>{label}</small> : null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={resolvedAriaLabel}
      className={classNames('pulse-core', className)}
      style={style}
    >
      <div className="inner">
        {count}
        {smallNode}
      </div>
    </div>
  );
}

export default HeartbeatPulse;
