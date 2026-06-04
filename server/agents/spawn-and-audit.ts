/**
 * spawnAndAudit — thin wrapper around spawnInTmux + reasoning-audit persist
 * (Pattern 5 wave 2, 2026-05-01).
 *
 * Goal: every LLM inference in the tier orchestrator automatically appends an
 * audit trace to reasoning_audit, without the callers having to copy ~20 lines
 * of boilerplate.
 *
 * Guarantees:
 *   - queueMicrotask: the audit write runs after the return — latency hit ≈ 0ms.
 *   - Fail-soft: writeReasoningAudit catches its own errors; one more try here.
 *   - Skip on rateLimited or empty output (no meaningful audit trace).
 *
 * Foundation:
 *   - lib/audit/reasoning.writeReasoningAudit (live seit 2026-05-01).
 *   - db/schema/reasoning_audit + Migration 0044.
 */

import { spawnInTmux, type SpawnArgs, type SpawnResult } from './tmux-spawn';

export interface AuditMeta {
  workspaceId: string;
  workstreamId?: string | null;
  parentTicketId?: string | null;
  phase: string;
  role: string;
  llmProvider?: string;
  sourceChunks?: Array<{ sourceType: string; sourceId: string; score?: number }>;
  priorOutputs?: Array<{ phase: string; hash: string }>;
  userCorrections?: Array<{ ts: number; text: string }>;
}

export async function spawnAndAudit(
  spawnArgs: SpawnArgs,
  audit: AuditMeta,
): Promise<SpawnResult> {
  const result = await spawnInTmux(spawnArgs);

  if (!result.rateLimited && result.text.length > 0) {
    queueMicrotask(() => {
      void (async () => {
        try {
          const { writeReasoningAudit } = await import('@/lib/audit/reasoning');
          writeReasoningAudit({
            workspaceId: audit.workspaceId,
            workstreamId: audit.workstreamId ?? null,
            parentTicketId: audit.parentTicketId ?? null,
            phase: audit.phase,
            role: audit.role,
            llmProvider: audit.llmProvider ?? 'tmux-claude',
            llmModel: spawnArgs.model,
            systemPrompt: spawnArgs.systemPrompt,
            userPrompt: spawnArgs.userPrompt,
            output: result.text,
            sourceChunks: audit.sourceChunks ?? [],
            priorOutputs: audit.priorOutputs ?? [],
            userCorrections: audit.userCorrections ?? [],
            costCents: result.costCents,
            durationMs: result.durationMs,
            outputTokens: result.tokens?.output ?? null,
          });
        } catch {
          /* non-fatal — the audit write must never break the spawn after the fact */
        }
      })();
    });
  }

  return result;
}
