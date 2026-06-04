export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'overdue';

export interface InvoiceLine {
  /** Primary label, e.g. "KR-Modell-Prüfung". */
  label: string;
  /** Optional secondary line under the label, e.g. "14 Modelle · Validierung". */
  detail?: string;
  /**
   * Pre-formatted amount string, e.g. "8 580,00".
   * Formatting is the caller's responsibility — the component MUST NOT
   * reformat numbers (locale, currency, thousand separators).
   */
  amount: string;
}

export interface InvoiceProps {
  /** Lifecycle status. Drives tag label/tone, sum color, default CTAs. */
  status: InvoiceStatus;
  /** Invoice number, e.g. "RE-2026-0142". */
  number: string;
  /** Headline, e.g. "Sprint 14 · KR-Audit". */
  title: string;
  /** Optional meta line, e.g. "Nord-Sparkasse AG · Fällig 15.05.2026". */
  subtitle?: string;
  /** Line items. Amounts must be pre-formatted strings. */
  lines: InvoiceLine[];
  /**
   * Label shown left of the total amount.
   * Defaults:
   *   - draft / sent / overdue → "Gesamt inkl. USt."
   *   - paid                   → "Betrag"
   */
  totalLabel?: string;
  /** Pre-formatted total, e.g. "14 018,20 €". */
  totalAmount: string;
  /**
   * Currency symbol, used only for the aria-label when it cannot be
   * derived from `totalAmount`. Defaults to "€".
   */
  currency?: string;
  /** Secondary CTA ("Anpassen"). Hidden when not provided. */
  onAdjust?: () => void;
  /** Primary CTA handler. Hidden when neither handler nor label given. */
  onPrimary?: () => void;
  /**
   * Override the primary CTA label. Defaults per status:
   *   - draft    → "Senden · DATEV"
   *   - overdue  → "Erinnerung senden"
   *   - sent     → undefined (no primary CTA unless explicitly set)
   *   - paid     → undefined (no CTA)
   */
  primaryLabel?: string;
  /** Extra className appended to the root <section>. */
  className?: string;
}
