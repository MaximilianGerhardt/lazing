// E2 — Belief-Curation tests (periodische ExpeL-Distillation) · Stream A.
//
// Strategy: in-memory better-sqlite3 DB, Schema aus der ECHTEN Migration
// db/migrations/0113_workspace_beliefs.sql via readFileSync (identisch zum
// beliefs-repo.test.ts Setup). curateWorkspaceBeliefs nimmt das rohe Handle —
// kein getDb()-Singleton, kein vi.mock. `now` wird injiziert → deterministisch.
//
// Run:
//   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
//     lib/reasoning/__tests__/curate.test.ts

import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  listBeliefs,
  listBeliefsByMarkerPrefix,
  recordOutcome,
  upsertBelief,
  type OutcomeKind,
} from "@/lib/reasoning/beliefs-repo";
import {
  CURATION_MARKER_PREFIX,
  curateWorkspaceBeliefs,
  curationPeriodKey,
  tallyTopicsFromTeachBeliefs,
} from "@/lib/reasoning/curate";

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

/** Seedet eine P0.1-Lehr-Belief (so wie reconcile.ts learnFromOutcome sie schreibt):
 * belief beginnt mit `[teach-v1:<wsId>:<outcome>]`. */
function seedTeach(
  raw: import("better-sqlite3").Database,
  workspaceId: string,
  topic: string,
  outcome: OutcomeKind,
  runId: string,
  rationale: string,
): void {
  upsertBelief(raw, {
    workspaceId,
    topic,
    belief: `[teach-v1:${runId}:${outcome}] „${topic}" führte zu outcome=${outcome} (Run ${runId}).`,
    rationale,
    source: "ai",
    confidence: outcome === "failure" ? 0.5 : 0.4,
  });
}

/** Seedet decision_outcomes (das minOutcomes-Gate). */
function seedOutcome(
  raw: import("better-sqlite3").Database,
  workspaceId: string,
  outcome: OutcomeKind,
  runId: string,
): void {
  recordOutcome(raw, {
    workspaceId,
    workstreamId: runId,
    outcome,
    note: `seed ${runId}`,
  });
}

const WS = "wsp-curate";
const NOW = new Date(Date.UTC(2026, 4, 27, 12, 0, 0)); // 2026-05-27 → ISO-Week 22

describe("curationPeriodKey (pure, ISO-week)", () => {
  it("produces a stable <year>-W<2-digit-week> key", () => {
    expect(curationPeriodKey(NOW)).toBe("2026-W22");
    // Jahreswechsel-robust: 1. Jan 2026 ist ISO-Woche 1.
    expect(curationPeriodKey(new Date(Date.UTC(2026, 0, 1)))).toMatch(
      /^2026-W0[12]$/,
    );
    // 2-stellig gepaddet.
    expect(curationPeriodKey(new Date(Date.UTC(2026, 0, 5)))).toMatch(/W\d{2}$/);
  });
});

describe("tallyTopicsFromTeachBeliefs (pure aggregation)", () => {
  it("clusters by topic, counts outcomes, joins WHY verbatim, ignores non-teach", () => {
    const raw = freshDb();
    seedTeach(raw, WS, "video", "failure", "R1", "heygen-Drift A");
    seedTeach(raw, WS, "video", "failure", "R2", "heygen-Drift B");
    seedTeach(raw, WS, "video", "partial", "R3", "teilweise ok");
    seedTeach(raw, WS, "deploy", "failure", "R4", "freitag schlecht");
    // Eine NICHT-teach Belief (normaler User-Belief) → darf nicht mitzählen.
    upsertBelief(raw, {
      workspaceId: WS,
      topic: "video",
      belief: "Wir machen Video selbst",
      rationale: "egal",
      source: "user",
    });

    const teach = listBeliefsByMarkerPrefix(raw, WS, "[teach-v1");
    const tallies = tallyTopicsFromTeachBeliefs(teach);

    // alphabetisch: deploy, video
    expect(tallies.map((t) => t.topic)).toEqual(["deploy", "video"]);
    const video = tallies.find((t) => t.topic === "video")!;
    expect(video.failures).toBe(2);
    expect(video.partials).toBe(1);
    expect(video.successes).toBe(0);
    expect(video.total).toBe(3);
    // VERBATIM zusammengefügte WARUMs (N1).
    expect(video.joinedWhy).toContain("heygen-Drift A");
    expect(video.joinedWhy).toContain("heygen-Drift B");
    expect(video.joinedWhy).toContain("teilweise ok");
  });
});

describe("curateWorkspaceBeliefs (E2 distillation)", () => {
  let raw: import("better-sqlite3").Database;
  beforeEach(() => {
    raw = freshDb();
  });

  it("distills a generalized belief from a mixed failure/partial pool", () => {
    // 4 Outcomes (≥ minOutcomes default 3) + Lehr-Beliefs zu „video".
    seedOutcome(raw, WS, "failure", "R1");
    seedOutcome(raw, WS, "failure", "R2");
    seedOutcome(raw, WS, "partial", "R3");
    seedOutcome(raw, WS, "success", "R4");
    seedTeach(raw, WS, "video", "failure", "R1", "heygen-Connector-Drift");
    seedTeach(raw, WS, "video", "failure", "R2", "erneut heygen gescheitert");
    seedTeach(raw, WS, "video", "partial", "R3", "nur halb erzeugt");

    const res = curateWorkspaceBeliefs(raw, WS, { now: NOW });
    expect(res.skipped).toBe(false);
    expect(res.period).toBe("2026-W22");
    expect(res.outcomeCount).toBe(4);
    expect(res.topicsConsidered).toBe(1);
    expect(res.curated).toHaveLength(1);

    const active = listBeliefs(raw, WS);
    const curated = active.find((b) =>
      b.belief.startsWith(CURATION_MARKER_PREFIX),
    );
    expect(curated).toBeDefined();
    // Generalisierte Insight: 0 Erfolge / 3 Fehler → verifizierte Alternative.
    expect(curated!.belief).toContain("0 Erfolge / 3 Fehler");
    expect(curated!.belief).toContain("verifizierte Alternative");
    // WARUMs VERBATIM in der rationale (N1).
    expect(curated!.rationale).toContain("heygen-Connector-Drift");
    expect(curated!.rationale).toContain("nur halb erzeugt");
    // Marker trägt Periode + Bilanz-Fingerprint.
    expect(curated!.belief).toContain("[curate-v1:2026-W22:s0:f3]");
  });

  it("is idempotent: second run in the same period writes nothing new", () => {
    seedOutcome(raw, WS, "failure", "R1");
    seedOutcome(raw, WS, "failure", "R2");
    seedOutcome(raw, WS, "failure", "R3");
    seedTeach(raw, WS, "deploy", "failure", "R1", "a");
    seedTeach(raw, WS, "deploy", "failure", "R2", "b");
    seedTeach(raw, WS, "deploy", "failure", "R3", "c");

    const first = curateWorkspaceBeliefs(raw, WS, { now: NOW });
    expect(first.curated).toHaveLength(1);
    const afterFirst = listBeliefsByMarkerPrefix(
      raw,
      WS,
      CURATION_MARKER_PREFIX,
    ).length;

    const second = curateWorkspaceBeliefs(raw, WS, { now: NOW });
    expect(second.curated).toHaveLength(0); // No-Op, kein Doppel
    const afterSecond = listBeliefsByMarkerPrefix(
      raw,
      WS,
      CURATION_MARKER_PREFIX,
    ).length;
    expect(afterSecond).toBe(afterFirst);

    // Nur EINE aktive Curation-Belief für den topic.
    const active = listBeliefs(raw, WS).filter((b) =>
      b.belief.startsWith(CURATION_MARKER_PREFIX),
    );
    expect(active).toHaveLength(1);
  });

  it("a later period with a shifted tally supersedes the prior curation (history kept)", () => {
    seedOutcome(raw, WS, "failure", "R1");
    seedOutcome(raw, WS, "failure", "R2");
    seedOutcome(raw, WS, "failure", "R3");
    seedTeach(raw, WS, "deploy", "failure", "R1", "a");
    seedTeach(raw, WS, "deploy", "failure", "R2", "b");
    seedTeach(raw, WS, "deploy", "failure", "R3", "c");

    const p1 = curateWorkspaceBeliefs(raw, WS, { now: NOW });
    expect(p1.curated).toHaveLength(1);

    // Eine Woche später + ein weiterer Fehler → andere Bilanz → neue Distillation.
    seedOutcome(raw, WS, "failure", "R4");
    seedTeach(raw, WS, "deploy", "failure", "R4", "d");
    const later = new Date(Date.UTC(2026, 5, 3, 12, 0, 0)); // andere ISO-Woche
    const p2 = curateWorkspaceBeliefs(raw, WS, { now: later });
    expect(p2.period).not.toBe(p1.period);
    expect(p2.curated).toHaveLength(1);

    // Nur EINE aktive Curation-Belief (die neue löst die alte ab); Historie hat beide.
    const active = listBeliefs(raw, WS).filter((b) =>
      b.belief.startsWith(CURATION_MARKER_PREFIX),
    );
    expect(active).toHaveLength(1);
    expect(active[0]!.belief).toContain("4 Fehler");
    const all = listBeliefsByMarkerPrefix(raw, WS, CURATION_MARKER_PREFIX);
    expect(all).toHaveLength(2); // aktiv + abgelöst
  });

  it("no-op when below minOutcomes", () => {
    seedOutcome(raw, WS, "failure", "R1");
    seedTeach(raw, WS, "video", "failure", "R1", "x");
    const res = curateWorkspaceBeliefs(raw, WS, { now: NOW, minOutcomes: 3 });
    expect(res.skipped).toBe(true);
    expect(res.skipReason).toContain("minOutcomes");
    expect(res.curated).toHaveLength(0);
    expect(listBeliefsByMarkerPrefix(raw, WS, CURATION_MARKER_PREFIX)).toHaveLength(
      0,
    );
  });

  it("no-op for an empty workspace (no outcomes, no teach beliefs)", () => {
    const res = curateWorkspaceBeliefs(raw, "wsp-empty", { now: NOW });
    expect(res.skipped).toBe(true);
    expect(res.curated).toHaveLength(0);
  });

  it("no-op when outcomes pass the gate but there are no teach-belief signals", () => {
    seedOutcome(raw, WS, "success", "R1");
    seedOutcome(raw, WS, "success", "R2");
    seedOutcome(raw, WS, "success", "R3");
    const res = curateWorkspaceBeliefs(raw, WS, { now: NOW });
    expect(res.skipped).toBe(true);
    expect(res.skipReason).toContain("no teach-belief");
    expect(res.curated).toHaveLength(0);
  });

  it("is workspace-scoped (no cross-workspace leak)", () => {
    // WS hat genug Evidenz, ein anderer Workspace ist leer.
    seedOutcome(raw, WS, "failure", "R1");
    seedOutcome(raw, WS, "failure", "R2");
    seedOutcome(raw, WS, "failure", "R3");
    seedTeach(raw, WS, "deploy", "failure", "R1", "a");
    seedTeach(raw, WS, "deploy", "failure", "R2", "b");
    seedTeach(raw, WS, "deploy", "failure", "R3", "c");
    // Fremder Workspace-Outcome darf das Gate von WS nicht beeinflussen.
    seedOutcome(raw, "wsp-other", "failure", "X1");

    curateWorkspaceBeliefs(raw, WS, { now: NOW });
    expect(listBeliefs(raw, "wsp-other")).toHaveLength(0);
  });

  it("requires workspaceId", () => {
    expect(() => curateWorkspaceBeliefs(raw, "", { now: NOW })).toThrow(
      /workspaceId required/,
    );
  });
});
