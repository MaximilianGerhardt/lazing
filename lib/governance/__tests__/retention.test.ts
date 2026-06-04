/**
 * Lane G Governance — retention.ts Tests.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_RETENTION_POLICY,
  isExpired,
  retentionDaysForLevel,
  retentionExpiresAt,
} from "@/lib/governance/retention";

describe("Lane G · retention.ts", () => {
  it("DEFAULT_RETENTION_POLICY: documented owner values", () => {
    expect(DEFAULT_RETENTION_POLICY.rawDataDays).toBe(30);
    expect(DEFAULT_RETENTION_POLICY.derivedDataDays).toBe(365);
    expect(DEFAULT_RETENTION_POLICY.auditRetentionDays).toBe(2555); // ≈ 7 Jahre
    expect(DEFAULT_RETENTION_POLICY.consentRevocationGracePeriodDays).toBe(14);
  });

  it("isExpired: deterministic with nowMs", () => {
    const created = 1_000_000;
    const oneDay = 86_400_000;
    expect(isExpired(created, 30, created + 29 * oneDay)).toBe(false);
    expect(isExpired(created, 30, created + 31 * oneDay)).toBe(true);
  });

  it("isExpired: invalid args → false (fail-soft)", () => {
    expect(isExpired(NaN, 30, 100)).toBe(false);
    expect(isExpired(100, 0, 100)).toBe(false);
    expect(isExpired(100, -1, 100)).toBe(false);
  });

  it("retentionExpiresAt: deterministic addition", () => {
    expect(retentionExpiresAt(1000, 30)).toBe(1000 + 30 * 86_400_000);
    expect(retentionExpiresAt(NaN, 30)).toBe(Number.POSITIVE_INFINITY);
  });

  it("retentionDaysForLevel: raw vs derived", () => {
    expect(retentionDaysForLevel("none")).toBe(30);
    expect(retentionDaysForLevel("read-only")).toBe(30);
    expect(retentionDaysForLevel("read-derive")).toBe(365);
    expect(retentionDaysForLevel("read-derive-act")).toBe(365);
    expect(retentionDaysForLevel("full-automation")).toBe(365);
  });
});
