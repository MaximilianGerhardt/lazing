/**
 * In-memory token-bucket rate-limiter for Edge middleware.
 *
 * Key: `${ip}:${routeKey}`. Storage: a bounded LRU (max 10000
 * entries) so one lambda instance can't be memory-bombed by
 * unique IP/route combinations.
 *
 * IMPORTANT: This is per-lambda-instance state. With Vercel's
 * serverless cold-start model an attacker could rotate instances
 * to get higher effective rates. For MVP that's acceptable; the
 * real line of defense is the auth-gate. Phase "post-MVP" should
 * move this to Redis/Upstash.
 */

export interface Bucket {
  /** Current tokens available. */
  tokens: number;
  /** ms timestamp of last refill. */
  lastRefill: number;
}

export interface RateLimitConfig {
  /** Tokens added per minute (steady-state limit). */
  perMinute: number;
  /** Max burst — bucket capacity. */
  burst: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Tokens remaining AFTER this request (0..burst). */
  remaining: number;
  /** Seconds the client should wait before retrying if denied. */
  retryAfterSec: number;
  /** Matches the config that applied, useful for logging. */
  limit: number;
}

const MAX_ENTRIES = 10_000;
const CLEANUP_EVERY_MS = 5 * 60 * 1000; // 5 minutes

interface Store {
  buckets: Map<string, Bucket>;
  lastCleanup: number;
}

// Singleton per lambda. We attach to globalThis so hot-reload in
// dev doesn't duplicate state.
const globalForRL = globalThis as unknown as { __lazyosRL?: Store };

function getStore(): Store {
  if (!globalForRL.__lazyosRL) {
    globalForRL.__lazyosRL = { buckets: new Map(), lastCleanup: Date.now() };
  }
  return globalForRL.__lazyosRL;
}

/**
 * Default policy: 600 req/min, burst 60.
 *
 * Rationale: lazyOS is single-user. Next.js prefetches many routes at once
 * when hovering links (up to 20 parallel) — with the old
 * default 60/min burst 10 it hits the cap immediately. Since auth + bridge-bearer
 * are the real defense (rate limiting is only against blunt-force login),
 * we set this generously. The login endpoint stays strict.
 */
export const DEFAULT_POLICY: RateLimitConfig = { perMinute: 600, burst: 60 };

/** Per-route overrides. Only the exact route-key matches. */
export const ROUTE_POLICIES: Record<string, RateLimitConfig> = {
  // Login stays strict — that is the actual brute-force protection.
  "POST:/api/auth/login": { perMinute: 10, burst: 5 },
  // Chat can run long but is not started often.
  "POST:/api/chat/stream": { perMinute: 60, burst: 10 },
  "GET:/api/chat/stream": { perMinute: 60, burst: 10 },
  // Event emit comes from the agent itself, high throughput is ok.
  "POST:/api/events/emit": { perMinute: 600, burst: 60 },
  // The SSE stream is reopened on reconnect, higher tolerance.
  "GET:/api/events/stream": { perMinute: 120, burst: 10 },
  "POST:/api/feedback": { perMinute: 30, burst: 5 },
};

/**
 * Prefix policies (startsWith) — apply when NO exact route key matches.
 * Necessary for routes with a dynamic path segment (e.g. token in the URL):
 * their `pathname` contains the token, so no exact key matches and they
 * would otherwise fall back to the generous DEFAULT_POLICY (600/min).
 *
 * SECURITY (P0 #4, 2026-06-03): the EXTERNAL sub-chat endpoints are
 * UNAUTHENTICATED (token = auth) and publicly reachable. They must NOT
 * get the single-user DEFAULT. Order matters — more specific (longer)
 * prefixes first. Method '*' matches any method.
 */
interface PrefixPolicy {
  method: string | "*";
  prefix: string;
  config: RateLimitConfig;
}
export const PREFIX_POLICIES: PrefixPolicy[] = [
  // External upload (anonymous guest): in addition to the in-route stopgap (8/min)
  // a hard edge cap here.
  { method: "POST", prefix: "/api/subchats/external/", config: { perMinute: 20, burst: 8 } },
  // External posting / token-resolve / media / SSE reconnect (GET+other): moderate.
  // SSE holds ONE long connection (1 request); polling fallback ~15/min; media
  // a few per message — 120/min burst 24 is generous enough, but not a
  // blunt-force gateway.
  { method: "*", prefix: "/api/subchats/external/", config: { perMinute: 120, burst: 24 } },
  // Throttle public share-token pages/API (no login) as well.
  { method: "*", prefix: "/api/share/", config: { perMinute: 120, burst: 24 } },
];

export function policyFor(method: string, pathname: string): RateLimitConfig {
  const key = `${method}:${pathname}`;
  const exact = ROUTE_POLICIES[key];
  if (exact) return exact;
  for (const p of PREFIX_POLICIES) {
    if (p.method !== "*" && p.method !== method) continue;
    if (pathname.startsWith(p.prefix)) return p.config;
  }
  return DEFAULT_POLICY;
}

/** Remove buckets idle for > 15 min. Keeps the map bounded. */
function maybeCleanup(store: Store, now: number): void {
  if (now - store.lastCleanup < CLEANUP_EVERY_MS) return;
  store.lastCleanup = now;
  const cutoff = now - 15 * 60 * 1000;
  for (const [key, bucket] of store.buckets) {
    if (bucket.lastRefill < cutoff) store.buckets.delete(key);
  }
  // Hard cap — if we're still over the limit, drop oldest.
  if (store.buckets.size > MAX_ENTRIES) {
    const excess = store.buckets.size - MAX_ENTRIES;
    const iter = store.buckets.keys();
    for (let i = 0; i < excess; i += 1) {
      const next = iter.next();
      if (next.done) break;
      store.buckets.delete(next.value);
    }
  }
}

export function checkRateLimit(
  key: string,
  config: RateLimitConfig,
  now: number = Date.now(),
): RateLimitResult {
  const store = getStore();
  maybeCleanup(store, now);

  let bucket = store.buckets.get(key);
  if (!bucket) {
    bucket = { tokens: config.burst, lastRefill: now };
    store.buckets.set(key, bucket);
  } else {
    // LRU refresh: delete + re-insert so most-recent stays at the tail.
    store.buckets.delete(key);
    store.buckets.set(key, bucket);
  }

  // Refill based on time elapsed.
  const elapsed = Math.max(0, now - bucket.lastRefill);
  const refill = (elapsed / 60_000) * config.perMinute;
  bucket.tokens = Math.min(config.burst, bucket.tokens + refill);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return {
      allowed: true,
      remaining: Math.floor(bucket.tokens),
      retryAfterSec: 0,
      limit: config.perMinute,
    };
  }

  // Need `1 - tokens` to become available; each token costs 60/perMinute seconds.
  const missing = 1 - bucket.tokens;
  const retryAfterSec = Math.max(
    1,
    Math.ceil((missing * 60) / config.perMinute),
  );
  return {
    allowed: false,
    remaining: 0,
    retryAfterSec,
    limit: config.perMinute,
  };
}

/** Test-only reset hook. */
export function __resetRateLimitForTests(): void {
  const store = getStore();
  store.buckets.clear();
  store.lastCleanup = Date.now();
}
