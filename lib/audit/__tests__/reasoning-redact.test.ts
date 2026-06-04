/**
 * Privacy-Sprint V2 (2026-05-01) — Tests für Klartext-Prompt-Redaction in
 * `writeReasoningAudit`.
 *
 * Critic-VETO V2: `LAZYOS_AUDIT_FULL_PROMPTS=1` schrieb Twin-enriched
 * System-Prompts in Klartext in die DB — auch wenn der Workspace
 * 'high'-sensitivity war. Diese Tests sichern: high-Workspace ⇒ NIE
 * persistieren, egal welches ENV-Flag.
 *
 * Run:
 *   npx tsx --test --test-force-exit lib/audit/__tests__/reasoning-redact.test.ts
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, beforeEach, describe, it } from "node:test";

if (!process.env.LAZYOS_DB_PATH) {
  process.env.LAZYOS_DB_PATH = join(
    mkdtempSync(join(tmpdir(), "lazyos-redact-")),
    "redact-test.db",
  );
}
process.env.LAZYOS_TEST_DISABLE_FK = "1";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const reasoningMod = require("../reasoning") as typeof import("../reasoning");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const wsSensMod = require("../workspace-sensitivity") as typeof import("../workspace-sensitivity");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dbMod = require("@/db/client") as typeof import("@/db/client");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const schemaMod = require("@/db/schema/reasoning_audit") as typeof import("@/db/schema/reasoning_audit");

const { writeReasoningAudit } = reasoningMod;
const { __clearWorkspaceSensitivityCacheForTests } = wsSensMod;
const { reasoningAudit } = schemaMod;

import { eq } from "drizzle-orm";

function loadAudit(id: string) {
  const db = dbMod.getDb();
  return db
    .select()
    .from(reasoningAudit)
    .where(eq(reasoningAudit.id, id))
    .all()[0];
}

describe("writeReasoningAudit — workspaceSensitivity-Gate", () => {
  before(() => {
    dbMod.getDb(); // Migrations triggern
  });

  beforeEach(() => {
    __clearWorkspaceSensitivityCacheForTests();
  });

  it("high-Workspace + ENV=1 → systemPromptText UND userPromptText NULL", () => {
    process.env.LAZYOS_AUDIT_FULL_PROMPTS = "1";
    const id = writeReasoningAudit({
      phase: "synthesis",
      role: "synthesis",
      llmProvider: "tmux-claude",
      llmModel: "claude-opus-4-7",
      systemPrompt: "sys-with-private-twin",
      userPrompt: "user-with-private-twin",
      output: "Claim",
      workspaceId: "ws_user_private",
      workspaceSensitivity: "high",
    });
    assert.ok(id, "id returned");
    const row = loadAudit(id!);
    assert.ok(row, "row exists");
    assert.equal(
      row.systemPromptText,
      null,
      "high-Workspace: systemPromptText IMMER null",
    );
    assert.equal(
      row.userPromptText,
      null,
      "high-Workspace: userPromptText IMMER null",
    );
  });

  it("low-Workspace + ENV=1 → systemPromptText UND userPromptText gesetzt", () => {
    process.env.LAZYOS_AUDIT_FULL_PROMPTS = "1";
    const id = writeReasoningAudit({
      phase: "synthesis",
      role: "synthesis",
      llmProvider: "tmux-claude",
      llmModel: "claude-opus-4-7",
      systemPrompt: "sys-low",
      userPrompt: "user-low",
      output: "Claim",
      workspaceId: "ws_low_kunde",
      workspaceSensitivity: "low",
    });
    assert.ok(id);
    const row = loadAudit(id!);
    assert.equal(row.systemPromptText, "sys-low");
    assert.equal(row.userPromptText, "user-low");
  });

  it("low-Workspace + ENV unset → beide null (default off)", () => {
    delete process.env.LAZYOS_AUDIT_FULL_PROMPTS;
    const id = writeReasoningAudit({
      phase: "synthesis",
      role: "synthesis",
      llmProvider: "tmux-claude",
      llmModel: "claude-opus-4-7",
      systemPrompt: "sys",
      userPrompt: "user",
      output: "Claim",
      workspaceId: "ws_low_kunde",
      workspaceSensitivity: "low",
    });
    assert.ok(id);
    const row = loadAudit(id!);
    assert.equal(row.systemPromptText, null);
    assert.equal(row.userPromptText, null);
  });

  it("unknown-Workspace (Lookup-Fehler) + ENV=1 → konservativ NULL", () => {
    process.env.LAZYOS_AUDIT_FULL_PROMPTS = "1";
    const id = writeReasoningAudit({
      phase: "synthesis",
      role: "synthesis",
      llmProvider: "tmux-claude",
      llmModel: "claude-opus-4-7",
      systemPrompt: "sys-unknown",
      userPrompt: "user-unknown",
      output: "Claim",
      workspaceId: "ws_does_not_exist_xyz",
      workspaceSensitivity: "unknown",
    });
    assert.ok(id);
    const row = loadAudit(id!);
    assert.equal(
      row.systemPromptText,
      null,
      "unknown → konservativ keine Persistierung",
    );
    assert.equal(row.userPromptText, null);
  });

  it("kein workspaceId + ENV=1 → Backwards-Compat (low-Default, persistiert)", () => {
    // Legacy-Audits ohne Workspace-Bezug bleiben funktional. Reasoning-Verify
    // nutzt das im bestehenden Test-Setup.
    process.env.LAZYOS_AUDIT_FULL_PROMPTS = "1";
    const id = writeReasoningAudit({
      phase: "synthesis",
      role: "synthesis",
      llmProvider: "tmux-claude",
      llmModel: "claude-opus-4-7",
      systemPrompt: "sys-legacy",
      userPrompt: "user-legacy",
      output: "Claim",
    });
    assert.ok(id);
    const row = loadAudit(id!);
    assert.equal(row.systemPromptText, "sys-legacy");
    assert.equal(row.userPromptText, "user-legacy");
  });
});
