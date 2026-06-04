/**
 * lib/ui/pip — Stepper-Domain-Typen (Sub-Plan 5 Welle 1, 2026-05-01).
 *
 * StageDescriptor ist die Adapter-Output-Form: jedes Welle-2-Adapter
 * (workflows, iterate, rag, drift, sniper) liefert ein
 * `StageDescriptor[]` an den Pipeline-Renderer.
 *
 * `StepStatus` ist hier 5-wertig (pending|running|done|failed|skipped).
 * Step.tsx mappt das auf CSS-Klassen `w|r|d|f|k`. Der bestehende
 * 3-wertige `StepStatus`-Export aus Step.tsx (`'done'|'running'|'waiting'`)
 * bleibt aus Backwards-Compat-Gründen funktional, intern wird er auf den
 * neuen Typ gehoben.
 */

export type StepStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped';

/**
 * Qualitative ETA-Buckets — wir geben keine harten Zeit-Promises ab,
 * sondern Hinweise wie "fast fertig" / "läuft länger als üblich".
 *
 * Renderer entscheidet wie das anzeigt wird (Subtitle-String oder
 * Pill-Color); der Adapter bestimmt nur den Bucket.
 */
export type EtaBucket = 'fast' | 'normal' | 'slow' | 'overdue';

export interface StageDescriptor {
  /** Stabile ID für React-Keys + a11y. Pro Adapter eindeutig. */
  id: string;
  /** Lesbares Label, z.B. "Roast V2" oder "Embedding". */
  label: string;
  status: StepStatus;
  /**
   * Optionaler ETA-Bucket — qualitativer Zeit-Hinweis. Renderer kann
   * daraus Subtitle wie "fast fertig" oder "läuft länger als üblich"
   * generieren, oder den Bucket per Color-Token visualisieren.
   */
  etaBucket?: EtaBucket;
  /**
   * Frei-Text-Subtitle, z.B. "ca. 2 Wellen noch", "47/120 Chunks".
   * Hat Vorrang vor automatisch aus etaBucket abgeleitetem Subtitle.
   */
  subtitle?: string;
  /**
   * 0..100 — wenn gesetzt, rendert Step eine 1px Underline-Bar.
   * Werte außerhalb [0,100] werden geklammert.
   */
  progressPct?: number;
  /**
   * GitHub-Actions-Style aufklappbare Sub-Steps. Optional, eine Ebene
   * tief reicht für die aktuellen Use-Cases (Workflow-Sub-States,
   * Sub-Plan-Sniper-Tickets).
   */
  sub?: StageDescriptor[];
}

/**
 * Mapping von 5-wertiger StepStatus auf CSS-Modifier.
 *
 *   pending  → 'w'  (waiting/neutral, alt: identisch)
 *   running  → 'r'  (amber, alt: identisch)
 *   done     → 'd'  (green, alt: identisch)
 *   failed   → 'f'  (rot, NEU)
 *   skipped  → 'k'  (durchgestrichen-grau, NEU)
 */
export const STEP_STATUS_CLASS: Record<StepStatus, 'w' | 'r' | 'd' | 'f' | 'k'> = {
  pending: 'w',
  running: 'r',
  done: 'd',
  failed: 'f',
  skipped: 'k',
};

/**
 * Default-Kurz-Labels (visual shorthand only — a11y nimmt die Voll-Form).
 */
export const STEP_STATUS_LABEL: Record<StepStatus, string> = {
  pending: 'wait',
  running: 'run',
  done: 'ok',
  failed: 'fail',
  skipped: 'skip',
};

/**
 * a11y-Voll-Form für `aria-label` an der Status-Pille.
 */
export const STEP_STATUS_ARIA: Record<StepStatus, string> = {
  pending: 'Wartet',
  running: 'Läuft',
  done: 'Abgeschlossen',
  failed: 'Fehlgeschlagen',
  skipped: 'Übersprungen',
};

/**
 * Helper für Subtitle aus EtaBucket — nur wenn Adapter keinen
 * eigenen Subtitle gesetzt hat.
 */
export function defaultSubtitleForEta(bucket: EtaBucket): string {
  switch (bucket) {
    case 'fast':
      return 'fast fertig';
    case 'normal':
      return 'läuft';
    case 'slow':
      return 'läuft länger als üblich';
    case 'overdue':
      return 'sollte längst fertig sein';
  }
}

/**
 * Klammert progressPct auf [0,100]. Nicht-Numbers → undefined.
 */
export function clampProgressPct(pct: number | undefined): number | undefined {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return undefined;
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}
