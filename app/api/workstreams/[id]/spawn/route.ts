/**
 * POST /api/workstreams/[id]/spawn
 *
 * Phase A + D: tier-spawn engine. Called by the frontend after a tier-choice
 * click. Steps:
 *
 *   1. create the master plan ticket (if none yet)
 *   2. set Workstream.primaryTicketId
 *   3. tier spawn in parallel (N Opus + M Sonnet + K Haiku)
 *   4. synthesis by the lead agent (Opus xhigh)
 *   5. aggregate cost onto the workstream
 *
 * Background run: responds immediately with { ok: true, ticketId } and keeps
 * running in the background. The frontend polls /api/workstreams/[id] for progress.
 *
 * Auth: a cookie session suffices (default API auth via middleware).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import fs from 'node:fs';

import { getWorkstream, updateWorkstream } from '@/lib/workstreams/service';
import { createTicket } from '@/lib/tickets/service';
import {
  spawnTier,
  runSynthesis,
  runIterate,
  waitForSniperPause,
  SNIPER_PAUSE_MS_PUBLIC,
} from '@/server/agents/tier-orchestrator';
import { emitEvent } from '@/lib/events/emit';
import { getDb } from '@/db/client';
import { getWorkspace } from '@/lib/workspaces';
import { defaultWorkspacePath, projectsRoot } from '@/lib/workspaces/projects-root';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  planTitle: z.string().min(1).max(200).optional(),
  prompt: z.string().min(1).max(20_000).optional(),
  // Phase IT (2026-04-27): mode choice between swarm (Phase A) and
  // iterate (Phase IT). Default: 'iterate' because 90% of user cases
  // are convergent and 28× output makes no sense.
  mode: z.enum(['swarm', 'iterate']).optional(),
  // Sub-Plan A (2026-04-30): tier preset for iterate mode.
  // Default = 'standard' (backwards-compat).
  presetId: z.enum(['schnell', 'standard', 'tief']).optional(),
});

interface Ctx {
  params: Promise<{ id: string }>;
}

async function resolveWorkspacePath(workspaceId: string): Promise<string> {
  if (workspaceId === '__root__') return projectsRoot();
  const ws = await getWorkspace(workspaceId).catch(() => null);
  if (ws && typeof ws.path === 'string' && fs.existsSync(ws.path)) return ws.path;
  // Fallback: <projectsRoot>/<id> when it exists.
  const guess = defaultWorkspacePath(workspaceId);
  if (fs.existsSync(guess)) return guess;
  return projectsRoot();
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  const ws = await getWorkstream(id);
  if (!ws) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const planTitle = parsed.data.planTitle ?? ws.name;
  const prompt = parsed.data.prompt ?? planTitle;
  const mode: 'swarm' | 'iterate' = parsed.data.mode ?? 'iterate';

  // tierMix is only mandatory for swarm mode. Iterate has a fixed architecture
  // (1 lead + 2 roasters + 1 lead-V2).
  if (mode === 'swarm' && !ws.tierMix) {
    return NextResponse.json(
      { error: 'no_tier_mix', hint: 'Swarm-Mode braucht tierMix auf dem Workstream' },
      { status: 400 },
    );
  }

  // 1. create the master plan ticket if none yet
  let masterTicketId = ws.primaryTicketId;
  if (!masterTicketId) {
    const ticket = await createTicket({
      workspaceId: ws.workspaceId,
      title: planTitle,
      body: `Master-Plan-Ticket fuer Workstream ${ws.id}\n\nUrspruenglicher Prompt:\n${prompt}`,
      prio: 'P2',
      actor: 'system',
      workstreamId: ws.id,
    });
    masterTicketId = ticket.id;
    await updateWorkstream(ws.id, { primaryTicketId: masterTicketId });
  }

  const workspacePath = await resolveWorkspacePath(ws.workspaceId);

  // Sub-Plan A (2026-04-30): persist the tier preset + mode BEFORE the
  // iterate background run starts — otherwise runIterateMode() reads the
  // old/empty `iterate_config_json` and falls back to standard.
  if (mode === 'iterate') {
    const presetId = parsed.data.presetId ?? 'standard';
    try {
      const { TIER_PRESETS } = await import('@/lib/workstreams/tier-presets');
      const cfg = TIER_PRESETS[presetId];
      const db = getDb();
      db.$raw
        .prepare(
          'UPDATE workstreams SET mode = ?, iterate_config_json = ? WHERE id = ?',
        )
        .run('iterate', JSON.stringify(cfg), ws.id);
    } catch (err) {
      console.warn('[spawn] iterate-config-persist failed:', err);
    }
  }

  // 2. background spawn (no await, return 202 immediately)
  if (mode === 'iterate') {
    const masterTicketIdLocal = masterTicketId;
    void runIterateMode(ws.id, masterTicketIdLocal, ws.workspaceId, workspacePath, prompt).catch(
      async (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[iterate-orchestrator]', msg);
        // Phase IT 2026-04-27: set the workstream to 'archived' + error
        // comment on the master so the user immediately sees "spawn failed".
        try {
          await updateWorkstream(ws.id, { status: 'archived' });
          const { emitEvent } = await import('@/lib/events/emit');
          await emitEvent({
            segmentId: ws.workspaceId,
            entityType: 'ticket',
            entityId: masterTicketIdLocal,
            eventType: 'commented',
            actor: 'agent:iterate-lead',
            payload: {
              kind: 'iterate-error',
              error: msg,
              workstreamId: ws.id,
            },
            sensitivity: 'low',
          });
        } catch {
          /* swallow recovery errors */
        }
      },
    );
  } else {
    void runSwarmMode(ws.id, masterTicketId, ws.workspaceId, workspacePath, prompt, ws.tierMix!).catch(
      (err) => {
        console.error('[tier-orchestrator]', err);
      },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      workstreamId: ws.id,
      masterTicketId,
      tierMix: ws.tierMix,
      mode,
      url: `/workstreams/${encodeURIComponent(ws.id)}`,
    },
    { status: 202 },
  );
}

async function runSwarmMode(
  workstreamId: string,
  parentTicketId: string,
  workspaceId: string,
  workspacePath: string,
  prompt: string,
  tierMix: { opus: number; sonnet: number; haiku: number },
): Promise<void> {
  // 3. tier spawn
  const result = await spawnTier({
    workspaceId,
    workspacePath,
    parentTicketId,
    workstreamId,
    prompt,
    tierMix,
  });

  // 4. synthesis by the lead
  const synth = await runSynthesis({
    workspaceId,
    workspacePath,
    parentTicketId,
    workstreamId,
    originalPrompt: prompt,
    outputs: result.outputs,
  });

  // 4b. sniper multi-round after synthesis: up to 3 re-synth iterations.
  // Per iteration: 25s pause + on inject re-spawn with user corrections.
  let extraSynthCostCents = 0;
  let prevText = synth.text;
  let prevEmittedAt = Date.now();
  const MAX_RESYNTH = 3;
  for (let round = 1; round <= MAX_RESYNTH; round++) {
    const afterTag = round === 1 ? 'synthesis' : `synthesis-v${round}`;
    await emitEvent({
      segmentId: workspaceId,
      entityType: 'ticket',
      entityId: parentTicketId,
      eventType: 'commented',
      actor: 'agent:swarm-lead',
      payload: {
        kind: 'sniper-pause-start',
        after: afterTag,
        workstreamId,
        durationMs: SNIPER_PAUSE_MS_PUBLIC,
        message: `Synthesis-Round ${round} ist fertig — ${Math.round(
          SNIPER_PAUSE_MS_PUBLIC / 1000,
        )}s Window. Korrektur löst Re-Synth ${round + 1} aus, sonst final.`,
      },
      sensitivity: 'low',
    }).catch(() => undefined);
    const correctionsAfter = await waitForSniperPause(
      parentTicketId,
      prevEmittedAt,
      SNIPER_PAUSE_MS_PUBLIC,
    );
    if (correctionsAfter === 0) break;

    try {
      const db = getDb();
      const correctionRows = db.$raw
        .prepare(
          `SELECT payload FROM events
            WHERE entity_type = 'ticket' AND entity_id = ?
              AND event_type = 'commented'
              AND created_at >= ?
              AND json_extract(payload, '$.kind') = 'user-correction'
            ORDER BY created_at ASC`,
        )
        .all(parentTicketId, prevEmittedAt) as Array<{ payload: string }>;
      const messages: string[] = [];
      for (const r of correctionRows) {
        try {
          const p = JSON.parse(r.payload) as { message?: string };
          if (p.message) messages.push(p.message);
        } catch {
          /* skip */
        }
      }
      if (messages.length === 0) break;

      const { spawnInTmux } = await import('@/server/agents/tmux-spawn');
      const reviseSystemSwarm = [
        'Du bist der Synthesis-Lead im Swarm-Mode (Re-Synth-Round ' +
          (round + 1) +
          ').',
        'Die letzte Synthesis ist fertig. User hat eine Mid-Course-Korrektur reingeworfen.',
        'Schreibe eine REVIDIERTE Synthesis, in der die User-Korrektur höher gewichtet ist',
        'als jeder ursprüngliche Schwarm-Output.',
        '',
        'Output-Struktur:',
        '## Konsolidierter Plan',
        '## User-Sicht',
        '## Risiken',
        '## Offene Fragen',
        '',
        '## User-Korrekturen (Sniper-Hook)',
        '- "Übernommen: <wie integriert>"',
        '- "Abgelehnt: <Begründung>"',
        '',
        'Maximal 2000 Wörter.',
      ].join('\n');
      const userPrompt = [
        'Anfrage Max: ' + prompt,
        '',
        `## Letzte Synthesis (Round ${round}):`,
        prevText,
        '',
        '## SNIPER-HOOK · NEUE User-Korrekturen',
        ...messages.map((m) => `- ${m}`),
        '',
        'Schreibe Re-Synth — diese Korrekturen sind höchste Priorität.',
      ].join('\n\n');
      const reSynth = await spawnInTmux({
        workspaceId,
        workspacePath,
        workstreamId,
        tier: 'opus',
        agentIdx: 990 + round,
        model: 'claude-opus-4-8',
        systemPrompt: reviseSystemSwarm,
        userPrompt,
        timeoutMs: 6 * 60_000,
      });
      extraSynthCostCents += reSynth.costCents;
      prevText = reSynth.text || prevText;
      prevEmittedAt = Date.now();
      await emitEvent({
        segmentId: workspaceId,
        entityType: 'ticket',
        entityId: parentTicketId,
        eventType: 'commented',
        actor: 'agent:swarm-lead',
        payload: {
          kind: 'synthesis',
          mode: `swarm-revised-${round + 1}`,
          text: reSynth.text,
          tokens: reSynth.tokens,
          costCents: reSynth.costCents,
          durationMs: reSynth.durationMs,
          workstreamId,
          sniperRevised: true,
          sniperRound: round + 1,
        },
        sensitivity: 'low',
      }).catch(() => undefined);
    } catch (err) {
      console.warn('[swarm-sniper] re-synth failed:', err);
      break;
    }
  }

  // 5. cost aggregation onto the workstream
  await updateWorkstream(workstreamId, {
    costCents: result.totalCostCents + synth.costCents + extraSynthCostCents,
    status: 'done',
  }).catch(() => undefined);
}

async function runIterateMode(
  workstreamId: string,
  parentTicketId: string,
  workspaceId: string,
  workspacePath: string,
  prompt: string,
): Promise<void> {
  // Sub-Plan A (2026-04-30): respect the tier choice. If the workstream
  // has an `iterate_config_json` (set by start-dispatch + spawn bodies),
  // we use it. Otherwise default = TIER_PRESETS.standard.
  const { resolveIterateConfig } = await import(
    '@/lib/workstreams/tier-presets'
  );
  let iterateConfigJson: string | null = null;
  try {
    const db = getDb();
    const row = db.$raw
      .prepare('SELECT iterate_config_json FROM workstreams WHERE id = ?')
      .get(workstreamId) as { iterate_config_json: string | null } | undefined;
    iterateConfigJson = row?.iterate_config_json ?? null;
  } catch {
    /* non-fatal — the default applies below */
  }
  const iterateConfig = resolveIterateConfig(iterateConfigJson);

  // Phase IT (2026-04-27): N lead + M roaster + 1 revise = ~4 spawns total
  // (standard). Fast = 1 spawn, deep = up to 7 spawns.
  // Token budget ~75% lower than swarm mode (balanced preset: 20 spawns).
  const result = await runIterate(
    {
      workspaceId,
      workspacePath,
      parentTicketId,
      workstreamId,
      originalPrompt: prompt,
    },
    iterateConfig,
  );

  await updateWorkstream(workstreamId, {
    costCents: result.totalCostCents,
    status: 'done',
  }).catch(() => undefined);
}
