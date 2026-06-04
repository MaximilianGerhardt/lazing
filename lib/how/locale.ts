/**
 * /how — Locale-Helper
 *
 * Reads the language from the `?lang=` query param. Default: 'de'.
 * Deliberately minimal: no i18n library, no cookie roundtrip.
 * Server components receive searchParams as a prop; this helper
 * only normalizes the value.
 */

export type Locale = 'de' | 'en';

// 2026-04-27 — user pivot: English is default, German is explicit opt-in.
// Cookie/localStorage override takes effect when present.
export const DEFAULT_LOCALE: Locale = 'en';

export function pickLocale(value: unknown): Locale {
  if (typeof value === 'string' && value.toLowerCase() === 'de') {
    return 'de';
  }
  return 'en';
}

export function altLocale(loc: Locale): Locale {
  return loc === 'de' ? 'en' : 'de';
}

export function tr<T>(loc: Locale, value: { de: T; en: T }): T {
  return value[loc];
}

export const UI_STRINGS: Record<
  Locale,
  {
    backToHow: string;
    related: string;
    languageSwitch: string;
    overviewKicker: string;
    statLive: string;
    statSkills: string;
    statWorkspaces: string;
    statSessions: string;
  }
> = {
  de: {
    backToHow: 'Zurück zur Übersicht',
    related: 'Verwandte Routen',
    languageSwitch: 'Sprache',
    overviewKicker: 'Handbuch · für Max · v1',
    statLive: 'Live-Daten',
    statSkills: 'Skills aktiv',
    statWorkspaces: 'Workspaces',
    statSessions: 'Sessions',
  },
  en: {
    backToHow: 'Back to overview',
    related: 'Related routes',
    languageSwitch: 'Language',
    overviewKicker: 'Manual · for Max · v1',
    statLive: 'Live data',
    statSkills: 'Active skills',
    statWorkspaces: 'Workspaces',
    statSessions: 'Sessions',
  },
};
