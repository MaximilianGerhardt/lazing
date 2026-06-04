/**
 * FSM-Tests — `node --test lib/approvals/fsm.test.ts`
 *
 * Läuft ohne zusätzliche Dependencies (nativer node:test-Runner).
 * tsx muss PATH-verfügbar sein (liegt in devDependencies).
 * Aufruf: `pnpm exec tsx --test lib/approvals/fsm.test.ts`
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  ALL_STATES,
  ALL_TRANSITIONS,
  DEFAULT_STATE,
  availableUserTransitions,
  canTransition,
  eventTypeFor,
  isTerminalState,
  nextState,
  projectStateFromEvents,
  transitionForEvent,
} from "./fsm";

describe("fsm · happy-path transitions (user)", () => {
  it("draft → review via request_approval", () => {
    assert.equal(canTransition("draft", "request_approval", "user"), true);
    assert.equal(nextState("draft", "request_approval"), "review");
  });

  it("review → approved via approve (user)", () => {
    assert.equal(canTransition("review", "approve", "user"), true);
    assert.equal(nextState("review", "approve"), "approved");
  });

  it("approved → executed via execute", () => {
    assert.equal(canTransition("approved", "execute", "user"), true);
    assert.equal(nextState("approved", "execute"), "executed");
  });

  it("executed → closed via close", () => {
    assert.equal(canTransition("executed", "close", "user"), true);
    assert.equal(nextState("executed", "close"), "closed");
  });

  it("rejected → draft via reopen", () => {
    assert.equal(canTransition("rejected", "reopen", "user"), true);
    assert.equal(nextState("rejected", "reopen"), "draft");
  });

  it("executed → review via request_approval (rework)", () => {
    assert.equal(canTransition("executed", "request_approval", "user"), true);
    assert.equal(nextState("executed", "request_approval"), "review");
  });
});

describe("fsm · actor-policy", () => {
  it("agent darf nicht approven ohne autoApprove", () => {
    assert.equal(canTransition("review", "approve", "agent"), false);
  });

  it("agent darf approven mit autoApprove=true", () => {
    assert.equal(
      canTransition("review", "approve", "agent", { autoApprove: true }),
      true,
    );
  });

  it("agent darf NICHT rejecten (auch nicht mit autoApprove)", () => {
    assert.equal(
      canTransition("review", "reject", "agent", { autoApprove: true }),
      false,
    );
  });

  it("agent darf NICHT reopen (rejected → draft)", () => {
    assert.equal(canTransition("rejected", "reopen", "agent"), false);
  });

  it("agent darf request_approval und execute", () => {
    assert.equal(canTransition("draft", "request_approval", "agent"), true);
    assert.equal(canTransition("approved", "execute", "agent"), true);
  });
});

describe("fsm · invalid transitions", () => {
  it("draft → approved direkt ist ungültig", () => {
    assert.equal(canTransition("draft", "approve", "user"), false);
    assert.equal(nextState("draft", "approve"), null);
  });

  it("closed → any ist final (außer Reject, und das auch nicht)", () => {
    for (const t of ALL_TRANSITIONS) {
      assert.equal(
        nextState("closed", t),
        null,
        `closed → ${t} sollte null sein`,
      );
    }
  });

  it("approved → review ist ungültig (nur executed kann via request_approval zurück)", () => {
    assert.equal(canTransition("approved", "request_approval", "user"), false);
  });

  it("review → executed direkt (ohne approve) ist ungültig", () => {
    assert.equal(nextState("review", "execute"), null);
  });

  it("draft → reopen ist ungültig (reopen ist nur rejected → draft)", () => {
    assert.equal(canTransition("draft", "reopen", "user"), false);
  });
});

describe("fsm · reject fan-in", () => {
  for (const from of ["draft", "review", "approved", "executed"] as const) {
    it(`${from} → rejected via reject (user)`, () => {
      assert.equal(canTransition(from, "reject", "user"), true);
      assert.equal(nextState(from, "reject"), "rejected");
    });
  }

  it("closed → rejected ist nicht möglich (terminal)", () => {
    assert.equal(nextState("closed", "reject"), null);
  });

  it("rejected → rejected (Doppel-Reject) ist idempotent-unerlaubt", () => {
    assert.equal(nextState("rejected", "reject"), null);
  });
});

describe("fsm · eventTypeFor mapping", () => {
  const mapping: Record<string, string> = {
    request_approval: "approval_requested",
    approve: "approved",
    reject: "rejected",
    execute: "executed",
    close: "closed",
    reopen: "reopened",
  };

  for (const [transition, expected] of Object.entries(mapping)) {
    it(`${transition} → ${expected}`, () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assert.equal(eventTypeFor(transition as any), expected);
    });
  }

  it("reverse: transitionForEvent", () => {
    assert.equal(transitionForEvent("approved"), "approve");
    assert.equal(transitionForEvent("approval_requested"), "request_approval");
    assert.equal(transitionForEvent("reopened"), "reopen");
    assert.equal(transitionForEvent("commented"), null);
  });
});

describe("fsm · projectStateFromEvents", () => {
  it("empty events → DEFAULT_STATE (draft)", () => {
    assert.equal(projectStateFromEvents([]), DEFAULT_STATE);
  });

  it("created → approval_requested → approved → executed → closed", () => {
    const events = [
      { eventType: "created" as const },
      { eventType: "approval_requested" as const },
      { eventType: "approved" as const },
      { eventType: "executed" as const },
      { eventType: "closed" as const },
    ];
    assert.equal(projectStateFromEvents(events), "closed");
  });

  it("rework: request → approve → execute → request → ... bleibt in review", () => {
    const events = [
      { eventType: "approval_requested" as const },
      { eventType: "approved" as const },
      { eventType: "executed" as const },
      { eventType: "approval_requested" as const }, // rework
    ];
    assert.equal(projectStateFromEvents(events), "review");
  });

  it("ignoriert Non-FSM-Events (commented, updated)", () => {
    const events = [
      { eventType: "approval_requested" as const },
      { eventType: "commented" as const },
      { eventType: "updated" as const },
      { eventType: "approved" as const },
    ];
    assert.equal(projectStateFromEvents(events), "approved");
  });

  it("überspringt ungültige Sequenzen (defensive)", () => {
    // approve aus draft ist ungültig → wird ignoriert
    const events = [
      { eventType: "approved" as const },
      { eventType: "approval_requested" as const },
    ];
    assert.equal(projectStateFromEvents(events), "review");
  });

  it("reject aus jedem Zwischen-State", () => {
    const events = [
      { eventType: "approval_requested" as const },
      { eventType: "rejected" as const },
    ];
    assert.equal(projectStateFromEvents(events), "rejected");
  });

  it("reopen-Loop: reject → reopen → zurück zu draft", () => {
    const events = [
      { eventType: "approval_requested" as const },
      { eventType: "rejected" as const },
      { eventType: "reopened" as const },
    ];
    assert.equal(projectStateFromEvents(events), "draft");
  });
});

describe("fsm · availableUserTransitions", () => {
  it("draft: request_approval + reject", () => {
    const avail = availableUserTransitions("draft");
    assert.deepEqual(avail.sort(), ["reject", "request_approval"].sort());
  });

  it("review: approve + reject", () => {
    const avail = availableUserTransitions("review");
    assert.deepEqual(avail.sort(), ["approve", "reject"].sort());
  });

  it("approved: execute + reject", () => {
    const avail = availableUserTransitions("approved");
    assert.deepEqual(avail.sort(), ["execute", "reject"].sort());
  });

  it("executed: close + request_approval + reject", () => {
    const avail = availableUserTransitions("executed");
    assert.deepEqual(
      avail.sort(),
      ["close", "reject", "request_approval"].sort(),
    );
  });

  it("rejected: reopen nur", () => {
    const avail = availableUserTransitions("rejected");
    assert.deepEqual(avail, ["reopen"]);
  });

  it("closed: keine Transitions", () => {
    assert.deepEqual(availableUserTransitions("closed"), []);
  });
});

describe("fsm · isTerminalState", () => {
  it("closed ist terminal", () => {
    assert.equal(isTerminalState("closed"), true);
  });

  it("rejected NICHT terminal (reopen möglich)", () => {
    assert.equal(isTerminalState("rejected"), false);
  });

  it("alle anderen States nicht terminal", () => {
    for (const s of ALL_STATES.filter((x) => x !== "closed")) {
      assert.equal(isTerminalState(s), false, `${s} nicht terminal`);
    }
  });
});
