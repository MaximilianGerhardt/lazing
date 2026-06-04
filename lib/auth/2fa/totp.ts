/**
 * TOTP core — RFC 6238 via otplib.
 *
 * Sprint 3, 2026-04-30. We use otplib because:
 *   - standards-compliant (RFC 6238 + RFC 4226).
 *   - 0 native deps (unlike the sharp stress with Xenova v2).
 *   - default 30s window, 6-digit code, SHA-1 (compatible with all
 *     authenticator apps: Google, Microsoft, 1Password, Authy, Aegis).
 *
 * Replay guard: counter per user (totp_last_counter). User input is
 * only accepted when counter > last successful counter.
 */

import {
  generateSecret as otpGenerateSecret,
  generateURI as otpGenerateUri,
  verifySync as otpVerifySync,
} from 'otplib';
import * as QRCode from 'qrcode';
import { randomBytes, createHash } from 'node:crypto';
import { BRAND_TWO_FA_ISSUER as BRAND_NAME } from '@/lib/brand';

// The TOTP issuer label comes from the brand module (laz.ing default, rollback
// via ENV LAZYOS_BRAND_NAME=lazyOS). The issuer is only a display label
// in the authenticator app — existing setups with "lazyOS:..." URIs
// stay valid (verify depends only on the secret, not the label).

const TOTP_OPTIONS = {
  step: 30,
  digits: 6,
  algorithm: 'sha1' as const,
  // Toleranz ±1 Step (±30s) gegen leichte Clock-Drift.
  window: 1,
} as const;

/**
 * Generates a new TOTP secret (160 bit = base32 32 chars).
 * The plaintext secret is returned in the setup step — the caller MUST
 * encrypt it via vault before storing.
 */
export function generateSecret(): string {
  return otpGenerateSecret({ length: 20 });
}

/**
 * otpauth URL for the QR code: `otpauth://totp/{issuer}:{label}?secret=...&issuer=...`
 */
export function buildOtpauthUrl(args: {
  secret: string;
  userEmail: string;
}): string {
  return otpGenerateUri({
    secret: args.secret,
    label: args.userEmail,
    issuer: BRAND_NAME,
    digits: TOTP_OPTIONS.digits,
    algorithm: TOTP_OPTIONS.algorithm,
    period: TOTP_OPTIONS.step,
  });
}

/**
 * Render the otpauth URL as a data-URL PNG for the setup page.
 */
export async function buildQrDataUrl(otpauthUrl: string): Promise<string> {
  return await QRCode.toDataURL(otpauthUrl, {
    margin: 1,
    width: 240,
    color: { dark: '#070707', light: '#ffffff' },
  });
}

/**
 * Verifies a 6-digit TOTP input.
 * Returns (ok, currentCounter) — the caller stores the counter when ok=true.
 */
export function verifyTotp(args: {
  secret: string;
  token: string;
  lastCounter: number | null;
}): { ok: boolean; counter: number | null } {
  if (typeof args.token !== 'string' || !/^\d{6}$/.test(args.token)) {
    return { ok: false, counter: null };
  }
  // otplib v13: epochTolerance is the drift-window parameter (seconds,
  // symmetric). 30s = ±1 step. afterTimeStep prevents replay directly
  // in the library (lastCounter is checked below as an additional layer).
  const result = otpVerifySync({
    secret: args.secret,
    token: args.token,
    digits: TOTP_OPTIONS.digits,
    algorithm: TOTP_OPTIONS.algorithm,
    period: TOTP_OPTIONS.step,
    epochTolerance: TOTP_OPTIONS.step * TOTP_OPTIONS.window,
    afterTimeStep: args.lastCounter ?? undefined,
  });
  const ok = typeof result === 'boolean' ? result : !!(result as { valid?: boolean }).valid;
  if (!ok) return { ok: false, counter: null };
  // Derive the counter from the current time step — against replay.
  const currentCounter = Math.floor(Date.now() / 1000 / 30);
  if (args.lastCounter !== null && currentCounter <= args.lastCounter) {
    return { ok: false, counter: null };
  }
  return { ok: true, counter: currentCounter };
}

/**
 * Generates 10 recovery codes in the format `XXXX-XXXX-XXXX` (12 hex chars).
 * Codes are plaintext — the CALLER must show them to the user once AND then
 * store only the hashes (see hashRecoveryCode).
 */
export function generateRecoveryCodes(count = 10): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const buf = randomBytes(6); // 12 hex chars
    const hex = buf.toString('hex').toUpperCase();
    out.push(`${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`);
  }
  return out;
}

/**
 * SHA-256 hash for recovery codes. We use sha256 instead of argon2 because:
 *   - recovery codes have 48 bit entropy → brute-force-resistant without a KDF
 *   - argon2 here would be overkill + forces a native build
 *   - codes are single-use (used_at is set) → no replay
 */
export function hashRecoveryCode(code: string): string {
  const normalized = code.replace(/[-\s]/g, '').toUpperCase();
  return createHash('sha256').update(normalized).digest('hex');
}
