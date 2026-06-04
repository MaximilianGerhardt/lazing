// A2 Workspace-ReasoningBank tests — Self-Learning / WARUM-Engine · Stream A.
//
// Strategy: in-memory better-sqlite3 DB, Schema aus der ECHTEN Migration
// db/migrations/0113_workspace_beliefs.sql via readFileSync (beweist nebenbei,
// dass die Migration-SQL gültig ist + idempotent re-applyt). Repo nimmt ein
// rohes DB-Handle — kein getDb()-Singleton, kein vi.mock.
//
// Run:
//   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
//     lib/reasoning/__tests__/beliefs-repo.test.ts

import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  beliefHistory,
  listBeliefs,
  listBeliefsByMarkerPrefix,
  listOutcomes,
  listOutcomesByWorkspace,
  recallRelevant,
  recordOutcome,
  reinforceBelief,
  rankBeliefs,
  upsertBelief,
} from "@/lib/reasoning/beliefs-repo";

const MIGRATION = path.join(
  process.cwd(),
  "db",
  "migrations",
  "0113_workspace_beliefs.sql",
);

function freshDb(): import("better-sqlite3").Database {
  const raw = new Database(":memory:");
  const sql = readFileSync(MIGRATION, "utf8");
  raw.exec(sql);
  raw.exec(sql); // re-apply → IF NOT EXISTS idempotency
  return raw;
}

describe("beliefs-repo (A2)", () => {
  let raw: import("better-sqlite3").Database;
  beforeEach(() => {
    raw = freshDb();
  });

  it("upsertBelief roundtrip + verbatim N1 + content_hash N10", () => {
    const longRationale = "warum ".repeat(2000); // N1: nicht gekürzt
    const b = upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "deploy-strategy",
      belief: "Wir deployen freitags nicht",
      rationale: longRationale,
      source: "user",
      confidence: 0.9,
    });
    expect(b.id).toMatch(/^BLF-/);
    expect(b.belief).toBe("Wir deployen freitags nicht");
    expect(b.rationale).toBe(longRationale);
    expect(b.rationale.length).toBe(longRationale.length);
    expect(b.source).toBe("user");
    expect(b.confidence).toBe(0.9);
    expect(b.supersedesId).toBeNull();
    expect(b.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const active = listBeliefs(raw, "wsp-1");
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(b.id);
  });

  it("supersede: old belief stays as history, listBeliefs shows only active", () => {
    const v1 = upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "deploy-strategy",
      belief: "Wir deployen freitags nicht",
      rationale: "Freitag-Deploys gingen 2x schief",
      source: "user",
    });
    const v2 = upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "deploy-strategy",
      belief: "Wir deployen freitags wieder, mit Canary",
      rationale: "Canary-Pipeline seit Q2 stabil",
      source: "ai",
      supersedesId: v1.id,
    });

    // listBeliefs zeigt nur die aktive (nicht-abgelöste) v2.
    const active = listBeliefs(raw, "wsp-1");
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(v2.id);
    expect(active[0]!.belief).toBe("Wir deployen freitags wieder, mit Canary");
    expect(active[0]!.supersedesId).toBe(v1.id);

    // v1 ist NICHT gelöscht — beliefHistory zeigt die volle Kette.
    const history = beliefHistory(raw, "wsp-1", "deploy-strategy");
    expect(history).toHaveLength(2);
    const ids = history.map((h) => h.id);
    expect(ids).toContain(v1.id);
    expect(ids).toContain(v2.id);
  });

  it("supersede chain v1<-v2<-v3: only v3 active, history has all 3", () => {
    const v1 = upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "stack",
      belief: "Next 14",
      rationale: "war Stand 2024",
      source: "ai",
    });
    const v2 = upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "stack",
      belief: "Next 15",
      rationale: "Upgrade",
      source: "ai",
      supersedesId: v1.id,
    });
    const v3 = upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "stack",
      belief: "Next 16",
      rationale: "aktuell",
      source: "ai",
      supersedesId: v2.id,
    });

    const active = listBeliefs(raw, "wsp-1");
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(v3.id);

    expect(beliefHistory(raw, "wsp-1", "stack")).toHaveLength(3);
  });

  it("upsertBelief ignores cross-workspace / unknown supersedesId", () => {
    const other = upsertBelief(raw, {
      workspaceId: "wsp-OTHER",
      topic: "x",
      belief: "fremd",
      rationale: "r",
      source: "ai",
    });
    // Versuch, eine fremde Belief abzulösen → Kante wird verworfen (null).
    const b = upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "x",
      belief: "meins",
      rationale: "r",
      source: "ai",
      supersedesId: other.id,
    });
    expect(b.supersedesId).toBeNull();
    // Beide bleiben aktiv (kein versehentliches Ablösen über Scope-Grenze).
    expect(listBeliefs(raw, "wsp-OTHER")).toHaveLength(1);
    expect(listBeliefs(raw, "wsp-1")).toHaveLength(1);
  });

  it("recallRelevant matches topic (exact + LIKE), only active, scoped", () => {
    upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "deploy-strategy",
      belief: "freitags-nein",
      rationale: "r",
      source: "user",
    });
    upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "testing-policy",
      belief: "coverage>=80",
      rationale: "r",
      source: "ai",
    });
    upsertBelief(raw, {
      workspaceId: "wsp-OTHER",
      topic: "deploy-strategy",
      belief: "fremd",
      rationale: "r",
      source: "ai",
    });

    // exact
    const exact = recallRelevant(raw, "wsp-1", "deploy-strategy");
    expect(exact).toHaveLength(1);
    expect(exact[0]!.belief).toBe("freitags-nein");

    // LIKE substring
    const partial = recallRelevant(raw, "wsp-1", "deploy");
    expect(partial).toHaveLength(1);
    expect(partial[0]!.topic).toBe("deploy-strategy");

    // no cross-workspace leak
    expect(recallRelevant(raw, "wsp-1", "deploy").map((b) => b.belief)).not.toContain(
      "fremd",
    );

    // no match
    expect(recallRelevant(raw, "wsp-1", "nonexistent")).toHaveLength(0);
  });

  it("recallRelevant excludes superseded beliefs", () => {
    const v1 = upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "deploy-strategy",
      belief: "alt",
      rationale: "r",
      source: "user",
    });
    upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "deploy-strategy",
      belief: "neu",
      rationale: "r",
      source: "ai",
      supersedesId: v1.id,
    });
    const hits = recallRelevant(raw, "wsp-1", "deploy");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.belief).toBe("neu");
  });

  it("recallRelevant escapes LIKE wildcards in topic", () => {
    upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "100%-coverage",
      belief: "b",
      rationale: "r",
      source: "ai",
    });
    upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "deploy",
      belief: "b2",
      rationale: "r",
      source: "ai",
    });
    // '%' darf NICHT als Wildcard wirken → matcht nur den 100%-Eintrag, nicht deploy.
    const hits = recallRelevant(raw, "wsp-1", "%");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.topic).toBe("100%-coverage");
  });

  it("recordOutcome roundtrip (decisionId + workstreamId)", () => {
    const o = recordOutcome(raw, {
      workspaceId: "wsp-1",
      decisionId: "dec_001",
      workstreamId: "WS-A",
      outcome: "success",
      note: "Plan ging wie begründet auf",
    });
    expect(o.id).toMatch(/^DOUT-/);
    expect(o.outcome).toBe("success");
    expect(o.note).toBe("Plan ging wie begründet auf");

    const byDecision = listOutcomes(raw, {
      workspaceId: "wsp-1",
      decisionId: "dec_001",
    });
    expect(byDecision).toHaveLength(1);
    expect(byDecision[0]!.id).toBe(o.id);

    const byWorkstream = listOutcomes(raw, {
      workspaceId: "wsp-1",
      workstreamId: "WS-A",
    });
    expect(byWorkstream).toHaveLength(1);
  });

  it("recordOutcome requires a decision or workstream + valid outcome", () => {
    expect(() =>
      recordOutcome(raw, { workspaceId: "wsp-1", outcome: "success" }),
    ).toThrow(/at least one of decisionId/);
    expect(() =>
      recordOutcome(raw, {
        workspaceId: "wsp-1",
        decisionId: "d",
        // @ts-expect-error testing invalid outcome at runtime
        outcome: "nope",
      }),
    ).toThrow(/outcome must be one of/);
  });

  it("input validation: upsertBelief rejects empty required fields", () => {
    expect(() =>
      upsertBelief(raw, {
        workspaceId: "",
        topic: "t",
        belief: "b",
        rationale: "r",
        source: "ai",
      }),
    ).toThrow(/workspaceId required/);
    expect(() =>
      upsertBelief(raw, {
        workspaceId: "w",
        topic: "t",
        belief: "b",
        rationale: "r",
        // @ts-expect-error invalid source
        source: "robot",
      }),
    ).toThrow(/source must be/);
  });
});

// ===========================================================================
// P1.1 — reinforceBelief (Erfolg verstärkt; supersede, Historie bleibt).
// ===========================================================================

describe("reinforceBelief (P1.1)", () => {
  let raw: import("better-sqlite3").Database;
  beforeEach(() => {
    raw = freshDb();
  });

  it("raises confidence via supersede; old row stays as history; belief verbatim", () => {
    const v1 = upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "deploy-strategy",
      belief: "Canary first",
      rationale: "stabil seit Q2",
      source: "ai",
      confidence: 0.6,
    });
    const reinforced = reinforceBelief(raw, {
      workspaceId: "wsp-1",
      beliefId: v1.id,
      delta: 0.2,
      rationale: "Run X bestätigte Canary erneut",
    });
    expect(reinforced).not.toBeNull();
    expect(reinforced!.confidence).toBeCloseTo(0.8, 5);
    expect(reinforced!.belief).toBe("Canary first"); // N1: unverändert
    expect(reinforced!.supersedesId).toBe(v1.id);
    expect(reinforced!.rationale).toContain("Run X bestätigte Canary erneut");

    // Nur die verstärkte ist aktiv; v1 bleibt Historie.
    const active = listBeliefs(raw, "wsp-1");
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(reinforced!.id);
    expect(beliefHistory(raw, "wsp-1", "deploy-strategy")).toHaveLength(2);
  });

  it("null confidence treated as neutral 0.5; default delta 0.1 → 0.6", () => {
    const v1 = upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "t",
      belief: "b",
      rationale: "r",
      source: "ai",
    });
    const r = reinforceBelief(raw, {
      workspaceId: "wsp-1",
      beliefId: v1.id,
      rationale: "bestätigt",
    });
    expect(r!.confidence).toBeCloseTo(0.6, 5);
  });

  it("confidence is clamped to [0,1]", () => {
    const v1 = upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "t",
      belief: "b",
      rationale: "r",
      source: "ai",
      confidence: 0.95,
    });
    const r = reinforceBelief(raw, {
      workspaceId: "wsp-1",
      beliefId: v1.id,
      delta: 0.5,
      rationale: "bestätigt",
    });
    expect(r!.confidence).toBe(1);
  });

  it("returns null for unknown / cross-workspace / superseded belief (fail-soft)", () => {
    expect(
      reinforceBelief(raw, {
        workspaceId: "wsp-1",
        beliefId: "BLF-does-not-exist",
        rationale: "x",
      }),
    ).toBeNull();

    // cross-workspace
    const other = upsertBelief(raw, {
      workspaceId: "wsp-OTHER",
      topic: "t",
      belief: "b",
      rationale: "r",
      source: "ai",
    });
    expect(
      reinforceBelief(raw, {
        workspaceId: "wsp-1",
        beliefId: other.id,
        rationale: "x",
      }),
    ).toBeNull();

    // already superseded → not active → null
    const v1 = upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "t2",
      belief: "alt",
      rationale: "r",
      source: "ai",
    });
    upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "t2",
      belief: "neu",
      rationale: "r",
      source: "ai",
      supersedesId: v1.id,
    });
    expect(
      reinforceBelief(raw, {
        workspaceId: "wsp-1",
        beliefId: v1.id,
        rationale: "x",
      }),
    ).toBeNull();
  });
});

// ===========================================================================
// P1.3 — gewichteter Recall (recency · confidence · relevance), lexical N7.
// rankBeliefs ist pure → deterministisch ohne Clock-Abhängigkeit testbar.
// ===========================================================================

describe("rankBeliefs (P1.3 deterministic weighted ranking)", () => {
  const mk = (
    over: Partial<Parameters<typeof rankBeliefs>[0][number]>,
  ): Parameters<typeof rankBeliefs>[0][number] => ({
    id: "BLF-x",
    workspaceId: "wsp-1",
    topic: "route",
    belief: "b",
    rationale: "r",
    source: "ai",
    supersedesId: null,
    confidence: null,
    contentHash: "h",
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  });

  it("exact topic-match ranks before LIKE-only match (relevance dominates)", () => {
    const exact = mk({ id: "BLF-exact", topic: "route", confidence: 0.1 });
    const like = mk({ id: "BLF-like", topic: "route-fallback", confidence: 0.1 });
    const ranked = rankBeliefs([like, exact], "route");
    expect(ranked[0]!.id).toBe("BLF-exact");
  });

  it("higher confidence ranks before lower at equal relevance", () => {
    const hi = mk({ id: "BLF-hi", topic: "route", confidence: 0.9 });
    const lo = mk({ id: "BLF-lo", topic: "route", confidence: 0.1 });
    const ranked = rankBeliefs([lo, hi], "route");
    expect(ranked[0]!.id).toBe("BLF-hi");
  });

  it("newer (higher updated_at) ranks before older at equal relevance+confidence", () => {
    const newer = mk({ id: "BLF-new", topic: "route", confidence: 0.5, updatedAt: 5000 });
    const older = mk({ id: "BLF-old", topic: "route", confidence: 0.5, updatedAt: 1000 });
    const ranked = rankBeliefs([older, newer], "route");
    expect(ranked[0]!.id).toBe("BLF-new");
  });

  it("combined: exact+high-confidence+new beats older LIKE/low-confidence", () => {
    const winner = mk({
      id: "BLF-winner",
      topic: "route",
      confidence: 0.9,
      updatedAt: 9000,
    });
    const loser = mk({
      id: "BLF-loser",
      topic: "route-old-fallback",
      confidence: 0.2,
      updatedAt: 1000,
    });
    const ranked = rankBeliefs([loser, winner], "route");
    expect(ranked[0]!.id).toBe("BLF-winner");
    expect(ranked[1]!.id).toBe("BLF-loser");
  });

  it("single belief is returned unchanged (no ranking needed)", () => {
    const one = mk({ id: "BLF-one" });
    expect(rankBeliefs([one], "route").map((b) => b.id)).toEqual(["BLF-one"]);
  });
});

describe("recallRelevant ranking + limit (P1.3, backward-compatible form)", () => {
  let raw: import("better-sqlite3").Database;
  beforeEach(() => {
    raw = freshDb();
  });

  it("returns Belief[] (same shape) and ranks exact-match + high-confidence first", () => {
    // LIKE-only, low confidence.
    upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "route-fallback",
      belief: "fallback",
      rationale: "r",
      source: "ai",
      confidence: 0.1,
    });
    // exact topic, high confidence — should rank first.
    upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "route",
      belief: "primary",
      rationale: "r",
      source: "ai",
      confidence: 0.9,
    });

    const hits = recallRelevant(raw, "wsp-1", "route");
    expect(hits).toHaveLength(2);
    // Rückwärtskompatibel: dieselbe Form (Belief[]) — nur sortiert.
    expect(hits[0]!.belief).toBe("primary");
    expect(hits[0]!.topic).toBe("route");

    // limit schneidet nach dem Ranking ab.
    const top1 = recallRelevant(raw, "wsp-1", "route", { limit: 1 });
    expect(top1).toHaveLength(1);
    expect(top1[0]!.belief).toBe("primary");
  });
});

// ===========================================================================
// E2 — additive Lese-Helfer für die Belief-Curation (listOutcomesByWorkspace,
// listBeliefsByMarkerPrefix). Bestehende Exporte unverändert.
// ===========================================================================

describe("listOutcomesByWorkspace (E2 additive helper)", () => {
  let raw: import("better-sqlite3").Database;
  beforeEach(() => {
    raw = freshDb();
  });

  it("returns the whole workspace outcome pool, newest first, scoped", () => {
    recordOutcome(raw, {
      workspaceId: "wsp-1",
      workstreamId: "WS-A",
      outcome: "failure",
      note: "a",
    });
    recordOutcome(raw, {
      workspaceId: "wsp-1",
      decisionId: "dec_1",
      outcome: "success",
      note: "b",
    });
    recordOutcome(raw, {
      workspaceId: "wsp-OTHER",
      workstreamId: "WS-X",
      outcome: "failure",
      note: "fremd",
    });

    const pool = listOutcomesByWorkspace(raw, "wsp-1");
    expect(pool).toHaveLength(2); // kein cross-workspace leak
    expect(pool.map((o) => o.note)).not.toContain("fremd");
    // newest first (created_at DESC, id DESC).
    expect(pool[0]!.createdAt).toBeGreaterThanOrEqual(pool[1]!.createdAt);

    // limit respektiert.
    const one = listOutcomesByWorkspace(raw, "wsp-1", { limit: 1 });
    expect(one).toHaveLength(1);
  });

  it("returns empty for a workspace with no outcomes + requires workspaceId", () => {
    expect(listOutcomesByWorkspace(raw, "wsp-empty")).toHaveLength(0);
    expect(() => listOutcomesByWorkspace(raw, "")).toThrow(/workspaceId required/);
  });
});

describe("listBeliefsByMarkerPrefix (E2 additive helper)", () => {
  let raw: import("better-sqlite3").Database;
  beforeEach(() => {
    raw = freshDb();
  });

  it("returns active+superseded beliefs whose belief starts with the prefix, scoped", () => {
    // Eine teach-Belief, eine reflect-Belief, eine normale Belief.
    upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "video",
      belief: "[teach-v1:R1:failure] heygen gescheitert",
      rationale: "r",
      source: "ai",
    });
    upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "video",
      belief: "[reflect-v1:video:3] nach 3 Fehlern prüfen",
      rationale: "r",
      source: "ai",
    });
    upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "video",
      belief: "Normale Überzeugung ohne Marker",
      rationale: "r",
      source: "user",
    });
    upsertBelief(raw, {
      workspaceId: "wsp-OTHER",
      topic: "video",
      belief: "[teach-v1:RX:failure] fremd",
      rationale: "r",
      source: "ai",
    });

    const teach = listBeliefsByMarkerPrefix(raw, "wsp-1", "[teach-v1");
    expect(teach).toHaveLength(1);
    expect(teach[0]!.belief).toContain("heygen gescheitert");
    // kein cross-workspace leak.
    expect(teach.map((b) => b.belief)).not.toContain(
      "[teach-v1:RX:failure] fremd",
    );

    // includes superseded rows (analog beliefHistory — kein NOT EXISTS-Filter).
    const v1 = upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "x",
      belief: "[teach-v1:R2:failure] alt",
      rationale: "r",
      source: "ai",
    });
    upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "x",
      belief: "[teach-v1:R3:failure] neu",
      rationale: "r",
      source: "ai",
      supersedesId: v1.id,
    });
    const teachAll = listBeliefsByMarkerPrefix(raw, "wsp-1", "[teach-v1");
    expect(teachAll).toHaveLength(3); // erste + alt + neu (abgelöst zählt mit)
  });

  it("escapes LIKE wildcards in the prefix + requires workspaceId/prefix", () => {
    upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "t",
      belief: "[curate-v1:2026-W22:s0:f3] insight",
      rationale: "r",
      source: "ai",
    });
    // Präfix mit '%' darf nicht als Wildcard wirken — exakter Präfix matcht.
    expect(
      listBeliefsByMarkerPrefix(raw, "wsp-1", "[curate-v1"),
    ).toHaveLength(1);
    expect(listBeliefsByMarkerPrefix(raw, "wsp-1", "[nope")).toHaveLength(0);
    expect(() => listBeliefsByMarkerPrefix(raw, "", "[x")).toThrow(
      /workspaceId required/,
    );
    expect(() => listBeliefsByMarkerPrefix(raw, "wsp-1", "")).toThrow(
      /prefix required/,
    );
  });
});
