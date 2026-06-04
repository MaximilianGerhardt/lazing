'use client';

import { useEffect, useRef } from 'react';

export type ToastVariant = 'default' | 'ok' | 'warn' | 'err';

export interface ToastProps {
  /** Semantic variant — maps to the `.ok`, `.warn`, `.err` CSS modifiers. */
  variant?: ToastVariant;
  /** Bold title line. Required. */
  title: string;
  /** Optional secondary line (dimmer, line-height 1.35). */
  body?: string;
  /** Glyph rendered in the square icon slot. Defaults to "L" (lazyOS). */
  iconGlyph?: string;
  /**
   * Called when the toast wants to disappear (auto-hide timer fires,
   * or a close affordance is activated). Parent owns the list state.
   */
  onDismiss?: () => void;
  /**
   * When set, schedule a dismissal after N ms. Cleared on unmount so
   * we never touch state after the component is gone.
   */
  autoHideMs?: number;
  /** Extra className appended after the variant classes. */
  className?: string;
}

const VARIANT_CLASS: Record<ToastVariant, string> = {
  default: 'toast',
  ok: 'toast ok',
  warn: 'toast warn',
  err: 'toast err',
};

function classNames(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * TST-01 Notification Toast.
 *
 * Glass-morphic toast card with icon + title + optional body. Uses
 * `role="alert"` for `err` / `warn` (assertive announcement) and
 * `role="status"` for `default` / `ok` (polite announcement) — this
 * matches the actual urgency rather than flooding screen readers with
 * routine confirmations.
 *
 * Styling is section O of `app/components.css`. Auto-hide is handled
 * locally; the parent (usually `ToastStack`) only needs to drop the
 * entry from its list when `onDismiss` fires.
 */
export function Toast({
  variant = 'default',
  title,
  body,
  iconGlyph = 'L',
  onDismiss,
  autoHideMs,
  className,
}: ToastProps): React.JSX.Element {
  // Track the latest onDismiss in a ref so the effect below doesn't
  // restart its timer every time the parent passes a fresh closure.
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!autoHideMs || autoHideMs <= 0) return;
    const handle = window.setTimeout(() => {
      dismissRef.current?.();
    }, autoHideMs);
    return () => window.clearTimeout(handle);
  }, [autoHideMs]);

  const isUrgent = variant === 'err' || variant === 'warn';

  return (
    <div
      role={isUrgent ? 'alert' : 'status'}
      aria-live={isUrgent ? 'assertive' : 'polite'}
      aria-atomic="true"
      className={classNames(VARIANT_CLASS[variant], className)}
    >
      <div className="ic" aria-hidden="true">
        {iconGlyph}
      </div>
      <div className="b">
        <div className="t">{title}</div>
        {body ? <div className="s">{body}</div> : null}
      </div>
    </div>
  );
}

export default Toast;
