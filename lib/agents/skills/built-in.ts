/**
 * Built-in skill definitions (Phase S — skill-first-class).
 *
 * These 16 skills map the old DIVERSITY_ROLES list 1:1 and are
 * seeded into the DB on first boot. Users can then add, archive or adjust
 * their own skills freely — built-ins are not
 * deleted, only marked read-only.
 */

export interface BuiltInSkill {
  id: string;
  name: string;
  focusPrompt: string;
  preferTier: 'opus' | 'sonnet' | 'haiku';
  defaultEffort: 'xhigh' | 'high' | 'medium' | 'low';
  defaultCount: number;
  description: string;
}

export const BUILT_IN_SKILLS: ReadonlyArray<BuiltInSkill> = [
  {
    id: 'skill-ux',
    name: 'UX',
    focusPrompt:
      'User-Erfahrung, Klickwege, Ergonomie, Friction-Punkte. Wo bleibt der Nutzer hängen?',
    preferTier: 'opus',
    defaultEffort: 'xhigh',
    defaultCount: 2,
    description: 'User-Perspektive — Klickwege, Microcopy, Friction.',
  },
  {
    id: 'skill-architecture',
    name: 'Architecture',
    focusPrompt:
      'Technische Robustheit, Datenfluss, Skalierung, Modularitaet. Wo bricht das System?',
    preferTier: 'opus',
    defaultEffort: 'xhigh',
    defaultCount: 2,
    description: 'System-Design, Datenfluss, Skalierung, Modularität.',
  },
  {
    id: 'skill-cost',
    name: 'Cost',
    focusPrompt:
      'Cost-Optimierung, Cloud-Bills, Token-Verbrauch, Effizienz. Wo verbrennen wir Geld?',
    preferTier: 'sonnet',
    defaultEffort: 'medium',
    defaultCount: 1,
    description: 'Kostenseite — wo sind unsichtbare Kostenfresser?',
  },
  {
    id: 'skill-risk',
    name: 'Risk',
    focusPrompt:
      'Risiken, Edge-Cases, Sicherheit, Compliance, was kann brechen. Worst-Case-Szenarien.',
    preferTier: 'opus',
    defaultEffort: 'xhigh',
    defaultCount: 1,
    description: 'Risiken + Edge-Cases + Worst-Case-Szenarien.',
  },
  {
    id: 'skill-speed',
    name: 'Speed',
    focusPrompt:
      'Time-to-Ship, MVP-Schnitt, welche Schritte parallel, was zuerst. Wie kommen wir live?',
    preferTier: 'sonnet',
    defaultEffort: 'medium',
    defaultCount: 1,
    description: 'Liefer-Geschwindigkeit, MVP-Schnitt, Parallelisierung.',
  },
  {
    id: 'skill-maintenance',
    name: 'Maintenance',
    focusPrompt:
      'Langfristige Wartbarkeit, Tests, Monitoring, Onboarding. Wer pflegt das in 2 Jahren?',
    preferTier: 'sonnet',
    defaultEffort: 'medium',
    defaultCount: 1,
    description: 'Wartbarkeit + Tests + Monitoring + Onboarding.',
  },
  {
    id: 'skill-brand',
    name: 'Brand',
    focusPrompt:
      'Markenkonsistenz, Tonalitaet, Apple/Rams-Designprinzipien. Riecht es premium?',
    preferTier: 'sonnet',
    defaultEffort: 'medium',
    defaultCount: 1,
    description: 'Markenkonsistenz, Tonalität, Premium-Wahrnehmung.',
  },
  {
    id: 'skill-mobile',
    name: 'Mobile',
    focusPrompt:
      'Mobile-First, Touch, PWA-Constraints, Offline-Verhalten. Wie fühlt sichs auf iPhone an?',
    preferTier: 'sonnet',
    defaultEffort: 'medium',
    defaultCount: 1,
    description: 'Mobile-First, Touch, PWA, Offline.',
  },
  {
    id: 'skill-accessibility',
    name: 'Accessibility',
    focusPrompt:
      'A11y, Screenreader, Keyboard-Navigation, prefers-reduced-motion. Wer wird ausgeschlossen?',
    preferTier: 'haiku',
    defaultEffort: 'medium',
    defaultCount: 1,
    description: 'A11y — Screenreader, Keyboard, reduce-motion.',
  },
  {
    id: 'skill-performance',
    name: 'Performance',
    focusPrompt:
      'Loading, Render, Bundle-Size, INP, Network. Wo ruckeln wir?',
    preferTier: 'sonnet',
    defaultEffort: 'medium',
    defaultCount: 1,
    description: 'Performance — Loading, Render, Bundle-Size, INP.',
  },
  {
    id: 'skill-privacy',
    name: 'Privacy',
    focusPrompt:
      'Daten-Minimierung, DSGVO, Consent, Logs, PII-Kontrolle. Wo leakt PII?',
    preferTier: 'opus',
    defaultEffort: 'high',
    defaultCount: 1,
    description: 'Datenschutz, DSGVO, PII, Consent, Logs.',
  },
  {
    id: 'skill-failure',
    name: 'Failure',
    focusPrompt:
      'Failure-Modi, Retries, Circuit-Breaker, Graceful-Degradation. Was passiert bei Ausfall?',
    preferTier: 'sonnet',
    defaultEffort: 'high',
    defaultCount: 1,
    description: 'Failure-Modi, Retries, Graceful-Degradation.',
  },
  {
    id: 'skill-onboarding',
    name: 'Onboarding',
    focusPrompt:
      'Wie merkt ein neuer Mitarbeiter was hier passiert? Verständlichkeit für Neue.',
    preferTier: 'haiku',
    defaultEffort: 'medium',
    defaultCount: 1,
    description: 'Onboarding — Verständlichkeit für Neue.',
  },
  {
    id: 'skill-migrate',
    name: 'Migrate',
    focusPrompt:
      'Migration alter Daten, Backward-Compat, Rollback. Was passiert bei Re-Deploy?',
    preferTier: 'opus',
    defaultEffort: 'high',
    defaultCount: 1,
    description: 'Migrationen, Backward-Compat, Rollback.',
  },
  {
    id: 'skill-observability',
    name: 'Observability',
    focusPrompt:
      'Logs, Metriken, Tracing, Debugging-Werkzeuge. Wie sehen wir was passiert?',
    preferTier: 'haiku',
    defaultEffort: 'medium',
    defaultCount: 1,
    description: 'Observability — Logs, Metriken, Tracing.',
  },
  {
    id: 'skill-critic',
    name: 'Critic',
    focusPrompt:
      'Was fehlt, was ist falsch geplant, Annahmen die nicht halten. Hinterfrag den Plan.',
    preferTier: 'opus',
    defaultEffort: 'xhigh',
    defaultCount: 2,
    description: 'Advocatus Diaboli — was übersehen alle?',
  },
];
