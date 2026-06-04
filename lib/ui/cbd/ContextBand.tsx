import { Pill, type PillVariant } from '../pil/Pill';

export interface ContextBandProps {
  /** Pill variant for the leading context marker. Defaults to 'north'. */
  pillVariant?: PillVariant;
  /** Visible text inside the pill, e.g. "clientb GmbH". */
  pillLabel: string;
  /**
   * Breadcrumb / status line rendered next to the pill.
   * Conventionally uses middle-dots, e.g. "Sprint 14 · KR-007 Prüfung".
   */
  breadcrumb: string;
  /**
   * Optional click handler on the pill. When set, the pill becomes an
   * interactive <button> (see Pill); when omitted the pill is a passive
   * status indicator.
   */
  onPillClick?: () => void;
  className?: string;
}

function classNames(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * CBD-01 Context Band.
 *
 * A single-line band that pins the user's current context: an ambient
 * pill (segment / identity) plus a monospaced breadcrumb describing
 * where inside that context they are. Both pieces live in CSS section
 * `P · CBD` and `G · PIL`.
 *
 * Server-Component-safe when `onPillClick` is omitted.
 */
export function ContextBand({
  pillVariant = 'north',
  pillLabel,
  breadcrumb,
  onPillClick,
  className,
}: ContextBandProps): React.JSX.Element {
  return (
    <div className={classNames('cband', className)}>
      <Pill
        variant={pillVariant}
        onClick={onPillClick}
        ariaLabel={onPillClick ? pillLabel : undefined}
      >
        {pillLabel}
      </Pill>
      <span className="cr">{breadcrumb}</span>
    </div>
  );
}

export default ContextBand;
