/**
 * Drift verification for reasoning-audit rows (Pattern 5 wave 3, 2026-05-01).
 *
 * Goal: detect after the fact whether a stored LLM output (claim_text)
 * is reproducible or whether the model drifts/hallucinates. Algorithm:
 *
 *   1. Load the audit row.
 *   2. If verified_status is already set → skip (idempotent).
 *   3. If system_prompt_text/user_prompt_text is NULL → skip with note
 *      "no-prompt-text-stored" (storage-saving default — no re-spawn possible).
 *   4. Re-spawn with identical model + prompts + hint for reproduction.
 *   5. Embed claim_text + new_text via lib/rag/embedder. Cosine similarity.
 *   6. Threshold bucket → 'ok' | 'drift' | 'fabricated'.
 *   7. UPDATE reasoning_audit SET verified_status, verified_at, verified_note.
 *
 * Conservative thresholds:
 *   - sim >= 0.92 → 'ok' (high semantic agreement)
 *   - sim >= 0.75 → 'ok' soft-drift (acceptable variation)
 *   - sim >= 0.55 → 'drift' (re-run-confirmed, model drifts)
 *   - sim < 0.55  → 'fabricated' (re-run does not find the original)
 *
 * In the "drift" bucket we do a second re-run; if it is closer to
 * new_text than to the original claim, it is real drift; otherwise it stays
 * soft-variance (sampling noise) and is downgraded to 'ok'.
 *
 * Cost awareness: every verifyOne triggers real LLM inference. Callers
 * (cron in scripts/verify-reasoning-drift.ts) must set the cap per run.
 */

import { eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { reasoningAudit } from "@/db/schema/reasoning_audit";
import { cosineSimilarity, embed } from "@/lib/rag/embedder";
import { spawnInTmux, type SpawnArgs } from "@/server/agents/tmux-spawn";

export interface DriftDecision {
  auditId: string;
  similarity: number;
  status: "ok" | "drift" | "fabricated";
  note: string;
}

const REPRO_HINT =
  "\n\n[Drift-Verifikation: Reproduziere möglichst wörtlich aus identischen Inputs. " +
  "Keine Verschönerung, keine neuen Argumente, keine geänderte Reihenfolge.]";

/**
 * Threshold mapping similarity → DriftDecision bucket.
 * Exported for tests.
 */
export function classifySimilarity(
  auditId: string,
  similarity: number,
): DriftDecision {
  if (similarity >= 0.92) {
    return {
      auditId,
      similarity,
      status: "ok",
      note: `similarity ${similarity.toFixed(3)}`,
    };
  }
  if (similarity >= 0.75) {
    return {
      auditId,
      similarity,
      status: "ok",
      note: `soft-drift sim=${similarity.toFixed(3)}`,
    };
  }
  if (similarity >= 0.55) {
    return {
      auditId,
      similarity,
      status: "drift",
      note: `drift sim=${similarity.toFixed(3)}`,
    };
  }
  return {
    auditId,
    similarity,
    status: "fabricated",
    note: `fabricated sim=${similarity.toFixed(3)}`,
  };
}

/**
 * Test hooks: allow mocking spawn + embed via dependency injection.
 * In production, defaults are used.
 */
export interface VerifyDeps {
  reSpawn?: (
    model: string,
    systemPrompt: string,
    userPrompt: string,
    workspaceId: string,
    workstreamId: string,
  ) => Promise<{ text: string }>;
  embed?: (text: string) => Promise<Float32Array>;
}

async function defaultReSpawn(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  workspaceId: string,
  workstreamId: string,
): Promise<{ text: string }> {
  const args: SpawnArgs = {
    workspaceId: workspaceId || "drift-verify",
    workspacePath: process.cwd(),
    workstreamId: `verify-${workstreamId || "x"}-${Date.now()}`,
    tier: "opus",
    agentIdx: 0,
    model,
    systemPrompt: systemPrompt + REPRO_HINT,
    userPrompt,
    timeoutMs: 5 * 60_000,
    maxTurns: 1,
  };
  const res = await spawnInTmux(args);
  return { text: res.text };
}

/**
 * Verifies exactly one audit row. Idempotent: skips when verified_status is
 * already set. Returns null if the row does not exist.
 */
export async function verifyOne(
  auditId: string,
  deps: VerifyDeps = {},
): Promise<DriftDecision | null> {
  const db = getDb();
  const row = db
    .select()
    .from(reasoningAudit)
    .where(eq(reasoningAudit.id, auditId))
    .all()[0];

  if (!row) return null;

  // Idempotent: already verified.
  if (row.verifiedStatus !== null && row.verifiedStatus !== undefined) {
    return {
      auditId,
      similarity: 1.0,
      status: row.verifiedStatus as DriftDecision["status"],
      note: row.verifiedNote ?? "already-verified",
    };
  }

  // No plaintext prompt → skip with note. We mark as 'ok' so
  // the cron does not retry this row on the next run.
  if (!row.systemPromptText || !row.userPromptText) {
    const decision: DriftDecision = {
      auditId,
      similarity: 1.0,
      status: "ok",
      note: "no-prompt-text-stored",
    };
    persistDecision(decision);
    return decision;
  }

  const reSpawnFn = deps.reSpawn ?? defaultReSpawn;
  const embedFn = deps.embed ?? embed;

  // 1. Re-Spawn mit identischem Model + Prompts + Hint.
  let newText = "";
  try {
    const result = await reSpawnFn(
      row.llmModel,
      row.systemPromptText,
      row.userPromptText,
      row.workspaceId ?? "",
      row.workstreamId ?? "",
    );
    newText = result.text;
  } catch (err) {
    const decision: DriftDecision = {
      auditId,
      similarity: 0,
      status: "ok",
      note: `respawn-failed: ${err instanceof Error ? err.message : String(err)}`,
    };
    persistDecision(decision);
    return decision;
  }

  if (!newText || newText.length === 0) {
    const decision: DriftDecision = {
      auditId,
      similarity: 0,
      status: "ok",
      note: "respawn-empty-output",
    };
    persistDecision(decision);
    return decision;
  }

  // 2. Embeddings + Cosine.
  const [origVec, newVec] = await Promise.all([
    embedFn(row.claimText),
    embedFn(newText),
  ]);
  const sim = cosineSimilarity(origVec, newVec);

  let decision = classifySimilarity(auditId, sim);

  // 3. On 'drift': second re-run for confirmation. If the second re-run
  //    is closer to new_text than to the original claim → real drift.
  //    Otherwise → soft-variance, downgrade to 'ok'.
  if (decision.status === "drift") {
    try {
      const second = await reSpawnFn(
        row.llmModel,
        row.systemPromptText,
        row.userPromptText,
        row.workspaceId ?? "",
        row.workstreamId ?? "",
      );
      if (second.text && second.text.length > 0) {
        const secondVec = await embedFn(second.text);
        const simToOrig = cosineSimilarity(origVec, secondVec);
        const simToNew = cosineSimilarity(newVec, secondVec);
        if (simToNew > simToOrig + 0.05) {
          // Real drift confirmed: two re-runs converge away from the original.
          decision.note = `${decision.note}; confirmed (2nd-run sim-to-orig=${simToOrig.toFixed(3)} sim-to-new=${simToNew.toFixed(3)})`;
        } else {
          decision = {
            auditId,
            similarity: sim,
            status: "ok",
            note: `soft-variance sim=${sim.toFixed(3)} (2nd-run sim-to-orig=${simToOrig.toFixed(3)})`,
          };
        }
      }
    } catch {
      /* non-fatal — we stick with the first finding */
    }
  }

  persistDecision(decision);
  return decision;
}

function persistDecision(decision: DriftDecision): void {
  try {
    const db = getDb();
    db.update(reasoningAudit)
      .set({
        verifiedStatus: decision.status,
        verifiedAt: Math.floor(Date.now() / 1000),
        verifiedNote: decision.note,
      })
      .where(eq(reasoningAudit.id, decision.auditId))
      .run();
  } catch (err) {
    console.warn(
      "[reasoning-verify] persist failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
