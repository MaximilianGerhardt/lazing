// A1 Decision-Read-Back tests — Self-Learning / WARUM-Engine · Stream A · 2026-05-27.
//
// Strategy: in-memory better-sqlite3 DB. Schema aus den ECHTEN Migrationen
// geladen (0009 workstreams als JOIN-Ziel + 0071 workstream_decisions) via
// readFileSync — beweist nebenbei, dass die JOIN-Annahme (decisions.workstream_id
// → workstreams.id, Workspace-Scope an workstreams.workspace_id) gegen die echte
// DDL hält. Decision-Rows werden direkt per INSERT angelegt (wir testen das
// LESEN, nicht trace-repo's writeDecision, das ein getDb()-Singleton braucht).
//
// Run:
//   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
//     lib/reasoning/__tests__/decisions-read.test.ts

import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { listDecisions, recentRationales } from "@/lib/reasoning/decisions-read";

const MIG_WORKSTREAMS = path.join(
  process.cwd(),
  "db",
  "migrations",
  "0009_workstreams.sql",
);
const MIG_DECISIONS = path.join(
  process.cwd(),
  "db",
  "migrations",
  "0071_workstream_decisions.sql",
);

function freshDb(): import("better-sqlite3").Database {
  const raw = new Database(":memory:");
  raw.exec(readFileSync(MIG_WORKSTREAMS, "utf8"));
  raw.exec(readFileSync(MIG_DECISIONS, "utf8"));
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
    createdAt?: number;
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
      opts.createdAt ?? Date.now(),
    );
  return id;
}

describe("decisions-read (A1)", () => {
  let raw: import("better-sqlite3").Database;
  beforeEach(() => {
    decSeq = 0;
    raw = freshDb();
    // Zwei Workspaces, je ein Workstream — Scope-Isolation prüfen.
    insertWorkstream(raw, "WS-A", "wsp-A");
    insertWorkstream(raw, "WS-B", "wsp-B");
  });

  it("listDecisions filters by workspace (JOIN via workstreams)", () => {
    insertDecision(raw, {
      workstreamId: "WS-A",
      decisionKind: "route",
      rationale: "A1",
    });
    insertDecision(raw, {
      workstreamId: "WS-B",
      decisionKind: "route",
      rationale: "B1",
    });

    const a = listDecisions(raw, { workspaceId: "wsp-A" });
    expect(a).toHaveLength(1);
    expect(a[0]!.rationale).toBe("A1");
    expect(a[0]!.workspaceId).toBe("wsp-A");
    expect(a[0]!.workstreamId).toBe("WS-A");

    const b = listDecisions(raw, { workspaceId: "wsp-B" });
    expect(b).toHaveLength(1);
    expect(b[0]!.rationale).toBe("B1");
  });

  it("listDecisions filters by kind", () => {
    insertDecision(raw, {
      workstreamId: "WS-A",
      decisionKind: "route",
      rationale: "routed",
    });
    insertDecision(raw, {
      workstreamId: "WS-A",
      decisionKind: "pause",
      rationale: "paused",
    });

    const onlyPause = listDecisions(raw, {
      workspaceId: "wsp-A",
      kind: "pause",
    });
    expect(onlyPause).toHaveLength(1);
    expect(onlyPause[0]!.decisionKind).toBe("pause");
    expect(onlyPause[0]!.rationale).toBe("paused");
  });

  it("listDecisions filters by coordKey (resolved to workstream_id)", () => {
    insertWorkstream(raw, "WS-A2", "wsp-A");
    insertDecision(raw, {
      workstreamId: "WS-A",
      decisionKind: "route",
      rationale: "on A",
    });
    insertDecision(raw, {
      workstreamId: "WS-A2",
      decisionKind: "route",
      rationale: "on A2",
    });

    // reine workstream_id
    const direct = listDecisions(raw, {
      workspaceId: "wsp-A",
      coordKey: "WS-A2",
    });
    expect(direct).toHaveLength(1);
    expect(direct[0]!.rationale).toBe("on A2");

    // `<workspaceId>/<workstreamId>`-Label → reduziert auf WS-A
    const labelled = listDecisions(raw, {
      workspaceId: "wsp-A",
      coordKey: "wsp-A/WS-A",
    });
    expect(labelled).toHaveLength(1);
    expect(labelled[0]!.rationale).toBe("on A");
  });

  it("listDecisions orders newest-first and respects limit", () => {
    insertDecision(raw, {
      workstreamId: "WS-A",
      decisionKind: "route",
      rationale: "old",
      createdAt: 1000,
    });
    insertDecision(raw, {
      workstreamId: "WS-A",
      decisionKind: "route",
      rationale: "new",
      createdAt: 2000,
    });

    const all = listDecisions(raw, { workspaceId: "wsp-A" });
    expect(all[0]!.rationale).toBe("new");
    expect(all[1]!.rationale).toBe("old");

    const limited = listDecisions(raw, { workspaceId: "wsp-A", limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]!.rationale).toBe("new");
  });

  it("listDecisions requires workspaceId", () => {
    expect(() => listDecisions(raw, { workspaceId: "" })).toThrow(
      /workspaceId required/,
    );
  });

  it("recentRationales returns verbatim WHY fields newest-first", () => {
    const long = "x".repeat(5000); // N1: NICHT gekürzt
    insertDecision(raw, {
      workstreamId: "WS-A",
      decisionKind: "override",
      rationale: long,
      actor: "user",
      createdAt: 3000,
    });
    insertDecision(raw, {
      workstreamId: "WS-A",
      decisionKind: "route",
      rationale: "second",
      actor: "agent",
      createdAt: 1000,
    });

    const r = recentRationales(raw, "wsp-A");
    expect(r).toHaveLength(2);
    expect(r[0]!.decisionKind).toBe("override");
    expect(r[0]!.actor).toBe("user");
    expect(r[0]!.rationale).toBe(long); // verbatim, full length
    expect(r[0]!.rationale.length).toBe(5000);
    expect(r[1]!.rationale).toBe("second");

    const limited = recentRationales(raw, "wsp-A", 1);
    expect(limited).toHaveLength(1);
    expect(limited[0]!.decisionKind).toBe("override");
  });
});
