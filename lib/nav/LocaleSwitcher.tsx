'use client';

/**
 * Phase OSS.3 — Locale-Switcher (in TopNav-Sandwich-System-Section).
 *
 * Writes both localStorage `lazyos.locale` (for client hooks) and
 * the cookie `lazyos.locale` (for server components on the next render).
 * On switch: hard-reload so server components read the new cookie
 * and render all surfaces in the new locale.
 */

import { useCallback } from 'react';

import {
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  type Locale,
} from '@/lib/i18n/dictionary';
import { useI18n } from '@/lib/i18n/use-i18n';

export function LocaleSwitcher(): React.JSX.Element {
  const { locale, t } = useI18n();

  const onChange = useCallback((next: Locale) => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem('lazyos.locale', next);
    } catch {
      /* ignore */
    }
    // Cookie for server components.
    const oneYear = 60 * 60 * 24 * 365;
    document.cookie = `lazyos.locale=${encodeURIComponent(next)}; Path=/; Max-Age=${oneYear}; SameSite=Lax`;
    // Hard-reload so server components re-render.
    window.location.reload();
  }, []);

  return (
    <div className="locale-switcher">
      <span className="locale-switcher-label">{t('nav.locale.label')}</span>
      <div className="locale-switcher-row" role="radiogroup" aria-label={t('nav.locale.label')}>
        {SUPPORTED_LOCALES.map((loc) => {
          const active = loc === locale;
          return (
            <button
              key={loc}
              type="button"
              role="radio"
              aria-checked={active}
              className={`locale-switcher-btn${active ? ' is-active' : ''}`}
              onClick={() => onChange(loc)}
              title={LOCALE_LABELS[loc]}
            >
              {loc.toUpperCase()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
