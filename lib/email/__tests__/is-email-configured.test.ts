/**
 * lib/email/__tests__/is-email-configured.test.ts
 *
 * isEmailConfigured() gates whether the login UI offers the passwordless
 * magic-link. "Configured" must mean a provider that can actually deliver mail:
 * provider=resend AND an API key present. The `null`/`console` provider only
 * logs, so it must count as NOT configured.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isEmailConfigured } from "@/lib/email/send";

const KEYS = [
  "LAZYOS_EMAIL_PROVIDER",
  "RESEND_API_KEY",
  "LAZYOS_RESEND_API_KEY",
] as const;

describe("isEmailConfigured", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("is false by default (no provider set → null provider)", () => {
    expect(isEmailConfigured()).toBe(false);
  });

  it("is false for the explicit null/console provider even with a key", () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.LAZYOS_EMAIL_PROVIDER = "null";
    expect(isEmailConfigured()).toBe(false);
    process.env.LAZYOS_EMAIL_PROVIDER = "console";
    expect(isEmailConfigured()).toBe(false);
  });

  it("is false for provider=resend without any key", () => {
    process.env.LAZYOS_EMAIL_PROVIDER = "resend";
    expect(isEmailConfigured()).toBe(false);
  });

  it("is true for provider=resend with RESEND_API_KEY", () => {
    process.env.LAZYOS_EMAIL_PROVIDER = "resend";
    process.env.RESEND_API_KEY = "re_test_key";
    expect(isEmailConfigured()).toBe(true);
  });

  it("is true for provider=resend with the legacy LAZYOS_RESEND_API_KEY", () => {
    process.env.LAZYOS_EMAIL_PROVIDER = "resend";
    process.env.LAZYOS_RESEND_API_KEY = "re_legacy_key";
    expect(isEmailConfigured()).toBe(true);
  });

  it("treats a whitespace-only key as not configured", () => {
    process.env.LAZYOS_EMAIL_PROVIDER = "resend";
    process.env.RESEND_API_KEY = "   ";
    expect(isEmailConfigured()).toBe(false);
  });
});
