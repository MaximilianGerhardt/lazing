/**
 * public-base — laufzeitgelesene öffentliche Base-URL für Kunden-Share-Links.
 *
 * Problem (Out-of-the-Box-OSS): `next start` friert `process.env` beim Boot ein.
 * Schreibt der Tunnel-Manager die (ephemere) öffentliche URL nur nach
 * `.env.local`, greift sie erst nach einem App-NEUSTART — bei jeder Quick-Tunnel-
 * Rotation müsste man neu starten. Das ist genau die manuelle Arbeit, die wir
 * vermeiden wollen.
 *
 * Lösung: der Tunnel-Manager schreibt die aktuelle URL ZUSÄTZLICH in eine
 * Laufzeit-Datei `data/public-url`. Diese Funktion liest sie PRO REQUEST (mit
 * kurzem Cache) — so propagiert eine neue Tunnel-URL LIVE in alle Share-Links,
 * ohne Neustart. ENV bleibt vorrangig (für feste Reverse-Proxy-/Domain-Setups).
 *
 * Reihenfolge: **Laufzeit-Datei zuerst** (sie spiegelt den AKTUELL aktiven
 * Tunnel und wird vom Manager live aktualisiert/bei `down` gelöscht) → dann ENV
 * (LAZYOS_PREVIEW_BASE_URL → PUBLIC_URL → BASE_URL; für feste Reverse-Proxy-/
 * Domain-Setups ohne Tunnel-Manager). localhost/127.0.0.1/0.0.0.0 werden
 * übersprungen (nutzlos für externe Gäste). Datei-zuerst ist entscheidend, weil
 * `next start` ENV beim Boot einfriert — sonst überschattete eine alte ENV-Zeile
 * die frische Tunnel-URL.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Kanonischer Pfad der Laufzeit-URL-Datei (vom Tunnel-Manager geschrieben). */
export const PUBLIC_URL_FILE = join(process.cwd(), 'data', 'public-url');

const isUsable = (u: string | undefined | null): u is string =>
  !!u && /^https?:\/\//.test(u) && !/(localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(u);

let cache: { url: string | null; at: number } | null = null;
const CACHE_MS = 3000;

function readFileUrl(now: number): string | null {
  if (cache && now - cache.at < CACHE_MS) return cache.url;
  let url: string | null = null;
  try {
    const raw = readFileSync(PUBLIC_URL_FILE, 'utf8').trim();
    if (isUsable(raw)) url = raw.replace(/\/+$/, '');
  } catch {
    /* keine Datei → null (ENV oder Request-Origin greifen) */
  }
  cache = { url, at: now };
  return url;
}

/**
 * Liefert die konfigurierte öffentliche Base-URL ODER null, wenn keine brauchbare
 * gesetzt ist (dann sollte der Aufrufer auf die Request-Origin zurückfallen).
 */
export function readPublicBaseOverride(now: number = Date.now()): string | null {
  // Datei zuerst (aktiver Tunnel, live), dann ENV (statische Reverse-Proxy-Config).
  const fileUrl = readFileUrl(now);
  if (fileUrl) return fileUrl;
  for (const env of [
    process.env.LAZYOS_PREVIEW_BASE_URL,
    process.env.LAZYOS_PUBLIC_URL,
    process.env.LAZYOS_BASE_URL,
  ]) {
    if (isUsable(env)) return env.replace(/\/+$/, '');
  }
  return null;
}

/**
 * Bequemer Helfer für Route-Handler: Override ODER die Request-Origin.
 * `origin` ist typischerweise `req.nextUrl.origin`.
 */
export function publicBaseUrlFrom(origin: string): string {
  return (readPublicBaseOverride() ?? origin).replace(/\/+$/, '');
}
