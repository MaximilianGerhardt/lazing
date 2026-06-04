/**
 * Phase OSS.3 — Server-Side-i18n-Helper.
 *
 * Thin wrapper around `t()` from dictionary.ts that reads the locale from the
 * `lazyos.locale` cookie (or sniffs Accept-Language).
 *
 * Usage in Server-Components:
 *   const tt = await getServerT();
 *   <h1>{tt("org.list.title")}</h1>
 *
 * Oder direkt:
 *   const locale = await getServerLocale();
 *   t(locale, "org.list.title")
 */

import { cookies, headers } from "next/headers";

import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  sniffLocale,
  t,
  type Locale,
} from "./dictionary";

export async function getServerLocale(): Promise<Locale> {
  const c = await cookies();
  const cookieLocale = c.get("lazyos.locale")?.value;
  if (
    cookieLocale &&
    (SUPPORTED_LOCALES as readonly string[]).includes(cookieLocale)
  ) {
    return cookieLocale as Locale;
  }
  const h = await headers();
  const al = h.get("accept-language") ?? "";
  return sniffLocale(al);
}

/**
 * Synchronous t() for server components that already knows the locale.
 * Call pattern:
 *   const tt = await getServerT();
 *   tt('org.list.title');
 *   tt('login.email.success', { email: 'a@b.c' });
 */
export async function getServerT(): Promise<
  (key: string, params?: Record<string, string | number>) => string
> {
  const locale = await getServerLocale();
  return (key: string, params?: Record<string, string | number>) =>
    t(locale, key, params);
}

export { DEFAULT_LOCALE };
