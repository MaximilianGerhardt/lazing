// Lane A (Communication Intake) + Lane B (Expertise Compiler) substrate tests.
// Phase 2 W2.2 · 2026-05-29 · N4-Remediation.
//
// Strategy (analog lib/reasoning/__tests__/beliefs-repo.test.ts): in-memory
// better-sqlite3 DB, Schema aus den ECHTEN Migrationen via readFileSync
// (beweist nebenbei, dass die Migration-SQL gueltig + idempotent ist). Repos
// nehmen ein rohes DB-Handle — kein getDb()-Singleton, kein vi.mock.
//
// Run:
//   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
//     lib/lanes/__tests__/lane-ab-substrate.test.ts

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  buildSourceEnvelope,
  computeEnvelopeContentHash,
} from "@/lib/lanes/communication-intake/source-envelope";
import { classify } from "@/lib/lanes/communication-intake/nudge-classifier";
import {
  advanceIntakeFsm,
  insertIntakeEvent as writeIntakeEvent,
  isLegalFsmTransition,
  nextFsmPhase,
  phaseToSchemaState,
} from "@/lib/lanes/communication-intake/intake-writer";
import {
  compileKnowledgeForms,
  insertKnowledgeForm,
  parseCompilerOutput,
  type CallEngineFn,
} from "@/lib/lanes/expertise-compiler/compile";
import {
  deriveBeliefTopic,
  mirrorApprovedKnowledgeFormToBelief,
} from "@/lib/lanes/expertise-compiler/mirror-to-beliefs";
import { listBeliefs, recallRelevant } from "@/lib/reasoning/beliefs-repo";

const MIG_0113 = path.join(
  process.cwd(),
  "db",
  "migrations",
  "0113_workspace_beliefs.sql",
);
const MIG_0119 = path.join(
  process.cwd(),
  "db",
  "migrations",
  "0119_intake_events.sql",
);
const MIG_0120 = path.join(
  process.cwd(),
  "db",
  "migrations",
  "0120_expertise_knowledge_forms.sql",
);

type RawDb = import("better-sqlite3").Database;

function freshDb(): RawDb {
  const raw = new Database(":memory:");
  for (const mig of [MIG_0113, MIG_0119, MIG_0120]) {
    const sql = readFileSync(mig, "utf8");
    raw.exec(sql);
    raw.exec(sql); // re-apply → IF NOT EXISTS idempotency
  }
  return raw;
}

// Minimaler intake_events-Inserter (Lane A schreibt das spaeter via Pipeline;
// hier direkt, weil wir das Substrat + den Trigger testen, nicht die Pipeline).
function insertIntakeEvent(
  raw: RawDb,
  args: { id: string; workspaceId: string; rawContent: string; nowMs: number },
) {
  const hash = createHash("sha256")
    .update(args.rawContent)
    .digest("hex");
  raw
    .prepare(
      `INSERT INTO intake_events
         (id, workspace_id, external_id, source_kind, speaker_external_id,
          speaker_local_id, received_at, sensitivity, raw_content,
          raw_content_type, parent_envelope_id, nudge_class, fsm_state,
          content_hash, created_at, updated_at)
       VALUES (?, ?, NULL, 'whatsapp', NULL, NULL, ?, 'internal', ?, 'text',
               NULL, NULL, 'staged', ?, ?, ?)`,
    )
    .run(
      args.id,
      args.workspaceId,
      args.nowMs,
      args.rawContent,
      hash,
      args.nowMs,
      args.nowMs,
    );
}

describe("Lane A — intake_events substrate (0119)", () => {
  let raw: RawDb;
  beforeEach(() => {
    raw = freshDb();
  });

  it("(a) insert roundtrip + verbatim N1 raw_content (kein slice)", () => {
    const longContent = "verbatim ".repeat(5000); // N1: nicht gekuerzt
    insertIntakeEvent(raw, {
      id: "INE-1",
      workspaceId: "wsp-1",
      rawContent: longContent,
      nowMs: 1000,
    });
    const row = raw
      .prepare(`SELECT raw_content, fsm_state FROM intake_events WHERE id = ?`)
      .get("INE-1") as { raw_content: string; fsm_state: string };
    expect(row.raw_content).toBe(longContent); // verbatim, voll erhalten
    expect(row.fsm_state).toBe("staged");
  });

  it("(a) append-only Trigger blockt DELETE (N8)", () => {
    insertIntakeEvent(raw, {
      id: "INE-2",
      workspaceId: "wsp-1",
      rawContent: "hallo",
      nowMs: 1000,
    });
    expect(() =>
      raw.prepare(`DELETE FROM intake_events WHERE id = ?`).run("INE-2"),
    ).toThrow(/append-only/i);
  });

  it("(a) Trigger blockt Kern-Mutation (raw_content immutable), erlaubt FSM-Fortschritt", () => {
    insertIntakeEvent(raw, {
      id: "INE-3",
      workspaceId: "wsp-1",
      rawContent: "original",
      nowMs: 1000,
    });
    // raw_content darf NICHT mutieren (N1/N10).
    expect(() =>
      raw
        .prepare(`UPDATE intake_events SET raw_content = ? WHERE id = ?`)
        .run("getampert", "INE-3"),
    ).toThrow(/immutable/i);
    // fsm_state + nudge_class duerfen fortschreiten (Pipeline).
    expect(() =>
      raw
        .prepare(
          `UPDATE intake_events SET fsm_state = ?, nudge_class = ?, updated_at = ? WHERE id = ?`,
        )
        .run("classified", "urgent", 2000, "INE-3"),
    ).not.toThrow();
    const row = raw
      .prepare(`SELECT fsm_state, nudge_class FROM intake_events WHERE id = ?`)
      .get("INE-3") as { fsm_state: string; nudge_class: string };
    expect(row.fsm_state).toBe("classified");
    expect(row.nudge_class).toBe("urgent");
  });

  it("(a) CHECK-Constraint weist unbekannten source_kind ab (N6)", () => {
    expect(() =>
      raw
        .prepare(
          `INSERT INTO intake_events
             (id, workspace_id, source_kind, received_at, sensitivity,
              raw_content, raw_content_type, fsm_state, content_hash,
              created_at, updated_at)
           VALUES ('INE-bad','wsp-1','carrier-pigeon',1,'internal','x','text',
                   'staged','h',1,1)`,
        )
        .run(),
    ).toThrow();
  });
});

describe("(b) source-envelope contentHash deterministisch (N10)", () => {
  it("gleicher Input → gleicher Hash, unabhaengig von Speaker-Annotation", () => {
    const base = {
      externalId: "wa-42",
      dataSource: "whatsapp" as const,
      receivedAt: 1717000000000,
      sensitivity: "internal" as const,
      projectScope: "wsp-1",
      rawContent: "PV-Planung heute besprochen",
      rawContentType: "text" as const,
    };
    const e1 = buildSourceEnvelope(base);
    const e2 = buildSourceEnvelope({ ...base, speakerExternalId: "max" });
    // Speaker ist Annotation, nicht Identitaet → Hash bleibt stabil.
    expect(e1.contentHash).toBe(e2.contentHash);
    // Re-Compute matcht den envelope-Hash.
    expect(
      computeEnvelopeContentHash({
        externalId: base.externalId,
        dataSource: base.dataSource,
        rawContent: base.rawContent,
        receivedAt: base.receivedAt,
        projectScope: base.projectScope,
      }),
    ).toBe(e1.contentHash);
  });

  it("anderer rawContent → anderer Hash", () => {
    const a = computeEnvelopeContentHash({
      externalId: "x",
      dataSource: "telegram",
      rawContent: "A",
      receivedAt: 1,
      projectScope: "wsp-1",
    });
    const b = computeEnvelopeContentHash({
      externalId: "x",
      dataSource: "telegram",
      rawContent: "B",
      receivedAt: 1,
      projectScope: "wsp-1",
    });
    expect(a).not.toBe(b);
    expect(a).toHaveLength(64); // sha256 hex
  });
});

describe("(c) nudge-classifier Klassen (N6)", () => {
  function env(rawContent: string) {
    return buildSourceEnvelope({
      externalId: "e",
      dataSource: "whatsapp",
      receivedAt: 1,
      sensitivity: "internal",
      projectScope: "wsp-1",
      rawContent,
      rawContentType: "text",
    });
  }

  it("urgent gewinnt (hoechste Prioritaet)", () => {
    expect(classify(env("ASAP bitte! Deadline heute"))).toBe("urgent");
    expect(classify(env("Das ist ein Notfall"))).toBe("urgent");
  });

  it("decision-needed bei Fragezeichen ODER Decision-Keyword", () => {
    expect(classify(env("Sollen wir freitags deployen?"))).toBe(
      "decision-needed",
    );
    expect(classify(env("Bitte um Freigabe der Rechnung"))).toBe(
      "decision-needed",
    );
  });

  it("info-only bei deklarativem Satz mit Action-Verb oder >=5 Woertern", () => {
    expect(classify(env("Ich schick dir die Datei"))).toBe("info-only");
    expect(classify(env("Das Meeting war heute sehr produktiv gewesen"))).toBe(
      "info-only",
    );
  });

  it("noise bei Filler / leer", () => {
    expect(classify(env("ok danke"))).toBe("noise");
    expect(classify(env(""))).toBe("noise");
  });
});

describe("Lane B — deriveBeliefTopic (deterministisch)", () => {
  it("glossary → term; sonst → domain; Fallback → kind", () => {
    expect(
      deriveBeliefTopic({ kind: "glossary", term: "PV-Planung", domain: "pv" }),
    ).toBe("pv-planung");
    expect(
      deriveBeliefTopic({ kind: "principle", term: null, domain: "PV  Planning" }),
    ).toBe("pv planning"); // whitespace normalisiert
    expect(
      deriveBeliefTopic({ kind: "if-then-rule", term: null, domain: null }),
    ).toBe("if-then-rule");
  });
});

describe("(d) mirror-to-beliefs (N4-Naht)", () => {
  let raw: RawDb;
  beforeEach(() => {
    raw = freshDb();
  });

  function insertApprovedKnowledgeForm(
    args: {
      id: string;
      workspaceId: string;
      kind: string;
      term: string | null;
      statement: string;
      rationale: string | null;
      domain: string | null;
    },
  ) {
    const hash = createHash("sha256")
      .update(`${args.id}|${args.statement}`)
      .digest("hex");
    raw
      .prepare(
        `INSERT INTO knowledge_forms
           (id, workspace_id, kind, term, statement, rationale,
            example_cases_json, counter_cases_json, domain, source_json,
            confidence, review_state, supersedes_id, content_hash,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, 0.8, 'approved',
                 NULL, ?, 1, 1)`,
      )
      .run(
        args.id,
        args.workspaceId,
        args.kind,
        args.term,
        args.statement,
        args.rationale,
        args.domain,
        hash,
      );
  }

  it("schreibt GENAU EINE belief + setzt source_json.beliefId (Rueck-FK)", () => {
    insertApprovedKnowledgeForm({
      id: "KFM-1",
      workspaceId: "wsp-1",
      kind: "principle",
      term: null,
      statement: "PV-Planung ist nicht nur Dach zeichnen",
      rationale: "weil Modulbelegung/Stringing/Wechselrichter dazugehoeren",
      domain: "pv-planning",
    });

    const res = mirrorApprovedKnowledgeFormToBelief(raw, "KFM-1");
    expect(res.alreadyMirrored).toBe(false);
    expect(res.topic).toBe("pv-planning");

    // GENAU EINE belief-Row im Workspace.
    const beliefs = listBeliefs(raw, "wsp-1");
    expect(beliefs).toHaveLength(1);
    expect(beliefs[0]!.belief).toBe("PV-Planung ist nicht nur Dach zeichnen"); // N1 verbatim
    expect(beliefs[0]!.rationale).toBe(
      "weil Modulbelegung/Stringing/Wechselrichter dazugehoeren",
    );
    expect(beliefs[0]!.id).toBe(res.belief.id);

    // Rueck-FK in source_json.
    const kf = raw
      .prepare(`SELECT source_json FROM knowledge_forms WHERE id = ?`)
      .get("KFM-1") as { source_json: string };
    const parsed = JSON.parse(kf.source_json);
    expect(parsed.beliefId).toBe(res.belief.id);

    // recallRelevant findet die gespiegelte belief ueber das Topic.
    const recalled = recallRelevant(raw, "wsp-1", "pv-planning");
    expect(recalled.map((b) => b.id)).toContain(res.belief.id);
  });

  it("idempotent: zweiter Aufruf spiegelt NICHT erneut (alreadyMirrored=true, weiter EINE belief)", () => {
    insertApprovedKnowledgeForm({
      id: "KFM-2",
      workspaceId: "wsp-1",
      kind: "glossary",
      term: "Stringing",
      statement: "Reihenschaltung von PV-Modulen",
      rationale: null, // → Fallback auf statement
      domain: null,
    });

    const first = mirrorApprovedKnowledgeFormToBelief(raw, "KFM-2");
    const second = mirrorApprovedKnowledgeFormToBelief(raw, "KFM-2");

    expect(first.alreadyMirrored).toBe(false);
    expect(second.alreadyMirrored).toBe(true);
    expect(second.belief.id).toBe(first.belief.id);
    expect(second.topic).toBe("stringing"); // term-derived, lower

    // Trotz zweier Aufrufe weiterhin EINE belief-Row.
    expect(listBeliefs(raw, "wsp-1")).toHaveLength(1);
    // rationale-Fallback (N1 verbatim statement).
    expect(first.belief.rationale).toBe("Reihenschaltung von PV-Modulen");
  });

  it("wirft bei nicht-approved knowledge_form (§8 review gate)", () => {
    raw
      .prepare(
        `INSERT INTO knowledge_forms
           (id, workspace_id, kind, term, statement, rationale, domain,
            review_state, content_hash, created_at, updated_at)
         VALUES ('KFM-3','wsp-1','principle',NULL,'noch nicht reviewed',NULL,
                 'crm','pending-review','h3',1,1)`,
      )
      .run();
    expect(() =>
      mirrorApprovedKnowledgeFormToBelief(raw, "KFM-3"),
    ).toThrow(/only 'approved'/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// KERN-Remediation 2026-05-29 · intake-writer + expertise-compiler
// ═══════════════════════════════════════════════════════════════════════════

function env(rawContent: string, projectScope = "wsp-1") {
  return buildSourceEnvelope({
    externalId: `wa-${createHash("sha256").update(rawContent).digest("hex").slice(0, 8)}`,
    dataSource: "whatsapp",
    receivedAt: 1717000000000,
    sensitivity: "internal",
    projectScope,
    rawContent,
    rawContentType: "text",
  });
}

describe("(a) intake-writer · insertIntakeEvent (0119 Writer)", () => {
  let raw: RawDb;
  beforeEach(() => {
    raw = freshDb();
  });

  it("schreibt EINE Row mit content_hash (N10) + verbatim raw_content (N1) + FSM staged", () => {
    const longContent = "verbatim ".repeat(5000); // N1: nicht gekuerzt
    const envelope = env(longContent);
    const res = writeIntakeEvent(raw, envelope, { nowMs: 1000 });

    expect(res.deduplicated).toBe(false);
    expect(res.event.classificationStatus).toBe("staged"); // received → staged
    expect(res.event.nudgeClass).toBeNull(); // received hat noch keine Klassifikation

    const row = raw
      .prepare(
        `SELECT raw_content, fsm_state, content_hash, workspace_id
           FROM intake_events WHERE id = ?`,
      )
      .get(res.event.id) as {
      raw_content: string;
      fsm_state: string;
      content_hash: string;
      workspace_id: string;
    };
    expect(row.raw_content).toBe(longContent); // verbatim
    expect(row.fsm_state).toBe("staged");
    expect(row.content_hash).toBe(envelope.contentHash); // N10 aus der Hash-Schicht
    expect(row.content_hash).toHaveLength(64);
    expect(row.workspace_id).toBe("wsp-1"); // N9 = projectScope
  });

  it("classifyNow → FSM classified + nudge_class gesetzt (deterministisch)", () => {
    const res = writeIntakeEvent(raw, env("ASAP Deadline heute"), {
      nowMs: 1000,
      classifyNow: true,
    });
    expect(res.event.classificationStatus).toBe("classified"); // normalized
    expect(res.event.nudgeClass).toBe("urgent");
  });

  it("Idempotenz (N10): zweiter Insert desselben contentHash dedupliziert", () => {
    const envelope = env("PV-Planung heute besprochen");
    const first = writeIntakeEvent(raw, envelope, { nowMs: 1000 });
    const second = writeIntakeEvent(raw, envelope, { nowMs: 2000 });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.event.id).toBe(first.event.id);
    expect(raw.prepare(`SELECT COUNT(*) c FROM intake_events`).get()).toEqual({
      c: 1,
    });
  });

  it("append-only Trigger blockt DELETE (N8) auch fuer Writer-Rows", () => {
    const res = writeIntakeEvent(raw, env("hallo"), { nowMs: 1000 });
    expect(() =>
      raw.prepare(`DELETE FROM intake_events WHERE id = ?`).run(res.event.id),
    ).toThrow(/append-only/i);
  });

  it("wirft bei leerem rawContent / fehlendem projectScope (N1/N9)", () => {
    expect(() =>
      // @ts-expect-error — bewusst kaputtes envelope
      writeIntakeEvent(raw, { contentHash: "h", projectScope: "wsp-1", rawContent: "" }),
    ).toThrow(/rawContent/);
  });
});

describe("intake-writer · FSM reine Funktionen (N6)", () => {
  it("phaseToSchemaState bildet die Pipeline auf Schema-States ab", () => {
    expect(phaseToSchemaState("received")).toBe("staged");
    expect(phaseToSchemaState("normalized")).toBe("classified");
    expect(phaseToSchemaState("ready-for-compile")).toBe("ready-for-compile");
    expect(phaseToSchemaState("blocked")).toBe("blocked");
  });

  it("isLegalFsmTransition ist strikt-vorwaerts (no-auto-run §7.2)", () => {
    expect(isLegalFsmTransition("received", "normalized")).toBe(true);
    expect(isLegalFsmTransition("normalized", "ready-for-compile")).toBe(true);
    expect(isLegalFsmTransition("received", "ready-for-compile")).toBe(false); // kein Sprung
    expect(isLegalFsmTransition("normalized", "received")).toBe(false); // kein Rueckschritt
    expect(isLegalFsmTransition("ready-for-compile", "normalized")).toBe(false); // terminal
    expect(isLegalFsmTransition("received", "received")).toBe(true); // idempotent
    expect(isLegalFsmTransition("received", "blocked")).toBe(true);
  });

  it("nextFsmPhase folgt received→normalized→ready-for-compile (dann terminal)", () => {
    expect(nextFsmPhase("received")).toBe("normalized");
    expect(nextFsmPhase("normalized")).toBe("ready-for-compile");
    expect(nextFsmPhase("ready-for-compile")).toBe("ready-for-compile");
  });

  it("advanceIntakeFsm treibt die DB-Row vorwaerts; wirft bei illegalem Sprung", () => {
    const raw = freshDb();
    const res = writeIntakeEvent(raw, env("PV-Planung"), { nowMs: 1000 });
    const id = res.event.id;

    // legal: staged → classified
    const a = advanceIntakeFsm(raw, {
      id,
      workspaceId: "wsp-1",
      to: "normalized",
      nudgeClass: "info-only",
      nowMs: 2000,
    });
    expect(a?.classificationStatus).toBe("classified");
    expect(a?.nudgeClass).toBe("info-only");

    // legal: classified → ready-for-compile
    const b = advanceIntakeFsm(raw, {
      id,
      workspaceId: "wsp-1",
      to: "ready-for-compile",
      nowMs: 3000,
    });
    expect(b?.classificationStatus).toBe("ready-for-compile");

    // illegal: ready-for-compile ist terminal → kein auto-run weiter
    expect(() =>
      advanceIntakeFsm(raw, { id, workspaceId: "wsp-1", to: "normalized" }),
    ).toThrow(/illegal transition/);
  });
});

describe("(b)(c) expertise-compiler · compileKnowledgeForms (KERN)", () => {
  let raw: RawDb;
  beforeEach(() => {
    raw = freshDb();
  });

  // Gestubbter LLM, der drei Formen als JSON liefert (verbatim Owner-Wortlaut).
  const stubThreeForms: CallEngineFn = async () =>
    JSON.stringify({
      forms: [
        {
          kind: "glossary",
          term: "PV-Planung",
          statement:
            "PV-Planung bedeutet nicht nur Dach zeichnen, sondern Modulbelegung, Stringing, Wechselrichterauswahl, Speicher, Ertrag, Angebot.",
          rationale: "Owner-Definition aus dem Onboarding",
          example_cases: ["Reihenhaus-Dach mit 12 Modulen"],
          counter_cases: [],
          domain: "pv-planning",
          confidence: 0.9,
        },
        {
          kind: "if-then-rule",
          term: null,
          statement:
            "Wenn PV-Sol ersetzt werden soll, dann muss die technische Planungslogik deterministisch oder expertengerostet sein.",
          rationale: null,
          example_cases: [],
          counter_cases: ["Bei reinen Bestandsanlagen ohne Neuplanung"],
          domain: "pv-planning",
          confidence: 0.8,
        },
        {
          kind: "open-unknown",
          term: null,
          statement: "Unklar, welcher Wechselrichter-Hersteller bevorzugt wird.",
          rationale: null,
          example_cases: [],
          counter_cases: [],
          domain: "pv-planning",
          confidence: null,
        },
      ],
    });

  it("(b) liefert 3 knowledge_forms-Rows, alle pending-review, mit content_hash (N10)", async () => {
    const res = await compileKnowledgeForms({
      db: raw,
      rawText: "Owner erklaert PV-Planung im Onboarding.",
      workspaceId: "wsp-1",
      callEngine: stubThreeForms,
      userInputTurnId: "turn-42",
      nowMs: 1000,
    });

    expect(res.forms).toHaveLength(3);
    expect(res.rejectedCount).toBe(0);
    for (const f of res.forms) {
      expect(f.reviewState).toBe("pending-review"); // §8 Gate
      expect(f.contentHash).toHaveLength(64); // N10
    }

    // In der DB: exakt 3 Rows, alle pending-review, alle wsp-1.
    const rows = raw
      .prepare(
        `SELECT kind, term, statement, review_state, source_json, confidence
           FROM knowledge_forms WHERE workspace_id = ? ORDER BY kind`,
      )
      .all("wsp-1") as Array<{
      kind: string;
      term: string | null;
      statement: string;
      review_state: string;
      source_json: string;
      confidence: number | null;
    }>;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.review_state === "pending-review")).toBe(true);

    // N1: statement verbatim (kein slice) — der lange glossary-Satz voll erhalten.
    const glossary = rows.find((r) => r.kind === "glossary")!;
    expect(glossary.term).toBe("PV-Planung");
    expect(glossary.statement).toContain(
      "Modulbelegung, Stringing, Wechselrichterauswahl, Speicher, Ertrag, Angebot.",
    );
    // term NUR bei glossary (Schema-Disziplin).
    const rule = rows.find((r) => r.kind === "if-then-rule")!;
    expect(rule.term).toBeNull();
    // Provenienz (source_json) trägt userInputTurnId.
    expect(JSON.parse(glossary.source_json).userInputTurnId).toBe("turn-42");
    // out-of-range/null confidence → null (open-unknown).
    expect(rows.find((r) => r.kind === "open-unknown")!.confidence).toBeNull();
  });

  it("(c) malformed LLM-Output → fail-soft (0 Rows, kein Crash)", async () => {
    const garbage: CallEngineFn = async () => "ich bin kein JSON, nur Geschwätz {{{";
    const res = await compileKnowledgeForms({
      db: raw,
      rawText: "irgendwas",
      workspaceId: "wsp-1",
      callEngine: garbage,
    });
    expect(res.forms).toHaveLength(0);
    expect(
      raw.prepare(`SELECT COUNT(*) c FROM knowledge_forms`).get(),
    ).toEqual({ c: 0 });
  });

  it("(c) parseCompilerOutput verwirft unbekannten kind + leeres statement (N6), behält valide", () => {
    const out = parseCompilerOutput(
      JSON.stringify({
        forms: [
          { kind: "carrier-pigeon", statement: "x" }, // unbekannter kind → reject
          { kind: "principle", statement: "" }, // leeres statement → reject
          { kind: "principle", statement: "Halte es einfach." }, // valide
        ],
      }),
    );
    expect(out.forms).toHaveLength(1);
    expect(out.rejectedCount).toBe(2);
    expect(out.forms[0]!.statement).toBe("Halte es einfach.");
  });

  it("toleriert Markdown-Fences/Vortext um das JSON (robuster Extraktor)", () => {
    const out = parseCompilerOutput(
      'Hier dein Ergebnis:\n```json\n{ "forms": [ { "kind": "tactic", "statement": "Erst messen, dann bauen." } ] }\n```\nDanke.',
    );
    expect(out.forms).toHaveLength(1);
    expect(out.forms[0]!.kind).toBe("tactic");
  });

  it("LLM-Crash (callEngine wirft) → fail-soft (0 Rows)", async () => {
    const crash: CallEngineFn = async () => {
      throw new Error("engine down");
    };
    const res = await compileKnowledgeForms({
      db: raw,
      rawText: "x",
      workspaceId: "wsp-1",
      callEngine: crash,
    });
    expect(res.forms).toHaveLength(0);
  });

  it("wirft bei beidem/keinem von intakeEventId|rawText (Bedienfehler)", async () => {
    await expect(
      compileKnowledgeForms({
        db: raw,
        workspaceId: "wsp-1",
        callEngine: stubThreeForms,
      }),
    ).rejects.toThrow(/exactly ONE/);
  });
});

describe("(d) End-to-End: intake → compile → approve → mirror", () => {
  it("intakeEventId-Quelle wird verbatim kompiliert; nach approve findet mirror die Belief", async () => {
    const raw = freshDb();

    // 1. Lane A: Owner-Input verbatim stagen.
    const ownerInput =
      "PV-Planung ist nicht nur Dach zeichnen, sondern Modulbelegung und Stringing.";
    const intake = writeIntakeEvent(raw, env(ownerInput), { nowMs: 1000 });

    // 1b. FSM bis ready-for-compile treiben (no-auto-run: explizit, nicht auto).
    advanceIntakeFsm(raw, {
      id: intake.event.id,
      workspaceId: "wsp-1",
      to: "normalized",
      nudgeClass: "info-only",
      nowMs: 1100,
    });
    advanceIntakeFsm(raw, {
      id: intake.event.id,
      workspaceId: "wsp-1",
      to: "ready-for-compile",
      nowMs: 1200,
    });

    // 2. Lane B: aus dem intake_event kompilieren. Der Stub spiegelt den
    //    verbatim raw_content als statement zurück (beweist N1-Durchreichung).
    const echoEngine: CallEngineFn = async ({ user }) => {
      // Der User-Prompt trägt den verbatim Input zwischen den INPUT-Markern.
      const m = user.match(/----- INPUT \(verbatim\) -----\n([\s\S]*)\n----- ENDE INPUT -----/);
      const statement = m ? m[1] : "FALLBACK";
      return JSON.stringify({
        forms: [
          {
            kind: "principle",
            term: null,
            statement, // = verbatim ownerInput
            rationale: "weil die technische Tiefe sonst verloren geht",
            domain: "pv-planning",
            confidence: 0.85,
          },
        ],
      });
    };

    const res = await compileKnowledgeForms({
      db: raw,
      intakeEventId: intake.event.id,
      workspaceId: "wsp-1",
      callEngine: echoEngine,
      nowMs: 2000,
    });
    expect(res.intakeEventId).toBe(intake.event.id);
    expect(res.forms).toHaveLength(1);
    const kf = res.forms[0]!;
    expect(kf.statement).toBe(ownerInput); // N1 durchgereicht, kein slice
    expect(kf.reviewState).toBe("pending-review"); // §8 — noch KEINE Belief

    // 2b. Provenienz: source_json.intakeEventId zeigt zurück auf Lane A.
    const provRow = raw
      .prepare(`SELECT source_json FROM knowledge_forms WHERE id = ?`)
      .get(kf.id) as { source_json: string };
    expect(JSON.parse(provRow.source_json).intakeEventId).toBe(intake.event.id);

    // 2c. Vor approve: KEINE Belief (Gate hält).
    expect(listBeliefs(raw, "wsp-1")).toHaveLength(0);

    // 3. Owner approved (erlaubter review_state-UPDATE, 0120-Trigger lässt es zu).
    raw
      .prepare(
        `UPDATE knowledge_forms SET review_state = 'approved', updated_at = ? WHERE id = ?`,
      )
      .run(3000, kf.id);

    // 4. N4-Naht: mirror findet jetzt die Belief.
    const mirror = mirrorApprovedKnowledgeFormToBelief(raw, kf.id);
    expect(mirror.alreadyMirrored).toBe(false);
    expect(mirror.topic).toBe("pv-planning");

    const beliefs = listBeliefs(raw, "wsp-1");
    expect(beliefs).toHaveLength(1);
    expect(beliefs[0]!.belief).toBe(ownerInput); // N1 voll durchgereicht
    const recalled = recallRelevant(raw, "wsp-1", "pv-planning");
    expect(recalled.map((b) => b.id)).toContain(mirror.belief.id);
  });
});
