/**
 * Tests für /lab loadRealEvents (MVP, 2026-05-01).
 *
 * Pattern: setze LAZYOS_DB_PATH auf einen frischen tmp-File pro Test-Run
 * BEVOR db/client importiert wird. Danach reichen wir das echte Schema
 * via migrations durch, seeden ein paar fixture-Workspaces+Events, und
 * rufen loadRealEvents() gegen die isolierte DB.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const TMP_DIR = mkdtempSync(path.join(tmpdir(), "lazyos-lab-test-"));
const DB_FILE = path.join(TMP_DIR, "lab-test.db");

// MUST be set before any code path imports db/client.
process.env.LAZYOS_DB_PATH = DB_FILE;
// Migration 0036 referenziert Parent-Org-IDs die in einer leeren
// Test-DB nicht existieren — Test-Hook im db/client umgeht das.
process.env.LAZYOS_TEST_DISABLE_FK = "1";

// Lazy-Imports erst NACHDEM die env-Var gesetzt ist.
async function importLoader() {
  return import("../load-real-events");
}

async function importDb() {
  return import("../../../../db/client");
}

before(async () => {
  const { getDb } = await importDb();
  const db = getDb();
  const raw = db.$raw;

  // Seed Workspaces: einer low, einer high, einer ohne workspace-row.
  raw
    .prepare(
      `INSERT INTO workspaces
         (id, label, accent, path, sensitivity, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(
      "ws-demo-fitness",
      "Demo Fitness Fitness",
      "#10B981",
      path.join(tmpdir(), "projects", "demo-fitness"),
      "low",
      1700000000000,
      1700000000000,
    );
  raw
    .prepare(
      `INSERT INTO workspaces
         (id, label, accent, path, sensitivity, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(
      "ws-private",
      "Private Case",
      "#FF0000",
      path.join(tmpdir(), "projects", "private"),
      "high",
      1700000000000,
      1700000000000,
    );

  // Seed Events: 3 für dev-sprint (kind=auto-dispatch-stage), 1 für
  // private (sensitivity=high — MUSS ausgefiltert werden), 1 für
  // dev-sprint aber kind=other (darf nicht matchen).
  const insertEvent = raw.prepare(
    `INSERT INTO events
       (id, created_at, segment_id, entity_type, entity_id, event_type, actor, payload, sensitivity)
     VALUES (?, ?, ?, 'workstream', ?, 'chat_message_completed', 'agent:test', ?, 'low')`,
  );

  insertEvent.run(
    "ev-1",
    1700000001000,
    "ws-demo-fitness",
    "ws-1",
    JSON.stringify({
      kind: "auto-dispatch-stage",
      content: "Phase 1 — Senior-Dev läuft",
      title: "Auto-Dispatch Test",
    }),
  );
  insertEvent.run(
    "ev-2",
    1700000002000,
    "ws-demo-fitness",
    "ws-2",
    JSON.stringify({
      kind: "auto-dispatch-stage",
      content: "Mail an max@example.com",
    }),
  );
  insertEvent.run(
    "ev-3",
    1700000003000,
    "ws-demo-fitness",
    "ws-3",
    JSON.stringify({ kind: "auto-dispatch-stage", content: "Loop fertig" }),
  );
  insertEvent.run(
    "ev-private",
    1700000004000,
    "ws-private",
    "ws-priv",
    JSON.stringify({
      kind: "auto-dispatch-stage",
      content: "SECRET internal-record",
    }),
  );
  insertEvent.run(
    "ev-other",
    1700000005000,
    "ws-demo-fitness",
    "ws-x",
    JSON.stringify({ kind: "iterate-roast", content: "anderer Kind" }),
  );
});

after(() => {
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

test("loadRealEvents: liefert nur Events mit passendem kind", async () => {
  const { loadRealEvents } = await importLoader();
  const out = loadRealEvents("auto-dispatch-stage");
  assert.equal(out.length, 3);
  for (const ev of out) {
    assert.equal(ev.kind, "auto-dispatch-stage");
  }
});

test("loadRealEvents: filtert sensitivity='high' workspaces hart aus", async () => {
  const { loadRealEvents } = await importLoader();
  const out = loadRealEvents("auto-dispatch-stage");
  // ev-private darf NICHT auftauchen
  for (const ev of out) {
    assert.notEqual(ev.id, "ev-private");
    assert.notEqual(ev.workspaceId, "ws-private");
    const payloadStr = JSON.stringify(ev.payload);
    assert.ok(!payloadStr.includes("GEHEIM"), `private payload leaked: ${payloadStr}`);
  }
});

test("loadRealEvents: respektiert Limit-Parameter", async () => {
  const { loadRealEvents } = await importLoader();
  const out = loadRealEvents("auto-dispatch-stage", { limit: 2 });
  assert.equal(out.length, 2);
});

test("loadRealEvents: workspaceId-Filter", async () => {
  const { loadRealEvents } = await importLoader();
  const all = loadRealEvents("auto-dispatch-stage");
  const filtered = loadRealEvents("auto-dispatch-stage", {
    workspaceId: "ws-demo-fitness",
  });
  // Alle 3 Demo Fitness-Events kommen durch.
  assert.equal(filtered.length, 3);
  // Filter verändert das Ergebnis (Sanity), in unserem Setup sind
  // beide Listen identisch da private bereits ausgefiltert wurde.
  assert.equal(all.length, filtered.length);

  const empty = loadRealEvents("auto-dispatch-stage", {
    workspaceId: "ws-doesnt-exist",
  });
  assert.equal(empty.length, 0);
});

test("loadRealEvents: redacted PII in Payload-Strings", async () => {
  const { loadRealEvents } = await importLoader();
  const out = loadRealEvents("auto-dispatch-stage");
  const ev2 = out.find((e) => e.id === "ev-2");
  assert.ok(ev2, "ev-2 muss zurückkommen");
  const payloadStr = JSON.stringify(ev2!.payload);
  assert.ok(!payloadStr.includes("max@example.com"), "E-Mail nicht redacted");
  assert.ok(payloadStr.includes("[REDACTED-EMAIL]"), "REDACTED-Marker fehlt");
});
