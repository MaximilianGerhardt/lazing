// A5 + A4 Post-Prozess-Reconciliation tests — Self-Learning / WARUM-Engine ·
// Stream A · 2026-05-27.
//
// Strategy: in-memory better-sqlite3 DB, Schema aus den ECHTEN Migrationen:
//   0009 workstreams (JOIN-Ziel für decisions-read),
//   0071 workstream_decisions (Decision-Trail, append-only),
//   0113 workspace_beliefs + decision_outcomes (Lern-Store + Outcome).
// Reconcile nimmt ein rohes DB-Handle — kein getDb()-Singleton, kein vi.mock.
// Decision-Rows werden direkt per INSERT angelegt (wir testen das Reconcile,
// nicht trace-repo's writeDecision, das ein getDb()-Singleton bräuchte).
//
// Run:
//   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
//     lib/reasoning/__tests__/reconcile.test.ts

import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  reconcileWorkstream,
  determineOutcome,
  buildWhyQuestion,
  detectBeliefDrift,
  isUnjustified,
  reflectOnRepeatedFailures,
  RECONCILE_MARKER_PREFIX,
  TEACH_MARKER_PREFIX,
  REFLECTION_MARKER_PREFIX,
  REFLECTION_THRESHOLD,
} from "@/lib/reasoning/reconcile";
import {
  upsertBelief,
  listBeliefs,
  beliefHistory,
  listOutcomes,
} from "@/lib/reasoning/beliefs-repo";
import { listDecisions } from "@/lib/reasoning/decisions-read";
import { extractOpenQuestionsFromContent } from "@/lib/chat/open-questions-lifecycle";

const MIG = (name: string) =>
  path.join(process.cwd(), "db", "migrations", name);

function freshDb(): import("better-sqlite3").Database {
  const raw = new Database(":memory:");
  raw.exec(readFileSync(MIG("0009_workstreams.sql"), "utf8"));
  raw.exec(readFileSync(MIG("0071_workstream_decisions.sql"), "utf8"));
  raw.exec(readFileSync(MIG("0113_workspace_beliefs.sql"), "utf8"));
  return raw;
}

function insertWorkstream(
  raw: import("better-sqlite3").Database,
  id: string,
  workspaceId: string,
): void {
  raw
    .prepare(
      `INSERT INTO workstreams (id, workspace_id, name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
    )
    .run(id, workspaceId, `ws ${id}`, Date.now(), Date.now());
}

let decSeq = 0;
function insertDecision(
  raw: import("better-sqlite3").Database,
  opts: {
    workstreamId: string;
    decisionKind: string;
    rationale: string;
    actor?: string;
  },
): string {
  const id = `dec_${String(++decSeq).padStart(6, "0")}`;
  raw
    .prepare(
      `INSERT INTO workstream_decisions
         (id, workstream_id, decision_kind, rationale, evidence_refs, content_hash, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      opts.workstreamId,
      opts.decisionKind,
      opts.rationale,
      JSON.stringify(["ev_sentinel"]),
      `hash_${id}`,
      opts.actor ?? "agent",
      Date.now(),
    );
  return id;
}

const WS = "WS-RC";
const WSP = "wsp-rc";
const COORD = `${WSP}/${WS}`;

describe("determineOutcome (A5)", () => {
  it("all done → success", () => {
    expect(determineOutcome({ s1: "done", s2: "done" })).toBe("success");
  });
  it("all failed → failure", () => {
    expect(determineOutcome({ s1: "failed", s2: "failed" })).toBe("failure");
  });
  it("mixed done+failed → partial", () => {
    expect(determineOutcome({ s1: "done", s2: "failed" })).toBe("partial");
  });
  it("no steps → unknown", () => {
    expect(determineOutcome({})).toBe("unknown");
  });
  it("only non-terminal → unknown", () => {
    expect(determineOutcome({ s1: "pending", s2: "active" })).toBe("unknown");
  });
  it("done + non-terminal → partial (non-terminal counts as not-success)", () => {
    expect(determineOutcome({ s1: "done", s2: "pending" })).toBe("partial");
  });
});

describe("buildWhyQuestion (A4)", () => {
  const ws = WS;

  it("unjustified decision → pill-readable question", () => {
    const markup = buildWhyQuestion({
      workstreamId: ws,
      unjustified: [
        {
          id: "dec_x",
          workstreamId: ws,
          workspaceId: WSP,
          decisionKind: "route",
          rationale: "",
          evidenceRefs: "[]",
          contentHash: "h",
          actor: "agent",
          createdAt: 1,
          recoveredAt: null,
        },
      ],
      drifts: [],
    });
    expect(markup).not.toBeNull();
    // 2026-05-29: Selbst-Reflexion ist Counter-Evidence, KEINE Open-Question.
    expect(markup!).toContain("<surface:counter-evidence>");
    expect(markup!).toMatch(/ohne erkennbare Begründung/);
    // REGRESSIONS-GUARD: darf NICHT in der Offene-Fragen-Pille landen.
    expect(extractOpenQuestionsFromContent(markup!)).toHaveLength(0);
  });

  it("clearly-justified, no drift → null (nothing to ask)", () => {
    const markup = buildWhyQuestion({
      workstreamId: ws,
      unjustified: [],
      drifts: [],
    });
    expect(markup).toBeNull();
  });

  it("drift decision → pill-readable question mentioning prior belief", () => {
    const markup = buildWhyQuestion({
      workstreamId: ws,
      unjustified: [],
      drifts: [
        {
          topic: "route",
          decision: {
            id: "dec_y",
            workstreamId: ws,
            workspaceId: WSP,
            decisionKind: "route",
            rationale: "heygen statt higgsfield",
            evidenceRefs: "[]",
            contentHash: "h",
            actor: "agent",
            createdAt: 1,
            recoveredAt: null,
          },
          priorBelief: {
            id: "BLF-1",
            workspaceId: WSP,
            topic: "route",
            belief: "Video immer über Higgsfield",
            rationale: "weil Avatare dort besser sind",
            source: "user",
            supersedesId: null,
            confidence: null,
            contentHash: "h",
            createdAt: 1,
            updatedAt: 1,
          },
        },
      ],
    });
    expect(markup).not.toBeNull();
    // 2026-05-29: Drift-Reflexion ist Counter-Evidence, KEINE Open-Question.
    expect(markup!).toContain("<surface:counter-evidence>");
    expect(markup!).toMatch(/Video immer über Higgsfield/);
    // REGRESSIONS-GUARD: darf NICHT in der Offene-Fragen-Pille landen.
    expect(extractOpenQuestionsFromContent(markup!)).toHaveLength(0);
  });
});

describe("isUnjustified (A4)", () => {
  const base = {
    id: "d",
    workstreamId: WS,
    workspaceId: WSP,
    decisionKind: "route" as const,
    evidenceRefs: "[]",
    contentHash: "h",
    actor: "agent" as const,
    createdAt: 1,
    recoveredAt: null,
  };
  it("empty rationale → unjustified", () => {
    expect(isUnjustified({ ...base, rationale: "" })).toBe(true);
    expect(isUnjustified({ ...base, rationale: "   \n  " })).toBe(true);
  });
  it("non-empty rationale → justified", () => {
    expect(isUnjustified({ ...base, rationale: "weil X" })).toBe(false);
  });
});

describe("reconcileWorkstream (A5)", () => {
  let raw: import("better-sqlite3").Database;
  beforeEach(() => {
    decSeq = 0;
    raw = freshDb();
    insertWorkstream(raw, WS, WSP);
  });

  it("all-done → success + recordOutcome (workstream-scoped, marker)", () => {
    insertDecision(raw, {
      workstreamId: WS,
      decisionKind: "route",
      rationale: "klare Begründung vorhanden",
    });
    const res = reconcileWorkstream(raw, {
      workspaceId: WSP,
      workstreamId: WS,
      coordKey: COORD,
      stepStatuses: { s1: "done", s2: "done" },
    });
    expect(res.alreadyReconciled).toBe(false);
    expect(res.outcome).toBe("success");

    const outcomes = listOutcomes(raw, {
      workspaceId: WSP,
      workstreamId: WS,
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.outcome).toBe("success");
    expect(outcomes[0]!.note).toContain(RECONCILE_MARKER_PREFIX);
    // klare Begründung, kein Drift → keine WARUM-Frage.
    expect(res.whyQuestion).toBeNull();
  });

  it("some-failed → partial", () => {
    const res = reconcileWorkstream(raw, {
      workspaceId: WSP,
      workstreamId: WS,
      coordKey: COORD,
      stepStatuses: { s1: "done", s2: "failed" },
    });
    expect(res.outcome).toBe("partial");
    const outcomes = listOutcomes(raw, {
      workspaceId: WSP,
      workstreamId: WS,
    });
    expect(outcomes[0]!.outcome).toBe("partial");
  });

  it("drift Decision↔Belief → upsertBelief(supersedesId), old belief stays as history", () => {
    // Aktive Überzeugung (PA-Chat-Analogie: Video immer über Higgsfield).
    const prior = upsertBelief(raw, {
      workspaceId: WSP,
      topic: "route",
      belief: "Higgsfield",
      rationale: "Avatare dort besser",
      source: "user",
    });
    // Run entscheidet abweichend (rationale enthält NICHT „Higgsfield").
    insertDecision(raw, {
      workstreamId: WS,
      decisionKind: "route",
      rationale: "heygen gewählt wegen Connector-Drift",
    });

    const res = reconcileWorkstream(raw, {
      workspaceId: WSP,
      workstreamId: WS,
      coordKey: COORD,
      stepStatuses: { s1: "done" },
    });
    expect(res.drifts).toHaveLength(1);
    expect(res.beliefUpdates).toBe(1);

    // Aktive Belief ist jetzt die neue (supersede), alte bleibt als Historie.
    const active = listBeliefs(raw, WSP);
    expect(active).toHaveLength(1);
    expect(active[0]!.supersedesId).toBe(prior.id);
    // Das WARUM zitiert die Decision-rationale VERBATIM (N1).
    expect(active[0]!.rationale).toContain(
      "heygen gewählt wegen Connector-Drift",
    );

    const history = beliefHistory(raw, WSP, "route");
    expect(history).toHaveLength(2);
    expect(history.map((h) => h.id)).toContain(prior.id);

    // Drift → Selbst-Reflexion als Counter-Evidence (KEINE Open-Question, 2026-05-29).
    expect(res.whyQuestion).not.toBeNull();
    expect(res.whyQuestion!).toContain("<surface:counter-evidence>");
    expect(extractOpenQuestionsFromContent(res.whyQuestion!)).toHaveLength(0);
  });

  it("no drift when decision rationale matches the active belief", () => {
    upsertBelief(raw, {
      workspaceId: WSP,
      topic: "route",
      belief: "Higgsfield",
      rationale: "Avatare dort besser",
      source: "user",
    });
    insertDecision(raw, {
      workstreamId: WS,
      decisionKind: "route",
      rationale: "wie immer Higgsfield genommen",
    });
    const res = reconcileWorkstream(raw, {
      workspaceId: WSP,
      workstreamId: WS,
      coordKey: COORD,
      stepStatuses: { s1: "done" },
    });
    expect(res.drifts).toHaveLength(0);
    expect(res.beliefUpdates).toBe(0);
    // Genau EINE aktive Belief bleibt (kein DRIFT-supersede). P1.1 verstärkt sie
    // aber via supersede (success + Decision-rationale BESTÄTIGT die Belief), daher
    // wächst die Historie auf 2 — die alte Row bleibt als Historie erhalten.
    expect(listBeliefs(raw, WSP)).toHaveLength(1);
    expect(res.reinforcements).toBe(1);
    expect(beliefHistory(raw, WSP, "route")).toHaveLength(2);
  });

  it("idempotency: second reconcile does NOT double-write", () => {
    upsertBelief(raw, {
      workspaceId: WSP,
      topic: "route",
      belief: "Higgsfield",
      rationale: "r",
      source: "user",
    });
    insertDecision(raw, {
      workstreamId: WS,
      decisionKind: "route",
      rationale: "heygen abweichend",
    });

    const first = reconcileWorkstream(raw, {
      workspaceId: WSP,
      workstreamId: WS,
      coordKey: COORD,
      stepStatuses: { s1: "done" },
    });
    expect(first.alreadyReconciled).toBe(false);
    expect(first.beliefUpdates).toBe(1);

    const outcomesAfterFirst = listOutcomes(raw, {
      workspaceId: WSP,
      workstreamId: WS,
    });
    const beliefsAfterFirst = beliefHistory(raw, WSP, "route");

    const second = reconcileWorkstream(raw, {
      workspaceId: WSP,
      workstreamId: WS,
      coordKey: COORD,
      stepStatuses: { s1: "done" },
    });
    expect(second.alreadyReconciled).toBe(true);
    expect(second.beliefUpdates).toBe(0);
    // outcome still computed (frisches Urteil), aber nichts neu geschrieben.
    expect(second.outcome).toBe("success");

    // Keine neue Outcome-Row, keine neue Belief-Row.
    expect(
      listOutcomes(raw, { workspaceId: WSP, workstreamId: WS }),
    ).toHaveLength(outcomesAfterFirst.length);
    expect(beliefHistory(raw, WSP, "route")).toHaveLength(
      beliefsAfterFirst.length,
    );
  });

  it("unjustified decision (empty rationale) → WARUM-Frage even without drift", () => {
    insertDecision(raw, {
      workstreamId: WS,
      decisionKind: "route",
      rationale: "",
    });
    const res = reconcileWorkstream(raw, {
      workspaceId: WSP,
      workstreamId: WS,
      coordKey: COORD,
      stepStatuses: { s1: "done" },
    });
    expect(res.unjustified).toHaveLength(1);
    // Counter-Evidence statt Open-Question (2026-05-29).
    expect(res.whyQuestion).not.toBeNull();
    expect(res.whyQuestion!).toContain("<surface:counter-evidence>");
    expect(res.whyQuestion!).toMatch(/ohne erkennbare Begründung/);
    expect(extractOpenQuestionsFromContent(res.whyQuestion!)).toHaveLength(0);
  });

  it("detectBeliefDrift respects workspace scope (no cross-workspace)", () => {
    // Belief in einem ANDEREN Workspace darf NICHT als Drift gegen WSP zählen.
    upsertBelief(raw, {
      workspaceId: "wsp-OTHER",
      topic: "route",
      belief: "Higgsfield",
      rationale: "r",
      source: "user",
    });
    insertDecision(raw, {
      workstreamId: WS,
      decisionKind: "route",
      rationale: "heygen abweichend",
    });
    const decisions = listDecisions(raw, { workspaceId: WSP, coordKey: COORD });
    const drifts = detectBeliefDrift(raw, WSP, decisions);
    expect(drifts).toHaveLength(0);
  });

  it("requires workspaceId + workstreamId", () => {
    expect(() =>
      reconcileWorkstream(raw, {
        workspaceId: "",
        workstreamId: WS,
        coordKey: COORD,
        stepStatuses: {},
      }),
    ).toThrow(/workspaceId required/);
    expect(() =>
      reconcileWorkstream(raw, {
        workspaceId: WSP,
        workstreamId: "",
        coordKey: COORD,
        stepStatuses: {},
      }),
    ).toThrow(/workstreamId required/);
  });
});

// ===========================================================================
// P0.1 — Outcome-getriebenes Lernen (failure/partial → Lehr-Belief, auch ohne
// Vor-Belief). DER heygen-Fall: failure ohne Drift erzeugt jetzt eine Belief.
// ===========================================================================

describe("reconcileWorkstream P0.1 — outcome-driven learning", () => {
  let raw: import("better-sqlite3").Database;
  beforeEach(() => {
    decSeq = 0;
    raw = freshDb();
    insertWorkstream(raw, WS, WSP);
  });

  it("failure WITHOUT any prior belief → teaching belief is written (heygen case)", () => {
    // Eine Decision, die scheiterte — KEINE vorbestehende Belief existiert.
    insertDecision(raw, {
      workstreamId: WS,
      decisionKind: "route",
      rationale: "heygen gewählt wegen Connector-Drift",
    });
    const res = reconcileWorkstream(raw, {
      workspaceId: WSP,
      workstreamId: WS,
      coordKey: COORD,
      stepStatuses: { s1: "failed" },
    });
    expect(res.outcome).toBe("failure");
    // Vor P0.1 wäre das NULL Lerneinträge gewesen — jetzt genau eine Lehr-Belief.
    expect(res.outcomeLessons).toBe(1);

    const active = listBeliefs(raw, WSP);
    expect(active).toHaveLength(1);
    expect(active[0]!.topic).toBe("route");
    expect(active[0]!.belief).toContain(TEACH_MARKER_PREFIX);
    expect(active[0]!.belief).toContain("outcome=failure");
    expect(active[0]!.source).toBe("ai");
    // rationale zitiert die Decision-rationale VERBATIM (N1).
    expect(active[0]!.rationale).toContain(
      "heygen gewählt wegen Connector-Drift",
    );
  });

  it("failure WITHOUT any decision → learns from failed step keys (pure connector-step fail)", () => {
    const res = reconcileWorkstream(raw, {
      workspaceId: WSP,
      workstreamId: WS,
      coordKey: COORD,
      stepStatuses: { videoStep: "failed" },
    });
    expect(res.outcome).toBe("failure");
    expect(res.outcomeLessons).toBe(1);
    const active = listBeliefs(raw, WSP);
    expect(active).toHaveLength(1);
    expect(active[0]!.topic).toBe("step:videoStep");
    expect(active[0]!.belief).toContain("outcome=failure");
  });

  it("partial outcome also writes a teaching belief", () => {
    insertDecision(raw, {
      workstreamId: WS,
      decisionKind: "route",
      rationale: "Teilweg gewählt",
    });
    const res = reconcileWorkstream(raw, {
      workspaceId: WSP,
      workstreamId: WS,
      coordKey: COORD,
      stepStatuses: { s1: "done", s2: "failed" },
    });
    expect(res.outcome).toBe("partial");
    expect(res.outcomeLessons).toBe(1);
    expect(listBeliefs(raw, WSP)[0]!.belief).toContain("outcome=partial");
  });

  it("success → NO teaching belief (only failure/partial learn)", () => {
    insertDecision(raw, {
      workstreamId: WS,
      decisionKind: "route",
      rationale: "ging gut",
    });
    const res = reconcileWorkstream(raw, {
      workspaceId: WSP,
      workstreamId: WS,
      coordKey: COORD,
      stepStatuses: { s1: "done" },
    });
    expect(res.outcome).toBe("success");
    expect(res.outcomeLessons).toBe(0);
    expect(listBeliefs(raw, WSP)).toHaveLength(0);
  });

  it("idempotent: re-reconcile of the same run does NOT double-write the lesson", () => {
    insertDecision(raw, {
      workstreamId: WS,
      decisionKind: "route",
      rationale: "heygen Drift",
    });
    const first = reconcileWorkstream(raw, {
      workspaceId: WSP,
      workstreamId: WS,
      coordKey: COORD,
      stepStatuses: { s1: "failed" },
    });
    expect(first.outcomeLessons).toBe(1);
    const historyAfterFirst = beliefHistory(raw, WSP, "route").length;

    // Zweiter Aufruf ist via RECONCILE_MARKER ein No-Op (alreadyReconciled).
    const second = reconcileWorkstream(raw, {
      workspaceId: WSP,
      workstreamId: WS,
      coordKey: COORD,
      stepStatuses: { s1: "failed" },
    });
    expect(second.alreadyReconciled).toBe(true);
    expect(second.outcomeLessons).toBe(0);
    expect(beliefHistory(raw, WSP, "route")).toHaveLength(historyAfterFirst);
  });
});

// ===========================================================================
// P0.2 — Reflexion bei WIEDERHOLTEN Fehlern (3× gleicher Fehler → Meta-Belief).
// ===========================================================================

describe("reconcileWorkstream P0.2 — reflection on repeated failures", () => {
  let raw: import("better-sqlite3").Database;
  beforeEach(() => {
    decSeq = 0;
    raw = freshDb();
  });

  function failRun(id: string): void {
    insertWorkstream(raw, id, WSP);
    insertDecision(raw, {
      workstreamId: id,
      decisionKind: "route",
      rationale: `heygen Versuch in ${id}`,
    });
    reconcileWorkstream(raw, {
      workspaceId: WSP,
      workstreamId: id,
      coordKey: `${WSP}/${id}`,
      stepStatuses: { s1: "failed" },
    });
  }

  it("below threshold (2 failures) → NO reflection meta-belief", () => {
    failRun("WS-R1");
    const res2 = (() => {
      insertWorkstream(raw, "WS-R2", WSP);
      insertDecision(raw, {
        workstreamId: "WS-R2",
        decisionKind: "route",
        rationale: "heygen Versuch 2",
      });
      return reconcileWorkstream(raw, {
        workspaceId: WSP,
        workstreamId: "WS-R2",
        coordKey: `${WSP}/WS-R2`,
        stepStatuses: { s1: "failed" },
      });
    })();
    expect(REFLECTION_THRESHOLD).toBe(3);
    expect(res2.reflections).toBe(0);
    const reflections = beliefHistory(raw, WSP, "route").filter((b) =>
      b.belief.startsWith(REFLECTION_MARKER_PREFIX),
    );
    expect(reflections).toHaveLength(0);
  });

  it("at threshold (3 failures same topic) → high-confidence reflection meta-belief", () => {
    failRun("WS-R1");
    failRun("WS-R2");
    // Dritter Fehler über reconcile → triggert die Reflexion.
    insertWorkstream(raw, "WS-R3", WSP);
    insertDecision(raw, {
      workstreamId: "WS-R3",
      decisionKind: "route",
      rationale: "heygen Versuch 3",
    });
    const res3 = reconcileWorkstream(raw, {
      workspaceId: WSP,
      workstreamId: "WS-R3",
      coordKey: `${WSP}/WS-R3`,
      stepStatuses: { s1: "failed" },
    });
    expect(res3.reflections).toBe(1);

    const reflections = beliefHistory(raw, WSP, "route").filter((b) =>
      b.belief.startsWith(REFLECTION_MARKER_PREFIX),
    );
    expect(reflections).toHaveLength(1);
    expect(reflections[0]!.confidence).toBe(0.85);
    expect(reflections[0]!.belief).toContain("Nach 3 Fehlversuchen");
    // Verbal self-feedback zitiert die gesammelten WARUMs.
    expect(reflections[0]!.rationale).toContain("heygen Versuch");
  });

  it("reflectOnRepeatedFailures is idempotent per threshold-count", () => {
    failRun("WS-R1");
    failRun("WS-R2");
    failRun("WS-R3"); // 3 → reflection geschrieben

    const before = beliefHistory(raw, WSP, "route").filter((b) =>
      b.belief.startsWith(REFLECTION_MARKER_PREFIX),
    ).length;
    // Direkter zweiter Aufruf bei UNVERÄNDERTEM count (3) → kein Doppel-Write.
    const wrote = reflectOnRepeatedFailures(raw, WSP, "route");
    expect(wrote).toBe(false);
    const after = beliefHistory(raw, WSP, "route").filter((b) =>
      b.belief.startsWith(REFLECTION_MARKER_PREFIX),
    ).length;
    expect(after).toBe(before);
  });
});

// ===========================================================================
// P1.1 — Erfolg verstärkt (success + passende Belief → confidence rauf via
// supersede; alte Row bleibt Historie).
// ===========================================================================

describe("reconcileWorkstream P1.1 — success reinforces matching belief", () => {
  let raw: import("better-sqlite3").Database;
  beforeEach(() => {
    decSeq = 0;
    raw = freshDb();
    insertWorkstream(raw, WS, WSP);
  });

  it("success + decision confirming an active belief → confidence up via supersede", () => {
    const prior = upsertBelief(raw, {
      workspaceId: WSP,
      topic: "route",
      belief: "Higgsfield",
      rationale: "Avatare dort besser",
      source: "user",
      confidence: 0.5,
    });
    insertDecision(raw, {
      workstreamId: WS,
      decisionKind: "route",
      rationale: "wie immer Higgsfield genommen — lief sauber",
    });
    const res = reconcileWorkstream(raw, {
      workspaceId: WSP,
      workstreamId: WS,
      coordKey: COORD,
      stepStatuses: { s1: "done" },
    });
    expect(res.outcome).toBe("success");
    expect(res.reinforcements).toBe(1);

    // Aktive Belief ist jetzt die verstärkte (höhere confidence), alte bleibt Historie.
    const active = listBeliefs(raw, WSP);
    expect(active).toHaveLength(1);
    expect(active[0]!.supersedesId).toBe(prior.id);
    expect(active[0]!.confidence).toBeGreaterThan(0.5);
    expect(active[0]!.belief).toBe("Higgsfield"); // belief-Text unverändert (N1)
    expect(active[0]!.rationale).toContain("P1.1-Reinforcement");

    const history = beliefHistory(raw, WSP, "route");
    expect(history).toHaveLength(2);
    expect(history.map((h) => h.id)).toContain(prior.id);
  });

  it("success but decision CONTRADICTS belief → NO reinforcement (that is a drift)", () => {
    upsertBelief(raw, {
      workspaceId: WSP,
      topic: "route",
      belief: "Higgsfield",
      rationale: "r",
      source: "user",
      confidence: 0.5,
    });
    insertDecision(raw, {
      workstreamId: WS,
      decisionKind: "route",
      rationale: "heygen statt dessen genommen",
    });
    const res = reconcileWorkstream(raw, {
      workspaceId: WSP,
      workstreamId: WS,
      coordKey: COORD,
      stepStatuses: { s1: "done" },
    });
    expect(res.outcome).toBe("success");
    expect(res.reinforcements).toBe(0);
    // Drift-Zweig hat hier verstärkt? Nein — Drift braucht failure-Kontext nicht,
    // aber ein success-Drift erzeugt einen Drift-Belief-Update (beliefUpdates).
    expect(res.beliefUpdates).toBe(1);
  });
});
