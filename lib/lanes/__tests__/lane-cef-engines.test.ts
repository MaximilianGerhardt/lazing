// Lanes C/E/F engine tests (Migration 0122 · lane_artifacts).
// Phase 2 W2.3 · 2026-05-29.
//
// Strategy (analog lane-ab-substrate.test.ts): in-memory better-sqlite3 DB,
// Schema aus der ECHTEN Migration via readFileSync (beweist nebenbei, dass die
// Migration-SQL gueltig + idempotent ist + den append-only-Trigger anlegt).
// Engines nehmen ein rohes DB-Handle + injizierten callEngine (gestubbt).
//
// Run:
//   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
//     lib/lanes/__tests__/lane-cef-engines.test.ts

import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  insertLaneArtifact,
  listLaneArtifacts,
} from "@/lib/lanes/lane-artifacts-repo";
import {
  reverseEngineerRoles,
  parseRolesOutput,
  type CallEngineFn as RoleCallEngine,
} from "@/lib/lanes/role-reverse/reverse-engineer-roles";
import {
  buildReplacementMatrix,
  parseMatrixOutput,
  type CallEngineFn as ToolCallEngine,
} from "@/lib/lanes/toolstack/build-replacement-matrix";
import {
  holdReply,
  preSendNudge,
  decisionCardPayload,
  pushRuleClass,
  persistHitlRule,
} from "@/lib/lanes/mobile-hitl/mobile-hitl";

const MIG_0122 = path.join(
  process.cwd(),
  "db",
  "migrations",
  "0122_lane_artifacts.sql",
);

type RawDb = import("better-sqlite3").Database;

function freshDb(): RawDb {
  const raw = new Database(":memory:");
  const sql = readFileSync(MIG_0122, "utf8");
  raw.exec(sql);
  raw.exec(sql); // re-apply → IF NOT EXISTS idempotency
  return raw;
}

function tableNames(raw: RawDb): Set<string> {
  const rows = raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function triggerNames(raw: RawDb): Set<string> {
  const rows = raw
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
    .all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

// ═══════════════════════════════════════════════════════════════════════════
// (c) Migration-Boot: lane_artifacts + append-only-Trigger
// ═══════════════════════════════════════════════════════════════════════════

describe("Migration 0122 boot", () => {
  let db: RawDb;
  beforeEach(() => {
    db = freshDb();
  });

  it("creates lane_artifacts table + the 3 indexes are usable", () => {
    expect(tableNames(db).has("lane_artifacts")).toBe(true);
    // Insert one row of each lane to prove the (workspace_id, lane, kind) CHECK
    // accepts every kind.
    const kinds = [
      "role-model",
      "decision-map",
      "dependency-map",
      "automation-boundary",
      "tool-replacement",
      "hitl-rule",
    ] as const;
    for (const kind of kinds) {
      const row = insertLaneArtifact(db, {
        workspaceId: "ws-1",
        kind,
        content: `content for ${kind}`,
      });
      expect(row.id.startsWith("LNA-")).toBe(true);
      expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(listLaneArtifacts(db, { workspaceId: "ws-1" })).toHaveLength(6);
    // lane derived deterministically from kind
    expect(
      listLaneArtifacts(db, { workspaceId: "ws-1", lane: "c" }),
    ).toHaveLength(4);
    expect(
      listLaneArtifacts(db, { workspaceId: "ws-1", lane: "e" }),
    ).toHaveLength(1);
    expect(
      listLaneArtifacts(db, { workspaceId: "ws-1", lane: "f" }),
    ).toHaveLength(1);
  });

  it("registers append-only triggers; UPDATE + DELETE are blocked (N8)", () => {
    expect(triggerNames(db).has("lane_artifacts_no_update")).toBe(true);
    expect(triggerNames(db).has("lane_artifacts_no_delete")).toBe(true);

    const row = insertLaneArtifact(db, {
      workspaceId: "ws-1",
      kind: "role-model",
      content: "Vertrieb: qualifiziert Leads",
    });
    expect(() =>
      db
        .prepare("UPDATE lane_artifacts SET content = ? WHERE id = ?")
        .run("tampered", row.id),
    ).toThrow(/append-only/);
    expect(() =>
      db.prepare("DELETE FROM lane_artifacts WHERE id = ?").run(row.id),
    ).toThrow(/append-only/);
  });

  it("is idempotent on identical content (same content_hash → no dup, N10)", () => {
    const a = insertLaneArtifact(db, {
      workspaceId: "ws-1",
      kind: "tool-replacement",
      content: "HubSpot → integrate",
      source: { tool: "HubSpot", decision: "integrate" },
    });
    const b = insertLaneArtifact(db, {
      workspaceId: "ws-1",
      kind: "tool-replacement",
      content: "HubSpot → integrate",
      source: { tool: "HubSpot", decision: "integrate" },
    });
    expect(b.id).toBe(a.id);
    expect(listLaneArtifacts(db, { workspaceId: "ws-1" })).toHaveLength(1);
  });

  it("CHECK rejects an unknown kind (N6)", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO lane_artifacts
             (id, workspace_id, lane, kind, content, source_json, supersedes_id,
              content_hash, created_at)
           VALUES ('LNA-x','ws-1','c','not-a-kind','x',NULL,NULL,'h',1)`,
        )
        .run(),
    ).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Lane C — Role Reverse Engineering
// ═══════════════════════════════════════════════════════════════════════════

describe("Lane C — reverseEngineerRoles", () => {
  let db: RawDb;
  beforeEach(() => {
    db = freshDb();
  });

  const ROLE_JSON = JSON.stringify({
    roles: [
      {
        name: "Vertriebler",
        purpose: "Qualifiziert eingehende Leads und fuehrt das Erstgespraech.",
        output: "Qualifizierter Lead mit Bedarfsprofil",
        decisions: ["Ist der Lead kaufbereit?", "Welches Angebot passt?"],
        dependencies: ["Marketing liefert den Lead vorher"],
        automationBoundary:
          "Das Erstgespraech bleibt menschlich (Trust, Live-Call).",
        classification: "augment",
        rationale: "Mensch baut Vertrauen, KI bereitet vor.",
      },
      {
        name: "Dateneingabe",
        purpose: "Tippt Angebotsdaten manuell ins CRM.",
        output: "CRM-Eintrag",
        decisions: [],
        dependencies: ["Vertriebler liefert die Daten"],
        automationBoundary: null,
        classification: "automate",
        rationale: "Reine Transkription, voll automatisierbar.",
      },
    ],
  });

  it("(a) stubbed callEngine → expected artifact rows per role", async () => {
    const callEngine: RoleCallEngine = async () => ROLE_JSON;
    const res = await reverseEngineerRoles({
      db,
      workspaceId: "ws-c",
      rawText: "Beschreibung des Vertriebsprozesses ...",
      callEngine,
    });
    expect(res.roleCount).toBe(2);
    expect(res.rejectedCount).toBe(0);

    const roleModels = listLaneArtifacts(db, {
      workspaceId: "ws-c",
      kind: "role-model",
    });
    expect(roleModels).toHaveLength(2);
    // N1 verbatim: purpose stored unmodified
    expect(roleModels[0].content).toBe(
      "Qualifiziert eingehende Leads und fuehrt das Erstgespraech.",
    );

    // decision-map only for the role that HAS decisions (Vertriebler)
    expect(
      listLaneArtifacts(db, { workspaceId: "ws-c", kind: "decision-map" }),
    ).toHaveLength(1);
    // dependency-map for both (both have dependencies)
    expect(
      listLaneArtifacts(db, { workspaceId: "ws-c", kind: "dependency-map" }),
    ).toHaveLength(2);
    // automation-boundary always present
    const boundaries = listLaneArtifacts(db, {
      workspaceId: "ws-c",
      kind: "automation-boundary",
    });
    expect(boundaries).toHaveLength(2);
    // classification carried in source_json
    const src = JSON.parse(boundaries[0].sourceJson!);
    expect(["kill", "keep", "augment", "automate"]).toContain(
      src.classification,
    );
  });

  it("(b) malformed output → 0 artifacts, no crash (fail-soft N6)", async () => {
    const bad: RoleCallEngine = async () => "sorry, I cannot do that";
    const res = await reverseEngineerRoles({
      db,
      workspaceId: "ws-c",
      rawText: "x",
      callEngine: bad,
    });
    expect(res.roleCount).toBe(0);
    expect(res.artifacts).toHaveLength(0);
    expect(listLaneArtifacts(db, { workspaceId: "ws-c" })).toHaveLength(0);
  });

  it("(b) LLM throw → fail-soft (0 artifacts)", async () => {
    const boom: RoleCallEngine = async () => {
      throw new Error("engine down");
    };
    const res = await reverseEngineerRoles({
      db,
      workspaceId: "ws-c",
      rawText: "x",
      callEngine: boom,
    });
    expect(res.artifacts).toHaveLength(0);
  });

  it("(b) deterministic parser rejects invalid classification but keeps valid roles", () => {
    const out = parseRolesOutput(
      JSON.stringify({
        roles: [
          { name: "A", purpose: "p", classification: "destroy" }, // invalid
          { name: "B", purpose: "p2", classification: "keep" }, // valid
          { name: "", purpose: "p3", classification: "keep" }, // invalid (empty name)
          { purpose: "p4", classification: "keep" }, // invalid (no name)
        ],
      }),
    );
    expect(out.roles).toHaveLength(1);
    expect(out.roles[0].name).toBe("B");
    expect(out.rejectedCount).toBe(3);
  });

  it("parses JSON wrapped in markdown fences", () => {
    const out = parseRolesOutput(
      "```json\n" + ROLE_JSON + "\n```\nhope that helps!",
    );
    expect(out.roles).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Lane E — Toolstack Replacement
// ═══════════════════════════════════════════════════════════════════════════

describe("Lane E — buildReplacementMatrix", () => {
  let db: RawDb;
  beforeEach(() => {
    db = freshDb();
  });

  const MATRIX_JSON = JSON.stringify({
    matrix: [
      {
        tool: "PV-Sol",
        decision: "integrate",
        minimumReplacementScope:
          "Stringing, Wechselrichter-Auswahl und Speicher-Sizing muessen erhalten bleiben.",
        domainDepthRequired: true,
        integrationBoundaries: ["Ertragssimulation bleibt extern"],
        rationale: "Fachtiefe nicht generisch ersetzbar.",
      },
      {
        tool: "Excel-Angebotsliste",
        decision: "replace",
        minimumReplacementScope: "CRM mit Angebots-Pipeline",
        domainDepthRequired: false,
        integrationBoundaries: [],
        rationale: "Generische Tabelle, voll ersetzbar.",
      },
      {
        tool: "Alt-Fax",
        decision: "eliminate",
        minimumReplacementScope: null,
        domainDepthRequired: false,
        integrationBoundaries: [],
        rationale: "Unbenutzt.",
      },
    ],
  });

  it("(a) stubbed callEngine → one tool-replacement row per tool", async () => {
    const callEngine: ToolCallEngine = async () => MATRIX_JSON;
    const res = await buildReplacementMatrix({
      db,
      workspaceId: "ws-e",
      tools: ["PV-Sol (Auslegung)", "Excel-Angebotsliste", "Alt-Fax"],
      callEngine,
    });
    expect(res.toolCount).toBe(3);
    expect(res.rejectedCount).toBe(0);

    const rows = listLaneArtifacts(db, {
      workspaceId: "ws-e",
      kind: "tool-replacement",
    });
    expect(rows).toHaveLength(3);

    // domain-depth-Flag preserved + Anti-MVP scope verbatim (N1)
    const pvSol = rows.find(
      (r) => JSON.parse(r.sourceJson!).tool === "PV-Sol",
    )!;
    const src = JSON.parse(pvSol.sourceJson!);
    expect(src.domainDepthRequired).toBe(true);
    expect(src.decision).toBe("integrate");
    expect(pvSol.content).toBe(
      "Stringing, Wechselrichter-Auswahl und Speicher-Sizing muessen erhalten bleiben.",
    );
  });

  it("(b) malformed → 0 artifacts (fail-soft N6)", async () => {
    const bad: ToolCallEngine = async () => "{ not json";
    const res = await buildReplacementMatrix({
      db,
      workspaceId: "ws-e",
      tools: ["X"],
      callEngine: bad,
    });
    expect(res.toolCount).toBe(0);
    expect(listLaneArtifacts(db, { workspaceId: "ws-e" })).toHaveLength(0);
  });

  it("(b) parser rejects invalid decision, keeps valid (N6)", () => {
    const out = parseMatrixOutput(
      JSON.stringify({
        matrix: [
          { tool: "A", decision: "yeet" }, // invalid
          { tool: "B", decision: "replace" }, // valid
          { tool: "", decision: "replace" }, // invalid (empty tool)
        ],
      }),
    );
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].tool).toBe("B");
    expect(out.rejectedCount).toBe(2);
    // defensive boolean: missing domainDepthRequired → false
    expect(out.entries[0].domainDepthRequired).toBe(false);
  });

  it("throws on empty tools[] (operator error, not fail-soft)", async () => {
    const noop: ToolCallEngine = async () => "{}";
    await expect(
      buildReplacementMatrix({
        db,
        workspaceId: "ws-e",
        tools: [],
        callEngine: noop,
      }),
    ).rejects.toThrow(/tools/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Lane F — Mobile Human-in-the-Loop (deterministic, no LLM)
// ═══════════════════════════════════════════════════════════════════════════

describe("Lane F — mobile HITL (deterministic, N6 on lib/push N4)", () => {
  let db: RawDb;
  beforeEach(() => {
    db = freshDb();
  });

  it("(d) holdReply: external/live occasions are always gated", () => {
    expect(holdReply({ occasion: "connector-preview" }).hold).toBe(true);
    expect(holdReply({ occasion: "pre-send-nudge" }).hold).toBe(true);
    // even with owner auto-send approval, external stays gated (§3)
    expect(
      holdReply({ occasion: "connector-preview", autoSendApproved: true }).hold,
    ).toBe(true);
  });

  it("(d) holdReply: blocking owner-decision releases with auto-send approval", () => {
    expect(holdReply({ occasion: "approval" }).hold).toBe(true);
    expect(
      holdReply({ occasion: "approval", autoSendApproved: true }).hold,
    ).toBe(false);
  });

  it("(d) holdReply: non-blocking occasion does not hold; irreversible always holds", () => {
    expect(holdReply({ occasion: "open-questions" }).hold).toBe(false);
    expect(
      holdReply({ occasion: "open-questions", irreversible: true }).hold,
    ).toBe(true);
  });

  it("(d) holdReply: unknown occasion fails CLOSED", () => {
    // @ts-expect-error intentional invalid input
    expect(holdReply({ occasion: "totally-made-up" }).hold).toBe(true);
  });

  it("(d) pushRuleClass: deterministic priority + rate per occasion", () => {
    expect(pushRuleClass("connector-preview").priority).toBe("p0");
    expect(pushRuleClass("pre-send-nudge").priority).toBe("p0");
    expect(pushRuleClass("approval").priority).toBe("p1");
    expect(pushRuleClass("open-questions").rateLimit).toEqual({
      per: "hour",
      max: 6,
    });
    // unknown → fail-closed p1
    // @ts-expect-error intentional invalid input
    expect(pushRuleClass("nope").priority).toBe("p1");
    expect(pushRuleClass("approval").dedupPrefix).toBe("hitl-approval");
  });

  it("pre-send-nudge keeps draft verbatim (N1) but banner is a projection", () => {
    const longDraft =
      "Sehr geehrter Kunde,\n\n" + "x".repeat(300) + "\n\nMit freundlichen Gruessen";
    const nudge = preSendNudge({
      draft: longDraft,
      recipient: "Demo PV",
      url: "/ws/1",
    });
    expect(nudge.priority).toBe("p0");
    expect(nudge.draftVerbatim).toBe(longDraft); // N1: full verbatim
    expect(nudge.notification.body.length).toBeLessThanOrEqual(100); // banner cap
    expect(nudge.notification.title).toContain("Demo PV");
  });

  it("decisionCardPayload: defaults options + blocking, keeps context verbatim", () => {
    const card = decisionCardPayload({
      occasion: "approval",
      context: "Der Plan V3 schlaegt vor, die Website live zu deployen.",
      entityId: "WS-9",
    });
    expect(card.surfaceKind).toBe("decision-card");
    expect(card.blocking).toBe(true);
    expect(card.priority).toBe("p1");
    expect(card.options).toEqual(["Freigeben", "Ablehnen", "Bearbeiten"]);
    expect(card.context).toBe(
      "Der Plan V3 schlaegt vor, die Website live zu deployen.",
    );
  });

  it("(a/c) persistHitlRule writes a hitl-rule row with derived class in source_json", () => {
    const row = persistHitlRule(db, {
      workspaceId: "ws-f",
      occasion: "connector-preview",
      context: "WhatsApp-Nachricht an den Kunden steht zum Versand bereit.",
      entityId: "MSG-1",
    });
    expect(row.lane).toBe("f");
    expect(row.kind).toBe("hitl-rule");
    expect(row.content).toBe(
      "WhatsApp-Nachricht an den Kunden steht zum Versand bereit.",
    );
    const src = JSON.parse(row.sourceJson!);
    expect(src.occasion).toBe("connector-preview");
    expect(src.hold).toBe(true);
    expect(src.priority).toBe("p0");
    expect(src.blocking).toBe(true);

    // append-only round-trip via the repo
    expect(
      listLaneArtifacts(db, { workspaceId: "ws-f", kind: "hitl-rule" }),
    ).toHaveLength(1);
  });
});
