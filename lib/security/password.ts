/**
 * lib/security/password.ts — password hashing for email+password login.
 *
 * scrypt via node:crypto (no extra dependency). Stored format:
 *   scrypt$<saltHex>$<keyHex>
 * Verification is constant-time. Passwords are never logged or returned.
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEYLEN = 64;
export const MIN_PASSWORD_LENGTH = 10;

/** True if the password meets the minimum policy. */
export function isStrongEnough(password: unknown): password is string {
  return typeof password === "string" && password.length >= MIN_PASSWORD_LENGTH;
}

/** Hash a password → `scrypt$<salt>$<key>`. Throws if too short. */
export function hashPassword(password: string): string {
  if (!isStrongEnough(password)) {
    throw new Error(`password too short (min ${MIN_PASSWORD_LENGTH} chars)`);
  }
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEYLEN);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

/** Constant-time verify. False on any malformed/empty stored hash. */
export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored || typeof password !== "string" || password.length === 0) return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[1], "hex");
    expected = Buffer.from(parts[2], "hex");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, expected.length);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
