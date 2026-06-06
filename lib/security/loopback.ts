/**
 * lib/security/loopback.ts — "is this a first-run from the local machine itself?"
 *
 * Used to allow a CODELESS operator bootstrap on a fresh localhost install (the
 * Pure-Apple one-click first run) while still requiring LAZYOS_ACCESS_CODE for
 * any remote/tunneled access.
 *
 * 2026-06-06 fix: the previous inline checks treated ANY x-forwarded-* header as
 * "proxied" → false. But Next.js `next start` sets `x-forwarded-host` (== host)
 * and `x-forwarded-for` (== 127.0.0.1) on its own requests, so codeless never
 * activated and every fresh OSS install demanded the access code. The correct
 * signal for a REAL external proxy is: a forwarded host that DIFFERS from the
 * host, or an x-forwarded-for whose first hop is non-loopback.
 */

interface HeaderBag {
  get(name: string): string | null;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function stripPort(value: string): string {
  return value.toLowerCase().replace(/:\d+$/, "");
}

/**
 * True when the request originates from the local machine over loopback and was
 * NOT forwarded by an external reverse proxy/tunnel.
 *
 * Pass a Headers-like object (NextRequest.headers / Request.headers / the result
 * of next/headers `headers()`).
 */
export function isLoopbackFirstRun(headers: HeaderBag): boolean {
  const host = stripPort(headers.get("host") ?? "");
  if (!LOOPBACK_HOSTS.has(host)) return false;

  // An external proxy rewrites the host → x-forwarded-host differs from host.
  // Next's own self-set x-forwarded-host equals host and must NOT count.
  const xfh = headers.get("x-forwarded-host");
  if (xfh && stripPort(xfh) !== host) return false;

  // A real proxy hop puts the client IP first in x-forwarded-for; loopback there
  // (Next's self-set value) is fine.
  const xff = (headers.get("x-forwarded-for") ?? "").split(",")[0].trim().toLowerCase();
  if (xff && !LOOPBACK_IPS.has(xff)) return false;

  return true;
}
