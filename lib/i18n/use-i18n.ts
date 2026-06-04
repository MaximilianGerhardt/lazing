'use client';

/**
 * Phase OSS.3 — useI18n hook (Client-Component-only).
 *
 * Reads the locale from localStorage `lazyos.locale`. If unset,
 * sniffs from navigator.language. Persisted on change, including a custom
 * event so all hooks in the same tab live re-render.
 *
 * Server components should use `t()` from `dictionary.ts` directly with a
 * fixed locale (from cookie/header) — the client hook is
 * intended for interactive UI surfaces.
 */

import {
  useCallback,
  useSyncExternalStore,
} from 'react';

import {
  DEFAULT_LOCALE,
  resolve,
  SUPPORTED_LOCALES,
  sniffLocale,
  t as translate,
  type Locale,
} from './dictionary';

const STORAGE_KEY = 'lazyos.locale';
const CHANGE_EVENT = 'lazyos.locale-change';

let cached: Locale | null = null;

function getSnapshot(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  if (cached) return cached;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && SUPPORTED_LOCALES.includes(stored as Locale)) {
      cached = stored as Locale;
      return cached;
    }
  } catch {
    /* ignore */
  }
  cached = sniffLocale(window.navigator.language);
  return cached;
}

function getServerSnapshot(): Locale {
  return DEFAULT_LOCALE;
}

function subscribe(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (): void => {
    cached = null;
    listener();
  };
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener('storage', handler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener('storage', handler);
  };
}

export function useI18n(): {
  locale: Locale;
  t: (key: string, params?: Record<string, string | number>) => string;
  setLocale: (next: Locale) => void;
} {
  const locale = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setLocale = useCallback((next: Locale): void => {
    if (!SUPPORTED_LOCALES.includes(next)) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
    cached = next;
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string =>
      translate(locale, key, params),
    [locale],
  );

  // Re-export resolve for testing purposes
  void resolve;

  return { locale, t, setLocale };
}
