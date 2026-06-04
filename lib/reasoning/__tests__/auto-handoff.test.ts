// A6 Auto-Workspace-Handoff tests — Self-Learning / WARUM-Engine · Stream A · 2026-05-27.
//
// Strategy: in-memory better-sqlite3 DB. Schema aus den ECHTEN Migrationen
// (0009 workstreams + 0071 workstream_decisions + 0113 workspace_beliefs/
// decision_outcomes) via readFileSync — beweist nebenbei, dass die Aggregation
// gegen die echte DDL hält. Die `workspaces`-Tabelle wird minimal lokal angelegt
// (nur die für persistWorkspaceHandoff relevanten Spalten: id, notes,
// notes_updated_at, notes_source — exakt das Shape aus Migration 0013), um den
// Test fokussiert zu halten (kein 0002-Volltabellen-Chain).
//
// Es wird das LESEN/AGGREGIEREN getestet — Decision-/Belief-Rows werden direkt
// per INSERT bzw. via beliefs-repo angelegt; kein getDb()-Singleton, kein vi.mock.
//
// Run:
//   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
//     lib/reasoning/__tests__/auto-handoff.test.ts

import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  buildWorkspaceHandoff,
  persistWorkspaceHandoff,
  renderHandoffForSession,
  redactSecrets,
  TRUNCATION_MARKER,
} from "@/lib/reasoning/auto-handoff";
import { recordOutcome, upsertBelief } from "@/lib/reasoning/beliefs-repo";

const MIG = (name: string): string =>
  path.join(process.cwd(), "db", "migrations", name);

function freshDb(): import("better-sqlite3").Database {
  const raw = new Database(":memory:");
  raw.exec(readFileSync(MIG("0009_workstreams.sql"), "utf8"));
  raw.exec(readFileSync(MIG("0071_workstream_decisions.sql"), "utf8"));
  raw.exec(readFileSync(MIG("0113_workspace_beliefs.sql"), "utf8"));
  // Minimale workspaces-Tabelle (Shape wie 0002 + 0013-ALTERs, nur relevante Spalten).
  raw.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id               TEXT PRIMARY KEY NOT NULL,
      notes            TEXT,
      notes_updated_at INTEGER,
      notes_source     TEXT
    );
  `);
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

function insertWorkspaceRow(
  raw: import("better-sqlite3").Database,
  id: string,
  notes?: string | null,
  notesSource?: string | null,
): void {
  raw
    .prepare(
      `INSERT INTO workspaces (id, notes, notes_updated_at, notes_source)
       VALUES (?, ?, ?, ?)`,
    )
    .run(id, notes ?? null, notes != null ? Date.now() : null, notesSource ?? null);
}

describe("auto-handoff (A6)", () => {
  let raw: import("better-sqlite3").Database;
  beforeEach(() => {
    decSeq = 0;
    raw = freshDb();
  });

  // -------------------------------------------------------------------------
  // buildWorkspaceHandoff
  // -------------------------------------------------------------------------

  it("aggregates decisions + beliefs + open outcomes (scope-isolated)", () => {
    insertWorkstream(raw, "wst-1", "wsp-1");
    insertWorkstream(raw, "wst-other", "wsp-OTHER");

    const decResolved = insertDecision(raw, {
      workstreamId: "wst-1",
      decisionKind: "route",
      rationale: "Higgsfield gewählt weil heygen-Avatar 0× lieferte",
      createdAt: 1000,
    });
    const decOpen = insertDecision(raw, {
      workstreamId: "wst-1",
      decisionKind: "bridge",
      rationale: "Cross-WS-Retrieval nach CRM beantragt — noch offen",
      createdAt: 2000,
    });
    // Decision in einem ANDEREN Workspace — darf NICHT auftauchen.
    insertDecision(raw, {
      workstreamId: "wst-other",
      decisionKind: "override",
      rationale: "fremder Workspace — darf nicht leaken",
      createdAt: 3000,
    });

    // decResolved bekommt ein Outcome → zählt als „nicht offen".
    recordOutcome(raw, {
      workspaceId: "wsp-1",
      decisionId: decResolved,
      outcome: "success",
      note: "Video lief durch",
    });

    upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "video-connector",
      belief: "Higgsfield ist der verlässliche Motion-Connector",
      rationale: "heygen blieb 0× erreichbar (Connector-Drift-Bug)",
      source: "ai",
      confidence: 0.8,
    });
    // Belief in fremdem Workspace — darf nicht leaken.
    upsertBelief(raw, {
      workspaceId: "wsp-OTHER",
      topic: "leak",
      belief: "darf nicht erscheinen",
      rationale: "fremd",
      source: "ai",
    });

    const h = buildWorkspaceHandoff(raw, "wsp-1");

    expect(h.isEmpty).toBe(false);
    expect(h.workspaceId).toBe("wsp-1");

    // recentRationales: beide wsp-1-Decisions (neueste zuerst), kein fremder.
    expect(h.recentRationales.map((r) => r.rationale)).toEqual([
      "Cross-WS-Retrieval nach CRM beantragt — noch offen",
      "Higgsfield gewählt weil heygen-Avatar 0× lieferte",
    ]);
    expect(
      h.recentRationales.some((r) => r.rationale.includes("fremder")),
    ).toBe(false);

    // beliefs: nur der wsp-1-Belief.
    expect(h.beliefs).toHaveLength(1);
    expect(h.beliefs[0]!.topic).toBe("video-connector");
    expect(h.beliefs[0]!.confidence).toBe(0.8);

    // openDecisions: nur decOpen (decResolved hat ein Outcome).
    expect(h.openDecisions).toHaveLength(1);
    expect(h.openDecisions[0]!.decisionId).toBe(decOpen);
    expect(h.openDecisions[0]!.decisionKind).toBe("bridge");
  });

  it("verbatim N1 — rationale not sliced in build", () => {
    insertWorkstream(raw, "wst-1", "wsp-1");
    const long = "WARUM ".repeat(3000).trim();
    insertDecision(raw, {
      workstreamId: "wst-1",
      decisionKind: "route",
      rationale: long,
    });
    const h = buildWorkspaceHandoff(raw, "wsp-1");
    expect(h.recentRationales[0]!.rationale).toBe(long);
    expect(h.recentRationales[0]!.rationale.length).toBe(long.length);
  });

  it("fresh workspace → isEmpty, all arrays empty, no throw", () => {
    const h = buildWorkspaceHandoff(raw, "wsp-empty");
    expect(h.isEmpty).toBe(true);
    expect(h.recentRationales).toHaveLength(0);
    expect(h.beliefs).toHaveLength(0);
    expect(h.openDecisions).toHaveLength(0);
  });

  it("missing decision_outcomes table → fail-soft (all decisions open)", () => {
    // Frische DB OHNE 0113 → decision_outcomes existiert nicht.
    const raw2 = new Database(":memory:");
    raw2.exec(readFileSync(MIG("0009_workstreams.sql"), "utf8"));
    raw2.exec(readFileSync(MIG("0071_workstream_decisions.sql"), "utf8"));
    raw2.prepare(
      `INSERT INTO workstreams (id, workspace_id, name, status, created_at, updated_at)
       VALUES ('wst-x','wsp-x','x','active',?,?)`,
    ).run(Date.now(), Date.now());
    insertDecision(raw2, {
      workstreamId: "wst-x",
      decisionKind: "route",
      rationale: "kein outcomes-table",
    });
    // listBeliefs würde ohne 0113 werfen → wir testen nur den outcomes-Pfad
    // indem wir beliefs leer halten via try; aber buildWorkspaceHandoff ruft
    // listBeliefs. Daher: lege workspace_beliefs minimal an, decision_outcomes NICHT.
    raw2.exec(`CREATE TABLE workspace_beliefs (
      id TEXT PRIMARY KEY, workspace_id TEXT, topic TEXT, belief TEXT,
      rationale TEXT, source TEXT, supersedes_id TEXT, confidence REAL,
      content_hash TEXT, created_at INTEGER, updated_at INTEGER);`);
    const h = buildWorkspaceHandoff(raw2, "wsp-x");
    expect(h.openDecisions).toHaveLength(1);
    raw2.close();
  });

  // -------------------------------------------------------------------------
  // renderHandoffForSession
  // -------------------------------------------------------------------------

  it("renders structured block with all three sections", () => {
    insertWorkstream(raw, "wst-1", "wsp-1");
    insertDecision(raw, {
      workstreamId: "wst-1",
      decisionKind: "route",
      rationale: "Higgsfield gewählt",
      createdAt: 1000,
    });
    upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "deploy",
      belief: "freitags kein Deploy",
      rationale: "2x schiefgegangen",
      source: "user",
    });
    const h = buildWorkspaceHandoff(raw, "wsp-1");
    const block = renderHandoffForSession(h);
    expect(block).toContain("Workspace-Gedächtnis");
    expect(block).toContain("In diesem Workspace zuletzt:");
    expect(block).toContain("[route] Higgsfield gewählt");
    expect(block).toContain("Etablierte Überzeugungen:");
    expect(block).toContain("deploy: freitags kein Deploy");
    expect(block).toContain("Offene Entscheidungen (noch kein Ergebnis):");
  });

  it("empty handoff renders empty string (no noise in prompt)", () => {
    const h = buildWorkspaceHandoff(raw, "wsp-empty");
    expect(renderHandoffForSession(h)).toBe("");
  });

  it("maxChars hard-truncates with marker, budget respected", () => {
    insertWorkstream(raw, "wst-1", "wsp-1");
    for (let i = 0; i < 30; i++) {
      insertDecision(raw, {
        workstreamId: "wst-1",
        decisionKind: "route",
        rationale: `Entscheidung-Nummer-${i} `.repeat(20),
        createdAt: 1000 + i,
      });
    }
    const h = buildWorkspaceHandoff(raw, "wsp-1", { rationaleLimit: 30 });
    const block = renderHandoffForSession(h, { maxChars: 500 });
    expect(block.length).toBeLessThanOrEqual(500);
    expect(block.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // persistWorkspaceHandoff
  // -------------------------------------------------------------------------

  it("persists summary into workspaces.notes with notes_source=ai-summary", () => {
    insertWorkspaceRow(raw, "wsp-1", null, null);
    insertWorkstream(raw, "wst-1", "wsp-1");
    insertDecision(raw, {
      workstreamId: "wst-1",
      decisionKind: "route",
      rationale: "Higgsfield gewählt",
    });
    const h = buildWorkspaceHandoff(raw, "wsp-1");
    const res = persistWorkspaceHandoff(raw, "wsp-1", h);
    expect(res.written).toBe(true);

    const row = raw
      .prepare("SELECT notes, notes_source, notes_updated_at FROM workspaces WHERE id = ?")
      .get("wsp-1") as { notes: string; notes_source: string; notes_updated_at: number };
    expect(row.notes_source).toBe("ai-summary");
    expect(row.notes).toContain("Higgsfield gewählt");
    expect(row.notes_updated_at).toBe(h.generatedAt);
  });

  it("does NOT overwrite manual notes (foreign notes_source)", () => {
    insertWorkspaceRow(raw, "wsp-1", "Vom User gepflegtes CLAUDE.md", "manual");
    insertWorkstream(raw, "wst-1", "wsp-1");
    insertDecision(raw, {
      workstreamId: "wst-1",
      decisionKind: "route",
      rationale: "Higgsfield gewählt",
    });
    const h = buildWorkspaceHandoff(raw, "wsp-1");
    const res = persistWorkspaceHandoff(raw, "wsp-1", h);
    expect(res.written).toBe(false);
    expect(res.skippedReason).toBe("foreign-notes-source");

    const row = raw
      .prepare("SELECT notes, notes_source FROM workspaces WHERE id = ?")
      .get("wsp-1") as { notes: string; notes_source: string };
    expect(row.notes).toBe("Vom User gepflegtes CLAUDE.md");
    expect(row.notes_source).toBe("manual");
  });

  it("replaces a prior ai-summary (idempotent replace, no append growth)", () => {
    insertWorkspaceRow(raw, "wsp-1", "alter auto-handoff text", "ai-summary");
    insertWorkstream(raw, "wst-1", "wsp-1");
    insertDecision(raw, {
      workstreamId: "wst-1",
      decisionKind: "route",
      rationale: "neue Entscheidung",
    });
    const h = buildWorkspaceHandoff(raw, "wsp-1");
    const res1 = persistWorkspaceHandoff(raw, "wsp-1", h);
    expect(res1.written).toBe(true);
    const after1 = (
      raw.prepare("SELECT notes FROM workspaces WHERE id = ?").get("wsp-1") as {
        notes: string;
      }
    ).notes;
    expect(after1).not.toContain("alter auto-handoff text");
    expect(after1).toContain("neue Entscheidung");

    // Die Entscheidung erscheint sowohl unter „zuletzt" als auch „offen" (kein
    // Outcome) → genau 2× in EINEM Lauf. Beweis: kein unbegrenztes Anwachsen.
    const occurrencesAfter1 = after1.split("neue Entscheidung").length - 1;
    expect(occurrencesAfter1).toBe(2);

    // Zweiter Lauf mit gleichem Trail → identischer notes-Wert (idempotent,
    // REPLACE statt APPEND): Vorkommen bleiben konstant, wachsen NICHT.
    const h2 = buildWorkspaceHandoff(raw, "wsp-1");
    persistWorkspaceHandoff(raw, "wsp-1", h2);
    const after2 = (
      raw.prepare("SELECT notes FROM workspaces WHERE id = ?").get("wsp-1") as {
        notes: string;
      }
    ).notes;
    expect(after2).toContain("neue Entscheidung");
    // Gleiche Vorkommen-Zahl wie nach Lauf 1 → REPLACE, kein Append-Wachstum.
    expect(after2.split("neue Entscheidung").length - 1).toBe(occurrencesAfter1);
  });

  it("empty handoff → no write (does not clobber existing summary)", () => {
    insertWorkspaceRow(raw, "wsp-empty", "frühere Zusammenfassung", "ai-summary");
    const h = buildWorkspaceHandoff(raw, "wsp-empty");
    const res = persistWorkspaceHandoff(raw, "wsp-empty", h);
    expect(res.written).toBe(false);
    expect(res.skippedReason).toBe("empty-handoff");
    const row = raw
      .prepare("SELECT notes FROM workspaces WHERE id = ?")
      .get("wsp-empty") as { notes: string };
    expect(row.notes).toBe("frühere Zusammenfassung");
  });

  // -------------------------------------------------------------------------
  // Secret-Hygiene
  // -------------------------------------------------------------------------

  it("redactSecrets masks obvious key/token patterns", () => {
    expect(redactSecrets("key sk-ABCDEF1234567890")).toContain("[redacted-key]");
    expect(redactSecrets("ghp_ABCDEFGHIJ1234567890XY")).toContain("[redacted-token]");
    expect(redactSecrets("STRIPE_SECRET_KEY=sk_live_xyz")).toContain("[redacted]");
    expect(redactSecrets("Authorization: Bearer abcdef1234567890")).toContain(
      "Bearer [redacted]",
    );
    // Harmloser Text bleibt erhalten.
    expect(redactSecrets("Higgsfield gewählt weil heygen 0×")).toBe(
      "Higgsfield gewählt weil heygen 0×",
    );
  });

  it("rendered block contains no leaked secret from a rationale", () => {
    insertWorkstream(raw, "wst-1", "wsp-1");
    insertDecision(raw, {
      workstreamId: "wst-1",
      decisionKind: "route",
      rationale: "Stripe verbunden mit STRIPE_SECRET_KEY=sk_live_TOPSECRET12345",
    });
    const h = buildWorkspaceHandoff(raw, "wsp-1");
    const block = renderHandoffForSession(h);
    expect(block).not.toContain("sk_live_TOPSECRET12345");
    expect(block).toContain("[redacted]");
  });

  // -------------------------------------------------------------------------
  // E3 — summary-first (HERMES progressive-disclosure)
  // -------------------------------------------------------------------------

  // Realistisch langer rationale-Text (>160 Zeichen, mehrsätzig) — so dass
  // summarizeLine tatsächlich verdichtet (Kernsatz statt Volltext). Genau dieser
  // „wachsende Workspace mit langen Begründungen"-Fall ist der HERMES-Anwendungsfall.
  const LONG = (i: number) =>
    `Entscheidung Nummer ${i}: wir haben diesen Connector gewählt. ` +
    `Der ausführliche Grund war ein langer Audit mit vielen Befunden, Drift-Bugs, ` +
    `Coverage-Checks und einer Kette von Folge-Erwägungen, die hier verbatim stehen ` +
    `damit das WARUM nicht verloren geht und der Block beim Wachsen unter Druck gerät.`;

  function seedManyDecisions(n: number): void {
    insertWorkstream(raw, "wst-1", "wsp-1");
    for (let i = 0; i < n; i++) {
      insertDecision(raw, {
        workstreamId: "wst-1",
        decisionKind: "route",
        rationale: LONG(i),
        createdAt: 1000 + i,
      });
    }
  }

  /** Extrahiert nur die Zeilen der „zuletzt"-Sektion (bis zur nächsten Leerzeile). */
  function recentSection(block: string): string[] {
    const lines = block.split("\n");
    const start = lines.findIndex((l) => l.startsWith("In diesem Workspace zuletzt:"));
    if (start < 0) return [];
    const out: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].trim() === "") break;
      out.push(lines[i]);
    }
    return out;
  }

  it("default mode === 'full' ist bit-identisch zu explizitem mode:'full'", () => {
    seedManyDecisions(15);
    const h = buildWorkspaceHandoff(raw, "wsp-1", { rationaleLimit: 15 });
    const def = renderHandoffForSession(h);
    const full = renderHandoffForSession(h, { mode: "full" });
    expect(full).toBe(def);
  });

  it("summary-Modus deckt bei gleichem Budget MEHR Items ab als full-truncated", () => {
    seedManyDecisions(30);
    const h = buildWorkspaceHandoff(raw, "wsp-1", { rationaleLimit: 30 });
    const budget = 1200;
    const full = renderHandoffForSession(h, { mode: "full", maxChars: budget });
    const summary = renderHandoffForSession(h, {
      mode: "summary",
      maxChars: budget,
      topK: 2,
    });
    expect(summary.length).toBeLessThanOrEqual(budget);
    const countItems = (s: string) =>
      s.split("\n").filter((l) => /^[-·]\s*\[route\]/.test(l)).length;
    expect(countItems(summary)).toBeGreaterThan(countItems(full));
  });

  it("summary-Modus respektiert topK: nur top-k Rationales Volltext, Rest Summary-Zeilen (in der zuletzt-Sektion)", () => {
    seedManyDecisions(8);
    const h = buildWorkspaceHandoff(raw, "wsp-1", { rationaleLimit: 8 });
    const block = renderHandoffForSession(h, {
      mode: "summary",
      topK: 3,
      maxChars: 100000,
    });
    const sec = recentSection(block);
    const fullLines = sec.filter((l) => /^- \[route\]/.test(l));
    const summaryLines = sec.filter((l) => /^· \[route\]/.test(l));
    expect(fullLines).toHaveLength(3);
    expect(summaryLines).toHaveLength(5);
  });

  it("summary-Modus rankt Beliefs nach Konfidenz (höchste zuerst Volltext)", () => {
    insertWorkstream(raw, "wst-1", "wsp-1");
    upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "low",
      belief: "schwache Überzeugung",
      rationale: "wenig Evidenz",
      source: "ai",
      confidence: 0.1,
    });
    upsertBelief(raw, {
      workspaceId: "wsp-1",
      topic: "high",
      belief: "STARKE-ÜBERZEUGUNG",
      rationale: "viel Evidenz",
      source: "ai",
      confidence: 0.95,
    });
    const h = buildWorkspaceHandoff(raw, "wsp-1");
    const block = renderHandoffForSession(h, {
      mode: "summary",
      topK: 1,
      maxChars: 100000,
    });
    // top-1 Volltext-Belief ('- topic: belief … — warum: …') ist der hoch-konfidente.
    const fullBeliefLines = block
      .split("\n")
      .filter((l) => /^- \S+: .* — warum: /.test(l));
    expect(fullBeliefLines).toHaveLength(1);
    expect(fullBeliefLines[0]).toContain("STARKE-ÜBERZEUGUNG");
    // Der schwache erscheint als Summary-Zeile.
    expect(block).toContain("· low: schwache Überzeugung");
  });

  it("Secret-Redaction läuft auch im summary-Pfad", () => {
    seedManyDecisions(2); // top-k Volltext-Pfad
    insertDecision(raw, {
      workstreamId: "wst-1",
      decisionKind: "route",
      rationale: "altes Leak mit STRIPE_SECRET_KEY=sk_live_LEAK987654321 im Rest",
      createdAt: 100, // älter → landet im Summary-Rest bei topK klein
    });
    const h = buildWorkspaceHandoff(raw, "wsp-1", { rationaleLimit: 10 });
    const block = renderHandoffForSession(h, {
      mode: "summary",
      topK: 2,
      maxChars: 100000,
    });
    expect(block).not.toContain("sk_live_LEAK987654321");
    expect(block).toContain("[redacted]");
  });

  it("summary truncation hängt TRUNCATION_MARKER an wenn Budget zu klein", () => {
    seedManyDecisions(30);
    const h = buildWorkspaceHandoff(raw, "wsp-1", { rationaleLimit: 30 });
    const block = renderHandoffForSession(h, { mode: "summary", maxChars: 300, topK: 1 });
    expect(block.length).toBeLessThanOrEqual(300);
    expect(block.endsWith(TRUNCATION_MARKER)).toBe(true);
  });
});
