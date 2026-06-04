/**
 * POST /api/agents/spawn
 *
 * BACKPORT-02 (2026-05-23) — Subagent-Pool entry point. Spawns one or
 * more subagents, drives them through the SubagentSpawner, and feeds the
 * resulting lane events into the in-process fleet registry so
 * GET /api/agents/status reflects the live state.
 *
 * Body:
 *   {
 *     "fleetId":          string,      // operator-chosen id (idempotent re-use ok)
 *     "intent":           string,      // verbatim N1 text
 *     "parentWorkstreamId": string,
 *     "roles":            SubagentRole[],     // length === engines.length
 *     "engines":          SubagentEngine[],   // claude-cli | codex | ollama-heavy
 *     "worktreePaths"?:   string[],    // defaults to process.cwd() per role
 *     "topology"?:        SwarmTopology
 *   }
 *
 * Response (200): { fleetId, spawned: [{ agentId, role, status }] }
 * Response (429): { error: 'budget-exhausted', code: 'N11_HEAVY_CAP' }
 * Response (400): { error: 'validation-failed', details }
 *
 * Per BACKPORT-SPEC §6.5-6: when the resource-pool refuses an acquire
 * due to N11 caps, the endpoint returns 429 with denial_code
 * 'N11_HEAVY_CAP' so the operator UI can render the explicit budget
 * gate (this is a Wave-3 prerequisite for the M-RES-01 audit row —
 * once the audit table exists, an additional row is written; for now
 * the 429 is the load-bearing signal).
 */

import { NextResponse } from 'next/server';

import {
  createSubagentSpawner,
  defaultSpawnerAdapterFactory,
  resourcePool,
  SUBAGENT_ROLES,
  type SubagentEngine,
  type SubagentRole,
} from '@/lib/agents';
import { ingestLaneEvent } from '@/lib/agents/fleet-registry';
import { piiVaultEnabled } from '@/lib/privacy/protect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_ENGINES: ReadonlySet<SubagentEngine> = new Set<SubagentEngine>([
  'claude-cli',
  'codex',
  'ollama-heavy',
]);

interface SpawnBody {
  fleetId?: string;
  intent?: string;
  parentWorkstreamId?: string;
  /** PII-vault scope (N9): when set, cloud-engine prompts are tokenized. */
  workspaceId?: string;
  roles?: string[];
  engines?: string[];
  worktreePaths?: string[];
  topology?: string;
}

export async function POST(req: Request): Promise<Response> {
  let body: SpawnBody;
  try {
    body = (await req.json()) as SpawnBody;
  } catch {
    return NextResponse.json({ error: 'validation-failed', message: 'invalid JSON' }, { status: 400 });
  }

  const fleetId = typeof body.fleetId === 'string' && body.fleetId.length > 0
    ? body.fleetId
    : `fleet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const intent = typeof body.intent === 'string' ? body.intent : '';
  const parentWorkstreamId =
    typeof body.parentWorkstreamId === 'string' ? body.parentWorkstreamId : 'ws-default';
  const workspaceId =
    typeof body.workspaceId === 'string' && body.workspaceId.length > 0
      ? body.workspaceId
      : undefined;
  const roles = Array.isArray(body.roles) ? body.roles : [];
  const engines = Array.isArray(body.engines) ? body.engines : [];
  const worktreePaths = Array.isArray(body.worktreePaths) ? body.worktreePaths : [];

  if (intent.length === 0) {
    return NextResponse.json({ error: 'validation-failed', message: 'intent required' }, { status: 400 });
  }
  if (roles.length === 0) {
    return NextResponse.json({ error: 'validation-failed', message: 'roles required' }, { status: 400 });
  }
  if (roles.length !== engines.length) {
    return NextResponse.json(
      { error: 'validation-failed', message: 'roles.length must equal engines.length' },
      { status: 400 },
    );
  }
  for (const r of roles) {
    if (!SUBAGENT_ROLES.includes(r as SubagentRole)) {
      return NextResponse.json(
        { error: 'validation-failed', message: `unknown role: ${r}` },
        { status: 400 },
      );
    }
  }
  for (const e of engines) {
    if (!VALID_ENGINES.has(e as SubagentEngine)) {
      return NextResponse.json(
        { error: 'validation-failed', message: `unknown engine: ${e}` },
        { status: 400 },
      );
    }
  }

  // PII vault: fail CLOSED. The operator intent (N1, verbatim) may carry customer
  // PII, and a cloud engine (claude-cli / codex) would receive it. When the vault
  // is on, refuse to spawn a CLOUD agent without a workspace scope — otherwise the
  // default factory would call protectEngine('', …), which is a pass-through, and
  // the raw intent would leak. Local (ollama-heavy) spawns and vault-off are
  // unaffected.
  const usesCloudEngine = engines.some((e) => e === 'claude-cli' || e === 'codex');
  if (piiVaultEnabled() && usesCloudEngine && !workspaceId) {
    return NextResponse.json(
      {
        error: 'validation-failed',
        message:
          'workspaceId is required when the PII vault is enabled and spawning a cloud engine (claude-cli/codex) — the operator intent must be tokenized before egress.',
      },
      { status: 400 },
    );
  }

  // N11 pre-check — heavyTotal cap. Refusing here before invoking the
  // spawner keeps the operator-visible error simple (429) instead of
  // letting the per-lane error events bubble.
  const budget = resourcePool.getBudget();
  const currentInflight = resourcePool.getInflight().length;
  if (currentInflight + roles.length > budget.heavyTotal) {
    return NextResponse.json(
      {
        error: 'budget-exhausted',
        denial_code: 'N11_HEAVY_CAP',
        message: `Spawn-attempt of ${roles.length} heavy agents would exceed N11 heavyTotal=${budget.heavyTotal} (current=${currentInflight})`,
      },
      { status: 429 },
    );
  }

  // Default worktreePaths to process.cwd() per role (Wave-2 M-WORK-01 stub).
  const paths: string[] =
    worktreePaths.length === roles.length
      ? worktreePaths
      : roles.map(() => process.cwd());

  const spawner = createSubagentSpawner({
    adapterFactory: defaultSpawnerAdapterFactory,
  });

  const spawned: Array<{ agentId: string; role: SubagentRole; status: 'spawned' | 'errored' }> = [];

  // Fire-and-forget per-role; the registry collects events. We capture
  // the first `started` event per lane to return the agentIds
  // synchronously to the caller. The lanes continue running in the
  // background and update the registry.
  const startedSignals = new Map<number, (id: string) => void>();
  const startedPromises = roles.map(
    (_, i) =>
      new Promise<string>((resolve) => {
        startedSignals.set(i, resolve);
      }),
  );

  for (let i = 0; i < roles.length; i += 1) {
    const role = roles[i] as SubagentRole;
    const engine = engines[i] as SubagentEngine;
    const worktreePath = paths[i]!;
    void (async () => {
      try {
        for await (const ev of spawner.spawnSubagent({
          role,
          intent: { intentText: intent },
          parentWorkstreamId,
          worktreePath,
          engine,
          ...(workspaceId ? { workspaceId } : {}),
        })) {
          ingestLaneEvent(fleetId, ev, { intentText: intent });
          if (ev.kind === 'started') {
            const sig = startedSignals.get(i);
            if (sig) {
              sig(ev.subagentId);
              startedSignals.delete(i);
            }
          }
        }
      } catch (err) {
        // Surface to the registry as a generic error event.
        ingestLaneEvent(
          fleetId,
          {
            kind: 'error',
            subagentId: `sub-${role}-unknown`,
            role,
            worktreeBranch: null,
            code: 'spawn-driver-failed',
            message: err instanceof Error ? err.message : String(err),
            at: Date.now(),
          },
          { intentText: intent },
        );
        const sig = startedSignals.get(i);
        if (sig) {
          sig(`sub-${role}-error`);
          startedSignals.delete(i);
        }
      }
    })();
  }

  // Wait briefly for `started` from each lane (capped at 1s).
  const ids = await Promise.all(
    startedPromises.map(
      (p, i) =>
        Promise.race([
          p,
          new Promise<string>((resolve) =>
            setTimeout(() => resolve(`sub-${roles[i]}-pending`), 1000),
          ),
        ]) as Promise<string>,
    ),
  );

  for (let i = 0; i < roles.length; i += 1) {
    spawned.push({
      agentId: ids[i]!,
      role: roles[i] as SubagentRole,
      status: 'spawned',
    });
  }

  return NextResponse.json(
    { fleetId, spawned, topology: body.topology ?? 'parallel' },
    { status: 200 },
  );
}
