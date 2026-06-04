/**
 * Reasoning-Audit-Helper (Pattern 5 Traceability, 2026-05-01).
 *
 * Persists per LLM call the inputs (RAG chunks, prior outputs,
 * user corrections), the output excerpt and a SHA-256 prompt hash.
 *
 * Write pattern: synchronous via better-sqlite3, fail-soft.
 * Never block the tier spawn — an audit failure is non-fatal.
 *
 * Reproduction pattern: load the exact same inputs per workstreamId+phase,
 * cross-check with the current LLM. Drift > N% → verifiedStatus='drift'.
 */

import { createHash } from "node:crypto";
import { getDb } from "@/db/client";
import {
  reasoningAudit,
  type ReasoningAuditInsert,
} from "@/db/schema/reasoning_audit";
import { ulid } from "@/lib/ulid";
import {
  getWorkspaceSensitivity,
  shouldPersistFullPrompts,
} from "./workspace-sensitivity";

const MAX_CLAIM_LENGTH = 4000;

export interface WriteReasoningAuditInput {
  workspaceId?: string | null;
  workstreamId?: string | null;
  parentTicketId?: string | null;
  phase: string;
  role: string;
  llmProvider: string;
  llmModel: string;
  systemPrompt: string;
  userPrompt: string;
  output: string;
  sourceChunks?: Array<{ sourceType: string; sourceId: string; score?: number }>;
  priorOutputs?: Array<{ phase: string; hash: string }>;
  userCorrections?: Array<{ ts: number; text: string }>;
  costCents?: number;
  durationMs?: number;
  outputTokens?: number;
  /**
   * Privacy-Sprint V2 (2026-05-01): override for the DB sensitivity lookup.
   * Callers that already know the sensitivity can inject it here —
   * the default is auto-lookup via `workspaceId`. At `'high'`,
   * plaintext prompts are NEVER persisted (not even with
   * `LAZYOS_AUDIT_FULL_PROMPTS=1`).
   */
  workspaceSensitivity?: "low" | "high" | "unknown";
}

/**
 * SHA-256 hash of system+user prompt. Stable for reproducibility.
 * We do NOT trim whitespace or lowercase — prompts are sensitive to
 * exact formatting.
 */
export function hashPrompt(systemPrompt: string, userPrompt: string): string {
  return createHash("sha256")
    .update(systemPrompt)
    .update("\n---USER---\n")
    .update(userPrompt)
    .digest("hex");
}

export function writeReasoningAudit(input: WriteReasoningAuditInput): string | null {
  try {
    const db = getDb();
    const id = `rsn_${ulid()}`;
    const promptHash = hashPrompt(input.systemPrompt, input.userPrompt);
    const claimText =
      input.output.length > MAX_CLAIM_LENGTH
        ? input.output.slice(0, MAX_CLAIM_LENGTH) + "…[truncated]"
        : input.output;
    // Privacy-Sprint V2 (2026-05-01): high-sensitivity workspaces may NEVER
    // persist plaintext prompts — not even with LAZYOS_AUDIT_FULL_PROMPTS=1.
    // Auto-lookup when not explicitly passed. At 'unknown' (lookup error
    // or missing workspaceId) the default answer is conservatively false.
    const sensitivity =
      input.workspaceSensitivity ?? getWorkspaceSensitivity(input.workspaceId);
    const persistPrompts = shouldPersistFullPrompts(sensitivity);

    const insert: ReasoningAuditInsert = {
      id,
      ts: new Date(),
      workspaceId: input.workspaceId ?? null,
      workstreamId: input.workstreamId ?? null,
      parentTicketId: input.parentTicketId ?? null,
      phase: input.phase,
      role: input.role,
      llmProvider: input.llmProvider,
      llmModel: input.llmModel,
      promptHash,
      claimText,
      sourceChunksJson: input.sourceChunks?.length
        ? JSON.stringify(input.sourceChunks)
        : null,
      priorOutputsJson: input.priorOutputs?.length
        ? JSON.stringify(input.priorOutputs)
        : null,
      userCorrectionsJson: input.userCorrections?.length
        ? JSON.stringify(input.userCorrections)
        : null,
      costCents: input.costCents ?? 0,
      durationMs: input.durationMs ?? 0,
      outputTokens: input.outputTokens ?? null,
      verifiedStatus: null,
      verifiedAt: null,
      verifiedNote: null,
      // Pattern 5 wave 3 (2026-05-01): optional plaintext prompts for
      // later drift re-spawn. Default off — storage saving.
      // Privacy-Sprint V2: high workspace ⇒ ALWAYS null.
      systemPromptText: persistPrompts ? input.systemPrompt : null,
      userPromptText: persistPrompts ? input.userPrompt : null,
    };
    db.insert(reasoningAudit).values(insert).run();
    return id;
  } catch (err) {
    console.warn(
      "[reasoning-audit] write failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Hash of an output text — for the priorOutputs reference.
 * We hash only the first 8000 characters (output identity is enough).
 */
export function hashOutput(text: string): string {
  return createHash("sha256")
    .update(text.slice(0, 8000))
    .digest("hex")
    .slice(0, 16);
}
