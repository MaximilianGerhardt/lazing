// A3 — WHY-Einspeisung tests · Self-Learning / WARUM-Engine · Stream A · 2026-05-27.
//
// Strategy: in-memory better-sqlite3 DB, Schema aus den ECHTEN Migrationen via
// readFileSync (kein getDb()-Singleton, kein vi.mock). buildWhyContext nimmt —
// wie die ganze reasoning-Surface — ein rohes Database-Handle. Wir laden:
//   - 0009 workstreams          (JOIN-Ziel für workstream_decisions)
//   - 0071 workstream_decisions (A1 listDecisions/recentRationales)
//   - 0113 workspace_beliefs    (A2 recallRelevant)
//
// Run:
//   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
//     lib/reasoning/__tests__/why-context.test.ts

import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  buildWhyContext,
  renderWhyContextForPrompt,
  type WhyContext,
} from "@/lib/reasoning/why-context";
import { upsertBelief } from "@/lib/reasoning/beliefs-repo";

const MIG = (f: string) => path.join(process.cwd(), "db", "migrations", f);

const MIGRATIONS = [
  "0009_workstreams.sql",
  "0071_workstream_decisions.sql",
  "0113_workspace_beliefs.sql",
];

function freshDb(): import("better-sqlite3").Database {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = OFF");
  for (const f of MIGRATIONS) {
    const sql = readFileSync(MIG(f), "utf8");
    try {
      raw.exec(sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name/i.test(msg)) throw err;
      for (const stmt of sql.split(/;\s*$/m).map((s) => s.trim())) {
        if (!stmt || stmt.startsWith("--")) continue;
        try {
          raw.exec(stmt);
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          if (!/duplicate column name/i.test(m)) throw e;
        }
      }
    }
  }
  return raw;
}

const WS = "ws-why-1";
const OTHER_WS = "ws-why-2";

/** Seedet einen Workstream-Row (Scope-Träger des Workspace). */
function seedWorkstream(
  raw: import("better-sqlite3").Database,
  id: string,
  workspaceId: string,
): void {
  const ts = Date.now();
  raw
    .prepare(
      `INSERT INTO workstreams (id, workspace_id, name, status, cost_cents, created_at, updated_at)
       VALUES (?, ?, ?, 'active', 0, ?, ?)`,
    )
    .run(id, workspaceId, `WS ${id}`, ts, ts);
}

/**
 * Seedet eine Decision-Row direkt (append-only; trace-repo nicht nötig). evidence_refs
 * muss ein JSON-Array mit ≥1 Element sein (0071-CHECK). created_at explizit, damit
 * die ORDER BY created_at DESC deterministisch testbar ist.
 */
function seedDecision(
  raw: import("better-sqlite3").Database,
  opts: {
    id: string;
    workstreamId: string;
    kind: string;
    rationale: string;
    actor: "user" | "agent" | "policy";
    createdAt: number;
  },
): void {
  raw
    .prepare(
      `INSERT INTO workstream_decisions
         (id, workstream_id, decision_kind, rationale, evidence_refs, content_hash, created_at, actor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      opts.workstreamId,
      opts.kind,
      opts.rationale,
      JSON.stringify(["EV-1"]),
      `hash-${opts.id}`,
      opts.createdAt,
      opts.actor,
    );
}

describe("reasoning why-context — buildWhyContext", () => {
  let raw: import("better-sqlite3").Database;
  beforeEach(() => {
    raw = freshDb();
  });

  it("leeres Ledger (frischer Workspace) → isEmpty=true, leere Arrays, kein Fehler", () => {
    const ctx = buildWhyContext(raw, { workspaceId: WS, topic: "video" });
    expect(ctx.isEmpty).toBe(true);
    expect(ctx.recentRationales).toEqual([]);
    expect(ctx.relevantBeliefs).toEqual([]);
    expect(ctx.routeDecisions).toEqual([]);
    expect(ctx.topic).toBe("video");
  });

  it("aggregiert recentRationales + route-Decisions + topic-relevante Beliefs", () => {
    const wsId = "WS-A";
    seedWorkstream(raw, wsId, WS);
    seedDecision(raw, {
      id: "D-1",
      workstreamId: wsId,
      kind: "route",
      rationale: "Higgsfield für Motion gewählt, weil Higgsfield Hero-Video kann",
      actor: "agent",
      createdAt: 1000,
    });
    seedDecision(raw, {
      id: "D-2",
      workstreamId: wsId,
      kind: "override",
      rationale: "Owner hat heygen-Avatar verworfen — falscher Typ fürs Hero-Video",
      actor: "user",
      createdAt: 2000,
    });
    upsertBelief(raw, {
      workspaceId: WS,
      topic: "video",
      belief: "Hero-Video via Higgsfield-Motion, nicht Heygen-Avatar",
      rationale: "Heygen lieferte den falschen Typ (PA-Chat-Befund)",
      source: "user",
    });

    const ctx = buildWhyContext(raw, { workspaceId: WS, topic: "video" });

    expect(ctx.isEmpty).toBe(false);
    // recentRationales: neueste zuerst (D-2 vor D-1).
    expect(ctx.recentRationales.map((r) => r.rationale)).toEqual([
      "Owner hat heygen-Avatar verworfen — falscher Typ fürs Hero-Video",
      "Higgsfield für Motion gewählt, weil Higgsfield Hero-Video kann",
    ]);
    // routeDecisions: nur kind='route' (D-1).
    expect(ctx.routeDecisions).toHaveLength(1);
    expect(ctx.routeDecisions[0].decisionKind).toBe("route");
    // topic-relevante Beliefs.
    expect(ctx.relevantBeliefs).toHaveLength(1);
    expect(ctx.relevantBeliefs[0].belief).toContain("Higgsfield-Motion");
  });

  it("ohne topic → keine Beliefs gesammelt, aber Rationales/Route da", () => {
    const wsId = "WS-B";
    seedWorkstream(raw, wsId, WS);
    seedDecision(raw, {
      id: "D-3",
      workstreamId: wsId,
      kind: "route",
      rationale: "imagegen2 für Bilder",
      actor: "agent",
      createdAt: 3000,
    });
    upsertBelief(raw, {
      workspaceId: WS,
      topic: "image",
      belief: "imagegen2 ist der Default-Bild-Provider",
      rationale: "stabil + verbunden",
      source: "ai",
    });

    const ctx = buildWhyContext(raw, { workspaceId: WS }); // kein topic
    expect(ctx.topic).toBeNull();
    expect(ctx.relevantBeliefs).toEqual([]);
    expect(ctx.recentRationales).toHaveLength(1);
    expect(ctx.routeDecisions).toHaveLength(1);
    expect(ctx.isEmpty).toBe(false);
  });

  it("scope-isoliert: ein anderer Workspace sieht weder Decisions noch Beliefs (N9)", () => {
    const wsId = "WS-C";
    seedWorkstream(raw, wsId, WS);
    seedDecision(raw, {
      id: "D-4",
      workstreamId: wsId,
      kind: "route",
      rationale: "nur in WS sichtbar",
      actor: "agent",
      createdAt: 4000,
    });
    upsertBelief(raw, {
      workspaceId: WS,
      topic: "video",
      belief: "nur in WS",
      rationale: "scope",
      source: "user",
    });

    const ctx = buildWhyContext(raw, { workspaceId: OTHER_WS, topic: "video" });
    expect(ctx.isEmpty).toBe(true);
    expect(ctx.recentRationales).toEqual([]);
    expect(ctx.relevantBeliefs).toEqual([]);
    expect(ctx.routeDecisions).toEqual([]);
  });

  it("beliefLimit kappt die ANZAHL der Beliefs (Row-Grenze, kein Inhalts-Cut)", () => {
    for (let i = 0; i < 5; i += 1) {
      upsertBelief(raw, {
        workspaceId: WS,
        topic: "video",
        belief: `belief-${i}`,
        rationale: `rationale-${i}`,
        source: "ai",
      });
    }
    const ctx = buildWhyContext(raw, {
      workspaceId: WS,
      topic: "video",
      beliefLimit: 2,
    });
    expect(ctx.relevantBeliefs).toHaveLength(2);
  });

  it("decisionLimit kappt die ANZAHL der jüngsten Begründungen", () => {
    const wsId = "WS-D";
    seedWorkstream(raw, wsId, WS);
    for (let i = 0; i < 5; i += 1) {
      seedDecision(raw, {
        id: `D-lim-${i}`,
        workstreamId: wsId,
        kind: "inject",
        rationale: `r-${i}`,
        actor: "agent",
        createdAt: 5000 + i,
      });
    }
    const ctx = buildWhyContext(raw, { workspaceId: WS, decisionLimit: 3 });
    expect(ctx.recentRationales).toHaveLength(3);
  });

  it("wirft bei leerem workspaceId (N9-Schutz)", () => {
    expect(() => buildWhyContext(raw, { workspaceId: "" })).toThrow(
      /workspaceId/,
    );
  });
});

describe("reasoning why-context — renderWhyContextForPrompt", () => {
  function ctxWith(over: Partial<WhyContext>): WhyContext {
    return {
      workspaceId: WS,
      topic: null,
      recentRationales: [],
      relevantBeliefs: [],
      routeDecisions: [],
      isEmpty: false,
      ...over,
    };
  }

  it("leerer WhyContext (isEmpty) → leerer String (bit-identisches Verhalten ohne Kontext)", () => {
    const empty = ctxWith({ isEmpty: true });
    expect(renderWhyContextForPrompt(empty)).toBe("");
  });

  it("formatiert Beliefs + Begründungen mit Header/Footer + verbatim-Inhalt", () => {
    const ctx = ctxWith({
      topic: "video",
      relevantBeliefs: [
        {
          id: "BLF-1",
          workspaceId: WS,
          topic: "video",
          belief: "Hero-Video via Higgsfield",
          rationale: "Heygen falscher Typ",
          source: "user",
          supersedesId: null,
          confidence: null,
          contentHash: "h",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      recentRationales: [
        {
          decisionKind: "route",
          rationale: "imagegen2 für Bilder gewählt",
          actor: "agent",
          createdAt: 2,
        },
      ],
    });
    const out = renderWhyContextForPrompt(ctx);
    expect(out).toContain("Frühere Entscheidungen in diesem Workspace");
    expect(out).toContain('Aktive Überzeugungen (Topic "video")');
    expect(out).toContain("Hero-Video via Higgsfield");
    expect(out).toContain("Heygen falscher Typ"); // verbatim rationale
    expect(out).toContain("[Owner]"); // source 'user' → Owner
    expect(out).toContain("Jüngste Begründungen:");
    expect(out).toContain("[Routing]"); // kind 'route' → Routing
    expect(out).toContain("imagegen2 für Bilder gewählt");
    expect(out).toContain("Ende früherer Kontext");
    expect(out).not.toContain("…(gekürzt)"); // unter Budget → kein Marker
  });

  it("maxChars-Überschreitung → transparente Kürzung mit Marker + Footer bleibt", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      decisionKind: "inject" as const,
      rationale: `eine ziemlich lange Begründung Nummer ${i} mit etwas Fülltext zum Budget sprengen`,
      actor: "agent" as const,
      createdAt: i,
    }));
    const ctx = ctxWith({ recentRationales: many });
    const out = renderWhyContextForPrompt(ctx, { maxChars: 300 });
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out).toContain("…(gekürzt)"); // transparenter Kürzungs-Marker
    expect(out).toContain("Ende früherer Kontext"); // Footer bleibt erhalten
    expect(out).toContain("Frühere Entscheidungen"); // Header bleibt
  });

  // -------------------------------------------------------------------------
  // E3 — summary-first (HERMES progressive-disclosure)
  // -------------------------------------------------------------------------

  // Realistisch lange Begründung (>160 Zeichen, mehrsätzig) → summarizeLine
  // verdichtet zum Kernsatz. Das ist der HERMES-Anwendungsfall (wachsender
  // Workspace mit langen WARUMs).
  function manyRationales(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      decisionKind: "inject" as const,
      rationale:
        `Begründung Nummer ${i}: dieser Schritt wurde so gewählt. ` +
        `Der ausführliche Grund umfasst einen langen Audit mit vielen Befunden, ` +
        `Coverage-Checks und Folge-Erwägungen, die hier verbatim festgehalten sind ` +
        `damit das WARUM nicht verloren geht und der Block beim Wachsen unter Druck gerät.`,
      actor: "agent" as const,
      createdAt: i,
    }));
  }

  it("default mode === 'full' ist bit-identisch zu explizitem mode:'full'", () => {
    const ctx = ctxWith({ recentRationales: manyRationales(20) });
    const def = renderWhyContextForPrompt(ctx);
    const full = renderWhyContextForPrompt(ctx, { mode: "full" });
    expect(full).toBe(def);
  });

  it("summary-Modus deckt bei gleichem Budget MEHR Items ab als full-truncated", () => {
    const ctx = ctxWith({ recentRationales: manyRationales(40) });
    const budget = 1200;
    const full = renderWhyContextForPrompt(ctx, { mode: "full", maxChars: budget });
    const summary = renderWhyContextForPrompt(ctx, {
      mode: "summary",
      maxChars: budget,
      topK: 2,
    });
    // Beide halten das Budget.
    expect(summary.length).toBeLessThanOrEqual(budget);
    // „Items abgedeckt" = Anzahl Begründungs-Zeilen (Volltext '- ' ODER Summary '· ').
    const countItems = (s: string) =>
      s.split("\n").filter((l) => /^\s*[-·]\s*\[/.test(l)).length;
    expect(countItems(summary)).toBeGreaterThan(countItems(full));
  });

  it("summary-Modus respektiert topK: nur top-k bekommen Volltext, Rest sind Summary-Zeilen", () => {
    const ctx = ctxWith({ recentRationales: manyRationales(10) });
    const out = renderWhyContextForPrompt(ctx, {
      mode: "summary",
      topK: 3,
      maxChars: 100000, // großzügig: nichts wird budget-gekürzt
    });
    const fullLines = out.split("\n").filter((l) => /^\s{2}- \[/.test(l));
    const summaryLines = out.split("\n").filter((l) => /^\s{2}· \[/.test(l));
    expect(fullLines).toHaveLength(3); // top-3 Volltext
    expect(summaryLines).toHaveLength(7); // Rest verdichtet
  });

  it("summary-Modus rankt Beliefs nach rankBeliefs-Score (exakter Topic-Match zuerst Volltext)", () => {
    const mk = (over: Partial<WhyContext["relevantBeliefs"][number]>) => ({
      id: "x",
      workspaceId: WS,
      topic: "video",
      belief: "b",
      rationale: "r",
      source: "ai" as const,
      supersedesId: null,
      confidence: null,
      contentHash: "h",
      createdAt: 1,
      updatedAt: 1,
      ...over,
    });
    const ctx = ctxWith({
      topic: "video",
      relevantBeliefs: [
        // niedrige Relevanz (LIKE-only) + niedrige Konfidenz → soll NICHT top-1 sein
        mk({ id: "B-low", topic: "video-misc", belief: "schwach", confidence: 0.1 }),
        // exakter Topic-Match + hohe Konfidenz → MUSS top-1 Volltext sein
        mk({ id: "B-high", topic: "video", belief: "STARK-EXAKT", confidence: 0.9 }),
      ],
    });
    const out = renderWhyContextForPrompt(ctx, { mode: "summary", topK: 1, maxChars: 100000 });
    // Belief-Volltext-Zeilen tragen das „— weil:"-Marker (Rationale-Zeilen nicht).
    const beliefFullLines = out
      .split("\n")
      .filter((l) => /^\s{2}- /.test(l) && l.includes("— weil:"));
    // Genau 1 Belief-Volltext-Zeile (topK=1) und das ist der hoch-gerankte.
    expect(beliefFullLines).toHaveLength(1);
    expect(beliefFullLines[0]).toContain("STARK-EXAKT");
    // Der schwache erscheint als Summary-Zeile ('· topic: …').
    expect(out).toContain("· video-misc: schwach");
  });
});
