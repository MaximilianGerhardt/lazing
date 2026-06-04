/**
 * VPS-Bridge Proxy
 * ================
 *
 * Single source-of-truth for Vercel→VPS forwarding. Vercel-serverless
 * functions cannot persist SQLite (every cold-start gives a fresh
 * `/tmp/lazyos.db`), so read-side routes must consult the VPS Next.js
 * instance (port 4200, exposed via a Cloudflare tunnel) which owns the
 * real database.
 *
 * Contract
 * --------
 * - Read env once per call (config is cheap to parse, avoids stale imports).
 * - Bearer auth via `LAZYOS_VPS_BRIDGE_SECRET`. Same value lives on both
 *   sides; VPS middleware compares constant-time.
 * - 10s timeout (AbortController). Any timeout/network failure throws
 *   `BridgeUnavailableError` — callers are expected to fall back gracefully.
 * - No retries on this layer. The caller decides what to do on failure.
 * - JSON-only. Response bodies that fail JSON.parse throw
 *   `BridgeUnavailableError` (treated as tunnel flake).
 *
 * Caller ergonomics
 * -----------------
 * ```ts
 * const { data, degraded } = await tryProxyToVps<{ workspaces: Workspace[] }>(
 *   "/api/workspaces",
 *   { searchParams: req.nextUrl.searchParams },
 * );
 * if (degraded) return fallback();
 * return NextResponse.json(data);
 * ```
 *
 * Security notes
 * --------------
 * - The bridge secret MUST NOT leak to clients. It is only sent in the
 *   `Authorization` header toward the VPS.
 * - We explicitly do NOT forward the inbound `Authorization` / `Cookie`
 *   headers — the Vercel edge already validated the session; the VPS call
 *   is a trusted service-to-service hop.
 */

import {
  BridgeHttpError,
  BridgeNotConfiguredError,
  BridgeUnavailableError,
  type ProxyOptions,
  type VpsBridgeConfig,
} from "./types";

/** Default per-call timeout in ms. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Read bridge config from env. Returns `null` when either value is missing
 * so the caller can choose a local-DB fallback without throwing on every
 * request.
 */
export function readBridgeConfig(): VpsBridgeConfig | null {
  const baseRaw = process.env.LAZYOS_WEB_URL?.trim();
  const secretRaw = process.env.LAZYOS_VPS_BRIDGE_SECRET?.trim();
  if (!baseRaw || !secretRaw) return null;

  // Normalise: trim trailing slash so path concatenation is stable.
  const baseUrl = baseRaw.endsWith("/") ? baseRaw.slice(0, -1) : baseRaw;
  return { baseUrl, secret: secretRaw };
}

/** True when both env vars are present. */
export function isBridgeConfigured(): boolean {
  return readBridgeConfig() !== null;
}

function buildUrl(
  base: string,
  path: string,
  params: URLSearchParams | null | undefined,
): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  const qs = params && Array.from(params.keys()).length > 0
    ? `?${params.toString()}`
    : "";
  return `${base}${p}${qs}`;
}

/**
 * Core proxy call. Throws on any non-ok response or network failure.
 * Use `tryProxyToVps` when you want a degraded-fallback-friendly wrapper.
 */
export async function proxyToVps<T>(
  path: string,
  options: ProxyOptions = {},
): Promise<T> {
  const config = options.config ?? readBridgeConfig();
  if (!config) {
    throw new BridgeNotConfiguredError();
  }

  const url = buildUrl(config.baseUrl, path, options.searchParams);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.secret}`,
    Accept: "application/json",
    // Mark the call so the VPS side can surface it in observability.
    "x-lazyos-bridge": "vercel",
    ...(options.headers ?? {}),
  };
  if (options.body && !headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = "application/json";
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body ?? undefined,
      signal: controller.signal,
      // Proxy is always dynamic — never cache.
      cache: "no-store",
    });
  } catch (err) {
    clearTimeout(timer);
    const message =
      err instanceof Error && err.name === "AbortError"
        ? `vps_bridge_timeout_${timeoutMs}ms`
        : "vps_bridge_fetch_failed";
    throw new BridgeUnavailableError(message, err);
  } finally {
    clearTimeout(timer);
  }

  const throwOnNonOk = options.throwOnNonOk ?? true;
  if (!response.ok && throwOnNonOk) {
    // Capture the text body for diagnostics, but cap it so a huge HTML
    // error page doesn't blow up our logs.
    let bodyText = "";
    try {
      bodyText = (await response.text()).slice(0, 2000);
    } catch {
      /* swallow — body unreadable, status is enough */
    }
    throw new BridgeHttpError(response.status, bodyText);
  }

  try {
    return (await response.json()) as T;
  } catch (err) {
    throw new BridgeUnavailableError("vps_bridge_invalid_json", err);
  }
}

export interface BridgeResult<T> {
  /** Parsed response body on success. `null` when `degraded`. */
  data: T | null;
  /** True when the call failed and the caller must degrade gracefully. */
  degraded: boolean;
  /**
   * Reason token for the `X-LazyOS-Degraded` header. One of:
   *   - "not_configured" — env vars missing (typical local/dev)
   *   - "unavailable"    — tunnel down / timeout / network error
   *   - "http_<status>"  — upstream returned non-2xx
   *   - "invalid_json"   — upstream returned unparseable body
   */
  reason?: string;
}

/**
 * Wraps `proxyToVps` with a try/catch so route handlers can produce a
 * consistent "degraded response + header" pattern without repeating
 * boilerplate.
 */
export async function tryProxyToVps<T>(
  path: string,
  options: ProxyOptions = {},
): Promise<BridgeResult<T>> {
  try {
    const data = await proxyToVps<T>(path, options);
    return { data, degraded: false };
  } catch (err) {
    if (err instanceof BridgeNotConfiguredError) {
      return { data: null, degraded: true, reason: "not_configured" };
    }
    if (err instanceof BridgeHttpError) {
      return { data: null, degraded: true, reason: `http_${err.status}` };
    }
    if (err instanceof BridgeUnavailableError) {
      const kind = err.message.includes("invalid_json")
        ? "invalid_json"
        : "unavailable";
      return { data: null, degraded: true, reason: kind };
    }
    // Unknown failure — be conservative and degrade.
    return { data: null, degraded: true, reason: "unavailable" };
  }
}

/**
 * Helper for route handlers: stamps the degraded header consistently.
 * Use like:
 *   applyDegradedHeader(response, result.reason);
 */
export function degradedHeaderValue(reason: string | undefined): string {
  return reason ? `bridge_${reason}` : "bridge_unknown";
}
