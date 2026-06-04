'use client';

import type { JSX } from 'react';
import { useId } from 'react';

import type { InvoiceProps, InvoiceStatus } from './types';

function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

interface StatusMeta {
  tagLabel: string;
  /** Modifier class appended to `.ms` for colouring the tag-line. */
  msModifier: '' | 'paid' | 'overdue';
  /** Modifier class appended to `.sum b` for total colouring. */
  totalModifier: '' | 'paid';
  /** Default left-label for the sum row. */
  defaultTotalLabel: string;
  /** Default primary-CTA label. `null` = no default CTA for this status. */
  defaultPrimaryLabel: string | null;
}

const STATUS_META: Record<InvoiceStatus, StatusMeta> = {
  draft: {
    tagLabel: 'Rechnung · Entwurf',
    msModifier: '',
    totalModifier: '',
    defaultTotalLabel: 'Gesamt inkl. USt.',
    defaultPrimaryLabel: 'Senden · DATEV',
  },
  sent: {
    tagLabel: 'Rechnung · Gesendet',
    msModifier: '',
    totalModifier: '',
    defaultTotalLabel: 'Gesamt inkl. USt.',
    defaultPrimaryLabel: null,
  },
  paid: {
    tagLabel: 'Bestätigung',
    msModifier: 'paid',
    totalModifier: 'paid',
    defaultTotalLabel: 'Betrag',
    defaultPrimaryLabel: null,
  },
  overdue: {
    tagLabel: 'Überfällig',
    msModifier: 'overdue',
    totalModifier: '',
    defaultTotalLabel: 'Gesamt inkl. USt.',
    defaultPrimaryLabel: 'Erinnerung senden',
  },
};

/**
 * INV-01 Invoice Card.
 *
 * Status drives:
 *   - tag label and meta-line colour (`.ms.paid` / `.ms.overdue`)
 *   - sum total colour (`.sum b.paid`)
 *   - default primary-CTA label (override via `primaryLabel`)
 *
 * Formatting is explicitly the caller's responsibility — every
 * amount in `lines` and `totalAmount` must already be a display-ready
 * string (locale, currency symbol, thousand separators).
 */
export function Invoice({
  status,
  number,
  title,
  subtitle,
  lines,
  totalLabel,
  totalAmount,
  currency = '€',
  onAdjust,
  onPrimary,
  primaryLabel,
  className,
}: InvoiceProps): JSX.Element {
  const meta = STATUS_META[status];
  const titleId = useId();
  const numberId = useId();

  const resolvedTotalLabel = totalLabel ?? meta.defaultTotalLabel;
  const resolvedPrimaryLabel = primaryLabel ?? meta.defaultPrimaryLabel;

  // Show the primary CTA only if we have both a handler AND a label.
  // Status 'paid' never shows a CTA by default; callers can still
  // force one by passing both onPrimary and primaryLabel.
  const showPrimary = Boolean(onPrimary && resolvedPrimaryLabel);
  const showAdjust = Boolean(onAdjust);
  const showCtaRow = showPrimary || showAdjust;

  // The aria-label for the total repeats the formatted string so
  // assistive tech announces the value as shown. We append the currency
  // only if totalAmount doesn't already contain it.
  const totalAriaLabel = totalAmount.includes(currency)
    ? `Gesamtbetrag ${totalAmount}`
    : `Gesamtbetrag ${totalAmount} ${currency}`.trim();

  return (
    <section
      className={classNames('invc', className)}
      aria-labelledby={titleId}
      aria-describedby={numberId}
      data-status={status}
    >
      <div className="h">
        <div className="t">{meta.tagLabel}</div>
        <div className="n" id={numberId}>
          {number}
        </div>
      </div>

      <div className="tt" id={titleId}>
        {title}
      </div>

      {subtitle ? (
        <div className={classNames('ms', meta.msModifier && meta.msModifier)}>
          {subtitle}
        </div>
      ) : null}

      {lines.length > 0 ? (
        <div className="lines" role="list">
          {lines.map((line, index) => (
            <div
              // Line label + index is a stable-enough key; callers don't
              // reorder lines at runtime and labels are human-authored.
              key={`${line.label}-${index}`}
              className="line"
              role="listitem"
            >
              <div className="l">
                {line.label}
                {line.detail ? <small>{line.detail}</small> : null}
              </div>
              <div className="r">{line.amount}</div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="sum">
        <span>{resolvedTotalLabel}</span>
        <b
          className={meta.totalModifier || undefined}
          aria-label={totalAriaLabel}
        >
          {totalAmount}
        </b>
      </div>

      {showCtaRow ? (
        <div className="cta">
          {showAdjust ? (
            <button type="button" className="s" onClick={onAdjust}>
              Anpassen
            </button>
          ) : null}
          {showPrimary ? (
            <button type="button" className="p" onClick={onPrimary}>
              {resolvedPrimaryLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export default Invoice;
