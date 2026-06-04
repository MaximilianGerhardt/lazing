/**
 * public-base — runtime-read public base URL for client share links.
 *
 * Problem (out-of-the-box OSS): `next start` freezes `process.env` at boot.
 * If the tunnel manager writes the (ephemeral) public URL only to
 * `.env.local`, it only takes effect after an app RESTART — on every quick-tunnel
 * rotation you would have to restart. That is exactly the manual work we
 * want to avoid.
 *
 * Solution: the tunnel manager ADDITIONALLY writes the current URL to a
 * runtime file `data/public-url`. This function reads it PER REQUEST (with
 * a short cache) — so a new tunnel URL propagates LIVE into all share links,
 * without a restart. ENV remains preferred (for fixed reverse-proxy/domain setups).
 *
 * Order: **runtime file first** (it reflects the CURRENTLY active
 * tunnel and is updated live by the manager / deleted on `down`) → then ENV
 * (LAZYOS_PREVIEW_BASE_URL → PUBLIC_URL → BASE_URL; for fixed reverse-proxy/
 * domain setups without a tunnel manager). localhost/127.0.0.1/0.0.0.0 are
 * skipped (useless for external guests). File-first is decisive because
 * `next start` freezes ENV at boot — otherwise an old ENV line would shadow
 * the fresh tunnel URL.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Canonical path of the runtime URL file (written by the tunnel manager). */
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
    /* no file → null (ENV or request origin take over) */
  }
  cache = { url, at: now };
  return url;
}

/**
 * Returns the configured public base URL OR null when no usable one
 * is set (in which case the caller should fall back to the request origin).
 */
export function readPublicBaseOverride(now: number = Date.now()): string | null {
  // File first (active tunnel, live), then ENV (static reverse-proxy config).
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
 * Convenient helper for route handlers: override OR the request origin.
 * `origin` is typically `req.nextUrl.origin`.
 */
export function publicBaseUrlFrom(origin: string): string {
  return (readPublicBaseOverride() ?? origin).replace(/\/+$/, '');
}
