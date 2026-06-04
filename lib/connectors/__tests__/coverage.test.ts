// Connector Coverage Validator + Onboarding tests — ACL-4 · 2026-05-24.
//
// Tests cover:
//   (a) required ⊆ profile → ok: true, missing: [], extra annotated
//   (b) missing capability → ok: false, missing[] populated
//   (c) null/empty/undefined profile → fail-closed ok: false (multiple variants)
//   (d) version drift detection (declaredVersion ≠ profileVersion → drift: true)
//   (e) versionMatch flag in CoverageResult vs. checkVersion param
//   (f) extra capabilities are informational (do NOT affect ok)
//   (g) empty requiredCapabilities against a valid profile → ok: true (vacuous)
//   (h) persistDiscoveredProfile: delegates to guard + upsert
//   (i) persistDiscoveredProfile with PII → throws CONNECTOR_PII_GUARD
//
// Strategy: coverage.ts is pure (no I/O). We test it directly.
//           onboarding.ts calls catalog.ts — we vi.mock the catalog to avoid
//           needing a real DB for the onboarding tests.
//
// Run:
//   NODE_OPTIONS='--experimental-require-module' npx vitest run \
//     lib/connectors/__tests__/coverage.test.ts

import { describe, expect, it, vi } from "vitest";
import {
  validateCoverage,
  detectVersionDrift,
  type ValidatableProfile,
} from "../coverage";

// ---------------------------------------------------------------------------
// coverage.ts tests
// ---------------------------------------------------------------------------

describe("validateCoverage — ACL-4 Coverage Validator (N6 deterministic)", () => {
  // ─────────────────────────────────────────────────────────────────────────
  // (a) required ⊆ profile → ok: true
  // ─────────────────────────────────────────────────────────────────────────

  describe("(a) required ⊆ profile → ok: true", () => {
    it("all required capabilities present → ok: true, missing: []", () => {
      const profile: ValidatableProfile = {
        provider: "heygen",
        apiVersion: "v2",
        capabilities: [
          { name: "render_video" },
          { name: "list_avatars" },
          { name: "generate_script" },
        ],
      };

      const result = validateCoverage(["render_video", "list_avatars"], profile);

      expect(result.ok).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it("extra profile capabilities are listed in extra[] but ok remains true", () => {
      const profile: ValidatableProfile = {
        provider: "heygen",
        capabilities: [
          { name: "render_video" },
          { name: "list_avatars" },
          { name: "extra_cap_1" },
          { name: "extra_cap_2" },
        ],
      };

      const result = validateCoverage(["render_video"], profile);

      expect(result.ok).toBe(true);
      expect(result.missing).toEqual([]);
      expect(result.extra).toContain("list_avatars");
      expect(result.extra).toContain("extra_cap_1");
      expect(result.extra).toContain("extra_cap_2");
      expect(result.extra).not.toContain("render_video");
    });

    it("exact match (required set = profile set) → ok: true, extra: []", () => {
      const profile: ValidatableProfile = {
        provider: "stripe",
        capabilities: [{ name: "create_charge" }, { name: "list_charges" }],
      };

      const result = validateCoverage(["create_charge", "list_charges"], profile);

      expect(result.ok).toBe(true);
      expect(result.missing).toEqual([]);
      expect(result.extra).toEqual([]);
    });

    it("empty required set against any valid profile → ok: true (vacuous)", () => {
      const profile: ValidatableProfile = {
        provider: "openai",
        capabilities: [{ name: "chat_completion" }],
      };

      const result = validateCoverage([], profile);

      expect(result.ok).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it("empty required set against empty profile → ok: true (vacuous — no requirements)", () => {
      const profile: ValidatableProfile = {
        provider: "empty-provider",
        capabilities: [],
      };

      const result = validateCoverage([], profile);

      expect(result.ok).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (b) missing capability → ok: false
  // ─────────────────────────────────────────────────────────────────────────

  describe("(b) missing capability → ok: false", () => {
    it("one required capability absent from profile → ok: false + missing populated", () => {
      const profile: ValidatableProfile = {
        provider: "heygen",
        capabilities: [{ name: "list_avatars" }],
      };

      const result = validateCoverage(["render_video", "list_avatars"], profile);

      expect(result.ok).toBe(false);
      expect(result.missing).toContain("render_video");
      expect(result.missing).not.toContain("list_avatars");
    });

    it("multiple missing capabilities all appear in missing[]", () => {
      const profile: ValidatableProfile = {
        provider: "heygen",
        capabilities: [{ name: "list_avatars" }],
      };

      const result = validateCoverage(
        ["render_video", "generate_script", "list_avatars", "delete_video"],
        profile,
      );

      expect(result.ok).toBe(false);
      expect(result.missing).toContain("render_video");
      expect(result.missing).toContain("generate_script");
      expect(result.missing).toContain("delete_video");
      expect(result.missing).not.toContain("list_avatars");
      expect(result.missing).toHaveLength(3);
    });

    it("required capability against profile with no capabilities array → ok: false", () => {
      const profile: ValidatableProfile = {
        provider: "heygen",
        capabilities: undefined,
      };

      const result = validateCoverage(["render_video"], profile);

      expect(result.ok).toBe(false);
      expect(result.missing).toContain("render_video");
    });

    it("required capability against profile with empty capabilities array → ok: false", () => {
      const profile: ValidatableProfile = {
        provider: "heygen",
        capabilities: [],
      };

      const result = validateCoverage(["render_video"], profile);

      expect(result.ok).toBe(false);
      expect(result.missing).toContain("render_video");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (c) null/empty/undefined profile → fail-closed ok: false
  // ─────────────────────────────────────────────────────────────────────────

  describe("(c) null/empty/undefined profile → fail-closed ok: false", () => {
    it("null profile → ok: false (fail-closed)", () => {
      const result = validateCoverage(["render_video"], null);

      expect(result.ok).toBe(false);
      expect(result.missing).toContain("render_video");
      expect(result.extra).toEqual([]);
    });

    it("undefined profile → ok: false (fail-closed)", () => {
      const result = validateCoverage(["render_video"], undefined);

      expect(result.ok).toBe(false);
      expect(result.missing).toContain("render_video");
    });

    it("null profile with empty required set → ok: false (null profile is always fail-closed)", () => {
      // Even with no requirements, a null profile signals 'unknown connector'.
      // But per the contract: empty requirements → vacuously ok when profile is non-null.
      // null profile overrides the vacuous-true rule — fail-closed.
      const result = validateCoverage([], null);

      // Rationale: we don't know anything about the null profile.
      // missing[] will be empty (no requirements), but ok is still false
      // because the profile itself is absent.
      // Actually per implementation: null profile returns missing = [...requiredCapabilities]
      // and when requiredCapabilities is [], missing = []. But ok is still false
      // because we explicitly set ok: false for null profiles regardless.
      expect(result.ok).toBe(false);
      expect(result.missing).toEqual([]);
    });

    it("null profile — versionMatch is false when checkVersion is provided", () => {
      const result = validateCoverage(["cap"], null, "v1");

      expect(result.ok).toBe(false);
      expect(result.versionMatch).toBe(false);
    });

    it("null profile — versionMatch is true when no checkVersion provided", () => {
      const result = validateCoverage(["cap"], null);

      expect(result.ok).toBe(false);
      // No checkVersion → versionMatch vacuously true
      expect(result.versionMatch).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (d) version drift detection
  // ─────────────────────────────────────────────────────────────────────────

  describe("(d) detectVersionDrift", () => {
    it("different versions → drift: true", () => {
      expect(detectVersionDrift("v1", "v2")).toBe(true);
    });

    it("same version → drift: false", () => {
      expect(detectVersionDrift("v2", "v2")).toBe(false);
    });

    it("date-string versions differ → drift: true", () => {
      expect(detectVersionDrift("2024-01-01", "2024-06-20")).toBe(true);
    });

    it("date-string versions match → drift: false", () => {
      expect(detectVersionDrift("2024-06-20", "2024-06-20")).toBe(false);
    });

    it("null declaredVersion → drift: false (unknown, not detectable)", () => {
      expect(detectVersionDrift(null, "v2")).toBe(false);
    });

    it("null profileVersion → drift: false (unknown, not detectable)", () => {
      expect(detectVersionDrift("v1", null)).toBe(false);
    });

    it("both null → drift: false", () => {
      expect(detectVersionDrift(null, null)).toBe(false);
    });

    it("empty string versions → drift: false (treated as unknown)", () => {
      expect(detectVersionDrift("", "v2")).toBe(false);
      expect(detectVersionDrift("v1", "")).toBe(false);
    });

    it("versions with surrounding whitespace compare correctly after trim", () => {
      expect(detectVersionDrift("v1 ", " v1")).toBe(false);
      expect(detectVersionDrift("v1 ", " v2")).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (e) versionMatch flag in CoverageResult
  // ─────────────────────────────────────────────────────────────────────────

  describe("(e) versionMatch in CoverageResult", () => {
    const baseProfile: ValidatableProfile = {
      provider: "heygen",
      apiVersion: "v2",
      capabilities: [{ name: "render_video" }],
    };

    it("checkVersion matches profile.apiVersion → versionMatch: true", () => {
      const result = validateCoverage(["render_video"], baseProfile, "v2");
      expect(result.versionMatch).toBe(true);
    });

    it("checkVersion differs from profile.apiVersion → versionMatch: false", () => {
      const result = validateCoverage(["render_video"], baseProfile, "v1");
      expect(result.versionMatch).toBe(false);
    });

    it("no checkVersion provided → versionMatch: true (vacuous)", () => {
      const result = validateCoverage(["render_video"], baseProfile);
      expect(result.versionMatch).toBe(true);
    });

    it("versionMatch: false does NOT affect ok (informational only)", () => {
      // ok should still be true because render_video is present
      const result = validateCoverage(["render_video"], baseProfile, "v1");
      expect(result.ok).toBe(true);
      expect(result.versionMatch).toBe(false);
    });

    it("profile with no apiVersion + checkVersion provided → versionMatch: false", () => {
      const profile: ValidatableProfile = {
        provider: "heygen",
        apiVersion: null,
        capabilities: [{ name: "render_video" }],
      };
      const result = validateCoverage(["render_video"], profile, "v2");
      expect(result.versionMatch).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (f) extra capabilities informational
  // ─────────────────────────────────────────────────────────────────────────

  describe("(f) extra capabilities are informational — do NOT affect ok", () => {
    it("profile has many more caps than required — ok: true", () => {
      const profile: ValidatableProfile = {
        provider: "stripe",
        capabilities: [
          { name: "create_charge" },
          { name: "list_charges" },
          { name: "create_refund" },
          { name: "list_customers" },
          { name: "create_customer" },
          { name: "update_customer" },
          { name: "delete_customer" },
        ],
      };

      const result = validateCoverage(["create_charge"], profile);

      expect(result.ok).toBe(true);
      expect(result.extra).toHaveLength(6);
      expect(result.missing).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// onboarding.ts tests — uses vi.mock to avoid real DB
// ---------------------------------------------------------------------------

vi.mock("../catalog", () => ({
  assertNonSensitiveProfile: vi.fn((profile: Record<string, unknown>) => {
    // Replicate the guard logic for 'token' and 'workspace_id'
    const FORBIDDEN = new Set([
      "workspace_id", "workspaceId", "org_id", "orgId", "user_id", "userId",
      "email", "token", "secret", "api_key", "apiKey", "credential", "credentials",
      "password", "private_key", "privateKey", "access_token", "accessToken",
      "refresh_token", "refreshToken", "client_secret", "clientSecret",
    ]);
    for (const key of Object.keys(profile)) {
      if (FORBIDDEN.has(key)) {
        const err = new Error(`[CONNECTOR_PII_GUARD] Forbidden key: ${key}`);
        (err as Error & { code: string }).code = "CONNECTOR_PII_GUARD";
        throw err;
      }
    }
    // Also check caps
    const caps = profile["capabilities"] as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(caps)) {
      for (const cap of caps) {
        for (const key of Object.keys(cap)) {
          if (FORBIDDEN.has(key)) {
            const err = new Error(`[CONNECTOR_PII_GUARD] Forbidden key in capability: ${key}`);
            (err as Error & { code: string }).code = "CONNECTOR_PII_GUARD";
            throw err;
          }
        }
      }
    }
  }),
  upsertConnectorProfile: vi.fn((profile: Record<string, unknown>) => ({
    id: "CONN-MOCK-001",
    provider: profile["provider"],
    displayName: profile["displayName"],
    description: null,
    authKind: "api_key",
    baseUrl: null,
    apiVersion: null,
    docsUrl: null,
    source: "doc-research",
    validatedAt: null,
    contentHash: "aaaa0000bbbb1111cccc2222dddd3333eeee4444ffff5555aaaa0000bbbb1111",
    createdAt: 1716000000000,
    updatedAt: 1716000000000,
  })),
}));

// Import AFTER vi.mock so the mocked catalog is used
import { persistDiscoveredProfile } from "../onboarding";
import { assertNonSensitiveProfile, upsertConnectorProfile } from "../catalog";

describe("persistDiscoveredProfile — ACL-4 Onboarding Write Path", () => {
  // ─────────────────────────────────────────────────────────────────────────
  // (h) persistDiscoveredProfile: delegates to guard + upsert
  // ─────────────────────────────────────────────────────────────────────────

  describe("(h) clean profile → delegates to assertNonSensitiveProfile + upsertConnectorProfile", () => {
    it("calls assertNonSensitiveProfile first with the raw profile", () => {
      const profile = {
        provider: "heygen",
        displayName: "HeyGen Video API",
        authKind: "api_key" as const,
        source: "doc-research" as const,
        capabilities: [
          { name: "render_video", description: "Render a video", required: true },
        ],
      };

      persistDiscoveredProfile(profile);

      expect(assertNonSensitiveProfile).toHaveBeenCalledWith(profile);
    });

    it("calls upsertConnectorProfile after the guard passes", () => {
      const profile = {
        provider: "stripe",
        displayName: "Stripe Payments API",
        authKind: "api_key" as const,
        baseUrl: "https://api.stripe.com",
        apiVersion: "2024-06-20",
        source: "doc-research" as const,
      };

      const result = persistDiscoveredProfile(profile);

      expect(upsertConnectorProfile).toHaveBeenCalledWith(profile);
      expect(result.provider).toBe("stripe");
      // Returns a catalog row with id and content_hash
      expect(result.id).toBeDefined();
      expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("returns the ConnectorCatalogRow from upsertConnectorProfile", () => {
      const profile = {
        provider: "openai",
        displayName: "OpenAI API",
      };

      const row = persistDiscoveredProfile(profile);

      expect(row).toBeDefined();
      expect(row.id).toBe("CONN-MOCK-001");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (i) PII injection → throws CONNECTOR_PII_GUARD
  // ─────────────────────────────────────────────────────────────────────────

  describe("(i) profile with PII → throws before any write", () => {
    it("token key in profile → throws CONNECTOR_PII_GUARD", () => {
      expect(() =>
        persistDiscoveredProfile({
          provider: "heygen",
          displayName: "HeyGen",
          // @ts-expect-error -- deliberate PII injection test
          token: "live-api-key-value",
        }),
      ).toThrow("CONNECTOR_PII_GUARD");
    });

    it("workspace_id in profile → throws CONNECTOR_PII_GUARD", () => {
      expect(() =>
        persistDiscoveredProfile({
          provider: "heygen",
          displayName: "HeyGen",
          // @ts-expect-error -- deliberate PII injection test
          workspace_id: "ws-123",
        }),
      ).toThrow("CONNECTOR_PII_GUARD");
    });

    it("credential in capabilities → throws CONNECTOR_PII_GUARD", () => {
      expect(() =>
        persistDiscoveredProfile({
          provider: "heygen",
          displayName: "HeyGen",
          capabilities: [
            // @ts-expect-error -- deliberate PII injection test
            { name: "render_video", credential: "bearer-token" },
          ],
        }),
      ).toThrow("CONNECTOR_PII_GUARD");
    });

    it("upsertConnectorProfile is NOT called when guard throws", () => {
      vi.clearAllMocks();

      try {
        persistDiscoveredProfile({
          provider: "poisoned",
          displayName: "Poisoned",
          // @ts-expect-error -- deliberate PII injection test
          email: "user@example.com",
        });
      } catch {
        // expected
      }

      expect(upsertConnectorProfile).not.toHaveBeenCalled();
    });
  });
});
