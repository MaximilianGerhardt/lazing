/**
 * Auto-Dispatch-Spawner (Phase AD · 2026-04-26).
 *
 * Spawns a 3-stage pipeline per sub-ticket: senior-dev → code-reviewer →
 * critic. SEQUENTIAL, because stage 2 needs the stage-1 output and stage 3
 * the stage-2 output. Each stage emits a comment on the sub-ticket.
 *
 * Security:
 *   - LAZYOS_TIER_DEPTH=1 in the child env -> no recursive spawn.
 *   - ANTHROPIC_API_KEY is stripped -> MAX plan takes effect, no credits.
 *   - Sub-ticket status runs executing -> closed (or rejected on failure).
 *
 * Re-uses spawnInTmux() from tmux-spawn.ts — same auth/resilience guarantees
 * as the tier orchestrator. tmux sessions carry unique names with
 * stage+sub-ticket ID, so competing spawns do not collide.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { emitEvent } from '../../lib/events/emit';
import { emitOrUpdateCard } from '../../lib/events/emit-or-update-card';
import {
  autoDispatchStageRetrySubKey,
  autoDispatchStageSubKey,
} from '../../lib/events/loop-card-coords';
import type { ActorType } from '../../lib/events/types';
import { MODEL_NAMES } from '../../lib/agents/pricing';
import { spawnInTmux } from './tmux-spawn';
import {
  createSubWorkstream,
  type SubWorkstreamRole,
} from '../../lib/workstreams/service';
import { getDb } from '../../db/client';
import {
  resolveIterateConfig,
  type AutoDispatchStage,
} from '../../lib/workstreams/tier-presets';

type StageRole = 'senior-dev' | 'code-reviewer' | 'critic';

const STAGE_TO_SUB_ROLE: Record<StageRole, SubWorkstreamRole> = {
  'senior-dev': 'auto-dispatch-senior-dev',
  'code-reviewer': 'auto-dispatch-code-reviewer',
  critic: 'auto-dispatch-critic',
};

export interface SpawnSubPipelineOpts {
  workspaceId: string;
  workspacePath: string;
  subTicketId: string;
  masterTicketId: string;
  workstreamId?: string;
  subTicketTitle: string;
  subTicketBody: string;
}

export interface SpawnSubPipelineResult {
  ok: boolean;
  stagesRun: number;
  stagesSucceeded: number;
  costCentsTotal: number;
  failedStage?: 'senior-dev' | 'code-reviewer' | 'critic';
  failedReason?: string;
}

type Stage = {
  role: 'senior-dev' | 'code-reviewer' | 'critic';
  actor: ActorType;
  systemPrompt: string;
  timeoutMs: number;
  /**
   * Tool whitelist for this stage (Sub-Plan B build mode, 2026-04-30).
   * Empty = pure markdown output (plan mode / legacy).
   */
  allowedTools?: ReadonlyArray<string>;
};

/**
 * Sub-Plan B (2026-04-30): build vs plan mode.
 *
 * - `build` (default): senior-dev gets tool use (Read/Write/Edit/Bash/Grep/Glob),
 *   writes a REAL code diff in the workspace + a commit with a [skip-mirror] footer.
 *   code-reviewer + critic get Read+Bash, read the real diff.
 *
 * - `plan` (legacy / explicitly desired): no tool use, all stages
 *   produce pure markdown sketches — as before 2026-04-30.
 *
 * The default is `build`. To get the old behavior, set
 * `LAZYOS_BUILD_MODE=plan`.
 */
function getBuildMode(): 'build' | 'plan' {
  const raw = (process.env.LAZYOS_BUILD_MODE ?? 'build').trim().toLowerCase();
  return raw === 'plan' ? 'plan' : 'build';
}

/**
 * Sub-Plan A (2026-04-30): load the `stages` from the workstream's
 * `iterate_config_json`. Fast = ['senior-dev'], Standard =
 * ['senior-dev', 'code-reviewer'], Deep = all 3. Backwards-compat:
 * workstreams without config keep running with the standard stages.
 */
function loadStagesForWorkstream(
  workstreamId: string | undefined,
): ReadonlyArray<AutoDispatchStage> {
  if (!workstreamId) {
    // No workstream reference — fall back to the 3-stage standard.
    return ['senior-dev', 'code-reviewer', 'critic'];
  }
  try {
    const db = getDb();
    const row = db.$raw
      .prepare('SELECT iterate_config_json FROM workstreams WHERE id = ?')
      .get(workstreamId) as
      | { iterate_config_json: string | null }
      | undefined;
    const cfg = resolveIterateConfig(row?.iterate_config_json ?? null);
    return cfg.stages;
  } catch {
    return ['senior-dev', 'code-reviewer', 'critic'];
  }
}

function buildStages(
  opts: SpawnSubPipelineOpts,
  activeStages: ReadonlyArray<AutoDispatchStage>,
): Stage[] {
  const ctx =
    `Sub-Ticket-ID: ${opts.subTicketId}\n` +
    `Master-Ticket: ${opts.masterTicketId}\n` +
    `Workspace: ${opts.workspaceId}\n` +
    `Workspace-Pfad: ${opts.workspacePath}\n` +
    `Titel: ${opts.subTicketTitle}\n\n` +
    `Body:\n${opts.subTicketBody}`;

  const mode = getBuildMode();

  // Plan mode = legacy sketch behavior (before Sub-Plan B).
  // Build mode = sub-agents write real code, commit with
  // [skip-mirror], reviewer/critic read the diff via git.
  const seniorPrompt =
    mode === 'plan'
      ? [
          'Du bist senior-dev (Phase AD Auto-Dispatch — plan-mode).',
          'Du implementierst ein Sub-Ticket aus einem approved Master-Plan.',
          '',
          ctx,
          '',
          'Aufgabe:',
          '1. Lies das Sub-Ticket. Verstehe Akzeptanzkriterium.',
          '2. Plane die Umsetzung (kurz). Identifiziere betroffene Dateien.',
          '3. Liefere konkrete Schritte + Code-Skizze. Production-ready Stil.',
          '4. Falls echter Code committed werden soll: nutze Footer "[skip-mirror]"',
          '   damit die Auto-Mirror-Logik den Commit nicht erneut ins Chat poppt.',
          '',
          'Output: max 800 Worter Markdown. Strukturiere:',
          '## Implementations-Skizze',
          '## Aenderungen pro Datei',
          '## Akzeptanz-Check',
          '',
          'KEIN Tool-Use, KEIN tatsaechliches Schreiben — nur Plan + Skizze.',
          'Der Comment landet als Notiz am Sub-Ticket.',
        ].join('\n')
      : [
          'Du bist senior-dev (Phase AD Auto-Dispatch — build-mode).',
          'Du hast Tool-Use: Read, Write, Edit, Bash, Grep, Glob.',
          `Working-Dir: ${opts.workspacePath} (= Ziel-Repo).`,
          '',
          ctx,
          '',
          'WICHTIG — Conversation-Voice (Sub-Plan F 2026-04-30):',
          '1. Beginne mit 1 Satz knappe Conversation als Intro (max 50 Worte).',
          '   Beispiel: "Ich implementiere Sub-Ticket ' + opts.subTicketTitle.slice(0, 40) + '. Lese erst die betroffenen Dateien."',
          '2. DANN folgen die PFLICHT-Schritte und Code-Edits.',
          '3. KEIN Multi-Paragraph-Wall ohne Conversation-Anker.',
          '',
          'Aufgabe: implementiere das Sub-Ticket als ECHTEN Code-Diff.',
          '',
          'PFLICHT-Schritte:',
          '1. Lies die relevanten Files (Read/Grep) bevor du editierst.',
          '2. Implementiere den Code (Write/Edit). TypeScript strict, kein any.',
          '3. Teste lokal wenn moeglich (Bash: pnpm build / npm run build /',
          '   pnpm test). Kein Hard-Fail bei fehlenden Test-Skripten.',
          '4. Commit MIT [skip-mirror]-Footer, NICHT pushen:',
          '   git add -A && git commit -m "[skip-mirror] <kurze msg>"',
          '   Der Footer ist PFLICHT — sonst entsteht ein Auto-Dispatch-',
          '   Echo-Loop.',
          '5. Output: 3-5 Zeilen Zusammenfassung was du gemacht hast,',
          '   inklusive Commit-SHA (git rev-parse --short HEAD).',
          '',
          'VERBOTEN:',
          '- Markdown-Skizzen ohne tatsaechliche File-Edits.',
          '- Commits ohne [skip-mirror]-Footer.',
          '- git push, git reset --hard, git checkout -- ., --no-verify,',
          '  --force, force-push, --amend ohne explizites User-OK.',
          '- Schreibzugriff ausserhalb des Working-Dir.',
        ].join('\n');

  const seniorTools: ReadonlyArray<string> | undefined =
    mode === 'plan' ? undefined : ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'];

  const reviewerPrompt =
    mode === 'plan'
      ? [
          'Du bist code-reviewer (Phase AD Auto-Dispatch — plan-mode).',
          'Du reviewst die Implementations-Skizze von senior-dev am Sub-Ticket.',
          '',
          ctx,
          '',
          'Pruefe:',
          '- Security (Input-Validation, Auth, Secret-Leaks)',
          '- TypeScript Types (kein any, kein implicit-any)',
          '- Edge Cases (Loading/Error/Empty/Auth-Fehler)',
          '- Performance (N+1, unnoetige Re-Renders, blocking IO)',
          '- UX-States vorhanden',
          '',
          'Verdict: APPROVED oder CHANGES-REQUESTED + nummerierte Findings.',
          'P15 PFLICHT: Jeder Finding endet mit Konsequenz-Zeile',
          '"Wenn fix: dies ermöglicht <X>" — Findings als Hebel, nicht als Wand.',
          'Output max 600 Worter Markdown.',
        ].join('\n')
      : [
          'Du bist code-reviewer (Phase AD Auto-Dispatch — build-mode).',
          'Du hast Tool-Use: Read, Bash, Grep, Glob (READ-ONLY, KEIN Write/Edit).',
          `Working-Dir: ${opts.workspacePath}.`,
          '',
          ctx,
          '',
          'WICHTIG — Conversation-Voice (Sub-Plan F 2026-04-30):',
          '1. Beginne mit 1 Satz knappe Conversation als Intro (max 50 Worte).',
          '   Beispiel: "Reviewer hier. Ich check den Diff auf Security, Types und Edge-Cases."',
          '2. DANN folgen Findings + Verdict.',
          '',
          'Aufgabe: review den letzten Commit (von senior-dev gemacht).',
          '',
          'Schritte:',
          '1. Bash: git log -1 --format="%H %s" — bestaetige [skip-mirror]-Footer.',
          '   Wenn Footer fehlt: CHANGES_REQUESTED + Begruendung im Output.',
          '2. Bash: git diff HEAD~1 HEAD — den echten Diff lesen.',
          '3. Read der geaenderten Files fuer Kontext (git diff --name-only HEAD~1 HEAD).',
          '4. Pruefe: Security (Input-Validation, Auth, Secret-Leaks), Types',
          '   (kein any), Edge Cases (Loading/Error/Empty/Auth), Performance',
          '   (N+1, blocking IO), UX-States.',
          '',
          'Output: APPROVED oder CHANGES_REQUESTED + 3-5 Findings im Format',
          '   "<File>:<Line> · <Severity high|med|low>: <Beschreibung>".',
          'P15 PFLICHT: Jeder Finding endet mit Konsequenz-Zeile',
          '"Wenn fix: dies ermöglicht <X>" (Trust-Zone, Compliance-Gain, etc).',
          'KEIN Code-Schreiben. Kein Commit. Nur Review.',
        ].join('\n');

  const reviewerTools: ReadonlyArray<string> | undefined =
    mode === 'plan' ? undefined : ['Read', 'Bash', 'Grep', 'Glob'];

  const criticPrompt =
    mode === 'plan'
      ? [
          'Du bist critic (Advocatus Diaboli, Phase AD Auto-Dispatch — plan-mode).',
          'Du hinterfragst die Sub-Ticket-Loesung aus 5 Perspektiven.',
          '',
          ctx,
          '',
          'Perspektiven (je 1-2 Saetze):',
          '1. User: was nervt? was ist unklar?',
          '2. Hacker: wie breche ich das? welche Inputs killen es?',
          '3. Konkurrent: was machen andere besser?',
          '4. Anwalt: DSGVO/Compliance/Haftung?',
          '5. Performance: Bottlenecks unter Last?',
          '',
          'Schluss: Verdict GO / GO-MIT-AUFLAGEN / BLOCK + Begruendung.',
          'Output max 500 Worter Markdown.',
        ].join('\n')
      : [
          'Du bist critic (Advocatus Diaboli, Phase AD Auto-Dispatch — build-mode).',
          'Du hast Tool-Use: Read, Bash, Grep, Glob (READ-ONLY).',
          `Working-Dir: ${opts.workspacePath}.`,
          '',
          ctx,
          '',
          'WICHTIG — Conversation-Voice (Sub-Plan F 2026-04-30):',
          '1. Beginne mit 1 Satz knappe Conversation als Intro (max 50 Worte).',
          '   Beispiel: "Critic-Pass. Ich gehe 5 Perspektiven durch — User, Hacker, Konkurrent, Anwalt, Performance."',
          '2. DANN folgen die Perspektiven + Verdict.',
          '',
          'Aufgabe: critique des echten Diffs aus 5 Perspektiven.',
          '',
          'Schritte:',
          '1. Bash: git log -1 --format="%H %s" — bestaetige [skip-mirror]-Footer.',
          '2. Bash: git diff HEAD~1 HEAD — den Diff lesen.',
          '3. Read der geaenderten Files bei Bedarf.',
          '4. Hinterfrag aus 5 Perspektiven (je 1-2 Saetze):',
          '   1) User: was nervt? was ist unklar?',
          '   2) Hacker: wie breche ich das? welche Inputs killen es?',
          '   3) Konkurrent: was machen andere besser?',
          '   4) Anwalt: DSGVO/Compliance/Haftung?',
          '   5) Performance: Bottlenecks unter Last?',
          '',
          'Schluss: Verdict GO / GO-MIT-AUFLAGEN / BLOCK + Begruendung.',
          'KEIN Code-Schreiben. Nur Critique.',
        ].join('\n');

  const criticTools: ReadonlyArray<string> | undefined =
    mode === 'plan' ? undefined : ['Read', 'Bash', 'Grep', 'Glob'];

  const allStages: Stage[] = [
    {
      role: 'senior-dev',
      actor: 'agent:senior-dev' as ActorType,
      systemPrompt: seniorPrompt,
      timeoutMs: 5 * 60_000,
      allowedTools: seniorTools,
    },
    {
      role: 'code-reviewer',
      actor: 'agent:code-reviewer' as ActorType,
      systemPrompt: reviewerPrompt,
      timeoutMs: 4 * 60_000,
      allowedTools: reviewerTools,
    },
    {
      role: 'critic',
      actor: 'agent:critic' as ActorType,
      systemPrompt: criticPrompt,
      timeoutMs: 3 * 60_000,
      allowedTools: criticTools,
    },
  ];
  // Filter only the active stages (config-driven, Sub-Plan A).
  // The order stays stable: senior-dev → code-reviewer → critic, because
  // each stage needs the output of the previous one as input.
  const activeSet = new Set(activeStages);
  return allStages.filter((s) => activeSet.has(s.role));
}

/**
 * Set workflowState=executing on the sub-ticket via an emit event.
 * `transition: 'auto_dispatch'` marks the event as fired by the Phase-AD
 * auto logic (echo protection in maybeAutoDispatch).
 */
async function markExecuting(opts: SpawnSubPipelineOpts): Promise<void> {
  await emitEvent({
    segmentId: opts.workspaceId,
    entityType: 'ticket',
    entityId: opts.subTicketId,
    eventType: 'updated',
    actor: 'system',
    payload: {
      workflowState: 'executing',
      transition: 'auto_dispatch',
      parentMaster: opts.masterTicketId,
      ...(opts.workstreamId ? { workstreamId: opts.workstreamId } : {}),
    },
    sensitivity: 'low',
  }).catch(() => undefined);
}

async function emitStageComment(
  opts: SpawnSubPipelineOpts,
  stage: Stage,
  text: string,
  costCents: number,
  durationMs: number,
  stageIdx: number,
): Promise<void> {
  await emitEvent({
    segmentId: opts.workspaceId,
    entityType: 'ticket',
    entityId: opts.subTicketId,
    eventType: 'commented',
    actor: stage.actor,
    payload: {
      kind: 'auto-dispatch-stage',
      stage: stage.role,
      text,
      costCents,
      durationMs,
      parentMaster: opts.masterTicketId,
      ...(opts.workstreamId ? { workstreamId: opts.workstreamId } : {}),
    },
    sensitivity: 'low',
  }).catch(() => undefined);

  // Wave 7 (2026-05-01): persistent LoopPhaseCard per stage index.
  // 1 card per (workspaceId, workstreamId, surfaceKind=loop-phase, subKey='stage:N').
  // Repeated stage-tick events update the card in-place (no stream spam,
  // no multiple rendering). Only when workstreamId is set — otherwise no
  // meaningful coord.
  if (opts.workstreamId) {
    const stageObj: Record<string, unknown> = {
      kind: 'auto-dispatch-stage',
      workstreamId: opts.workstreamId,
      workspaceId: opts.workspaceId,
      stage: stage.role,
      stageIdx,
      actor: stage.actor,
      text,
    };
    const surfaceTag = `<surface:loop-phase>${JSON.stringify(stageObj)}</surface:loop-phase>`;
    await emitOrUpdateCard({
      coords: {
        workspaceId: opts.workspaceId,
        workstreamId: opts.workstreamId,
        surfaceKind: 'loop-phase',
        subKey: autoDispatchStageSubKey(stageIdx),
      },
      content: surfaceTag,
      actor: 'system',
    }).catch(() => undefined);
  }
}

/**
 * Retry schedule for rate-limited stages (Phase 2026-04-26).
 * Backoff in the MAX-plan window: after 30s, 90s, 180s. 3 attempts total.
 * Only after that `auto_dispatch_failed` with `error: 'rate-limited (3 retries exhausted)'`.
 *
 * Justification: the MAX-plan quota renews on a rolling basis — when 6 parallel
 * pipelines × 3 stages drain the bucket, the system has breathing room again after a few
 * minutes. A one-shot fail on a rate limit is wasteful.
 */
const RATE_LIMIT_RETRY_WAIT_MS: ReadonlyArray<number> = [30_000, 90_000, 180_000];

async function emitStageRetryComment(
  opts: SpawnSubPipelineOpts,
  stage: Stage,
  attempt: number,
  reason: string,
  waitMs: number,
  stageIdx: number,
): Promise<void> {
  await emitEvent({
    segmentId: opts.workspaceId,
    entityType: 'ticket',
    entityId: opts.subTicketId,
    eventType: 'commented',
    actor: stage.actor,
    payload: {
      kind: 'auto-dispatch-stage-retry',
      stage: stage.role,
      attempt,
      maxAttempts: RATE_LIMIT_RETRY_WAIT_MS.length + 1,
      reason,
      waitMs,
      parentMaster: opts.masterTicketId,
      ...(opts.workstreamId ? { workstreamId: opts.workstreamId } : {}),
    },
    sensitivity: 'low',
  }).catch(() => undefined);

  // Wave 7 (2026-05-01): persistent retry card per (stage, attempt). Each
  // retry attempt has its own card with status & wait countdown. On
  // re-emit within the same (stage, attempt) it is updated in-place.
  if (opts.workstreamId) {
    const retryObj: Record<string, unknown> = {
      kind: 'auto-dispatch-stage-retry',
      workstreamId: opts.workstreamId,
      workspaceId: opts.workspaceId,
      stage: stage.role,
      stageIdx,
      attempt,
      maxAttempts: RATE_LIMIT_RETRY_WAIT_MS.length + 1,
      reason,
      waitMs,
    };
    const surfaceTag = `<surface:loop-phase>${JSON.stringify(retryObj)}</surface:loop-phase>`;
    await emitOrUpdateCard({
      coords: {
        workspaceId: opts.workspaceId,
        workstreamId: opts.workstreamId,
        surfaceKind: 'loop-phase',
        subKey: autoDispatchStageRetrySubKey(stageIdx, attempt),
      },
      content: surfaceTag,
      actor: 'system',
    }).catch(() => undefined);
  }
}

async function emitFailure(
  opts: SpawnSubPipelineOpts,
  stage: Stage['role'],
  reason: string,
): Promise<void> {
  await emitEvent({
    segmentId: opts.workspaceId,
    entityType: 'ticket',
    entityId: opts.subTicketId,
    eventType: 'updated',
    actor: 'system',
    payload: {
      workflowState: 'rejected',
      transition: 'auto_dispatch_failed',
      parentMaster: opts.masterTicketId,
      failedStage: stage,
      error: reason,
      ...(opts.workstreamId ? { workstreamId: opts.workstreamId } : {}),
    },
    sensitivity: 'low',
  }).catch(() => undefined);
}

/**
 * Sub-Plan B (2026-04-30): counts git commits in workspacePath since
 * `sinceMs`. Returns 0 if the directory is not a git repo or an
 * unexpected error occurs (defensive — we never want the check
 * to become a pipeline failure).
 *
 * `git log --since=@<unix-seconds>` is the portable form.
 */
function countCommitsSince(workspacePath: string, sinceMs: number): number {
  try {
    // Lazy import — the spawner also runs in edge builds etc., we
    // do not want `node:child_process` at the top level.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cp = require('node:child_process') as typeof import('node:child_process');
    const since = Math.max(0, Math.floor(sinceMs / 1000));
    const out = cp.execSync(`git log --since=@${since} --format=%H`, {
      cwd: workspacePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function emitNoCodeWritten(opts: SpawnSubPipelineOpts): Promise<void> {
  await emitEvent({
    segmentId: opts.workspaceId,
    entityType: 'ticket',
    entityId: opts.subTicketId,
    eventType: 'updated',
    actor: 'system',
    payload: {
      transition: 'no_code_written',
      failedReason: 'sub-ticket produced no commits',
      subTicketId: opts.subTicketId,
      parentMaster: opts.masterTicketId,
      ...(opts.workstreamId ? { workstreamId: opts.workstreamId } : {}),
    },
    sensitivity: 'low',
  }).catch(() => undefined);
  // Plus a comment for chat visibility.
  await emitEvent({
    segmentId: opts.workspaceId,
    entityType: 'ticket',
    entityId: opts.subTicketId,
    eventType: 'commented',
    actor: 'system',
    payload: {
      kind: 'auto-dispatch-no-code',
      subTicketId: opts.subTicketId,
      parentMaster: opts.masterTicketId,
      text:
        'Sub-Ticket-Pipeline hat keine Commits produziert. Senior-Dev hat keinen Code geschrieben — Master bleibt offen, Sub-Ticket nicht autoclose.',
    },
    sensitivity: 'low',
  }).catch(() => undefined);
}

async function emitClosed(opts: SpawnSubPipelineOpts): Promise<void> {
  await emitEvent({
    segmentId: opts.workspaceId,
    entityType: 'ticket',
    entityId: opts.subTicketId,
    eventType: 'updated',
    actor: 'system',
    payload: {
      workflowState: 'closed',
      transition: 'pipeline_complete',
      parentMaster: opts.masterTicketId,
      ...(opts.workstreamId ? { workstreamId: opts.workstreamId } : {}),
    },
    sensitivity: 'low',
  }).catch(() => undefined);
}

/**
 * Run the pipeline sequentially. Returns a result with
 * stage statistics. If a stage fails, we abort and
 * mark the sub-ticket as rejected.
 */
export async function spawnSubTicketPipeline(
  opts: SpawnSubPipelineOpts,
): Promise<SpawnSubPipelineResult> {
  // Pipeline start timestamp for the acceptance check (Sub-Plan B).
  const pipelineStartedAt = Date.now();
  await markExecuting(opts);

  const activeStagesRaw = loadStagesForWorkstream(opts.workstreamId);
  // Defensive default: if the config is empty (can happen via malformed JSON),
  // fall back to ['senior-dev'] — at least 1 stage must run.
  const activeStages: ReadonlyArray<AutoDispatchStage> =
    activeStagesRaw.length > 0 ? activeStagesRaw : ['senior-dev'];
  const stages = buildStages(opts, activeStages);
  const accumulated: Array<{ role: Stage['role']; text: string }> = [];
  let costTotal = 0;
  let succeeded = 0;

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];

    // Extend the system prompt with the previous stage outputs, so
    // code-reviewer sees the senior-dev output and critic sees both.
    const priorOutputs =
      accumulated.length === 0
        ? ''
        : '\n\n## Vorherige Stages:\n' +
          accumulated
            .map((a) => `### ${a.role}\n${a.text}`)
            .join('\n\n---\n\n');

    const userPrompt = [
      `Sub-Ticket: ${opts.subTicketId}`,
      `Master: ${opts.masterTicketId}`,
      `Titel: ${opts.subTicketTitle}`,
      '',
      'Body:',
      opts.subTicketBody,
      priorOutputs,
    ].join('\n');

    // tmux session name = `lazyos-spawn-<workstreamId>-<tier>-<agentIdx>`.
    // If 6 sub-tickets share the same workstreamId AND are at the same stage,
    // their session names collide. So we append the
    // subTicketId to guarantee uniqueness per sub.
    const uniqueWorkstream = `${opts.workstreamId ?? 'auto'}-${opts.subTicketId}`;

    // P0-3 fix (2026-04-29): create the sub-workstream ONCE per stage, NOT
    // per retry. Previously up to 4 sub-WS rows arose per stage (1 + up
    // to 3 retries) → DB bloat + top-consumer double-counting. Now
    // each stage creates MAX 1 sub-WS row; retries write token updates additively
    // to the same row via updateTokenUsage().
    let stageSubId: string | undefined;
    if (opts.workstreamId) {
      try {
        const sub = await createSubWorkstream({
          parentId: opts.workstreamId,
          role: STAGE_TO_SUB_ROLE[stage.role],
          model: MODEL_NAMES.opus,
          description: `Auto-Dispatch ${stage.role} · ${opts.subTicketId}`,
        });
        stageSubId = sub.id;
      } catch {
        /* non-fatal */
      }
    }

    // Retry loop: on a rate-limited failure, retry up to 3× with
    // 30s/90s/180s backoff. Other failures (timeout, exit_code) abort
    // immediately — they have other causes.
    let result: Awaited<ReturnType<typeof spawnInTmux>> | null = null;
    let attempt = 0; // 0 = first attempt
    // Unique agentIdx per stage; on retry we increment to
    // avoid a tmux session name collision (the old session might
    // not be cleaned up yet).
    const baseAgentIdx = 1000 + i;
    while (true) {
      const fakeRateLimit =
        attempt === 0 &&
        process.env.LAZYOS_FAKE_RATE_LIMIT === '1';

      result = await spawnInTmux({
        workspaceId: opts.workspaceId,
        workspacePath: opts.workspacePath,
        workstreamId: uniqueWorkstream,
        subWorkstreamId: stageSubId,
        tier: 'opus',
        agentIdx: baseAgentIdx + attempt * 100,
        model: MODEL_NAMES.opus,
        systemPrompt: stage.systemPrompt,
        userPrompt,
        timeoutMs: stage.timeoutMs,
        // Sub-Plan B: pass tool use through (build mode) or omit it
        // (plan mode legacy = pure markdown).
        allowedTools: stage.allowedTools,
      });
      costTotal += result.costCents;

      // Synthetic rate limit for tests — an env flag triggers an artificial
      // first failure so the retry path is locally verifiable.
      const isRateLimited = fakeRateLimit || result.rateLimited;

      const stageFailed =
        result.timedOut ||
        isRateLimited ||
        result.exitCode !== 0 ||
        !result.text ||
        result.text.trim().length === 0;

      if (!stageFailed) break;

      // Only retry on a rate limit. On timeout/exit-code -> fail immediately.
      const canRetry =
        isRateLimited && attempt < RATE_LIMIT_RETRY_WAIT_MS.length;
      if (!canRetry) {
        const reason = result.timedOut
          ? 'timeout'
          : isRateLimited
            ? `rate-limited (${attempt + 1} attempts exhausted)`
            : `exit_code_${result.exitCode}`;
        await emitStageComment(
          opts,
          stage,
          `(Stage ${stage.role} fehlgeschlagen: ${reason})`,
          result.costCents,
          result.durationMs,
          i,
        );
        await emitFailure(opts, stage.role, reason);
        return {
          ok: false,
          stagesRun: i + 1,
          stagesSucceeded: succeeded,
          costCentsTotal: costTotal,
          failedStage: stage.role,
          failedReason: reason,
        };
      }

      const waitMs = RATE_LIMIT_RETRY_WAIT_MS[attempt];
      attempt += 1;
      await emitStageRetryComment(
        opts,
        stage,
        attempt,
        'rate-limited',
        waitMs,
        i,
      );
      await sleep(waitMs);
      // Loop continues -> spawnInTmux with a new agentIdx.
    }

    // result is guaranteed non-null here and the stage responded
    // successfully (text is non-empty, exit=0).
    await emitStageComment(opts, stage, result.text, result.costCents, result.durationMs, i);
    accumulated.push({ role: stage.role, text: result.text });
    succeeded += 1;

    // A 250ms breather between stages so the rate-limit backoff has room.
    if (i < stages.length - 1) await sleep(250);
  }

  // Sub-Plan B (2026-04-30): acceptance check.
  // In build mode we expect senior-dev to have made at least one commit.
  // If not: emit a `no_code_written` event and NO auto-close.
  // In plan mode (legacy) the check is skipped.
  if (getBuildMode() === 'build') {
    const commitsCount = countCommitsSince(opts.workspacePath, pipelineStartedAt);
    if (commitsCount === 0) {
      await emitNoCodeWritten(opts);
      // The sub-ticket STAYS executing → the user sees an open item.
      // The master will NOT auto-close because the sub is not closed.
      return {
        ok: false,
        stagesRun: stages.length,
        stagesSucceeded: succeeded,
        costCentsTotal: costTotal,
        failedStage: 'senior-dev',
        failedReason: 'no_code_written',
      };
    }
  }

  await emitClosed(opts);
  return {
    ok: true,
    stagesRun: stages.length,
    stagesSucceeded: succeeded,
    costCentsTotal: costTotal,
  };
}
