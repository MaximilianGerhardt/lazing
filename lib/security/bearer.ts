/**
 * Bearer-auth helper. Single source for all 6 API routes that verify bearer
 * tokens (Phase Cons.2). Before: 6× copy-paste of the same regex
 * (`/^Bearer\s+(.+)$/i`) + 6× their own timing-safe comparisons.
 *
 * `extractBearer` only parses the header. `verifyBearer` additionally does
 * the constant-time comparison against a secret. Both work with
 * `Request` and `NextRequest` because we only need `headers.get()`.
 */

const BEARER_RE = /^Bearer\s+(.+)$/i;

export interface RequestLike {
  headers: { get(name: string): string | null };
}

/**
 * Extracts the bearer-token string from the `Authorization` header.
 * Returns `null` if the header is missing or has no bearer scheme.
 */
export function extractBearer(req: RequestLike): string | null {
  const header = req.headers.get('authorization') ?? '';
  const match = BEARER_RE.exec(header.trim());
  if (!match) return null;
  const token = match[1]?.trim();
  return token && token.length > 0 ? token : null;
}

/**
 * Constant-time comparison. Avoids timing side-channels that can
 * arise with string-equality checks.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export type BearerVerificationResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'missing' | 'invalid' | 'not_configured' };

/**
 * Returns `{ok: true}` if the bearer in the header matches `expectedSecret`
 * (timing-safe). `expectedSecret = undefined` yields
 * `not_configured` — the caller decides whether that produces a 503.
 */
export function verifyBearer(
  req: RequestLike,
  expectedSecret: string | undefined,
): BearerVerificationResult {
  if (!expectedSecret) {
    return { ok: false, reason: 'not_configured' };
  }
  const token = extractBearer(req);
  if (!token) {
    return { ok: false, reason: 'missing' };
  }
  if (!timingSafeEqual(token, expectedSecret)) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, token };
}
