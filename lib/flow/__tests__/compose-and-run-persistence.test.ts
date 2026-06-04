/**
 * Track-D — composeAndRun-Persistenz-Integrationstest (2026-05-29).
 *
 * Quelle: Master-Kontext §10 Befund 2 — "Es wurde im kurzen Check kein neuer
 * flow_run und kein neuer workstream sichtbar." Dieser Test stellt sicher,
 * dass JEDER POST /api/flow/compose-and-run einen Persistenz-Trail anlegt:
 *
 *   (a) Success-Pfad (running):
 *       - flow_runs-Row mit status='pending' wird SOFORT nach Compose
 *         geschrieben (mit reqId), dann auf 'running' aktualisiert mit
 *         workstreamId.
 *       - Response trägt reqId + flowRunId.
 *       - Strukturierter Log-Marker emittiert.
 *
 *   (b) needs-coupling-Pfad:
 *       - flow_runs-Row mit status='pending' bleibt (kein dispatch, kein
 *         Status-Update — Pending heißt: Owner blockiert auf Credential).
 *       - Response trägt reqId + flowRunId.
 *       - events-Row mit event_type='flow_pending_persisted'.
 *
 *   (c) needs-style-choice-Pfad:
 *       - flow_runs-Row mit status='pending'.
 *       - Response trägt reqId + flowRunId.
 *       - events-Row mit pendingStatus='needs-style-choice'.
 *
 *   (d) Dispatch-Error-Pfad:
 *       - flow_runs-Row wird auf status='failed' geflippt + error_message
 *         + error_code gesetzt.
 *       - FlowDispatchError propagiert.
 *
 *   (e) Idempotenz: identischer Request 2× → 2 flow_runs (verschiedene
 *       reqIds), keine Dedup-Annahmen.
 *
 * In-Memory better-sqlite3 mit den ECHTEN Migrationen inkl. 0116. Trigger
 * wird als Spy injiziert (kein echter Background-Run).
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
 *     lib/flow/__tests__/compose-and-run-persistence.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  composeAndRun,
  type TriggerFlowExecutionFn,
} from "@/lib/flow/compose-and-run";
import type { DecomposedStep } from "@/lib/flow/compose";

const MIG = (f: string) => path.join(process.cwd(), "db", "migrations", f);

/**
 * VOLLE Migrations-Kette für composeAndRun + Track-D-Persistenz. Reihenfolge
 * wichtig: 0001 (events) zuerst, 0009 (workstreams) vor 0094/0107/0110
 * (plan-steps), dann Flow-Studio + Track-D-Erweiterung.
 */
const MIGRATIONS = [
  "0001_initial.sql",
  "0009_workstreams.sql",
  "0051_workstream_intent.sql",
  "0094_recursive_plans.sql",
  "0100_api_credentials.sql",
  "0101_connector_catalog.sql",
  "0107_plan_step_allowed_tools.sql",
  "0110_plan_step_deps_group.sql",
  "0112_flow_studio.sql",
  "0116_flow_runs_repro_persistence.sql",
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
      // Statement-by-statement re-run, falls die Migration mehrere Statements
      // hat von denen nur eines duplicate-column wirft.
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

const WS = "ws-car-d-1";

const noToolDecompose = (): DecomposedStep[] => [
  { title: "Aufbau der Seitenstruktur", rationale: "IA + Routing" },
  { title: "Copy für die Startseite", rationale: "Headline + Body" },
];

const photoDecompose = (): DecomposedStep[] => [
  { title: "Aufbau der Seitenstruktur", rationale: "IA + Routing" },
  { title: "Fotos für die Hero-Section", rationale: "Bilder generieren" },
];

/** Stille console.log/error (Test-Rauschen). */
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

describe("composeAndRun — Persistenz-Trail (Track-D · Befund 2)", () => {
  it("success-Pfad: pending-Stub → running, Response trägt reqId+flowRunId, Log-Marker emittiert", async () => {
    const raw = freshDb();
    const trigger: TriggerFlowExecutionFn = () => {};

    const result = await composeAndRun(raw, {
      intent: "Plane meine Woche",
      workspaceId: WS,
      decompose: noToolDecompose,
      triggerExecution: trigger,
      reqId: "req-success-1",
    });

    expect(result.status).toBe("running");
    expect(result.reqId).toBe("req-success-1");
    expect(result.flowRunId).toMatch(/^FRUN-/);

    // DB: der frühe Pending-Stub ist da, ist jetzt 'running' und kennt die
    // workstreamId.
    const stub = raw
      .prepare(
        `SELECT id, status, workstream_id, req_id
           FROM flow_runs WHERE id = ?`,
      )
      .get(result.flowRunId!) as Record<string, unknown>;
    expect(stub.status).toBe("running");
    expect(stub.req_id).toBe("req-success-1");
    if (result.status === "running") {
      expect(stub.workstream_id).toBe(result.workstreamId);
    }

    // Es existieren GENAU 2 flow_runs-Rows: der Pending-Stub (mit reqId) +
    // der dispatch-erzeugte Run (von createFlowRun in execute.ts).
    const count = (
      raw.prepare("SELECT COUNT(*) AS n FROM flow_runs").get() as { n: number }
    ).n;
    expect(count).toBe(2);

    // Log-Marker: mindestens 'start' + 'compose ok' + 'persist pending' +
    // 'branch=running'.
    const markers: string[] = logSpy.mock.calls.map((c: unknown[]) =>
      String(c[0]),
    );
    expect(
      markers.some((m: string) =>
        m.includes("compose-and-run req=req-success-1"),
      ),
    ).toBe(true);
    expect(markers.some((m: string) => m.includes("start"))).toBe(true);
    expect(markers.some((m: string) => m.includes("compose ok"))).toBe(true);
    expect(markers.some((m: string) => m.includes("persist pending"))).toBe(
      true,
    );
    expect(markers.some((m: string) => m.includes("branch=running"))).toBe(
      true,
    );
  });

  it("needs-coupling-Pfad: pending-Stub bleibt 'pending', Response+events tragen reqId+flowRunId", async () => {
    const raw = freshDb(); // KEIN Connector → imagegen2 unverbunden.
    const trigger: TriggerFlowExecutionFn = () => {
      throw new Error("trigger MUST NOT be called on needs-coupling");
    };

    const result = await composeAndRun(raw, {
      intent: "Erstelle eine Webseite mit Hero-Fotos",
      workspaceId: WS,
      decompose: photoDecompose,
      triggerExecution: trigger,
      reqId: "req-coupling-1",
      styleChoices: { "1": "image-imagegen2" }, // erzwingt connector-Bedarf
    });

    expect(result.status).toBe("needs-coupling");
    expect(result.reqId).toBe("req-coupling-1");
    expect(result.flowRunId).toMatch(/^FRUN-/);

    const stub = raw
      .prepare(
        `SELECT status, req_id, workstream_id FROM flow_runs WHERE id = ?`,
      )
      .get(result.flowRunId!) as Record<string, unknown>;
    expect(stub.status).toBe("pending");
    expect(stub.req_id).toBe("req-coupling-1");
    expect(stub.workstream_id).toBeNull(); // kein dispatch.

    // events: ein flow_pending_persisted-Row mit pendingStatus=needs-coupling.
    const evt = raw
      .prepare(
        `SELECT event_type, entity_type, payload FROM events
           WHERE entity_id = ? AND event_type = 'flow_pending_persisted'`,
      )
      .get(result.flowRunId!) as Record<string, unknown>;
    expect(evt).toBeTruthy();
    expect(evt.event_type).toBe("flow_pending_persisted");
    const payload = JSON.parse(String(evt.payload)) as Record<string, unknown>;
    expect(payload.reqId).toBe("req-coupling-1");
    expect(payload.pendingStatus).toBe("needs-coupling");
  });

  it("needs-style-choice-Pfad: pending-Stub bleibt 'pending', Response+events tragen reqId+flowRunId", async () => {
    const raw = freshDb();
    const trigger: TriggerFlowExecutionFn = () => {
      throw new Error("trigger MUST NOT be called on needs-style-choice");
    };

    const result = await composeAndRun(raw, {
      intent: "Erstelle eine Webseite mit Hero-Fotos",
      workspaceId: WS,
      decompose: photoDecompose,
      triggerExecution: trigger,
      reqId: "req-style-1",
      // KEINE styleChoices → needs-style-choice (Medien-Step ohne Wahl).
    });

    expect(result.status).toBe("needs-style-choice");
    expect(result.reqId).toBe("req-style-1");
    expect(result.flowRunId).toMatch(/^FRUN-/);

    const stub = raw
      .prepare(`SELECT status, req_id FROM flow_runs WHERE id = ?`)
      .get(result.flowRunId!) as Record<string, unknown>;
    expect(stub.status).toBe("pending");
    expect(stub.req_id).toBe("req-style-1");

    const evt = raw
      .prepare(
        `SELECT event_type, payload FROM events
           WHERE entity_id = ? AND event_type = 'flow_pending_persisted'`,
      )
      .get(result.flowRunId!) as Record<string, unknown>;
    const payload = JSON.parse(String(evt.payload)) as Record<string, unknown>;
    expect(payload.pendingStatus).toBe("needs-style-choice");
  });

  it("Idempotenz: zweimaliger Request → 2 verschiedene reqIds + 2+ flow_runs-Stubs", async () => {
    const raw = freshDb();
    const result1 = await composeAndRun(raw, {
      intent: "Plane meine Woche",
      workspaceId: WS,
      decompose: noToolDecompose,
      triggerExecution: () => {},
      reqId: "req-idem-1",
    });
    const result2 = await composeAndRun(raw, {
      intent: "Plane meine Woche",
      workspaceId: WS,
      decompose: noToolDecompose,
      triggerExecution: () => {},
      reqId: "req-idem-2",
    });
    expect(result1.reqId).toBe("req-idem-1");
    expect(result2.reqId).toBe("req-idem-2");
    expect(result1.flowRunId).not.toBe(result2.flowRunId);

    // Stubs: mindestens 2 mit verschiedenen req_ids.
    const stubs = raw
      .prepare(
        `SELECT req_id FROM flow_runs WHERE req_id IN ('req-idem-1', 'req-idem-2')`,
      )
      .all() as Array<{ req_id: string }>;
    expect(stubs).toHaveLength(2);
    const reqIds = stubs.map((s) => s.req_id).sort();
    expect(reqIds).toEqual(["req-idem-1", "req-idem-2"]);
  });

  it("ohne reqId-Input: composeAndRun generiert eine + gibt sie zurück", async () => {
    const raw = freshDb();
    const result = await composeAndRun(raw, {
      intent: "Plane meine Woche",
      workspaceId: WS,
      decompose: noToolDecompose,
      triggerExecution: () => {},
      // KEIN reqId.
    });
    expect(result.reqId).toMatch(/^req-/);
    expect(result.flowRunId).toMatch(/^FRUN-/);
  });
});

describe("composeAndRun — Fehler-Pfad (synchroner Trigger-Throw)", () => {
  it("synchroner Trigger-Throw → composeAndRun wirft + Pending-Stub wird 'failed' mit errorMessage", async () => {
    const raw = freshDb();

    // Wir merken uns die persistierte flowRunId, indem wir VOR dem Throw die
    // flow_runs-Tabelle pollen (composeAndRun schreibt den Pending-Stub VOR
    // dem dispatch-try/catch — der Trigger throwt INNERHALB des try-Blocks,
    // also weiß composeAndRun davon und flippt status auf 'failed').
    await expect(
      composeAndRun(raw, {
        intent: "Plane meine Woche",
        workspaceId: WS,
        decompose: noToolDecompose,
        triggerExecution: () => {
          throw new Error("trigger boom");
        },
        reqId: "req-trigger-throw",
      }),
    ).rejects.toThrow(/trigger boom/);

    // Der Pending-Stub MUSS jetzt 'failed' sein + die Error-Message tragen.
    const failedRows = raw
      .prepare(
        `SELECT status, error_message, error_code, req_id
           FROM flow_runs
          WHERE req_id = ? AND status = 'failed'`,
      )
      .all("req-trigger-throw") as Array<Record<string, unknown>>;
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0].status).toBe("failed");
    expect(String(failedRows[0].error_message)).toContain("trigger boom");
    expect(failedRows[0].error_code).toBeTruthy();
  });

});
