/**
 * lib/security/__tests__/password.test.ts — scrypt password hashing.
 */

import { describe, expect, it } from "vitest";

import {
  hashPassword,
  verifyPassword,
  isStrongEnough,
  MIN_PASSWORD_LENGTH,
} from "@/lib/security/password";

describe("password hashing", () => {
  it("round-trips the correct password", () => {
    const stored = hashPassword("correct horse battery");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(verifyPassword("correct horse battery", stored)).toBe(true);
  });

  it("rejects the wrong password", () => {
    const stored = hashPassword("correct horse battery");
    expect(verifyPassword("wrong horse battery", stored)).toBe(false);
  });

  it("never stores the plaintext", () => {
    const stored = hashPassword("supersecretvalue");
    expect(stored).not.toContain("supersecretvalue");
  });

  it("produces a different hash each time (random salt)", () => {
    const a = hashPassword("samepassword123");
    const b = hashPassword("samepassword123");
    expect(a).not.toBe(b);
    expect(verifyPassword("samepassword123", a)).toBe(true);
    expect(verifyPassword("samepassword123", b)).toBe(true);
  });

  it("returns false for empty/malformed stored hashes (no crash)", () => {
    expect(verifyPassword("x", null)).toBe(false);
    expect(verifyPassword("x", "")).toBe(false);
    expect(verifyPassword("x", "notscrypt$aa$bb")).toBe(false);
    expect(verifyPassword("x", "scrypt$zz")).toBe(false);
  });

  it("enforces the minimum length", () => {
    expect(isStrongEnough("short")).toBe(false);
    expect(isStrongEnough("a".repeat(MIN_PASSWORD_LENGTH))).toBe(true);
    expect(() => hashPassword("short")).toThrow(/too short/i);
  });
});
