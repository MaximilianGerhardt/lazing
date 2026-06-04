/**
 * Drift-Verify-Tests (Pattern 5 Welle 3, 2026-05-01).
 *
 * Run: `pnpm exec tsx --test lib/audit/reasoning-verify.test.ts`
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";

// Set DB path BEFORE importing modules that touch getDb().
// FK-Constraint-Check muss off sein während wir Migrations gegen eine
// frische DB laufen lassen — Migration 0036 (suborgs_restore) referenziert
// Parent-IDs die in einer leeren Test-DB nicht existieren. Das ist ein
// bestehendes Test-Setup-Issue, nicht spezifisch für diesen Test.
// (better-sqlite3 prüft pragma per-connection — Setting via SQLITE_CFLAGS
// ist nicht reichlich, deshalb override: wir patchen die getDb-Pragma in
// einem Wrapper unten.)
if (!process.env.LAZYOS_DB_PATH) {
  process.env.LAZYOS_DB_PATH = join(
    mkdtempSync(join(tmpdir(), "lazyos-drift-verify-")),
    "drift-verify-test.db",
  );
}
process.env.LAZYOS_TEST_DISABLE_FK = "1";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const verifyMod = require("./reasoning-verify") as typeof import("./reasoning-verify");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const reasoningMod = require("./reasoning") as typeof import("./reasoning");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dbMod = require("@/db/client") as typeof import("@/db/client");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const schemaMod = require("@/db/schema/reasoning_audit") as typeof import("@/db/schema/reasoning_audit");

const { classifySimilarity, verifyOne } = verifyMod;
const { writeReasoningAudit } = reasoningMod;
const { reasoningAudit } = schemaMod;

describe("classifySimilarity", () => {
  it("sim >= 0.92 → ok (high-similarity)", () => {
    const d = classifySimilarity("a1", 0.95);
    assert.equal(d.status, "ok");
    assert.match(d.note, /similarity 0\.950/);
  });

  it("sim 0.80 → ok soft-drift", () => {
    const d = classifySimilarity("a2", 0.8);
    assert.equal(d.status, "ok");
    assert.match(d.note, /soft-drift/);
  });

  it("sim 0.65 → drift", () => {
    const d = classifySimilarity("a3", 0.65);
    assert.equal(d.status, "drift");
    assert.match(d.note, /drift/);
  });

  it("sim 0.40 → fabricated", () => {
    const d = classifySimilarity("a4", 0.4);
    assert.equal(d.status, "fabricated");
    assert.match(d.note, /fabricated/);
  });

  it("Grenzfall sim = 0.92 exakt → ok", () => {
    const d = classifySimilarity("a5", 0.92);
    assert.equal(d.status, "ok");
  });

  it("Grenzfall sim = 0.55 exakt → drift", () => {
    const d = classifySimilarity("a6", 0.55);
    assert.equal(d.status, "drift");
  });
});

/**
 * Helper: Erstelle eine fixe 8-dim Float32Array. Wir simulieren Embeddings.
 * Da `cosineSimilarity` nur Dot-Product macht (beide L2-norm), reicht
 * uns ein einfacher Vector-Mock — wir setzen ihn so, dass das Dot-Product
 * den gewünschten Wert produziert.
 */
function vec(scale: number): Float32Array {
  // Wir bauen 2 Vektoren mit gewünschtem Dot-Product:
  // a=[scale,0,...], b=[1,0,...] → dot = scale (wenn scale<=1).
  const a = new Float32Array(8);
  a[0] = scale;
  return a;
}

function unitVec(): Float32Array {
  const v = new Float32Array(8);
  v[0] = 1;
  return v;
}

describe("verifyOne · integration (gemockte spawn+embed)", () => {
  before(() => {
    // Trigger Migrations.
    dbMod.getDb();
  });

  it("Row ohne system_prompt_text → ok 'no-prompt-text-stored'", async () => {
    // LAZYOS_AUDIT_FULL_PROMPTS NICHT gesetzt → Klartext bleibt NULL.
    delete process.env.LAZYOS_AUDIT_FULL_PROMPTS;
    const id = writeReasoningAudit({
      phase: "synthesis",
      role: "synthesis",
      llmProvider: "tmux-claude",
      llmModel: "claude-opus-4-7",
      systemPrompt: "sys",
      userPrompt: "user",
      output: "claim",
    });
    assert.ok(id, "writeReasoningAudit should return id");
    const decision = await verifyOne(id!);
    assert.ok(decision);
    assert.equal(decision!.status, "ok");
    assert.equal(decision!.note, "no-prompt-text-stored");
  });

  it("Row mit Prompts + Mock-Spawn-near-original → ok (high sim)", async () => {
    process.env.LAZYOS_AUDIT_FULL_PROMPTS = "1";
    const id = writeReasoningAudit({
      phase: "synthesis",
      role: "synthesis",
      llmProvider: "tmux-claude",
      llmModel: "claude-opus-4-7",
      systemPrompt: "sys-with-text",
      userPrompt: "user-with-text",
      output: "Original-Claim-Text mit echtem Inhalt.",
    });
    assert.ok(id);

    // Mock: reSpawn returnt fast identischen Text. Embed-Mock gibt für beide
    // den gleichen Vector (sim=1.0).
    const decision = await verifyOne(id!, {
      reSpawn: async () => ({ text: "Original-Claim-Text mit echtem Inhalt." }),
      embed: async () => unitVec(),
    });
    assert.ok(decision);
    assert.equal(decision!.status, "ok");
    assert.ok(decision!.similarity >= 0.92);
  });

  it("Row mit Prompts + Mock-Spawn-mid-similarity → drift (≥0.55, <0.75)", async () => {
    process.env.LAZYOS_AUDIT_FULL_PROMPTS = "1";
    const id = writeReasoningAudit({
      phase: "cross-roast",
      role: "cross-roast",
      llmProvider: "tmux-claude",
      llmModel: "claude-opus-4-7",
      systemPrompt: "sys-mid",
      userPrompt: "user-mid",
      output: "Original-Claim-A",
    });
    assert.ok(id);

    // Mock-Embed: 3 Embeddings (Original, New-Run-1, New-Run-2).
    // Original = unitVec [1,0,...]
    // New-Run-1 = drift-Vector mit cosine(orig)=0.65, Vec auf [0.65, sqrt(1-0.65²)≈0.7599, 0...]
    //   → L2-norm = 1, cosine(unit, this) = 0.65
    // New-Run-2 (für confirm-step) = nahe an New-Run-1 (cosine zu New-Run-1 hoch,
    //   cosine zu Original niedriger) → bestätigter Drift.
    const driftVec = (): Float32Array => {
      const v = new Float32Array(8);
      v[0] = 0.65;
      v[1] = Math.sqrt(1 - 0.65 * 0.65); // ≈0.7599
      return v;
    };
    let callCount = 0;
    const embedMock = async (): Promise<Float32Array> => {
      callCount += 1;
      if (callCount === 1) return unitVec(); // Original
      if (callCount === 2) return driftVec(); // New-Run-1, sim-to-orig = 0.65
      // 2nd-Re-Run: identisch zum ersten New-Run → sim-to-new=1.0, sim-to-orig=0.65
      return driftVec();
    };

    const decision = await verifyOne(id!, {
      reSpawn: async () => ({ text: "Other-Text-Mid-Drift" }),
      embed: embedMock,
    });
    assert.ok(decision);
    // Status bleibt drift weil 2nd-run nahe new (simToNew > simToOrig+0.05).
    assert.equal(decision!.status, "drift");
  });

  it("Row mit Prompts + Mock-Spawn-very-low → fabricated", async () => {
    process.env.LAZYOS_AUDIT_FULL_PROMPTS = "1";
    const id = writeReasoningAudit({
      phase: "synthesis",
      role: "synthesis",
      llmProvider: "tmux-claude",
      llmModel: "claude-opus-4-7",
      systemPrompt: "sys-fab",
      userPrompt: "user-fab",
      output: "Original",
    });
    assert.ok(id);

    let n = 0;
    const embedMock = async (): Promise<Float32Array> => {
      n += 1;
      if (n === 1) return unitVec();
      return vec(0.4); // sim < 0.55
    };

    const decision = await verifyOne(id!, {
      reSpawn: async () => ({ text: "Total-Anders" }),
      embed: embedMock,
    });
    assert.ok(decision);
    assert.equal(decision!.status, "fabricated");
  });

  it("idempotent: zweiter verifyOne returnt bereits-gesetztes Status", async () => {
    process.env.LAZYOS_AUDIT_FULL_PROMPTS = "1";
    const id = writeReasoningAudit({
      phase: "synthesis",
      role: "synthesis",
      llmProvider: "tmux-claude",
      llmModel: "claude-opus-4-7",
      systemPrompt: "sys-idem",
      userPrompt: "user-idem",
      output: "X",
    });
    assert.ok(id);

    // Erster Run setzt status.
    let spawned = 0;
    await verifyOne(id!, {
      reSpawn: async () => {
        spawned += 1;
        return { text: "X" };
      },
      embed: async () => unitVec(),
    });
    assert.equal(spawned, 1);

    // Zweiter Run sollte NICHT erneut spawnen.
    spawned = 0;
    const second = await verifyOne(id!, {
      reSpawn: async () => {
        spawned += 1;
        return { text: "X" };
      },
      embed: async () => unitVec(),
    });
    assert.equal(spawned, 0, "second verifyOne must not re-spawn");
    assert.ok(second);
    assert.equal(second!.status, "ok");
  });

  it("nicht-existierende ID → null", async () => {
    const decision = await verifyOne("rsn_does_not_exist_xyz");
    assert.equal(decision, null);
  });
});
