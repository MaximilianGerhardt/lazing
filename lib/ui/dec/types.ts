export type DecisionMode = 'multi' | 'binary' | 'confirm';

export interface DecisionOption {
  /** Stable identifier for the option. */
  id: string;
  /** Primary label, e.g. "Q2/2026". */
  label: string;
  /** Optional secondary line, e.g. "mit Revision". */
  sublabel?: string;
  /**
   * Single character shown in the key-badge. Defaults to the index-letter
   * ("A", "B", ...) in multi mode, "" / "" in binary, "" in confirm.
   */
  key?: string;
  /**
   * Optional counter, e.g. "42/50". Only rendered when set — never
   * synthesised (see Strategie-Review: no fake medians).
   */
  counter?: string;
  /** Marks the recommended option (visual emphasis + aria-checked default). */
  recommended?: boolean;
  /** Invoked on click / Space / Enter. */
  onSelect?: () => void;
}

export interface DecisionDeepLink {
  /** Button label. Defaults to "Dossier öffnen". */
  label?: string;
  onClick: () => void;
}

export interface DecisionProps {
  /** Uppercased pill tag. Defaults to "Entscheidung benötigt". */
  tag?: string;
  /** Required headline (h4). */
  headline: string;
  /** Optional sub-line below the headline. */
  sub?: string;
  /** Options list. In binary: expects 2, in confirm: expects 1. */
  options: DecisionOption[];
  /** Optional deep-link footer button. */
  deepLink?: DecisionDeepLink;
  /** Layout/semantics variant. Default: 'multi'. */
  mode?: DecisionMode;
  /** Extra className appended to root. */
  className?: string;
}
