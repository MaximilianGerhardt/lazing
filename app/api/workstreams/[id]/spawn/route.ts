/**
 * POST /api/workstreams/[id]/spawn
 *
 * Phase A + D: Tier-Spawn-Engine. Wird vom Frontend nach Tier-Choice-Klick
 * aufgerufen. Schritte:
 *
 *   1. Master-Plan-Ticket anlegen (falls noch keins)
 *   2. Workstream.primaryTicketId setzen
 *   3. Tier-Spawn parallel (N Opus + M Sonnet + K Haiku)
 *   4. Synthesis durch Lead-Agent (Opus xhigh)
 *   5. Cost auf Workstream aggregieren
 *
 * Background-Run: Antwortet sofort mit { ok: true, ticketId } und laeuft
 * im Hintergrund weiter. Frontend pollt /api/workstreams/[id] fuer Progress.
 *
 * Auth: Cookie-Session reicht (default API-Auth via middleware).
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
  // Phase IT (2026-04-27): mode wahl zwischen Swarm (Phase A) und
  // Iterate (Phase IT). Default: 'iterate' weil 90% der User-Faelle
  // konvergent sind und 28× Output kein Sinn macht.
  mode: z.enum(['swarm', 'iterate']).optional(),
  // Sub-Plan A (2026-04-30): Tier-Preset für Iterate-Modus.
  // Default = 'standard' (Backwards-Compat).
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

  // tierMix ist nur für Swarm-Mode Pflicht. Iterate hat fixe Architektur
  // (1 Lead + 2 Roaster + 1 Lead-V2).
  if (mode === 'swarm' && !ws.tierMix) {
    return NextResponse.json(
      { error: 'no_tier_mix', hint: 'Swarm-Mode braucht tierMix auf dem Workstream' },
      { status: 400 },
    );
  }

  // 1. Master-Plan-Ticket anlegen falls noch keins
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

  // Sub-Plan A (2026-04-30): Tier-Preset + Mode persistieren BEVOR der
  // Iterate-Background-Run startet — sonst liest runIterateMode() das
  // alte/leere `iterate_config_json` und fällt auf Standard zurück.
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

  // 2. Hintergrund-Spawn (kein await, sofort 202 zurueck)
  if (mode === 'iterate') {
    const masterTicketIdLocal = masterTicketId;
    void runIterateMode(ws.id, masterTicketIdLocal, ws.workspaceId, workspacePath, prompt).catch(
      async (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[iterate-orchestrator]', msg);
        // Phase IT 2026-04-27: Workstream auf 'archived' setzen + Error-
        // Comment am Master damit User sofort sieht "Spawn fehlgeschlagen".
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
  // 3. Tier-Spawn
  const result = await spawnTier({
    workspaceId,
    workspacePath,
    parentTicketId,
    workstreamId,
    prompt,
    tierMix,
  });

  // 4. Synthesis durch Lead
  const synth = await runSynthesis({
    workspaceId,
    workspacePath,
    parentTicketId,
    workstreamId,
    originalPrompt: prompt,
    outputs: result.outputs,
  });

  // 4b. Sniper-Multi-Round nach Synthesis: bis zu 3 Re-Synth-Iterationen.
  // Pro Iteration: 25s-Pause + bei Inject Re-Spawn mit User-Korrekturen.
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

  // 5. Cost-Aggregation auf Workstream
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
  // Sub-Plan A (2026-04-30): Tier-Choice respektieren. Falls der Workstream
  // ein `iterate_config_json` hat (gesetzt von start-dispatch + spawn-Bodies),
  // nutzen wir es. Sonst Default = TIER_PRESETS.standard.
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
    /* nicht-fatal — Default greift unten */
  }
  const iterateConfig = resolveIterateConfig(iterateConfigJson);

  // Phase IT (2026-04-27): N Lead + M Roaster + 1 Revise = ~4 Spawns total
  // (Standard). Schnell = 1 Spawn, Tief = bis 7 Spawns.
  // Token-Budget ~75% niedriger als Swarm-Modus (Balanced-Preset: 20 Spawns).
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
