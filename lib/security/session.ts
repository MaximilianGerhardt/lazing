/**
 * Session cookie helpers.
 *
 * Cookie: `lazyos_session`
 *
 * Format Phase ORG (2026-04-27):
 *   `<issuedAtMs>.<userId>.<hmacHex>`
 *   hmacHex = HMAC_SHA256(LAZYOS_AUTH_SECRET, `${issuedAtMs}.${userId}.${LAZYOS_ACCESS_CODE}`)
 *
 * Legacy format (Phase 0..ORG-1):
 *   `<issuedAtMs>.<hmacHex>`
 *   hmacHex = HMAC_SHA256(LAZYOS_AUTH_SECRET, `${issuedAtMs}.${LAZYOS_ACCESS_CODE}`)
 *
 * We accept both. Legacy cookies are assigned the synthetic
 * `userId="max-bootstrap"` — the SP-9 backfill maps the real
 * ULID into it. The cookie-format migration is transparent: the user stays
 * logged in, no forced logout.
 *
 * Cookie ist HttpOnly + Secure + SameSite=Lax, 30 days TTL.
 *
 * Edge-runtime safe (uses Web-Crypto via lib/security/crypto).
 */

import { hmacSha256Hex, hmacSha256Verify } from "./crypto";

export const SESSION_COOKIE = "lazyos_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Bootstrap user ID for legacy cookies + owner bootstrap.
 * The SP-9 backfill replaces it with the real `users.id` ULID.
 */
export const BOOTSTRAP_USER_ID = "max-bootstrap";

export interface SessionConfig {
  accessCode: string;
  authSecret: string;
}

/** Reads env into a validated config, or null if not configured. */
export function readSessionConfig(): SessionConfig | null {
  const accessCode = process.env.LAZYOS_ACCESS_CODE;
  const authSecret = process.env.LAZYOS_AUTH_SECRET;
  if (!accessCode || accessCode.length < 16) return null;
  if (!authSecret || authSecret.length < 16) return null;
  return { accessCode, authSecret };
}

function legacyMessage(issuedAtMs: number, accessCode: string): string {
  return `${issuedAtMs}.${accessCode}`;
}

function userBoundMessage(
  issuedAtMs: number,
  userId: string,
  accessCode: string,
): string {
  return `${issuedAtMs}.${userId}.${accessCode}`;
}

/**
 * Issues the new format with a userId claim.
 * If `userId` is omitted, falls back to BOOTSTRAP_USER_ID — still used in
 * the SP-2 login refactor for the owner-access-code branch
 * before the real user exists in the DB.
 */
export async function issueSessionCookieValue(
  config: SessionConfig,
  opts: { issuedAtMs?: number; userId?: string } | number = {},
): Promise<string> {
  // Backwards-compat: callers that passed a number as the 2nd arg
  // (legacy issueSessionCookieValue(config, issuedAtMs)) are tolerated
  // here; we treat the number as issuedAtMs without a userId claim.
  const o =
    typeof opts === "number" ? { issuedAtMs: opts } : opts;
  const issuedAtMs = o.issuedAtMs ?? Date.now();
  const userId = o.userId ?? BOOTSTRAP_USER_ID;
  const sig = await hmacSha256Hex(
    config.authSecret,
    userBoundMessage(issuedAtMs, userId, config.accessCode),
  );
  return `${issuedAtMs}.${userId}.${sig}`;
}

export interface VerifyResult {
  ok: boolean;
  reason?: "missing" | "malformed" | "expired" | "bad_signature" | "not_configured";
  issuedAtMs?: number;
  /** Phase ORG: set both for the new format and for legacy mapping. */
  userId?: string;
  /** Marker so the caller knows whether the token is still in the legacy format. */
  legacy?: boolean;
}

export async function verifySessionCookieValue(
  raw: string | undefined,
  config: SessionConfig,
  now: number = Date.now(),
): Promise<VerifyResult> {
  if (!raw) return { ok: false, reason: "missing" };
  const parts = raw.split(".");
  if (parts.length !== 2 && parts.length !== 3) {
    return { ok: false, reason: "malformed" };
  }
  const issuedAtStr = parts[0];
  const issuedAtMs = Number.parseInt(issuedAtStr ?? "", 10);
  if (!Number.isFinite(issuedAtMs) || issuedAtMs <= 0) {
    return { ok: false, reason: "malformed" };
  }
  if (now - issuedAtMs > SESSION_TTL_MS) {
    return { ok: false, reason: "expired" };
  }
  if (issuedAtMs > now + 60_000) {
    return { ok: false, reason: "malformed" };
  }

  if (parts.length === 3) {
    // New format: <ts>.<userId>.<sig>
    const [, userId, sigHex] = parts as [string, string, string];
    if (!userId || userId.length === 0 || userId.length > 64) {
      return { ok: false, reason: "malformed" };
    }
    const ok = await hmacSha256Verify(
      config.authSecret,
      userBoundMessage(issuedAtMs, userId, config.accessCode),
      sigHex,
    );
    if (!ok) return { ok: false, reason: "bad_signature" };
    return { ok: true, issuedAtMs, userId };
  }

  // Legacy format: <ts>.<sig> — verifizieren mit altem Message-Schema,
  // mappen auf BOOTSTRAP_USER_ID.
  const [, sigHex] = parts as [string, string];
  const ok = await hmacSha256Verify(
    config.authSecret,
    legacyMessage(issuedAtMs, config.accessCode),
    sigHex,
  );
  if (!ok) return { ok: false, reason: "bad_signature" };
  return { ok: true, issuedAtMs, userId: BOOTSTRAP_USER_ID, legacy: true };
}

/**
 * Build a `Set-Cookie` header value for the session cookie.
 *
 * `isSecure` defaults to `true` — we always require HTTPS in production.
 * Pass `false` only for local-dev HTTP if you explicitly need it.
 */
export function sessionSetCookieHeader(
  value: string,
  opts: { maxAgeSec?: number; isSecure?: boolean } = {},
): string {
  const maxAge = opts.maxAgeSec ?? Math.floor(SESSION_TTL_MS / 1000);
  const secure = opts.isSecure !== false;
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    `Path=/`,
    `Max-Age=${maxAge}`,
    `HttpOnly`,
    `SameSite=Lax`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookieHeader(isSecure = true): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    `Path=/`,
    `Max-Age=0`,
    `HttpOnly`,
    `SameSite=Lax`,
  ];
  if (isSecure) parts.push("Secure");
  return parts.join("; ");
}

/** Parse a `Cookie` header and return the session cookie value. */
export function readSessionCookie(
  cookieHeader: string | null | undefined,
): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${SESSION_COOKIE}=`)) {
      return trimmed.slice(SESSION_COOKIE.length + 1);
    }
  }
  return undefined;
}
