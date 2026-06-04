'use client';

export interface QuickChoiceOption {
  /** Stable identity for React reconciliation and test selectors. */
  id: string;
  /** Primary label (e.g. "Ja"). */
  label: string;
  /** Optional small uppercase descriptor (e.g. "empfohlen"). */
  sublabel?: string;
  /**
   * Promotes the option to the recommended choice — rendered with
   * `--a-now` background and black text (the `.p` CSS modifier).
   */
  primary?: boolean;
  /** Invoked on click. Consumers own the navigation / side-effect. */
  onSelect: () => void;
  /** Optional per-button disabled state. */
  disabled?: boolean;
}

export interface QuickChoiceProps {
  /**
   * The CSS grid is hard-coded to `1fr 1fr 1fr`, so 3 options is the
   * canonical shape. Consumers may still pass 2 or 4+ (the grid will
   * simply wrap or leave gaps — visual QA required).
   */
  options: QuickChoiceOption[];
  /** Extra className appended after `qc`. */
  className?: string;
  /**
   * Accessible group label. When supplied, the wrapper gets
   * `role="group"` with `aria-label` so assistive tech announces the
   * choice-set context (e.g. "Rechnung senden?").
   */
  ariaLabel?: string;
}

function classNames(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * QCK-01 Quick Choice.
 *
 * Three-column grid of glass-morphic choice buttons with an optional
 * primary recommendation. Styling lives in section M of
 * `app/components.css`. Focus handling relies on the browser's native
 * focus-visible ring on `.qc button` — we only need to ensure the
 * buttons are real `<button>` elements for keyboard parity.
 */
export function QuickChoice({
  options,
  className,
  ariaLabel,
}: QuickChoiceProps): React.JSX.Element {
  return (
    <div
      className={classNames('qc', className)}
      role={ariaLabel ? 'group' : undefined}
      aria-label={ariaLabel}
    >
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          className={classNames(opt.primary && 'p')}
          onClick={opt.onSelect}
          disabled={opt.disabled}
          aria-label={
            opt.sublabel ? `${opt.label} (${opt.sublabel})` : opt.label
          }
        >
          {opt.label}
          {opt.sublabel ? <small>{opt.sublabel}</small> : null}
        </button>
      ))}
    </div>
  );
}

export default QuickChoice;
