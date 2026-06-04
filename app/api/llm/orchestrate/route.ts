/**
 * POST /api/llm/orchestrate
 *
 * Body: { mode: 'parallel-all' | 'claude-cli' | 'codex-cli' | 'ollama',
 *         messages: [{role,content}], model?, maxTokens?, timeoutMs? }
 *
 * Returns:
 *   {
 *     engine, model, text, latencyMs, usage?,
 *     mode: 'parallel-all' | EngineId,
 *     attempts: [{ engine, latencyMs, won, error? }]
 *   }
 *
 * Used by:
 *   - Engine-Pill smoke (developer console)
 *   - Future `lib/chat/useChatStream.ts` Plain-Chat-Mode integration
 *
 * NOT used by the main agent-server chat path (workspace-session.ts) — that
 * one stays on claude-CLI MAX-Plan. The orchestrator here is the new
 * "user-pickable engine routing" surface that the Engine-Pill drives.
 *
 * Security (defense-in-depth, Codex-Write-Boundary):
 *   - BodySchema is a strict Zod parse (no `as`-cast). Unknown fields —
 *     including any client-supplied `codexMode` — are stripped by Zod's
 *     default `.strip()` behaviour. This prevents a forged body from ever
 *     reaching `orchestrate()` with codexMode='write'.
 *   - `orchestrate()` is always called with `codexMode: 'read'` hardcoded
 *     here, independent of what the client sends. Even if Zod's stripping
 *     were somehow bypassed, the hardcoded 'read' wins.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { orchestrate, type EngineMode } from '@/lib/llm/orchestrator';
import { piiVaultEnabled } from '@/lib/privacy/protect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Accepted request shape.
// NOTE: `codexMode` is intentionally absent — clients may never set it.
//       It is hardcoded to 'read' in the orchestrate() call below.
// ---------------------------------------------------------------------------

const MessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});

const EngineModeSchema = z.enum([
  'parallel-all',
  'claude-cli',
  'codex-cli',
  'ollama',
]);

const BodySchema = z.object({
  mode: EngineModeSchema.default('parallel-all'),
  messages: z.array(MessageSchema).min(1, 'messages-empty'),
  model: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().nonnegative().optional(),
  parallelTimeoutMs: z.number().int().nonnegative().optional(),
  // PII vault: when a workspace scope is supplied, outbound messages are
  // tokenized before they reach the (cloud) racers and the winning text is
  // rehydrated locally. Absent → scope-less dev/smoke pass-through (this endpoint
  // is not on the main chat path, which tokenizes in app/api/chat/stream).
  workspaceId: z.string().optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid-json' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    // Surface a helpful code: 'messages-empty' for the min(1) failure.
    const errorCode =
      firstIssue?.message === 'messages-empty'
        ? 'messages-empty'
        : 'invalid-body';
    return NextResponse.json(
      { error: errorCode, details: parsed.error.issues },
      { status: 400 },
    );
  }

  const body = parsed.data;
  const mode = body.mode as EngineMode;

  // PII vault: fail CLOSED. Any mode other than the local 'ollama' can reach a
  // cloud engine. When the vault is on, refuse to race raw client messages
  // without a workspace scope (orchestrate() would otherwise pass them through
  // untokenized). 'ollama' is local → no scope needed; vault-off → unaffected.
  if (piiVaultEnabled() && mode !== 'ollama' && !body.workspaceId) {
    return NextResponse.json(
      {
        error: 'workspace-scope-required',
        message:
          'workspaceId is required when the PII vault is enabled and the mode can reach a cloud engine — messages must be tokenized before egress.',
      },
      { status: 400 },
    );
  }

  try {
    const result = await orchestrate({
      mode,
      messages: body.messages,
      model: body.model,
      maxTokens: body.maxTokens,
      timeoutMs: body.timeoutMs,
      parallelTimeoutMs: body.parallelTimeoutMs,
      // Defense-in-depth: hardcoded 'read' — client can never escalate to
      // write-codex via this endpoint regardless of what the body contained.
      codexMode: 'read',
      // PII vault: orchestrate() tokenizes the outbound messages and rehydrates
      // the reply internally when a workspace scope is supplied (pass-through
      // otherwise). This endpoint is not on the main chat path.
      ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}),
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      {
        error: 'orchestrate-failed',
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
}
