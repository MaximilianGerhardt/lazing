/**
 * Types shared by the VPS-Bridge layer.
 *
 * See `proxy.ts` for the fetch helper, and the route-level adapters in
 * `app/api/**` for consumers.
 */

export interface VpsBridgeConfig {
  /** Base URL of the VPS Next.js instance (via Cloudflare tunnel or direct). */
  baseUrl: string;
  /** Bearer secret accepted by the VPS middleware bridge-gate. */
  secret: string;
}

export interface ProxyOptions {
  /** Per-call timeout in ms. Defaults to 10_000. */
  timeoutMs?: number;
  /** Optional overrides. If omitted, env is read via `readBridgeConfig()`. */
  config?: VpsBridgeConfig;
  /**
   * When true, non-2xx responses will throw instead of returning the parsed
   * body. Default: `true` — we generally want a clean typed result on happy
   * path. Set `false` when the caller wants to inspect status manually.
   */
  throwOnNonOk?: boolean;
  /** Forwarded to the underlying `fetch` call. */
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  /** If `true`, forward `?query=...` from the incoming request (caller sets it). */
  searchParams?: URLSearchParams | null;
}

export class BridgeNotConfiguredError extends Error {
  constructor() {
    super("vps_bridge_not_configured");
    this.name = "BridgeNotConfiguredError";
  }
}

export class BridgeUnavailableError extends Error {
  readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "BridgeUnavailableError";
    this.cause = cause;
  }
}

export class BridgeHttpError extends Error {
  readonly status: number;
  readonly responseBody: string;
  constructor(status: number, body: string) {
    super(`bridge_http_${status}`);
    this.name = "BridgeHttpError";
    this.status = status;
    this.responseBody = body;
  }
}
