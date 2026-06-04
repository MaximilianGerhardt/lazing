/**
 * Dedup-Tests — Integration gegen in-memory SQLite.
 *
 * Run: `pnpm exec tsx --test lib/push/dedup.test.ts`
 *
 * Note: setzt LAZYOS_DB_PATH auf eine tmp-Datei, damit wir nicht die
 * lokale Dev-DB verschmutzen.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";

// Set DB path BEFORE importing dedup (getDb() reads env on first call).
// Using require.resolve'd path would defeat the purpose — we need env set
// at module eval. Tests must run with LAZYOS_DB_PATH pre-set by the caller
// (the suite below sets it via a dynamic require pattern).
if (!process.env.LAZYOS_DB_PATH) {
  process.env.LAZYOS_DB_PATH = join(
    mkdtempSync(join(tmpdir(), "lazyos-dedup-")),
    "dedup-test.db",
  );
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const dedup = require("./dedup") as typeof import("./dedup");
const {
  __resetPushStateForTests,
  checkAndRegisterDedup,
  checkGlobalCap,
  checkRuleRateLimit,
  recordAudit,
  recordPush,
  maxPushesPerDay,
} = dedup;

describe("dedup · checkAndRegisterDedup", () => {
  before(() => __resetPushStateForTests());

  it("erster Call ist NICHT duplicate", () => {
    const r = checkAndRegisterDedup("k1", "rule-a", 1_000);
    assert.equal(r.isDuplicate, false);
  });

  it("zweiter Call mit selbem Key innerhalb window IST duplicate", () => {
    const r = checkAndRegisterDedup("k1", "rule-a", 2_000);
    assert.equal(r.isDuplicate, true);
    assert.equal(r.firstSeenAt, 1_000);
  });

  it("nach window-expiry ist es wieder NICHT duplicate", () => {
    const future = 1_000 + 5 * 60 * 1000 + 1;
    const r = checkAndRegisterDedup("k1", "rule-a", future);
    assert.equal(r.isDuplicate, false);
  });

  it("verschiedene Keys sind unabhängig", () => {
    const r1 = checkAndRegisterDedup("k2", "rule-a", 3_000);
    const r2 = checkAndRegisterDedup("k3", "rule-a", 3_000);
    assert.equal(r1.isDuplicate, false);
    assert.equal(r2.isDuplicate, false);
  });
});

describe("dedup · global cap + recordPush", () => {
  before(() => __resetPushStateForTests());

  it("unter Cap erlaubt", () => {
    const c = checkGlobalCap(1_700_000_000_000);
    assert.equal(c.allowed, true);
    assert.equal(c.count, 0);
    assert.equal(c.max, maxPushesPerDay());
  });

  it("recordPush incrementiert den Tages-Counter", () => {
    for (let i = 0; i < 5; i++) {
      recordPush("rule-x", undefined, 1_700_000_000_000);
    }
    const c = checkGlobalCap(1_700_000_000_000);
    assert.equal(c.count, 5);
    assert.equal(c.allowed, true);
  });
});

describe("dedup · rule rate-limit", () => {
  before(() => __resetPushStateForTests());

  it("erste 3 Calls innerhalb window allowed", () => {
    const now = 2_000_000;
    recordPush("rule-y", 60_000, now);
    recordPush("rule-y", 60_000, now);
    recordPush("rule-y", 60_000, now);
    const r = checkRuleRateLimit("rule-y", 60_000, 5, now);
    assert.equal(r.allowed, true);
    assert.equal(r.count, 3);
  });

  it("überschreiten → not allowed", () => {
    const now = 2_000_000;
    recordPush("rule-y", 60_000, now);
    recordPush("rule-y", 60_000, now);
    const r = checkRuleRateLimit("rule-y", 60_000, 5, now);
    assert.equal(r.allowed, false);
    assert.equal(r.count, 5);
  });

  it("neues window → counter resetted", () => {
    const nextWindow = 2_000_000 + 60_000 + 1;
    const r = checkRuleRateLimit("rule-y", 60_000, 5, nextWindow);
    assert.equal(r.count, 0);
    assert.equal(r.allowed, true);
  });
});

describe("dedup · audit", () => {
  before(() => __resetPushStateForTests());

  it("recordAudit schreibt einen Row (kein throw)", () => {
    // No direct read API — we just check no exception is raised and
    // that the dedup/counter state stays clean.
    assert.doesNotThrow(() => {
      recordAudit({ ruleId: "r", outcome: "sent", now: 1 });
      recordAudit({ ruleId: "r", outcome: "dedup", detail: "foo", now: 2 });
    });
  });
});
