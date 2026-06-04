/**
 * Shared helpers for GET-route adapters that prefer the VPS-bridge
 * but must degrade gracefully when it is unavailable.
 *
 * Keep this file tiny and dependency-free so every route handler can
 * pull it in cheaply.
 */

import { NextResponse } from "next/server";

import {
  degradedHeaderValue,
  isBridgeConfigured,
  tryProxyToVps,
} from "./proxy";

/** Header signalling "this response came from the fallback path". */
export const DEGRADED_HEADER = "X-LazyOS-Degraded";
/** Header signalling the authoritative data source. */
export const SOURCE_HEADER = "X-LazyOS-Source";

export interface BridgeOrLocalOptions<T> {
  /** Upstream path (same on Vercel and VPS — these routes mirror). */
  path: string;
  /** Forward these query params to the VPS call. */
  searchParams?: URLSearchParams | null;
  /** Called when the bridge is unavailable (env missing or tunnel down). */
  fallback: () => Promise<Response> | Response;
  /** Optional shape validator — returning `false` triggers the fallback. */
  validate?: (body: unknown) => body is T;
  /** Per-call timeout override. */
  timeoutMs?: number;
}

/**
 * Standard flow for a GET route:
 *   1. If bridge is configured → proxy to VPS.
 *   2. On success → mirror response + `X-LazyOS-Source: vps` header.
 *   3. On failure → call `fallback()`, tag with `X-LazyOS-Degraded`.
 *   4. If bridge is not configured → call `fallback()` silently
 *      (treated as local/dev mode, not a degradation).
 */
export async function bridgeOrLocal<T>(
  opts: BridgeOrLocalOptions<T>,
): Promise<Response> {
  if (!isBridgeConfigured()) {
    // Local / dev path — no bridge intended. Let the fallback own the
    // response without any degraded markers.
    const res = await opts.fallback();
    // We still tag source so UI can reason about provenance.
    const cloned = new NextResponse(res.body, res);
    cloned.headers.set(SOURCE_HEADER, "local");
    return cloned;
  }

  const result = await tryProxyToVps<T>(opts.path, {
    searchParams: opts.searchParams ?? null,
    timeoutMs: opts.timeoutMs,
  });

  if (!result.degraded && result.data !== null) {
    const validated = opts.validate ? opts.validate(result.data) : true;
    if (validated) {
      const res = NextResponse.json(result.data);
      res.headers.set(SOURCE_HEADER, "vps");
      res.headers.set("cache-control", "no-store");
      return res;
    }
  }

  // Degraded path — fallback response, tagged so the UI can show a banner.
  const fallbackRes = await opts.fallback();
  const cloned = new NextResponse(fallbackRes.body, fallbackRes);
  cloned.headers.set(SOURCE_HEADER, "local_fallback");
  cloned.headers.set(DEGRADED_HEADER, degradedHeaderValue(result.reason));
  return cloned;
}

/**
 * Convenience: produce a `{ key: [] }` empty-collection response.
 * Use as a degraded-fallback for list endpoints.
 */
export function emptyCollection(key: string, extra: Record<string, unknown> = {}): Response {
  return NextResponse.json(
    { [key]: [], ...extra },
    { headers: { "cache-control": "no-store" } },
  );
}

/**
 * Convenience: 503 "not found in local fallback" when the resource is
 * id-addressed and we have no local alternative that could be correct.
 */
export function degradedNotFound(resource: string): Response {
  return NextResponse.json(
    { error: "bridge_unavailable", resource },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}
