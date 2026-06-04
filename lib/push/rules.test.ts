/**
 * Push-Rules Tests — pure predicate tests (kein DB-Zugriff).
 *
 * Run: `pnpm exec tsx --test lib/push/rules.test.ts`
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { LazyEvent } from "../events/types";
import { PUSH_RULES, findRuleById, windowMsForRateLimit } from "./rules";

function ev(partial: Partial<LazyEvent> & Pick<LazyEvent, "eventType" | "entityType">): LazyEvent {
  return {
    id: partial.id ?? "EV-test",
    createdAt: partial.createdAt ?? Date.now(),
    segmentId: partial.segmentId ?? "lazyos",
    entityId: partial.entityId ?? "E1",
    actor: partial.actor ?? "system",
    payload: partial.payload ?? {},
    sensitivity: partial.sensitivity ?? "low",
    eventType: partial.eventType,
    entityType: partial.entityType,
  };
}

describe("rules · registry integrity", () => {
  it("rules have unique ids", () => {
    const ids = PUSH_RULES.map((r) => r.id);
    // Count is intentionally not asserted — registry grows over time.
    // What matters is uniqueness (otherwise dedup-key collisions).
    assert.equal(new Set(ids).size, ids.length, "duplicate rule ids");
  });

  it("findRuleById works for known ids", () => {
    for (const r of PUSH_RULES) {
      assert.equal(findRuleById(r.id)?.id, r.id);
    }
  });

  it("returns undefined for unknown id", () => {
    assert.equal(findRuleById("no-such-rule"), undefined);
  });

  it("windowMsForRateLimit is correct", () => {
    assert.equal(windowMsForRateLimit({ per: "minute", max: 1 }), 60_000);
    assert.equal(windowMsForRateLimit({ per: "hour", max: 1 }), 3_600_000);
    assert.equal(windowMsForRateLimit({ per: "day", max: 1 }), 86_400_000);
  });
});

describe("rules · ticket-p0-created", () => {
  const rule = findRuleById("ticket-p0-created")!;

  it("triggert bei ticket_created P0", () => {
    const e = ev({
      eventType: "ticket_created",
      entityType: "ticket",
      entityId: "TCK-1",
      payload: { title: "Server down", prio: "P0" },
    });
    assert.equal(rule.when(e), true);
    const notif = rule.build(e);
    assert.match(notif.title, /P0/);
    assert.equal(notif.url, "/tickets/TCK-1");
  });

  it("triggert auch bei eventType=created + entityType=ticket + P0", () => {
    const e = ev({
      eventType: "created",
      entityType: "ticket",
      payload: { title: "X", prio: "P0" },
    });
    assert.equal(rule.when(e), true);
  });

  it("triggert NICHT bei P1", () => {
    const e = ev({
      eventType: "ticket_created",
      entityType: "ticket",
      payload: { title: "X", prio: "P1" },
    });
    assert.equal(rule.when(e), false);
  });

  it("triggert NICHT bei commented", () => {
    const e = ev({
      eventType: "commented",
      entityType: "ticket",
      payload: { text: "hi", prio: "P0" },
    });
    assert.equal(rule.when(e), false);
  });

  it("akzeptiert 'priority' als Alias für 'prio'", () => {
    const e = ev({
      eventType: "ticket_created",
      entityType: "ticket",
      payload: { title: "X", priority: "P0" },
    });
    assert.equal(rule.when(e), true);
  });
});

describe("rules · approval-requested", () => {
  const rule = findRuleById("approval-requested")!;

  it("triggert bei approval_requested", () => {
    const e = ev({
      eventType: "approval_requested",
      entityType: "ticket",
      entityId: "TCK-42",
      payload: { from: "draft", to: "review" },
    });
    assert.equal(rule.when(e), true);
    const notif = rule.build(e);
    assert.match(notif.body, /TCK-42/);
    assert.equal(notif.url, "/tickets/TCK-42");
  });

  it("triggert NICHT bei approved", () => {
    const e = ev({
      eventType: "approved",
      entityType: "ticket",
      payload: {},
    });
    assert.equal(rule.when(e), false);
  });
});

describe("rules · workspace-stale", () => {
  const rule = findRuleById("workspace-stale")!;

  it("triggert bei stale mit lag_sec > 3600", () => {
    const e = ev({
      eventType: "workspace_heartbeat",
      entityType: "workspace",
      payload: { status: "stale", lag_sec: 7200, workspaceId: "demo-client" },
    });
    assert.equal(rule.when(e), true);
    const notif = rule.build(e);
    assert.match(notif.body, /demo-client/);
    assert.match(notif.body, /2h/); // 7200/3600 = 2
  });

  it("triggert NICHT bei status=alive", () => {
    const e = ev({
      eventType: "workspace_heartbeat",
      entityType: "workspace",
      payload: { status: "alive", lag_sec: 7200 },
    });
    assert.equal(rule.when(e), false);
  });

  it("triggert NICHT bei lag_sec <= 3600", () => {
    const e = ev({
      eventType: "workspace_heartbeat",
      entityType: "workspace",
      payload: { status: "stale", lag_sec: 3000 },
    });
    assert.equal(rule.when(e), false);
  });
});

describe("rules · errors-burst", () => {
  const rule = findRuleById("errors-burst")!;

  it("`when` triggert bei JEDEM error_logged", () => {
    const e = ev({
      eventType: "error_logged",
      entityType: "note",
      payload: { context: "x", message: "boom" },
    });
    assert.equal(rule.when(e), true);
  });

  it("triggert NICHT bei anderen eventTypes", () => {
    const e = ev({
      eventType: "commented",
      entityType: "ticket",
      payload: {},
    });
    assert.equal(rule.when(e), false);
  });

  it("hat burst-config mit 5 events / 5min", () => {
    assert.ok(rule.burst, "burst config missing");
    assert.equal(rule.burst!.count, 5);
    assert.equal(rule.burst!.windowMs, 5 * 60 * 1000);
  });
});

describe("rules · routine-failed", () => {
  const rule = findRuleById("routine-failed")!;

  it("triggert bei routine_run mit status=failure", () => {
    const e = ev({
      eventType: "routine_run",
      entityType: "routine",
      entityId: "RTN-1",
      payload: { status: "failure", name: "backup", error: "disk full" },
    });
    assert.equal(rule.when(e), true);
    const notif = rule.build(e);
    assert.match(notif.body, /backup/);
    assert.match(notif.body, /disk full/);
    assert.equal(notif.url, "/routines");
  });

  it("triggert NICHT bei success", () => {
    const e = ev({
      eventType: "routine_run",
      entityType: "routine",
      payload: { status: "success" },
    });
    assert.equal(rule.when(e), false);
  });

  it("Fallback: name=entityId wenn payload.name fehlt", () => {
    const e = ev({
      eventType: "routine_run",
      entityType: "routine",
      entityId: "RTN-xyz",
      payload: { status: "failure" },
    });
    const notif = rule.build(e);
    assert.match(notif.body, /RTN-xyz/);
  });
});

// ---------------------------------------------------------------------------
// B1 Answer-Required Rules (2026-05-25)
// ---------------------------------------------------------------------------

describe("rules · answer-required-approval", () => {
  const rule = findRuleById("answer-required-approval")!;

  it("regel existiert", () => {
    assert.ok(rule, "answer-required-approval nicht in PUSH_RULES");
  });

  it("triggert bei answer_required + kind=approval", () => {
    const e = ev({
      eventType: "answer_required",
      entityType: "note",
      entityId: "WS-1",
      segmentId: "lazyos",
      payload: {
        kind: "approval",
        preview: "Plan X wartet auf Freigabe",
        url: "/?workspace=lazyos",
        workspaceId: "lazyos",
      },
    });
    assert.equal(rule.when(e), true);
    const notif = rule.build(e);
    assert.match(notif.title, /Freigabe/);
    assert.match(notif.body, /Plan X/);
    assert.equal(notif.url, "/?workspace=lazyos");
    assert.ok(notif.tag?.includes("WS-1"), "tag enthält entityId");
  });

  it("triggert NICHT bei kind=connector-preview", () => {
    const e = ev({
      eventType: "answer_required",
      entityType: "note",
      payload: { kind: "connector-preview", preview: "x", url: "/" },
    });
    assert.equal(rule.when(e), false);
  });

  it("triggert NICHT bei anderem eventType", () => {
    const e = ev({
      eventType: "commented",
      entityType: "note",
      payload: { kind: "approval" },
    });
    assert.equal(rule.when(e), false);
  });

  it("preview wird auf 100 Zeichen gekappt via firstLine", () => {
    const longPreview = "A".repeat(120);
    const e = ev({
      eventType: "answer_required",
      entityType: "note",
      payload: { kind: "approval", preview: longPreview, url: "/" },
    });
    const notif = rule.build(e);
    assert.ok(notif.body.length <= 101, `body zu lang: ${notif.body.length}`);
  });

  it("hat dedupKey und rateLimit", () => {
    assert.ok(typeof rule.dedupKey === "function");
    assert.ok(rule.rateLimit);
  });
});

describe("rules · answer-required-connector-preview", () => {
  const rule = findRuleById("answer-required-connector-preview")!;

  it("regel existiert", () => {
    assert.ok(rule, "answer-required-connector-preview nicht in PUSH_RULES");
  });

  it("triggert bei answer_required + kind=connector-preview", () => {
    const e = ev({
      eventType: "answer_required",
      entityType: "note",
      entityId: "acl5e-github",
      payload: {
        kind: "connector-preview",
        preview: "Connector 'github' wartet auf Freigabe",
        url: "/?workspace=lazyos",
        workspaceId: "lazyos",
      },
    });
    assert.equal(rule.when(e), true);
    const notif = rule.build(e);
    assert.match(notif.title, /Connector/);
    assert.match(notif.body, /github/);
  });

  it("triggert NICHT bei kind=approval", () => {
    const e = ev({
      eventType: "answer_required",
      entityType: "note",
      payload: { kind: "approval", preview: "x", url: "/" },
    });
    assert.equal(rule.when(e), false);
  });

  it("triggert NICHT bei falschem eventType", () => {
    const e = ev({
      eventType: "commented",
      entityType: "note",
      payload: { kind: "connector-preview" },
    });
    assert.equal(rule.when(e), false);
  });
});

describe("rules · answer-required-open-questions", () => {
  const rule = findRuleById("answer-required-open-questions")!;

  it("regel existiert", () => {
    assert.ok(rule, "answer-required-open-questions nicht in PUSH_RULES");
  });

  it("triggert bei answer_required + kind=open-questions", () => {
    const e = ev({
      eventType: "answer_required",
      entityType: "note",
      entityId: "MSG-1",
      payload: {
        kind: "open-questions",
        preview: "3 offene Fragen warten auf deine Antwort",
        url: "/?workspace=lazyos",
        workspaceId: "lazyos",
      },
    });
    assert.equal(rule.when(e), true);
    const notif = rule.build(e);
    assert.match(notif.title, /Offene Fragen/);
    assert.match(notif.body, /offene Fragen/);
  });

  it("triggert NICHT bei kind=approval", () => {
    const e = ev({
      eventType: "answer_required",
      entityType: "note",
      payload: { kind: "approval", preview: "x", url: "/" },
    });
    assert.equal(rule.when(e), false);
  });

  it("dedupKey enthält workspaceId und entityId", () => {
    const e = ev({
      eventType: "answer_required",
      entityType: "note",
      entityId: "MSG-oq",
      segmentId: "ws-abc",
      payload: {
        kind: "open-questions",
        preview: "x",
        url: "/",
        workspaceId: "ws-abc",
      },
    });
    assert.ok(typeof rule.dedupKey === "function");
    const key = rule.dedupKey!(e);
    assert.match(key, /ws-abc/);
    assert.match(key, /MSG-oq/);
  });
});

describe("rules · registry integrity (nach B1-Erweiterung)", () => {
  it("answer-required-Regeln sind in PUSH_RULES registriert", () => {
    const ids = PUSH_RULES.map((r) => r.id);
    assert.ok(ids.includes("answer-required-approval"));
    assert.ok(ids.includes("answer-required-connector-preview"));
    assert.ok(ids.includes("answer-required-open-questions"));
  });

  it("PUSH_RULES hat weiterhin unique IDs", () => {
    const ids = PUSH_RULES.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate rule ids nach B1-Erweiterung");
  });
});
