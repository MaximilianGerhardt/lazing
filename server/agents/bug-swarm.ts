/**
 * server/agents/bug-swarm.ts
 * --------------------------
 * Sprint H · 2026-04-30 — Bug-Fix-Swarm Runner.
 *
 * User complaint 2026-04-30 (verbatim):
 *   "Bug goes in, it rambles instead of fixing it itself... Here too I would
 *   have wished for a swarming analysis — 2-3 models, and if they find nothing
 *   or have consensus, continue. But also best in parallel."
 *
 * Architecture:
 *   Phase 1 — diagnosis (parallel)
 *     • 3 spawnInTmux calls via Promise.all
 *     • Roles: senior-dev + code-reviewer + critic
 *     • Tool whitelist: Read/Bash/Grep/Glob (READ-ONLY — no Write/Edit!)
 *     • Output: structured diagnosis (Hypothesis, File:Line, Reproducer,
 *       Confidence) — extracted from the raw response via parseDiagnosis().
 *
 *   Phase 2 — consensus detection
 *     • Consensus = ≥2 of 3 diagnoses name the SAME File:Line.
 *     • On consensus → phase 3 starts automatically.
 *     • On disagreement → surface card with phase='disagreement' + 3 hypotheses
 *       as QuickChoice. The run pauses until the user chooses (POST /resolve).
 *
 *   Phase 3 — fix (sequential after consensus)
 *     • spawnInTmux with senior-dev + build mode (Read/Write/Edit/Bash/Grep)
 *     • Prompt: implement the fix for the consensus hypothesis.
 *     • Commit footer required: `[skip-mirror]` (echo-loop protection).
 *
 *   Phase 4 — root cause (sequential after fix)
 *     • spawnInTmux with senior-dev + read-only.
 *     • Prompt: "How did this bug come about at all? Which pattern?"
 *     • Output: { what, whatBroke, prevention }.
 *
 * State persistence:
 *   We use the workstream row as the holder. `iterate_config_json` is
 *   already free-form JSON; we pack the bug-swarm state (`bug_swarm`)
 *   there as a sub-key. Status polling via `/api/bugs/swarm/[id]` reads
 *   this sub-key and projects it into the UI shape.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { MODEL_NAMES } from '../../lib/agents/pricing';
import type { ActorType } from '../../lib/events/types';
import { emitOrUpdateCard } from '../../lib/events/emit-or-update-card';
import { emitEvent } from '../../lib/events/emit';
import { getDb } from '../../db/client';
import { spawnInTmux, type SpawnResult } from './tmux-spawn';

export type BugSwarmRole = 'senior-dev' | 'code-reviewer' | 'critic';
export type BugSwarmPhase =
  | 'diagnose'
  | 'consensus'
  | 'disagreement'
  | 'fix'
  | 'rootcause'
  | 'done'
  | 'failed';
export type BugSwarmStatus = 'pending' | 'running' | 'done' | 'failed';

export interface BugDiagnosis {
  role: BugSwarmRole;
  status: BugSwarmStatus;
  hypothesis?: string;
  file?: string;
  line?: number;
  reproducer?: string;
  confidence?: number;
  raw?: string;
}

export interface BugRootCause {
  what?: string;
  whatBroke?: string;
  prevention?: string;
}

export interface BugSwarmState {
  swarmId: string;
  workspaceId: string;
  workstreamId: string;
  masterTicketId: string;
  bugDescription: string;
  phase: BugSwarmPhase;
  diagnoses: BugDiagnosis[];
  consensusFile?: string;
  consensusLine?: number;
  hypothesesForChoice?: Array<{ id: string; label: string; sublabel?: string }>;
  fixCommitSha?: string;
  fixSummary?: string;
  fixStatus?: BugSwarmStatus;
  rootCause?: BugRootCause;
  startedAt: number;
  finishedAt?: number;
}

export interface RunBugSwarmOpts {
  swarmId: string;
  workspaceId: string;
  workspacePath: string;
  workstreamId: string;
  masterTicketId: string;
  bugDescription: string;
  errorContext?: { stack?: string; file?: string; line?: number };
}

const DIAGNOSE_TIMEOUT_MS = 4 * 60_000;
const FIX_TIMEOUT_MS = 6 * 60_000;
const ROOT_CAUSE_TIMEOUT_MS = 3 * 60_000;

const DIAG_TOOLS = ['Read', 'Bash', 'Grep', 'Glob'] as const;
const FIX_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] as const;

// ---------------------------------------------------------------------------
// State persistence — we use workstream.iterate_config_json as the holder.
// The schema is already free-form JSON today (see tier-presets.resolveIterate-
// Config); we pack our bug-swarm state under the `bug_swarm` sub-key.
// ---------------------------------------------------------------------------

function readState(workstreamId: string): BugSwarmState | null {
  try {
    const db = getDb();
    const row = db.$raw
      .prepare('SELECT iterate_config_json FROM workstreams WHERE id = ?')
      .get(workstreamId) as { iterate_config_json: string | null } | undefined;
    if (!row?.iterate_config_json) return null;
    const parsed = JSON.parse(row.iterate_config_json) as Record<string, unknown>;
    const sw = parsed.bug_swarm;
    if (sw && typeof sw === 'object') return sw as BugSwarmState;
    return null;
  } catch {
    return null;
  }
}

function writeState(workstreamId: string, next: BugSwarmState): void {
  try {
    const db = getDb();
    const row = db.$raw
      .prepare('SELECT iterate_config_json FROM workstreams WHERE id = ?')
      .get(workstreamId) as { iterate_config_json: string | null } | undefined;
    let merged: Record<string, unknown> = {};
    if (row?.iterate_config_json) {
      try {
        merged = JSON.parse(row.iterate_config_json) as Record<string, unknown>;
      } catch {
        merged = {};
      }
    }
    merged.bug_swarm = next;
    db.$raw
      .prepare('UPDATE workstreams SET iterate_config_json = ? WHERE id = ?')
      .run(JSON.stringify(merged), workstreamId);
  } catch (err) {
    // Non-fatal — the run continues, the UI just gets no more
    // progress. We log so this does not silently swallow.
    // eslint-disable-next-line no-console
    console.error('[bug-swarm] writeState failed:', err);
  }
}

export function getBugSwarmState(workstreamId: string): BugSwarmState | null {
  return readState(workstreamId);
}

// ---------------------------------------------------------------------------
// Diagnosis parsing
// ---------------------------------------------------------------------------

const FILE_LINE_RE =
  /(?:^|[\s`(])([./\w-]+(?:\/[./\w-]+)+\.(?:tsx?|jsx?|py|rs|go|java|kt|md|css|html))(?::(\d+))?(?:[):\s])?/m;

function parseDiagnosis(role: BugSwarmRole, raw: string): BugDiagnosis {
  const text = String(raw ?? '').trim();
  if (text.length === 0) {
    return { role, status: 'failed', raw: '' };
  }

  // Hypothesis: first line after "Hypothese:" or "Hypothesis:", or as a fallback the first sentences.
  const hypMatch = text.match(/(?:Hypothes(?:e|is))\s*:\s*([^\n]+)/i);
  const hypothesis =
    (hypMatch?.[1] ?? text.split('\n')[0] ?? '').trim().slice(0, 400) || undefined;

  // File:Line — primarily marked via "Datei:" or "File:", otherwise a regex scan.
  const fileTagged = text.match(/(?:Datei|File)\s*:\s*([./\w-]+\.\w+)(?::(\d+))?/i);
  let file: string | undefined;
  let line: number | undefined;
  if (fileTagged) {
    file = fileTagged[1];
    line = fileTagged[2] ? Number(fileTagged[2]) : undefined;
  } else {
    const generic = text.match(FILE_LINE_RE);
    if (generic) {
      file = generic[1];
      line = generic[2] ? Number(generic[2]) : undefined;
    }
  }
  if (line !== undefined && (!Number.isFinite(line) || line < 1)) line = undefined;

  // Reproducer
  const reproMatch = text.match(/(?:Reproducer|Reproduktion|Repro)\s*:\s*([^\n][^\n]*(?:\n {2,}.+)*)/i);
  const reproducer = reproMatch?.[1]?.trim().slice(0, 400) || undefined;

  // Confidence
  const confMatch = text.match(/(?:Confidence|Vertrauen)\s*:\s*(\d{1,3})\s*%/i);
  let confidence: number | undefined;
  if (confMatch) {
    const n = Number(confMatch[1]);
    if (Number.isFinite(n)) confidence = Math.max(0, Math.min(1, n / 100));
  }

  return {
    role,
    status: 'done',
    hypothesis,
    file,
    line,
    reproducer,
    confidence,
    raw: text.slice(0, 4000),
  };
}

// ---------------------------------------------------------------------------
// Consensus detection
// ---------------------------------------------------------------------------

interface ConsensusResult {
  hasConsensus: boolean;
  consensusFile?: string;
  consensusLine?: number;
  hypotheses: Array<{ id: string; label: string; sublabel?: string }>;
}

function detectConsensus(diagnoses: BugDiagnosis[]): ConsensusResult {
  const valid = diagnoses.filter((d) => d.status === 'done' && d.file);
  // Hypotheses list for QuickChoice (always top-3, fallback to hypothesis-only).
  const hypotheses = diagnoses
    .filter((d) => d.hypothesis)
    .map((d) => ({
      id: d.role,
      label: d.hypothesis ?? d.role,
      sublabel: d.file ? `${d.file}${d.line ? `:${d.line}` : ''}` : undefined,
    }));

  if (valid.length === 0) {
    return { hasConsensus: false, hypotheses };
  }

  // Group by file (and line if both present)
  const counts = new Map<string, { count: number; file: string; line?: number }>();
  for (const d of valid) {
    if (!d.file) continue;
    const key = `${d.file}${d.line ? `:${d.line}` : ''}`;
    const cur = counts.get(key);
    if (cur) {
      cur.count += 1;
    } else {
      counts.set(key, { count: 1, file: d.file, line: d.line });
    }
  }

  let topKey: string | null = null;
  let topCount = 0;
  let topEntry: { count: number; file: string; line?: number } | null = null;
  for (const [k, v] of counts.entries()) {
    if (v.count > topCount) {
      topCount = v.count;
      topKey = k;
      topEntry = v;
    }
  }

  if (topCount >= 2 && topEntry) {
    return {
      hasConsensus: true,
      consensusFile: topEntry.file,
      consensusLine: topEntry.line,
      hypotheses,
    };
  }
  void topKey;

  return { hasConsensus: false, hypotheses };
}

// ---------------------------------------------------------------------------
// Surface-Emit (lebende Card via emitOrUpdateCard)
// ---------------------------------------------------------------------------

function buildSurfaceContent(state: BugSwarmState): string {
  return (
    `<surface:bug-fix-swarm>` +
    JSON.stringify({
      swarmId: state.swarmId,
      workspaceId: state.workspaceId,
      workstreamId: state.workstreamId,
      masterTicketId: state.masterTicketId,
      bugDescription: state.bugDescription,
    }) +
    `</surface:bug-fix-swarm>`
  );
}

async function emitCard(state: BugSwarmState): Promise<void> {
  await emitOrUpdateCard({
    coords: {
      workspaceId: state.workspaceId,
      workstreamId: state.workstreamId,
      surfaceKind: 'bug-fix-swarm',
    },
    content: buildSurfaceContent(state),
    actor: 'system',
  }).catch(() => undefined);
}

async function emitTimelineComment(
  state: BugSwarmState,
  role: BugSwarmRole | 'system',
  text: string,
): Promise<void> {
  const actor: ActorType =
    role === 'system' ? 'system' : (`agent:${role}` as ActorType);
  await emitEvent({
    segmentId: state.workspaceId,
    entityType: 'ticket',
    entityId: state.masterTicketId,
    eventType: 'commented',
    actor,
    payload: {
      kind: 'bug-swarm',
      role,
      text,
      swarmId: state.swarmId,
      workstreamId: state.workstreamId,
    },
    sensitivity: 'low',
  }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Diagnose-Spawn (single role)
// ---------------------------------------------------------------------------

function buildDiagnosePrompt(opts: {
  role: BugSwarmRole;
  bugDescription: string;
  errorContext: RunBugSwarmOpts['errorContext'];
  workspacePath: string;
}): { systemPrompt: string; userPrompt: string } {
  const ctxLines = [
    `Workspace-Pfad: ${opts.workspacePath}`,
    '',
    'Bug-Beschreibung:',
    opts.bugDescription,
  ];
  if (opts.errorContext?.stack) {
    ctxLines.push('', 'Stack-Trace:', opts.errorContext.stack);
  }
  if (opts.errorContext?.file) {
    ctxLines.push('', `Hinweis-File: ${opts.errorContext.file}${
      opts.errorContext.line ? `:${opts.errorContext.line}` : ''
    }`);
  }
  const ctx = ctxLines.join('\n');

  const rolePerspective: Record<BugSwarmRole, string> = {
    'senior-dev':
      'Du bist senior-dev. Du suchst die Root-Cause aus Code-Architektur-Sicht. ' +
      'Wo entsteht die kausale Ursache? Welcher Code-Pfad wird falsch durchlaufen?',
    'code-reviewer':
      'Du bist code-reviewer. Du suchst die Root-Cause aus Type-System / ' +
      'Defensive-Programming-Sicht. Welche Validation fehlt? Welche Annahme bricht?',
    critic:
      'Du bist critic (Advocatus Diaboli). Du suchst NICHT-offensichtliche ' +
      'Ursachen: Race-Conditions, environment-Differenzen, Edge-Cases die andere ' +
      'übersehen. Hinterfrage die naheliegende Hypothese.',
  };

  const systemPrompt = [
    rolePerspective[opts.role],
    '',
    'Du hast Tool-Use: Read, Bash, Grep, Glob (READ-ONLY, KEIN Write/Edit).',
    `Working-Dir: ${opts.workspacePath}.`,
    '',
    ctx,
    '',
    'Deine Aufgabe — diagnostiziere unabhängig:',
    '1. Lies die relevanten Files (Read/Grep). Folge dem Stack-Trace.',
    '2. Identifiziere die ECHTE Root-Cause (nicht das Symptom).',
    '3. Liefere strukturierten Output IM EXAKTEN FORMAT:',
    '',
    '   Hypothese: <1 Satz, was ist die Ursache>',
    '   Datei: <pfad/zu/datei.ts>',
    '   Zeile: <zahl>  (Best-Guess. Lass weg wenn nicht eindeutig.)',
    '   Reproducer: <wie reproduziert man den Bug? Bash-Cmd oder Schritt-Liste>',
    '   Confidence: <0-100>%',
    '',
    'KEIN Code schreiben. Kein Commit. Nur Diagnose.',
    'Output max 800 Worte Markdown. Max 5 Minuten Wallclock.',
  ].join('\n');

  const userPrompt = [
    `Bug-Diagnose-Auftrag (Rolle: ${opts.role}).`,
    '',
    ctx,
    '',
    'Liefere strikt das oben definierte Format.',
  ].join('\n');

  return { systemPrompt, userPrompt };
}

async function spawnDiagnose(
  opts: RunBugSwarmOpts,
  role: BugSwarmRole,
  agentIdx: number,
): Promise<BugDiagnosis> {
  const { systemPrompt, userPrompt } = buildDiagnosePrompt({
    role,
    bugDescription: opts.bugDescription,
    errorContext: opts.errorContext,
    workspacePath: opts.workspacePath,
  });

  let result: SpawnResult;
  try {
    result = await spawnInTmux({
      workspaceId: opts.workspaceId,
      workspacePath: opts.workspacePath,
      workstreamId: `${opts.workstreamId}-diag-${role}`,
      tier: 'opus',
      agentIdx,
      model: MODEL_NAMES.opus,
      systemPrompt,
      userPrompt,
      timeoutMs: DIAGNOSE_TIMEOUT_MS,
      allowedTools: DIAG_TOOLS,
    });
  } catch (err) {
    return {
      role,
      status: 'failed',
      raw: `(spawn failed: ${err instanceof Error ? err.message : String(err)})`,
    };
  }

  if (result.timedOut || result.exitCode !== 0 || !result.text || result.text.trim().length === 0) {
    return {
      role,
      status: 'failed',
      raw: result.text || `(timed_out=${result.timedOut} exit=${result.exitCode})`,
    };
  }

  return parseDiagnosis(role, result.text);
}

// ---------------------------------------------------------------------------
// Fix spawn (single, sequential after consensus)
// ---------------------------------------------------------------------------

interface FixResult {
  status: BugSwarmStatus;
  commitSha?: string;
  summary?: string;
  raw?: string;
}

async function spawnFix(
  opts: RunBugSwarmOpts,
  consensusDiag: BugDiagnosis,
): Promise<FixResult> {
  const target = consensusDiag.file
    ? `${consensusDiag.file}${consensusDiag.line ? `:${consensusDiag.line}` : ''}`
    : '(Konsens-File nicht eindeutig)';

  const systemPrompt = [
    'Du bist senior-dev (Bug-Fix-Swarm — Phase 3 Fix).',
    'Du hast Tool-Use: Read, Write, Edit, Bash, Grep, Glob.',
    `Working-Dir: ${opts.workspacePath}.`,
    '',
    'Bug-Beschreibung:',
    opts.bugDescription,
    '',
    'Konsens-Diagnose:',
    `Hypothese: ${consensusDiag.hypothesis ?? '(unklar)'}`,
    `Ziel-Datei: ${target}`,
    consensusDiag.reproducer ? `Reproducer: ${consensusDiag.reproducer}` : '',
    '',
    'Aufgabe: implementiere den Fix als ECHTEN Code-Diff.',
    '',
    'PFLICHT-Schritte:',
    '1. Lies die Ziel-Datei (Read).',
    '2. Implementiere den Fix (Edit/Write). TypeScript strict, kein any.',
    '3. Wenn Tests existieren: teste (Bash: pnpm test ... oder npm test ...).',
    '4. Commit MIT [skip-mirror]-Footer, NICHT pushen:',
    '   git add -A && git commit -m "[skip-mirror] fix: <kurze msg>"',
    '5. Output: 3-5 Zeilen Zusammenfassung was du gefixt hast,',
    '   inklusive Commit-SHA (git rev-parse --short HEAD).',
    '',
    'VERBOTEN:',
    '- Markdown-Skizzen ohne tatsächliche File-Edits.',
    '- Commits ohne [skip-mirror]-Footer.',
    '- git push, git reset --hard, --force, --amend ohne explizites OK.',
    '- Schreibzugriff außerhalb des Working-Dir.',
  ].join('\n');

  const userPrompt = [
    'Fix den Bug basierend auf der Konsens-Diagnose.',
    'Nach Commit: gib den Commit-SHA explizit aus.',
  ].join('\n');

  let result: SpawnResult;
  try {
    result = await spawnInTmux({
      workspaceId: opts.workspaceId,
      workspacePath: opts.workspacePath,
      workstreamId: `${opts.workstreamId}-fix`,
      tier: 'opus',
      agentIdx: 9000,
      model: MODEL_NAMES.opus,
      systemPrompt,
      userPrompt,
      timeoutMs: FIX_TIMEOUT_MS,
      allowedTools: FIX_TOOLS,
    });
  } catch (err) {
    return {
      status: 'failed',
      raw: `(spawn failed: ${err instanceof Error ? err.message : String(err)})`,
    };
  }

  if (result.timedOut || result.exitCode !== 0 || !result.text) {
    return {
      status: 'failed',
      raw: result.text || `(timed_out=${result.timedOut} exit=${result.exitCode})`,
    };
  }

  // SHA extraction: 7-12 hex chars, possibly after "Commit:" or "SHA:"
  const shaMatch =
    result.text.match(/(?:Commit(?:-SHA)?|SHA)\s*:\s*([0-9a-f]{7,40})/i) ||
    result.text.match(/\b([0-9a-f]{7,12})\b/);
  const commitSha = shaMatch ? shaMatch[1] : undefined;

  // Summary: erste 3-5 Zeilen des Outputs.
  const summary = result.text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .slice(0, 5)
    .join('\n')
    .slice(0, 600);

  return {
    status: commitSha ? 'done' : 'failed',
    commitSha,
    summary,
    raw: result.text.slice(0, 4000),
  };
}

// ---------------------------------------------------------------------------
// Root-Cause-Spawn (Phase 4)
// ---------------------------------------------------------------------------

function parseRootCause(raw: string): BugRootCause {
  const text = String(raw ?? '');
  const what = text.match(/(?:Was war es|What happened)\s*:?\s*([^\n]+(?:\n {2,}.+)*)/i)?.[1];
  const whatBroke = text.match(
    /(?:Was hat es gebrochen|Why did it break|Was war kaputt)\s*:?\s*([^\n]+(?:\n {2,}.+)*)/i,
  )?.[1];
  const prevention = text.match(
    /(?:Wie verhindern wir|Prevention|Prevent next time)\s*:?\s*([^\n]+(?:\n {2,}.+)*)/i,
  )?.[1];
  return {
    what: what?.trim().slice(0, 800) || undefined,
    whatBroke: whatBroke?.trim().slice(0, 800) || undefined,
    prevention: prevention?.trim().slice(0, 800) || undefined,
  };
}

async function spawnRootCause(
  opts: RunBugSwarmOpts,
  consensusDiag: BugDiagnosis,
  fixResult: FixResult,
): Promise<BugRootCause> {
  const systemPrompt = [
    'Du bist senior-dev (Bug-Fix-Swarm — Phase 4 Root-Cause).',
    'Du hast Tool-Use: Read, Bash, Grep, Glob (READ-ONLY).',
    `Working-Dir: ${opts.workspacePath}.`,
    '',
    'Bug:',
    opts.bugDescription,
    '',
    `Diagnose: ${consensusDiag.hypothesis ?? ''}`,
    `Fix-Commit: ${fixResult.commitSha ?? '(kein Commit)'}`,
    fixResult.summary ? `Fix-Summary:\n${fixResult.summary}` : '',
    '',
    'Aufgabe: analysiere wie dieser Bug überhaupt entstanden ist.',
    'Lies (git log, git blame) das ursprüngliche Coding-Pattern. Was ' +
      'war die Annahme, die gebrochen wurde? Wie hätte man das vermeiden können?',
    '',
    'Liefere EXAKT in diesem Format:',
    '',
    '   Was war es: <1-2 Sätze>',
    '   Was hat es gebrochen: <1-2 Sätze, technische Ursache>',
    '   Wie verhindern wir das: <1-3 konkrete Maßnahmen, z.B. Type-Constraints, Tests, Lint-Rule>',
    '',
    'KEIN Code schreiben. Nur Analyse. Max 400 Worte.',
  ].join('\n');

  const userPrompt = 'Root-Cause-Analyse für den gerade gefixten Bug.';

  let result: SpawnResult;
  try {
    result = await spawnInTmux({
      workspaceId: opts.workspaceId,
      workspacePath: opts.workspacePath,
      workstreamId: `${opts.workstreamId}-rootcause`,
      tier: 'opus',
      agentIdx: 9100,
      model: MODEL_NAMES.opus,
      systemPrompt,
      userPrompt,
      timeoutMs: ROOT_CAUSE_TIMEOUT_MS,
      allowedTools: DIAG_TOOLS,
    });
  } catch {
    return {};
  }

  if (result.timedOut || result.exitCode !== 0 || !result.text) {
    return {};
  }

  return parseRootCause(result.text);
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runBugSwarm(opts: RunBugSwarmOpts): Promise<BugSwarmState> {
  const startedAt = Date.now();

  // Initial state.
  let state: BugSwarmState = {
    swarmId: opts.swarmId,
    workspaceId: opts.workspaceId,
    workstreamId: opts.workstreamId,
    masterTicketId: opts.masterTicketId,
    bugDescription: opts.bugDescription,
    phase: 'diagnose',
    diagnoses: (['senior-dev', 'code-reviewer', 'critic'] as BugSwarmRole[]).map(
      (role) => ({ role, status: 'running' }),
    ),
    startedAt,
  };
  writeState(opts.workstreamId, state);
  await emitCard(state);
  await emitTimelineComment(
    state,
    'system',
    `Bug-Swarm gestartet (${opts.swarmId}). 3 Diagnose-Spawns parallel.`,
  );

  // ---- Phase 1: Diagnose (parallel) ----
  const diagPromises: Array<Promise<BugDiagnosis>> = [
    spawnDiagnose(opts, 'senior-dev', 8000),
    spawnDiagnose(opts, 'code-reviewer', 8001),
    spawnDiagnose(opts, 'critic', 8002),
  ];

  const settled = await Promise.allSettled(diagPromises);
  const diagnoses: BugDiagnosis[] = settled.map((s, i) => {
    const role = (['senior-dev', 'code-reviewer', 'critic'] as BugSwarmRole[])[i];
    if (s.status === 'fulfilled') return s.value;
    return {
      role,
      status: 'failed',
      raw: `(spawn rejected: ${s.reason instanceof Error ? s.reason.message : String(s.reason)})`,
    };
  });

  state = { ...state, diagnoses };
  writeState(opts.workstreamId, state);
  await emitCard(state);
  for (const d of diagnoses) {
    await emitTimelineComment(
      state,
      d.role,
      d.status === 'done'
        ? `Diagnose: ${d.hypothesis ?? '(keine Hypothese)'} — ${
            d.file ?? '(keine Datei)'
          }${d.line ? `:${d.line}` : ''}${
            d.confidence !== undefined ? ` (${Math.round(d.confidence * 100)}%)` : ''
          }`
        : `Diagnose fehlgeschlagen: ${d.raw?.slice(0, 200) ?? ''}`,
    );
  }

  const allFailed = diagnoses.every((d) => d.status === 'failed');
  if (allFailed) {
    state = { ...state, phase: 'failed', finishedAt: Date.now() };
    writeState(opts.workstreamId, state);
    await emitCard(state);
    return state;
  }

  // ---- Phase 2: Konsens-Detection ----
  const consensus = detectConsensus(diagnoses);

  if (!consensus.hasConsensus) {
    state = {
      ...state,
      phase: 'disagreement',
      hypothesesForChoice: consensus.hypotheses,
    };
    writeState(opts.workstreamId, state);
    await emitCard(state);
    await emitTimelineComment(
      state,
      'system',
      'Keine Konsens-Diagnose. User-Eskalation.',
    );
    // Abort — the user chooses via the /resolve endpoint, which then
    // calls resumeWithChosenHypothesis.
    return state;
  }

  state = {
    ...state,
    phase: 'consensus',
    consensusFile: consensus.consensusFile,
    consensusLine: consensus.consensusLine,
    hypothesesForChoice: consensus.hypotheses,
  };
  writeState(opts.workstreamId, state);
  await emitCard(state);

  // 250ms Atempause zwischen Phasen (Rate-Limit-Schonung).
  await sleep(250);

  // ---- Phase 3: Fix ----
  state = { ...state, phase: 'fix', fixStatus: 'running' };
  writeState(opts.workstreamId, state);
  await emitCard(state);

  // Pick the diagnosis matching the consensus file (or the first done diagnosis).
  const consensusDiag =
    diagnoses.find(
      (d) =>
        d.status === 'done' &&
        d.file === consensus.consensusFile &&
        (consensus.consensusLine === undefined || d.line === consensus.consensusLine),
    ) ?? diagnoses.find((d) => d.status === 'done') ?? diagnoses[0];

  const fixResult = await spawnFix(opts, consensusDiag);
  state = {
    ...state,
    fixStatus: fixResult.status,
    fixCommitSha: fixResult.commitSha,
    fixSummary: fixResult.summary,
  };
  writeState(opts.workstreamId, state);
  await emitCard(state);
  await emitTimelineComment(
    state,
    'senior-dev',
    fixResult.status === 'done'
      ? `Fix committed: ${fixResult.commitSha ?? '(no SHA)'}\n${fixResult.summary ?? ''}`
      : `Fix fehlgeschlagen: ${fixResult.raw?.slice(0, 200) ?? ''}`,
  );

  if (fixResult.status !== 'done') {
    state = { ...state, phase: 'failed', finishedAt: Date.now() };
    writeState(opts.workstreamId, state);
    await emitCard(state);
    return state;
  }

  // ---- Phase 4: root cause ----
  state = { ...state, phase: 'rootcause' };
  writeState(opts.workstreamId, state);
  await emitCard(state);

  await sleep(250);
  const rootCause = await spawnRootCause(opts, consensusDiag, fixResult);
  state = {
    ...state,
    rootCause,
    phase: 'done',
    finishedAt: Date.now(),
  };
  writeState(opts.workstreamId, state);
  await emitCard(state);
  await emitTimelineComment(
    state,
    'senior-dev',
    `Root-Cause-Analyse:\nWas war es: ${rootCause.what ?? '?'}\nWas hat es gebrochen: ${
      rootCause.whatBroke ?? '?'
    }\nWie verhindern: ${rootCause.prevention ?? '?'}`,
  );

  return state;
}

// ---------------------------------------------------------------------------
// Resume path after the user's choice on disagreement
// ---------------------------------------------------------------------------

export async function resumeBugSwarmWithChoice(
  workstreamId: string,
  chosenHypothesisId: BugSwarmRole,
  workspacePath: string,
): Promise<BugSwarmState | null> {
  const state = readState(workstreamId);
  if (!state) return null;
  if (state.phase !== 'disagreement') return state;

  const chosenDiag = state.diagnoses.find(
    (d) => d.role === chosenHypothesisId && d.status === 'done',
  );
  if (!chosenDiag || !chosenDiag.file) {
    // No valid diagnosis — stay on disagreement, no progress.
    return state;
  }

  const opts: RunBugSwarmOpts = {
    swarmId: state.swarmId,
    workspaceId: state.workspaceId,
    workspacePath,
    workstreamId: state.workstreamId,
    masterTicketId: state.masterTicketId,
    bugDescription: state.bugDescription,
  };

  // Schritte 3 + 4 wie oben — Direktstart in fix-phase.
  let next: BugSwarmState = {
    ...state,
    phase: 'fix',
    fixStatus: 'running',
    consensusFile: chosenDiag.file,
    consensusLine: chosenDiag.line,
  };
  writeState(workstreamId, next);
  await emitCard(next);
  await emitTimelineComment(
    next,
    'system',
    `User-Wahl: ${chosenHypothesisId} → Fix startet.`,
  );

  const fixResult = await spawnFix(opts, chosenDiag);
  next = {
    ...next,
    fixStatus: fixResult.status,
    fixCommitSha: fixResult.commitSha,
    fixSummary: fixResult.summary,
  };
  writeState(workstreamId, next);
  await emitCard(next);
  await emitTimelineComment(
    next,
    'senior-dev',
    fixResult.status === 'done'
      ? `Fix committed: ${fixResult.commitSha ?? '(no SHA)'}`
      : `Fix fehlgeschlagen: ${fixResult.raw?.slice(0, 200) ?? ''}`,
  );

  if (fixResult.status !== 'done') {
    next = { ...next, phase: 'failed', finishedAt: Date.now() };
    writeState(workstreamId, next);
    await emitCard(next);
    return next;
  }

  next = { ...next, phase: 'rootcause' };
  writeState(workstreamId, next);
  await emitCard(next);

  await sleep(250);
  const rootCause = await spawnRootCause(opts, chosenDiag, fixResult);
  next = {
    ...next,
    rootCause,
    phase: 'done',
    finishedAt: Date.now(),
  };
  writeState(workstreamId, next);
  await emitCard(next);
  await emitTimelineComment(
    next,
    'senior-dev',
    `Root-Cause: ${rootCause.what ?? '?'} | Prevention: ${rootCause.prevention ?? '?'}`,
  );
  return next;
}
