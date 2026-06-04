/**
 * Track-D — Repro-Persistenz-Helper-Tests (lib/flow/persistence.ts · 2026-05-29).
 *
 * Deckt:
 *   (a) createPendingFlowRun schreibt einen flow_runs-Row mit status='pending'
 *       + reqId + flowId + workspaceId.
 *   (b) updateFlowRunStatus flippt pending → running mit workstreamId.
 *   (c) updateFlowRunStatus flippt pending → failed mit errorMessage/Code.
 *   (d) emitFlowPendingPersistedEvent schreibt einen events-Row mit
 *       entity_type='flow_run' + event_type='flow_pending_persisted' +
 *       payload mit flowRunId/reqId.
 *   (e) Fail-soft: createPendingFlowRun gegen eine DB OHNE 0116-Spalten
 *       liefert null + crasht nicht (Migrations-Drift-Schutz).
 *   (f) logComposeAndRunStep emittiert das erwartete Marker-Format.
 *   (g) makeRequestId liefert eindeutige, präfixierte IDs.
 *
 * In-Memory better-sqlite3 mit den ECHTEN Migrationen (kein Mock, kein
 * getDb()-Singleton — die Helper nehmen das rohe Handle direkt).
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
 *     lib/flow/__tests__/persistence.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPendingFlowRun,
  emitFlowPendingPersistedEvent,
  logComposeAndRunStep,
  makeRequestId,
  updateFlowRunStatus,
} from "@/lib/flow/persistence";

const MIG = (f: string) => path.join(process.cwd(), "db", "migrations", f);

/** Vollständige Migrations-Kette inkl. 0116 (Repro-Persistenz). */
const MIGRATIONS_FULL = [
  "0001_initial.sql",
  "0112_flow_studio.sql",
  "0116_flow_runs_repro_persistence.sql",
];

/** Migrations-Kette OHNE 0116 — Drift-Test: createPendingFlowRun muss fail-soft sein. */
const MIGRATIONS_WITHOUT_0116 = ["0001_initial.sql", "0112_flow_studio.sql"];

function freshDb(migs: readonly string[]): Database.Database {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = OFF");
  for (const f of migs) {
    const sql = readFileSync(MIG(f), "utf8");
    raw.exec(sql);
  }
  return raw;
}

const WS = "ws-persistence-1";
const FLOW = "FLOW-test-1";

describe("createPendingFlowRun — schreibt pending-Stub mit reqId", () => {
  let raw: Database.Database;
  beforeEach(() => {
    raw = freshDb(MIGRATIONS_FULL);
  });

  it("schreibt einen flow_runs-Row mit status='pending', flow_id, workspace_id, req_id", () => {
    const reqId = "req-test-001";
    const row = createPendingFlowRun(raw, {
      flowId: FLOW,
      workspaceId: WS,
      reqId,
    });
    expect(row).not.toBeNull();
    expect(row!.id).toMatch(/^FRUN-/);
    expect(row!.status).toBe("pending");
    expect(row!.reqId).toBe(reqId);

    // DB-Check: Row ist persistiert mit allen Track-D-Spalten.
    const dbRow = raw
      .prepare(
        `SELECT id, flow_id, workspace_id, workstream_id, status,
                req_id, error_message, error_code
           FROM flow_runs WHERE id = ?`,
      )
      .get(row!.id) as Record<string, unknown>;
    expect(dbRow.status).toBe("pending");
    expect(dbRow.flow_id).toBe(FLOW);
    expect(dbRow.workspace_id).toBe(WS);
    expect(dbRow.workstream_id).toBeNull();
    expect(dbRow.req_id).toBe(reqId);
    expect(dbRow.error_message).toBeNull();
    expect(dbRow.error_code).toBeNull();
  });

  it("lehnt leere flowId/workspaceId/reqId ab (null-Return, kein Throw)", () => {
    expect(createPendingFlowRun(raw, { flowId: "", workspaceId: WS, reqId: "r" })).toBeNull();
    expect(createPendingFlowRun(raw, { flowId: FLOW, workspaceId: "", reqId: "r" })).toBeNull();
    expect(createPendingFlowRun(raw, { flowId: FLOW, workspaceId: WS, reqId: "" })).toBeNull();
  });

  it("akzeptiert eine vorgegebene id (Test-Determinismus)", () => {
    const row = createPendingFlowRun(raw, {
      flowId: FLOW,
      workspaceId: WS,
      reqId: "r1",
      id: "FRUN-explicit-1",
    });
    expect(row!.id).toBe("FRUN-explicit-1");
  });
});

describe("createPendingFlowRun — fail-soft bei Schema-Drift", () => {
  it("gibt null zurück + crasht nicht, wenn req_id-Spalte fehlt", () => {
    const raw = freshDb(MIGRATIONS_WITHOUT_0116);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const row = createPendingFlowRun(raw, {
      flowId: FLOW,
      workspaceId: WS,
      reqId: "req-drift-1",
    });
    expect(row).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("updateFlowRunStatus — Status-Übergänge", () => {
  let raw: Database.Database;
  let runId: string;
  beforeEach(() => {
    raw = freshDb(MIGRATIONS_FULL);
    const row = createPendingFlowRun(raw, {
      flowId: FLOW,
      workspaceId: WS,
      reqId: "req-update-1",
    });
    runId = row!.id;
  });

  it("flippt pending → running + setzt workstreamId", () => {
    const ok = updateFlowRunStatus(raw, {
      runId,
      status: "running",
      workstreamId: "WS-target-1",
    });
    expect(ok).toBe(true);
    const dbRow = raw
      .prepare("SELECT status, workstream_id FROM flow_runs WHERE id = ?")
      .get(runId) as Record<string, unknown>;
    expect(dbRow.status).toBe("running");
    expect(dbRow.workstream_id).toBe("WS-target-1");
  });

  it("flippt pending → failed + setzt errorMessage + errorCode", () => {
    const ok = updateFlowRunStatus(raw, {
      runId,
      status: "failed",
      errorMessage: "compose failed: empty flow",
      errorCode: "empty_flow",
    });
    expect(ok).toBe(true);
    const dbRow = raw
      .prepare(
        "SELECT status, error_message, error_code FROM flow_runs WHERE id = ?",
      )
      .get(runId) as Record<string, unknown>;
    expect(dbRow.status).toBe("failed");
    expect(dbRow.error_message).toBe("compose failed: empty flow");
    expect(dbRow.error_code).toBe("empty_flow");
  });

  it("liefert false, wenn runId nicht existiert (kein Throw)", () => {
    const ok = updateFlowRunStatus(raw, {
      runId: "FRUN-not-existing",
      status: "running",
    });
    expect(ok).toBe(false);
  });

  it("lehnt leere runId ab (false, kein Throw)", () => {
    expect(updateFlowRunStatus(raw, { runId: "", status: "running" })).toBe(false);
  });
});

describe("emitFlowPendingPersistedEvent — events-Row im UI-Stream", () => {
  it("schreibt entity_type='flow_run' + event_type='flow_pending_persisted'", () => {
    const raw = freshDb(MIGRATIONS_FULL);
    emitFlowPendingPersistedEvent(raw, {
      workspaceId: WS,
      flowRunId: "FRUN-evt-1",
      flowId: FLOW,
      reqId: "req-evt-1",
      status: "needs-coupling",
    });
    const evt = raw
      .prepare(
        `SELECT entity_type, entity_id, event_type, segment_id, actor, payload
           FROM events WHERE entity_id = ?`,
      )
      .get("FRUN-evt-1") as Record<string, unknown>;
    expect(evt.entity_type).toBe("flow_run");
    expect(evt.event_type).toBe("flow_pending_persisted");
    expect(evt.segment_id).toBe(WS);
    expect(evt.actor).toBe("system");
    const payload = JSON.parse(String(evt.payload)) as Record<string, unknown>;
    expect(payload.flowRunId).toBe("FRUN-evt-1");
    expect(payload.flowId).toBe(FLOW);
    expect(payload.reqId).toBe("req-evt-1");
    expect(payload.pendingStatus).toBe("needs-coupling");
  });

  it("fail-soft, wenn events-Tabelle fehlt (z.B. partielle Drift)", () => {
    const raw = new Database(":memory:");
    // KEINE Migration → events-Tabelle existiert nicht.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      emitFlowPendingPersistedEvent(raw, {
        workspaceId: WS,
        flowRunId: "FRUN-x",
        flowId: FLOW,
        reqId: "req-x",
        status: "pending",
      }),
    ).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("logComposeAndRunStep — Marker-Format", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("emittiert '[compose-and-run req=<id>] <step> <k=v>...'", () => {
    logComposeAndRunStep("req-log-1", "compose ok", {
      flowId: "FLOW-1",
      mediaSteps: 2,
    });
    expect(logSpy).toHaveBeenCalledWith(
      "[compose-and-run req=req-log-1] compose ok flowId=FLOW-1 mediaSteps=2",
    );
  });

  it("emittiert ohne fields-Block, wenn keine fields übergeben", () => {
    logComposeAndRunStep("req-log-2", "start");
    expect(logSpy).toHaveBeenCalledWith(
      "[compose-and-run req=req-log-2] start",
    );
  });

  it("überspringt null/undefined fields (kein Rauschen)", () => {
    logComposeAndRunStep("req-log-3", "branch", {
      flowRunId: null,
      workstreamId: undefined,
      dur_ms: 42,
    });
    expect(logSpy).toHaveBeenCalledWith(
      "[compose-and-run req=req-log-3] branch dur_ms=42",
    );
  });

  it("serialisiert Objekte als JSON", () => {
    logComposeAndRunStep("req-log-4", "obj", { meta: { a: 1 } });
    expect(logSpy).toHaveBeenCalledWith(
      '[compose-and-run req=req-log-4] obj meta={"a":1}',
    );
  });
});

describe("makeRequestId — eindeutig + präfixiert", () => {
  it("startet mit 'req-' und ist eindeutig", () => {
    const a = makeRequestId();
    const b = makeRequestId();
    expect(a.startsWith("req-")).toBe(true);
    expect(b.startsWith("req-")).toBe(true);
    expect(a).not.toBe(b);
  });
});
