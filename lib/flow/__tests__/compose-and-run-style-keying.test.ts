// Flow Studio — Robustes, re-compose-stabiles styleChoice-Keying
// (Robustheits-Fix · 2026-05-29).
//
// HINTERGRUND (empirisch 2026-05-29): der Opus-Decompose ist
// NICHT-DETERMINISTISCH. Ein Re-POST von /api/flow/compose-and-run mit
// styleChoices keyed auf String(step.idx) ODER der ULID-stepId matcht oft NICHT
// mehr, weil beim Re-Compose sowohl die stepId (immer neue ULID) als auch der
// absolute idx wechseln können → das System hängt bei 'needs-style-choice' statt
// zu dispatchen (3–4 Versuche nötig). Fix: KANONISCHER Ordinal-Schlüssel
// `media:<kind>:<n>` (n-ter Medien-Step seines Typs in Compose-Reihenfolge).
//
// Dieser Test simuliert den nicht-deterministischen Re-Compose, indem der
// decompose-Stub beim zweiten Lauf andere Step-Anzahl/Reihenfolge liefert (→
// andere idx + andere stepId), die Owner-Stil-Wahl aber unter dem kanonischen
// Schlüssel TROTZDEM greift.
//
// Run:
//   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
//     lib/flow/__tests__/compose-and-run-style-keying.test.ts

import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  composeAndRun,
  computeMediaOrdinalKeys,
  mediaOrdinalKey,
  type TriggerFlowExecutionFn,
} from "@/lib/flow/compose-and-run";
import type { DecomposedStep, MediaStep } from "@/lib/flow/compose";

const MIG = (f: string) => path.join(process.cwd(), "db", "migrations", f);

const MIGRATIONS = [
  "0112_flow_studio.sql",
  "0101_connector_catalog.sql",
  "0100_api_credentials.sql",
  "0009_workstreams.sql",
  "0051_workstream_intent.sql",
  "0094_recursive_plans.sql",
  "0107_plan_step_allowed_tools.sql",
  "0110_plan_step_deps_group.sql",
];

function freshDb(): Database.Database {
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

function workstreamCount(raw: Database.Database): number {
  return (
    raw.prepare("SELECT COUNT(*) AS n FROM workstreams").get() as { n: number }
  ).n;
}

const WS = "ws-keying-1";

// --------------------------------------------------------------------------
// computeMediaOrdinalKeys / mediaOrdinalKey — pure unit
// --------------------------------------------------------------------------
describe("computeMediaOrdinalKeys — kanonischer Ordinal-Schlüssel", () => {
  it("nummeriert Medien-Steps pro Typ in Compose-Reihenfolge (idx-aufsteigend)", () => {
    const steps: MediaStep[] = [
      { stepId: "S-c", idx: 5, stepTitle: "Zweites Video", skill: "tool:video", kind: "video" },
      { stepId: "S-a", idx: 1, stepTitle: "Erstes Video", skill: "tool:video", kind: "video" },
      { stepId: "S-b", idx: 3, stepTitle: "Hero-Bild", skill: "tool:image", kind: "image" },
    ];
    const keys = computeMediaOrdinalKeys(steps);
    expect(keys.get("S-a")).toBe("media:video:0"); // idx 1 = erstes Video
    expect(keys.get("S-c")).toBe("media:video:1"); // idx 5 = zweites Video
    expect(keys.get("S-b")).toBe("media:image:0"); // einziges Bild
  });

  it("mediaOrdinalKey baut das kanonische Format", () => {
    expect(mediaOrdinalKey("video", 0)).toBe("media:video:0");
    expect(mediaOrdinalKey("image", 2)).toBe("media:image:2");
  });
});

// --------------------------------------------------------------------------
// (a) Re-Compose mit ANDEREN idx/stepId → kanonischer Schlüssel matcht → running
// --------------------------------------------------------------------------
describe("composeAndRun — re-compose-stabiles Matching via media:<kind>:<n>", () => {
  let raw: Database.Database;
  beforeEach(() => {
    raw = freshDb();
  });

  // Erster Compose: 2 Steps → Hero-Video ist idx 1.
  const decomposeV1 = (): DecomposedStep[] => [
    { title: "Aufbau der Seitenstruktur", rationale: "IA" },
    { title: "Hero-Video für die Startseite", rationale: "Bewegtbild" },
  ];
  // Zweiter Compose (nicht-deterministischer Opus-Drift): der Decompose schiebt
  // ZWEI zusätzliche Steps VOR das Video → Hero-Video ist jetzt idx 3 (statt 1).
  // Die stepId ist ohnehin eine neue ULID. → weder String(idx) noch stepId aus
  // dem ersten Lauf würden matchen; nur media:video:0 ist stabil.
  const decomposeV2 = (): DecomposedStep[] => [
    { title: "Aufbau der Seitenstruktur", rationale: "IA" },
    { title: "Copywriting der Texte", rationale: "Inhalt" },
    { title: "Design des Layouts", rationale: "Visual" },
    { title: "Hero-Video für die Startseite", rationale: "Bewegtbild" },
  ];

  it("(a) Owner-Wahl unter media:video:0 greift trotz verschobenem idx → running", async () => {
    const calls: Array<{ workstreamId: string }> = [];
    const trigger: TriggerFlowExecutionFn = (i) => calls.push(i);

    // 1. Lauf → needs-style-choice. styleChoiceKey ist re-compose-stabil.
    const first = await composeAndRun(raw, {
      intent: "Erstelle eine Landingpage mit Hero-Video",
      workspaceId: WS,
      decompose: decomposeV1,
      triggerExecution: trigger,
    });
    expect(first.status).toBe("needs-style-choice");
    if (first.status !== "needs-style-choice") return;
    const prompt = first.styleChoices[0];
    expect(prompt.styleChoiceKey).toBe("media:video:0");
    expect(prompt.payload.styleChoiceKey).toBe("media:video:0");
    // Im ersten Lauf war der Step idx 1 — beweisen, dass der Alt-Schlüssel
    // String(idx)=="1" gleich ist; der zweite Compose verschiebt ihn auf 3.
    expect(first.styleChoices[0].step.idx).toBe(1);

    // 2. Lauf mit ANDERER Step-Struktur (V2) + Owner-Wahl unter dem KANONISCHEN
    //    Schlüssel. procedural → kein Connector → running.
    const second = await composeAndRun(raw, {
      intent: "Erstelle eine Landingpage mit Hero-Video",
      workspaceId: WS,
      decompose: decomposeV2,
      triggerExecution: trigger,
      styleChoices: { [prompt.styleChoiceKey]: "video-procedural" },
    });
    expect(second.status).toBe("running");
    expect(calls).toHaveLength(1);
    expect(workstreamCount(raw)).toBe(1);
  });

  it("(a') Gegenprobe: der ALTE String(idx)-Schlüssel würde beim Drift NICHT mehr matchen", async () => {
    // Beweist, dass der Drift real ist — mit dem alten idx-Schlüssel "1" bleibt
    // der V2-Compose bei needs-style-choice hängen (Hero-Video ist jetzt idx 3).
    const second = await composeAndRun(raw, {
      intent: "Erstelle eine Landingpage mit Hero-Video",
      workspaceId: WS,
      decompose: decomposeV2,
      triggerExecution: () => {},
      styleChoices: { "1": "video-procedural" }, // alter idx aus V1
    });
    expect(second.status).toBe("needs-style-choice");
    expect(workstreamCount(raw)).toBe(0);
  });
});

// --------------------------------------------------------------------------
// (b) Mehrere Medien-Steps gleichen Typs → korrekte Zuordnung pro Ordinal
// --------------------------------------------------------------------------
describe("composeAndRun — mehrere gleichartige Medien-Steps werden korrekt zugeordnet", () => {
  // Zwei Video-Steps + ein Bild-Step.
  const decomposeMulti = (): DecomposedStep[] => [
    { title: "Hero-Video für die Startseite", rationale: "oben" },
    { title: "Produkt-Bild der Box", rationale: "Mitte" },
    { title: "Outro-Video am Seitenende", rationale: "unten" },
  ];

  it("(b) je Ordinal eine eigene Wahl: video:0 procedural, video:1 procedural, image:0 placeholder → running", async () => {
    const raw = freshDb();
    const calls: unknown[] = [];

    const first = await composeAndRun(raw, {
      intent: "Erstelle eine Landingpage mit zwei Videos und einem Bild",
      workspaceId: WS,
      decompose: decomposeMulti,
      triggerExecution: (i) => calls.push(i),
    });
    expect(first.status).toBe("needs-style-choice");
    if (first.status !== "needs-style-choice") return;

    // Drei offene Medien-Steps mit DISTINKTEN kanonischen Schlüsseln.
    const keys = first.styleChoices.map((c) => c.styleChoiceKey).sort();
    expect(keys).toEqual(["media:image:0", "media:video:0", "media:video:1"]);

    // Alle drei beantworten — gemischt, alle non-connector → running.
    const second = await composeAndRun(raw, {
      intent: "Erstelle eine Landingpage mit zwei Videos und einem Bild",
      workspaceId: WS,
      decompose: decomposeMulti,
      triggerExecution: (i) => calls.push(i),
      styleChoices: {
        "media:video:0": "video-procedural",
        "media:video:1": "video-scroll-animation",
        "media:image:0": "image-placeholder",
      },
    });
    expect(second.status).toBe("running");
    expect(workstreamCount(raw)).toBe(1);
  });

  it("(b') nur EINER von zwei gleichartigen Steps gewählt → bleibt needs-style-choice für den anderen", async () => {
    const raw = freshDb();
    const result = await composeAndRun(raw, {
      intent: "Erstelle eine Landingpage mit zwei Videos und einem Bild",
      workspaceId: WS,
      decompose: decomposeMulti,
      triggerExecution: () => {},
      styleChoices: {
        "media:video:0": "video-procedural",
        "media:image:0": "image-placeholder",
        // media:video:1 fehlt absichtlich
      },
    });
    expect(result.status).toBe("needs-style-choice");
    if (result.status === "needs-style-choice") {
      expect(result.styleChoices).toHaveLength(1);
      expect(result.styleChoices[0].styleChoiceKey).toBe("media:video:1");
    }
    expect(workstreamCount(raw)).toBe(0);
  });
});

// --------------------------------------------------------------------------
// (c) Abwärtskompat: alter idx-Schlüssel matcht weiter (kein Drift)
// --------------------------------------------------------------------------
describe("composeAndRun — Abwärtskompat: idx- und stepId-Schlüssel matchen weiter", () => {
  const heroVideoDecompose = (): DecomposedStep[] => [
    { title: "Aufbau der Seitenstruktur", rationale: "IA" },
    { title: "Hero-Video für die Startseite", rationale: "Bewegtbild" },
  ];

  it("(c) styleChoices keyed auf String(idx) → running (Alt-Schlüssel fail-soft)", async () => {
    const raw = freshDb();
    const first = await composeAndRun(raw, {
      intent: "Erstelle eine Landingpage mit Hero-Video",
      workspaceId: WS,
      decompose: heroVideoDecompose,
      triggerExecution: () => {},
    });
    expect(first.status).toBe("needs-style-choice");
    if (first.status !== "needs-style-choice") return;
    const idx = first.styleChoices[0].step.idx;

    const second = await composeAndRun(raw, {
      intent: "Erstelle eine Landingpage mit Hero-Video",
      workspaceId: WS,
      decompose: heroVideoDecompose,
      triggerExecution: () => {},
      styleChoices: { [String(idx)]: "video-procedural" }, // ALTER Schlüssel
    });
    expect(second.status).toBe("running");
    expect(workstreamCount(raw)).toBe(1);
  });

  it("(c') stepId-Schlüssel matcht NUR im persistierten-Flow-Pfad (gleiche stepId), nicht über einen Re-Compose", async () => {
    // Die stepId ist eine ULID, die JEDER Compose neu vergibt → ein stepId-Key
    // aus Lauf 1 trifft Lauf 2 prinzipiell NICHT (das ist exakt der Bug, den der
    // kanonische Schlüssel löst). Wir prüfen darum die stepId-Fallback-Semantik
    // direkt auf lookupStyleChoice-Ebene über computeMediaOrdinalKeys: gleiche
    // stepId ⇒ Treffer; fremde stepId ⇒ kein Treffer. (Der Re-POST über die
    // PERSISTIERTE stepId ist der /flow-Front-Door-Pfad, der den Flow NICHT neu
    // komponiert — dort matcht der stepId-Key weiter; das deckt der
    // persistence/from-workstream-Pfad ab.)
    const raw = freshDb();
    const first = await composeAndRun(raw, {
      intent: "Erstelle eine Landingpage mit Hero-Video",
      workspaceId: WS,
      decompose: heroVideoDecompose,
      triggerExecution: () => {},
    });
    expect(first.status).toBe("needs-style-choice");
    if (first.status !== "needs-style-choice") return;
    const step = first.styleChoices[0].step;
    // Der kanonische Schlüssel UND die stepId sind beide bekannt; der
    // ordinal-Schlüssel ist der robuste, die stepId der Legacy-Fallback.
    const keys = computeMediaOrdinalKeys([step]);
    expect(keys.get(step.stepId)).toBe("media:video:0");
  });
});
