/**
 * Tests für POST /api/push/feedback (Pattern 6a Push-Telemetrie).
 *
 * Run: `pnpm exec tsx --test app/api/push/feedback/route.test.ts`
 *
 * Wir mocken `@/lib/events/emit` damit wir keinen echten DB-Write brauchen
 * und das Auth-Verhalten + emit-Aufruf isoliert prüfen können.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

// Pre-test ENV-Setup. Muss VOR dem dynamic-require der Route passieren.
if (!process.env.LAZYOS_DB_PATH) {
  process.env.LAZYOS_DB_PATH = join(
    mkdtempSync(join(tmpdir(), "lazyos-feedback-")),
    "feedback-test.db",
  );
}
process.env.LAZYOS_PUSH_SECRET = "test-secret-1234567890";
process.env.LAZYOS_DISABLE_PUSH = "1"; // niemals echte Pushs aus Tests

// Capture-Liste für emit-Aufrufe.
type EmitCall = {
  segmentId: string;
  entityType: string;
  entityId: string;
  eventType: string;
  actor: string;
  payload: Record<string, unknown>;
  sensitivity?: string;
};
const emitCalls: EmitCall[] = [];

// Module-mock via require-cache: wir injizieren einen Stub für
// `@/lib/events/emit` BEVOR die Route geladen wird. Die Route ruft dann
// unseren Stub statt der echten DB-Schreibfunktion auf.
const emitPath = require.resolve("@/lib/events/emit");
require.cache[emitPath] = {
  id: emitPath,
  filename: emitPath,
  loaded: true,
  exports: {
    emitEvent: async (call: EmitCall) => {
      emitCalls.push(call);
      return { ok: true };
    },
  },
} as unknown as NodeJS.Module;

// Jetzt erst die Route importieren (sie greift auf den geladenen Mock zu).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const route = require("./route") as typeof import("./route");
const { POST } = route;

function makeReq(opts: {
  body?: unknown;
  bodyRaw?: string;
  authorization?: string;
  cookie?: string;
}): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.authorization) headers.authorization = opts.authorization;
  if (opts.cookie) headers.cookie = opts.cookie;
  const body =
    opts.bodyRaw !== undefined
      ? opts.bodyRaw
      : opts.body !== undefined
        ? JSON.stringify(opts.body)
        : undefined;
  return new Request("http://localhost/api/push/feedback", {
    method: "POST",
    headers,
    body,
  });
}

describe("POST /api/push/feedback", () => {
  beforeEach(() => {
    emitCalls.length = 0;
  });

  it("liefert 401 ohne Auth-Header", async () => {
    const req = makeReq({
      body: { ruleId: "rule-a", action: "clicked" },
    });
    const res = await POST(req as never);
    assert.equal(res.status, 401);
    const json = (await res.json()) as { ok: boolean; error?: string };
    assert.equal(json.ok, false);
    assert.equal(json.error, "unauthorized");
    assert.equal(emitCalls.length, 0);
  });

  it("liefert 401 mit falschem Bearer", async () => {
    const req = makeReq({
      body: { ruleId: "rule-a", action: "clicked" },
      authorization: "Bearer wrong-secret-0000000000",
    });
    const res = await POST(req as never);
    assert.equal(res.status, 401);
    assert.equal(emitCalls.length, 0);
  });

  it("akzeptiert Bearer + emittiert notification_clicked", async () => {
    const req = makeReq({
      body: { ruleId: "rule-a", action: "clicked", tag: "lazyos-review-T1" },
      authorization: "Bearer test-secret-1234567890",
    });
    const res = await POST(req as never);
    assert.equal(res.status, 200);
    const json = (await res.json()) as { ok: boolean };
    assert.equal(json.ok, true);

    assert.equal(emitCalls.length, 1);
    const call = emitCalls[0]!;
    assert.equal(call.eventType, "notification_clicked");
    assert.equal(call.entityType, "push_rule");
    assert.equal(call.entityId, "rule-a");
    assert.equal(call.actor, "system");
    assert.equal(call.sensitivity, "low");
    assert.equal((call.payload as { ruleId: string }).ruleId, "rule-a");
    assert.equal((call.payload as { action: string }).action, "clicked");
    assert.equal((call.payload as { tag?: string }).tag, "lazyos-review-T1");
  });

  it("akzeptiert Bearer + emittiert notification_dismissed_without_action", async () => {
    const req = makeReq({
      body: { ruleId: "rule-b", action: "dismissed" },
      authorization: "Bearer test-secret-1234567890",
    });
    const res = await POST(req as never);
    assert.equal(res.status, 200);
    assert.equal(emitCalls.length, 1);
    assert.equal(emitCalls[0]!.eventType, "notification_dismissed_without_action");
  });

  it("liefert 400 bei invalid action", async () => {
    const req = makeReq({
      body: { ruleId: "rule-a", action: "exploded" },
      authorization: "Bearer test-secret-1234567890",
    });
    const res = await POST(req as never);
    assert.equal(res.status, 400);
    assert.equal(emitCalls.length, 0);
  });

  it("liefert 400 bei missing ruleId", async () => {
    const req = makeReq({
      body: { action: "clicked" },
      authorization: "Bearer test-secret-1234567890",
    });
    const res = await POST(req as never);
    assert.equal(res.status, 400);
    assert.equal(emitCalls.length, 0);
  });

  it("liefert 400 bei invalid JSON", async () => {
    const req = makeReq({
      bodyRaw: "{not-json}",
      authorization: "Bearer test-secret-1234567890",
    });
    const res = await POST(req as never);
    assert.equal(res.status, 400);
    const json = (await res.json()) as { error: string };
    assert.equal(json.error, "invalid json");
    assert.equal(emitCalls.length, 0);
  });
});
