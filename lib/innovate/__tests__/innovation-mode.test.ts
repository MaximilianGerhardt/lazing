// Innovation Mode (Lane D) substrate + engine tests.
// Phase IN-Implement · 2026-05-29 · Opus 4.8.
//
// Strategy (analog lib/lanes/__tests__/lane-ab-substrate.test.ts): in-memory
// better-sqlite3 DB, Schema aus der ECHTEN Migration 0121 via readFileSync
// (beweist nebenbei, dass die Migration-SQL gueltig + idempotent ist). Die
// Module nehmen ein rohes DB-Handle — kein getDb()-Singleton, kein vi.mock.
// callEngine wird gestubbt (kein echtes LLM).
//
// Run:
//   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
//     lib/innovate/__tests__/innovation-mode.test.ts

import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  insertArtifact,
  listArtifacts,
} from "@/lib/innovate/artifacts-repo";
import { extractAssumptions } from "@/lib/innovate/assumption-map";
import { generateReframes } from "@/lib/innovate/reframe";
import {
  contrarianRoast,
  COUNTER_EVIDENCE_TAG,
  type CounterEvidencePayload,
} from "@/lib/innovate/contrarian-roast";
import { parseStringList } from "@/lib/innovate/parse";
import { runInnovate } from "@/lib/innovate/contract";

type RawDb = import("better-sqlite3").Database;

const MIG_0121 = path.join(
  process.cwd(),
  "db",
  "migrations",
  "0121_innovation_artifacts.sql",
);

function freshDb(): RawDb {
  const raw = new Database(":memory:");
  const sql = readFileSync(MIG_0121, "utf8");
  raw.exec(sql);
  raw.exec(sql); // re-apply → IF NOT EXISTS idempotency
  return raw;
}

const WS = "WS-innovate-test";

/** Liefert einen callEngine-Stub, der pro Aufruf eine fixe Antwort zurueckgibt. */
function stubEngine(reply: string) {
  return async () => reply;
}

describe("(a) Migration 0121 — innovation_artifacts + append-only", () => {
  let db: RawDb;
  beforeEach(() => {
    db = freshDb();
  });

  it("legt die Tabelle an und nimmt Inserts an", () => {
    const row = insertArtifact(db, {
      workspaceId: WS,
      kind: "assumption",
      content: "PV-Planung braucht immer einen Vor-Ort-Termin.",
    });
    expect(row.id.startsWith("INV-")).toBe(true);
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const all = listArtifacts(db, { workspaceId: WS });
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe("PV-Planung braucht immer einen Vor-Ort-Termin.");
  });

  it("blockt DELETE (append-only, N8)", () => {
    const row = insertArtifact(db, {
      workspaceId: WS,
      kind: "assumption",
      content: "X",
    });
    expect(() =>
      db.prepare("DELETE FROM innovation_artifacts WHERE id = ?").run(row.id),
    ).toThrow(/append-only/i);
  });

  it("blockt UPDATE (append-only, N8)", () => {
    const row = insertArtifact(db, {
      workspaceId: WS,
      kind: "assumption",
      content: "X",
    });
    expect(() =>
      db
        .prepare("UPDATE innovation_artifacts SET content = ? WHERE id = ?")
        .run("Y", row.id),
    ).toThrow(/append-only/i);
  });

  it("ist idempotent bei identischem Inhalt (gleicher content_hash, N10)", () => {
    const a = insertArtifact(db, { workspaceId: WS, kind: "assumption", content: "Z" });
    const b = insertArtifact(db, { workspaceId: WS, kind: "assumption", content: "Z" });
    expect(b.id).toBe(a.id); // bestehende Row zurueck, kein Doppel-Insert
    expect(listArtifacts(db, { workspaceId: WS })).toHaveLength(1);
  });
});

describe("(b) extractAssumptions — gestubbtes callEngine → N Rows (N1/N6/N9)", () => {
  let db: RawDb;
  beforeEach(() => {
    db = freshDb();
  });

  it("schreibt eine Assumption-Row je extrahierter Annahme", async () => {
    const reply = JSON.stringify([
      "Der Kunde will eine fertige Webseite, nicht nur ein Design.",
      "Higgsfield ist der einzige Weg fuer Motion.",
      "Ein Avatar steigert die Conversion.",
    ]);
    const res = await extractAssumptions(db, {
      workspaceId: WS,
      rawText: "Erstelle eine Webseite mit Motion + Avatar.",
      callEngine: stubEngine(reply),
    });
    expect(res.count).toBe(3);
    const rows = listArtifacts(db, { workspaceId: WS, kind: "assumption" });
    expect(rows).toHaveLength(3);
    // N1: verbatim — der Annahme-Text wird nicht gekuerzt.
    expect(rows.map((r) => r.content)).toEqual([
      "Der Kunde will eine fertige Webseite, nicht nur ein Design.",
      "Higgsfield ist der einzige Weg fuer Motion.",
      "Ein Avatar steigert die Conversion.",
    ]);
  });

  it("toleriert code-fence + Objekt-Form", async () => {
    const reply =
      "```json\n[{ \"assumption\": \"A1\" }, { \"text\": \"A2\" }]\n```";
    const res = await extractAssumptions(db, {
      workspaceId: WS,
      rawText: "irgendwas",
      callEngine: stubEngine(reply),
    });
    expect(res.count).toBe(2);
  });

  it("leerer rawText → 0 Rows, kein Crash", async () => {
    const res = await extractAssumptions(db, {
      workspaceId: WS,
      rawText: "   ",
      callEngine: stubEngine("[]"),
    });
    expect(res.count).toBe(0);
  });
});

describe("(c) generateReframes — gestubbtes callEngine → Reframe-Rows", () => {
  let db: RawDb;
  beforeEach(() => {
    db = freshDb();
  });

  it("erzeugt Reframe-Rows mit Rueck-FK auf die Annahme", async () => {
    const assumption = insertArtifact(db, {
      workspaceId: WS,
      kind: "assumption",
      content: "Higgsfield ist der einzige Weg fuer Motion.",
    });
    const reply = JSON.stringify([
      "Was, wenn Motion serverseitig via CSS reicht?",
      "Was, wenn gar kein Motion noetig ist?",
    ]);
    const res = await generateReframes(db, {
      workspaceId: WS,
      assumptions: [assumption],
      callEngine: stubEngine(reply),
    });
    expect(res.count).toBe(2);
    const rows = listArtifacts(db, { workspaceId: WS, kind: "reframe" });
    expect(rows).toHaveLength(2);
    const src = JSON.parse(rows[0].sourceJson ?? "{}");
    expect(src.fromAssumptionId).toBe(assumption.id);
  });
});

describe("(d) contrarianRoast — valides counter-evidence-Payload (N4)", () => {
  let db: RawDb;
  beforeEach(() => {
    db = freshDb();
  });

  it("liefert ein counter-evidence-Surface im reconcile.ts-Format", async () => {
    const reply = JSON.stringify([
      "CSS-Motion kann komplexe Choreografie nicht abbilden.",
      "Ohne Motion sinkt die wahrgenommene Wertigkeit.",
    ]);
    const res = await contrarianRoast(db, {
      workspaceId: WS,
      proposal: "Was, wenn Motion serverseitig via CSS reicht?",
      callEngine: stubEngine(reply),
    });
    expect(res.counters).toHaveLength(2);
    const payload: CounterEvidencePayload = res.payload;
    expect(payload.verdict).toBe("falsifiable");
    expect(payload.counterEvidenceCount).toBe(2);
    // Surface-Format identisch zu lib/reasoning/reconcile.ts.
    expect(res.surface).not.toBeNull();
    expect(res.surface!).toContain(`<surface:${COUNTER_EVIDENCE_TAG}>`);
    expect(res.surface!).toContain(`</surface:${COUNTER_EVIDENCE_TAG}>`);
    const json = res.surface!
      .replace(`<surface:${COUNTER_EVIDENCE_TAG}>`, "")
      .replace(`</surface:${COUNTER_EVIDENCE_TAG}>`, "");
    const parsed = JSON.parse(json) as CounterEvidencePayload;
    expect(parsed.verdict).toBe("falsifiable");
    expect(parsed.counterEvidenceCount).toBe(2);
    // Persistiert genau EINE roast-Row.
    expect(listArtifacts(db, { workspaceId: WS, kind: "contrarian-roast" })).toHaveLength(
      1,
    );
  });

  it("kein Einwand → verdict 'ok', keine Surface, keine Row", async () => {
    const res = await contrarianRoast(db, {
      workspaceId: WS,
      proposal: "ein perfekter Vorschlag",
      callEngine: stubEngine("[]"),
    });
    expect(res.payload.verdict).toBe("ok");
    expect(res.surface).toBeNull();
    expect(res.artifact).toBeNull();
    expect(listArtifacts(db, { workspaceId: WS, kind: "contrarian-roast" })).toHaveLength(
      0,
    );
  });
});

describe("(e) deterministischer Parse — malformed → fail-soft (N6)", () => {
  let db: RawDb;
  beforeEach(() => {
    db = freshDb();
  });

  it("parseStringList: Muell → []", () => {
    expect(parseStringList("das ist kein json", [])).toEqual([]);
    expect(parseStringList("", [])).toEqual([]);
    expect(parseStringList("{ kaputt: ", [])).toEqual([]);
  });

  it("extractAssumptions mit malformter Antwort → 0 Rows, kein Crash", async () => {
    const res = await extractAssumptions(db, {
      workspaceId: WS,
      rawText: "etwas",
      callEngine: stubEngine("völlig kaputte LLM-Antwort ohne JSON"),
    });
    expect(res.count).toBe(0);
    expect(listArtifacts(db, { workspaceId: WS })).toHaveLength(0);
  });

  it("contrarianRoast: callEngine wirft → fail-soft (verdict 'ok')", async () => {
    const res = await contrarianRoast(db, {
      workspaceId: WS,
      proposal: "x",
      callEngine: async () => {
        throw new Error("engine down");
      },
    });
    expect(res.payload.verdict).toBe("ok");
    expect(res.surface).toBeNull();
  });
});

describe("(f) runInnovate — End-to-End-Pipeline (§10.2)", () => {
  let db: RawDb;
  beforeEach(() => {
    db = freshDb();
  });

  it("Annahmen → Reframes → Roasts, alle append-only persistiert", async () => {
    // Ein Engine-Stub, der je nach Prompt-Inhalt die passende Stufe bedient.
    const callEngine = async (prompt: string): Promise<string> => {
      if (prompt.includes("lege die IMPLIZITEN ANNAHMEN offen")) {
        return JSON.stringify(["Annahme A", "Annahme B"]);
      }
      if (prompt.includes("KEHRE die folgende Annahme UM")) {
        return JSON.stringify(["Reframe von " + (prompt.includes("Annahme A") ? "A" : "B")]);
      }
      if (prompt.includes("ROASTE den folgenden Vorschlag")) {
        return JSON.stringify(["Einwand gegen den Reframe"]);
      }
      return "[]";
    };

    const res = await runInnovate(db, {
      workspaceId: WS,
      rawText: "Ein Ist-Zustand mit zwei Annahmen.",
      callEngine,
    });

    expect(res.assumptions).toHaveLength(2);
    expect(res.reframes).toHaveLength(2);
    expect(res.roasts).toHaveLength(2);
    expect(res.counterEvidenceSurfaces).toHaveLength(2);
    // Alle vier Kinds in der append-only Evidenz-Tabelle.
    expect(listArtifacts(db, { workspaceId: WS, kind: "assumption" })).toHaveLength(2);
    expect(listArtifacts(db, { workspaceId: WS, kind: "reframe" })).toHaveLength(2);
    expect(listArtifacts(db, { workspaceId: WS, kind: "contrarian-roast" })).toHaveLength(2);
  });
});
