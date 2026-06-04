/**
 * lib/workstreams/plan-executor.ts
 * ---------------------------------
 * Slice 3 · Phase 1 → EXEC (2026-05-26, laz.ing Swarm Runtime V1.1).
 *
 * ZWEI-MODI-EXECUTOR (konsent-gated, R1-isoliert, parallel):
 *
 *   A) Default / sicher (mode unset / 'ask'):
 *      Pro Step NUR `engine.chat({messages})` — reine, tool-lose Text-Completion.
 *      KEINE Dateien geschrieben, KEINE Shell ausgeführt. Das ist BIT-IDENTISCH
 *      zum Vor-EXEC-Verhalten. Echte Tool-Ausführung gibt es NUR, wenn der
 *      Workspace explizit auf FreeRein/Lane gesetzt wurde (User-Einwilligung).
 *
 *   B) Konsentiert (mode = 'freerein' / 'freerein-with-audit' / 'lane'):
 *      Wenn der aufgelöste Modus Tools gewährt (allowedTools nicht leer) UND
 *      die R2-Entscheidung allow ist, läuft der Step als ECHTER Tool-Spawn über
 *      `spawnInTmux` (--allowedTools <mode-tools> + --permission-mode acceptEdits,
 *      inkl. Bash bei FreeRein). Das passiert ZWINGEND in R1-Worktree-Isolation:
 *      createRunWorktree → Spawn im isolierten Worktree → discardRunWorktree im
 *      finally. Der Live-Checkout wird NIE berührt; Merge bleibt gated (R3).
 *      ENV `env -i`-gescrubbt + K1 `--disallowedTools` (hart) sind in tmux-spawn.
 *
 * PARALLELITÄT (Aufgabe B):
 *   Der frühere sequenzielle Loop ist durch einen Dependency-Graph +
 *   Ready-Queue ersetzt. Steps ohne offene `depends_on` starten parallel,
 *   gebunden durch den resource-pool (N11 heavyTotal=2). Bei Step-Done werden
 *   abhängige Steps ready. Cycle-safe (Cycle → sequenzieller Fallback + warn).
 *   Fehler-isoliert pro Step. Die Status-Card zeigt laufend/wartend/fertig.
 *
 * Sicherheits-Constraints (kritisch):
 *   - Default (unset/ask) = exakt heutiges sicheres Verhalten (text-only).
 *   - Bash/Writes IMMER in R1-Worktree-Isolation, Merge bleibt gated.
 *   - codex bleibt ausgeschlossen (Code-Mode-Agent, schreibt Files/Shell).
 *   - N8-Audit pro echtem Tool-Lauf: tamper-evidente `workstream_decisions`-Row
 *     (writeDecision, content_hash-gekettet, N10) VOR dem Spawn + stdout-Audit.
 *
 * RESIDUAL (by design — ehrlich abgegrenzt): FreeRein-Bash = System-Zugriff
 *   durch beliebige Shell. Das ist die explizite, vom User über den
 *   Permission-Modus gegebene Einwilligung. Die R1-Worktree-Isolation begrenzt
 *   NUR git-Operationen (Writes/Commits/Merge passieren im throwaway-Branch, nie
 *   im Live-Checkout; Merge ist zusätzlich gated). Sie begrenzt NICHT die
 *   Datei-Reichweite des Prozesses: ein FreeRein-Bash-Lauf läuft mit der
 *   Prozess-uid und kann per ABSOLUTEM Pfad lesen, was diese uid lesen darf —
 *   u.a. $HOME (in der env-Allowlist, damit MAX-Auth greift), die Live-DB unter
 *   dem well-known Pfad ($HOME/.lazyos/lazyos.db, vgl. db/client.ts), eine
 *   `.env.local` im Live-Repo-Root und andere Projekte im Home-Verzeichnis. `env -i`
 *   scrubbt nur ENV-Secrets, K1 sperrt MCP-RAG-Tools — beides verhindert KEINEN
 *   absoluten Datei-Read. Die ECHTE Mehrmandanten-Härtung wäre eine OS-Sandbox
 *   (sandbox-exec / read-only-bind nur des Worktrees + Deny des restlichen FS);
 *   die ist BEWUSST noch NICHT aktiv. FreeRein bleibt deshalb explizite,
 *   vertrauensvolle User-Einwilligung, kein Mehrmandanten-Sandbox-Versprechen.
 *
 * N1 (Detail): Step-Titles + Rationales VERBATIM aus der DB. N6: deterministisches
 *   R2-Gate + Graph-Walk vor jeder Ausführung. N8: Audit pro Step. N9: coordKey
 *   auf allen Card-Emits. N10: content_hash bleibt unangetastet (plan-repo).
 *   N11: Parallelität an die JEWEILS richtige Ressource gebunden (siehe unten).
 *
 * PARALLELITÄTS-BREITE (SLOT-DECOUPLING 2026-05-26):
 *   Die frühere `maxParallel = heavyTotal(=2)` war eine künstliche 2er-Kappung
 *   für ALLE Plan-Steps — sie vermischte die echte N11-Grenze ("max 2 schwere
 *   lokale Ollama-Jobs") mit "max parallele Plan-Steps / claude-cli-Spawns".
 *   Jetzt ist die Breite PLAN-ABGELEITET (= Anzahl unabhängiger ready-Steps),
 *   gebunden durch die JEWEILS richtige Ressource:
 *     - text-only/read-Steps  → textConcurrency (Cores-abgeleitet, ~6),
 *                               KEIN heavy-Ollama-Slot, KEIN Worktree.
 *     - claude-cli-Spawn-Steps → spawnConcurrency (== Worktree-Cap 5),
 *                               echte Isolations-Grenze.
 *     - heavy-Ollama-Nutzung INNERHALB eines Steps → zusätzlich der
 *                               ollama-heavy-Slot (heavyOllama=2), orthogonal.
 *   Cycle-Fallback bleibt Breite 1 (sequenziell). N11 bleibt eingehalten:
 *   Worktrees ≤ 5 (createRunWorktree-Cap unangetastet), schwere Ollama-Jobs ≤ 2
 *   (ollama-heavy-Slot). NUR die 2er-Kappung auf claude-cli/text-Steps fällt weg.
 */

import { listRootPlanSteps, setPlanStepStatus } from '@/lib/workstreams/plan-repo';
import { detectEngines, pickEngine } from '@/lib/llm/engines/selector';
import { protectEngine } from '@/lib/privacy/protect';
import { resourcePool } from '@/lib/agents/resource-pool';
import { MODEL_NAMES } from '@/lib/agents/pricing';
import { waitForBudget } from '@/lib/agents/tpm-budget';
import { emitOrUpdateCard } from '@/lib/events/emit-or-update-card';
import { emitChatMessageCompleted } from '@/lib/events/emit';
import { ulid } from '@/lib/ulid';
import { readPublicBaseOverride } from '@/lib/hosting/public-base';
import type { WorkstreamPlanStepRow } from '@/db/schema/workstream_plan_steps';
import { enforceExecutionStep, type PermissionModeForGate } from '@/lib/security/execution-policy';
import {
  resolveAllowedToolsForMode,
  readWorkspacePermissionMode,
} from '@/lib/security/permission-tools';
import { spawnInTmux } from '@/server/agents/tmux-spawn';
import {
  createOrReuseRunWorktree,
  createStepWorktree,
  mergeStepIntoRun,
  discardStepWorktree,
} from '@/lib/agents/worktree-manager';
import { writeDecision, writeEvidence } from '@/lib/workstreams/trace-repo';
import {
  renderDesignSystemPrompt,
  parseChosenAccent,
} from '@/lib/flow/design-system';
// LANE-2 (2026-05-30): Demo PV / PV-stringing producer wiring.
// The pv-stringing skill (compose.ts) -> 'coder' (compile.ts) is intercepted
// here BEFORE the generic coder spawn: instead of a claude-cli worktree spawn,
// the DETERMINISTIC producer runs (N6, no LLM/I/O) and writes its
// PvArtifact (surfacePayload.strings[]/inverters[]) as step output, which
// from-artifact.ts -> evaluate.ts (G5) consumes.
import {
  produceStringingPlan,
  buildExpertReviewGate,
  type StringingProducerInput,
} from '@/lib/eval/demo-pv/producer';
import {
  buildDemoStringingInput,
  isDemoPvIntent,
} from '@/lib/eval/demo-pv/demo-hardware';
import { parseFlowAnnotation } from '@/lib/flow/from-workstream';
import { execFile as _execFile } from 'node:child_process';
import { promisify as _promisify } from 'node:util';

const execFileAsync = _promisify(_execFile);

/**
 * 2026-05-29 (Opus 4.8) — Verlustfreie Persistenz VOR dem Worktree-discard
 * (Cross-Roast: kleinster sicherer Schritt gegen Arbeitsverlust). Erfasst den
 * vollständigen Delta des Step-Worktrees (committed + uncommitted) gegen den
 * Basis-SHA und gibt ein Stat + den verbatim-Diff zurück (N1: kein Kürzen).
 * Strikt fail-soft: wirft NIE — Capture-Fehler darf den finally/discard nie
 * stören. Liefert null, wenn nichts erfasst werden konnte.
 *
 * NOTE: Dies ist Schritt 1 des Akkumulations-Plans — es STOPPT den Verlust
 * (Arbeit landet als Patch im Trace, recoverbar), löst aber noch NICHT die
 * Komposition (Steps bauen weiter NICHT aufeinander auf). Schritt 2-4
 * (akkumulierender Run-Branch + serieller Merge + gated Operator-Merge) folgt.
 */
async function captureWorktreeDiff(
  worktreePath: string,
  baseSha: string | null,
): Promise<{ stat: string; diff: string } | null> {
  try {
    // Uncommitted Änderungen stagen, damit der Diff committed+uncommitted erfasst.
    await execFileAsync('git', ['-C', worktreePath, 'add', '-A']).catch(() => {});
    const base = baseSha && /^[0-9a-f]{7,40}$/.test(baseSha) ? baseSha : 'HEAD';
    const [statRes, diffRes] = await Promise.all([
      execFileAsync('git', ['-C', worktreePath, 'diff', '--stat', base], {
        maxBuffer: 8 * 1024 * 1024,
      }).catch(() => ({ stdout: '' })),
      execFileAsync('git', ['-C', worktreePath, 'diff', base], {
        maxBuffer: 32 * 1024 * 1024,
      }).catch(() => ({ stdout: '' })),
    ]);
    const stat = (statRes.stdout || '').trim();
    const diff = (diffRes.stdout || '').trim();
    if (stat.length === 0 && diff.length === 0) return null;
    return { stat, diff };
  } catch {
    return null; // niemals werfen
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Typen
// ────────────────────────────────────────────────────────────────────────────

export interface ExecutePlanArgs {
  workstreamId: string;
  workspaceId: string;
  planId: string;
  /** ManifestCoord-Key (N9), Format: "<workspaceId>/<workstreamId>". */
  coordKey: string;
}

/**
 * Harte Gesamt-Deadline für den Background-Run (Critic-Fix M2). Ohne Cap
 * könnte ein mehrstufiger Plan minutenlang Slots belegen, ohne Abbruch-Pfad
 * (die Route gibt sofort 202 zurück, es gibt keinen Request-Lifecycle mehr).
 * Nach der Deadline brechen acquireSlot/engine.chat ab → restliche Steps
 * fallen schnell auf 'failed'.
 */
const EXEC_TOTAL_DEADLINE_MS = 240_000;

/** Status-Werte, die die Status-Card anzeigt (laufend/wartend/fertig). */
type StepStatus = 'pending' | 'active' | 'done' | 'failed';

/**
 * W2.1 (2026-05-30): erkennt website-artige Intents (gleiche Keywords wie der
 * Assembly-Step-Append in compose.ts). Nur dann wird das verbindliche
 * Design-System + die Artefakt-Verkettung vorwärts gereicht — sonst bleibt der
 * Prompt bit-identisch zum Vor-W2.1-Verhalten (rückwärtskompatibel). N6.
 */
export function isWebsiteIntent(intent: string): boolean {
  return /\b(website|webseite|web-?site|landing|landingpage|landing-page|homepage|home-?page|page|site)\b/i.test(
    intent || '',
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Flow-Graph Struktur-Hash-Cache (Flow Studio Stream C · C1, 2026-05-27)
// ────────────────────────────────────────────────────────────────────────────
//
// BEFUND (Stream C): die <surface:flow-graph>-Emission feuerte bislang bei JEDEM
// updateCard-Aufruf — d.h. nur an Step-STATUS-Übergänge gekoppelt. Owner-SOLL:
// "immer auch visualisieren wenn sich was ändert/erweitert" — also AUCH bei
// STRUKTUR-Änderungen (neue Steps, geänderte depends_on/Edges, geänderte Tools).
//
// Lösung (additiv, N6 deterministisch): wir berechnen pro Emit einen STRUKTUR-
// Hash über die Knoten (id+label+skill+tool) + Kanten (from→to) — bewusst OHNE
// die laufenden Status (die sind separat als runStatus erfasst). Wir cachen pro
// (workspaceId, workstreamId) den zuletzt emittierten Struktur-Hash UND
// run-Status. Ein erneuter Emit ist nur nötig, wenn sich Struktur ODER runStatus
// geändert haben. So entsteht bei reiner Status-Wiederholung KEIN redundanter
// Emit, eine Struktur-Erweiterung löst aber ZWINGEND eine neue Visualisierung
// aus (auch wenn der runStatus gleich bleibt).
//
// Map statt Memory-Leak-Risiko: die Keys sind pro Run kurzlebig; ein Run räumt
// seinen Eintrag im Abschluss NICHT explizit (best-effort), aber die Map wächst
// nur um die Zahl gleichzeitig laufender Runs — vernachlässigbar (N11: max 5
// Worktrees, Plan-Runs sind seltener). Falls gewünscht kann der Executor den
// Eintrag am Ende löschen; wir halten es minimal-invasiv.
interface FlowGraphEmitState {
  structureHash: string;
  runStatus: string;
}
const flowGraphEmitCache = new Map<string, FlowGraphEmitState>();

/**
 * Testbar exportiert (Stream C · C1): leert den Struktur-Hash-Cache. Wird vom
 * C1-Test zwischen Cases gerufen, damit ein Case nicht den nächsten verklemmt.
 * Produktiv NICHT nötig (Keys sind run-scoped) — rein für deterministische Tests.
 */
export function __resetFlowGraphEmitCacheForTests(): void {
  flowGraphEmitCache.clear();
}

/** Deterministischer Struktur-Hash über Nodes (ohne Status) + Edges. N6. */
export function computeFlowStructureHash(
  nodes: ReadonlyArray<{ id: string; label: string; skill?: string; tool?: string }>,
  edges: ReadonlyArray<{ from: string; to: string }>,
): string {
  // Stabile, status-freie Serialisierung. Nodes nach id sortiert (reihenfolge-
  // unabhängig), Edges als sortierte from>to-Paare. Reiner String-Vergleich
  // genügt — wir brauchen keine kryptografische Stärke (kein Tamper-Schutz hier,
  // das ist content_hash auf den Plan-Step-Rows; N10 bleibt unberührt).
  const nodePart = [...nodes]
    .map((n) => `${n.id}${n.label}${n.skill ?? ''}${n.tool ?? ''}`)
    .sort()
    .join('');
  const edgePart = [...edges]
    .map((e) => `${e.from}>${e.to}`)
    .sort()
    .join('');
  return `${nodePart}|${edgePart}`;
}

/**
 * C1-Kern (testbar): entscheidet, ob die flow-graph-Surface (re-)emittiert
 * werden muss, und aktualisiert den Cache. True = emittieren. Side-effect auf
 * den Cache ist gewollt (last-emitted-State). Reine Status-Wiederholung →
 * false; Struktur-Änderung ODER runStatus-Wechsel → true.
 */
export function shouldEmitFlowGraph(
  cacheKey: string,
  structureHash: string,
  runStatus: string,
): boolean {
  const prev = flowGraphEmitCache.get(cacheKey);
  const changed =
    !prev || prev.structureHash !== structureHash || prev.runStatus !== runStatus;
  if (changed) {
    flowGraphEmitCache.set(cacheKey, { structureHash, runStatus });
  }
  return changed;
}

// ────────────────────────────────────────────────────────────────────────────
// Workspace-FS-Pfad-Auflösung (für R1-Worktree-Isolation)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Löst den FS-Pfad eines Workspaces auf (= repoPath für createRunWorktree).
 * Mirror der privaten Helfer in app/api/bugs/swarm/route.ts +
 * lib/tickets/auto-dispatch.ts (workspaces.path → Fallback projects/<id>).
 *
 * Lazy import, damit der text-only-Pfad (Default) keinen DB/Workspace-Service
 * berührt — er wird NUR aufgerufen, wenn echte Tool-Spawns laufen sollen.
 */
async function resolveWorkspacePath(workspaceId: string): Promise<string> {
  try {
    const { getWorkspace } = await import('@/lib/workspaces');
    const ws = await getWorkspace(workspaceId);
    if (ws?.path) return ws.path;
  } catch {
    /* ignore — Fallback unten */
  }
  const { defaultWorkspacePath } = await import('@/lib/workspaces/projects-root');
  return defaultWorkspacePath(workspaceId);
}

// ────────────────────────────────────────────────────────────────────────────
// Dependency-Graph-Helfer (Aufgabe B)
// ────────────────────────────────────────────────────────────────────────────

/** Parst das `depends_on`-JSON-Feld einer Step-Row defensiv zu Step-IDs. */
function parseDependsOn(row: WorkstreamPlanStepRow): string[] {
  const raw = (row as { dependsOn?: string | null }).dependsOn;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string' && x.length > 0);
    }
  } catch {
    /* malformed → behandeln wie keine Dependency (konservativ ready) */
  }
  return [];
}

/** Liest das `group_id`-Feld (Default: parentStepId, sonst null). */
function readGroupId(row: WorkstreamPlanStepRow): string | null {
  const g = (row as { groupId?: string | null }).groupId;
  if (typeof g === 'string' && g.length > 0) return g;
  return row.parentStepId ?? null;
}

/**
 * Cycle-Detektion über den depends_on-Graphen (Kahn-Topo-Walk).
 * Gibt true zurück, wenn ein Zyklus existiert ODER eine Dependency auf eine
 * unbekannte Step-ID zeigt, die die Ready-Queue verklemmen würde.
 *
 * Bei true → der Caller fällt auf sequenzielle Ausführung zurück (warn).
 * N6: rein deterministischer Graph-Walk, kein LLM.
 */
function hasCycleOrDanglingDep(
  steps: readonly WorkstreamPlanStepRow[],
  depsById: Map<string, string[]>,
): boolean {
  const ids = new Set(steps.map((s) => s.id));

  // Dangling: eine Dependency zeigt auf eine Step-ID, die nicht im Plan ist.
  // Das würde die Ready-Queue für immer blockieren → wie ein Cycle behandeln.
  for (const deps of depsById.values()) {
    for (const d of deps) {
      if (!ids.has(d)) return true;
    }
  }

  // Kahn: wiederholt Steps mit 0 verbleibenden offenen Deps entfernen.
  const remaining = new Map<string, Set<string>>();
  for (const s of steps) {
    remaining.set(s.id, new Set(depsById.get(s.id) ?? []));
  }
  let progressed = true;
  while (progressed && remaining.size > 0) {
    progressed = false;
    for (const [id, deps] of Array.from(remaining.entries())) {
      if (deps.size === 0) {
        remaining.delete(id);
        for (const set of remaining.values()) set.delete(id);
        progressed = true;
      }
    }
  }
  // Was übrig bleibt, sitzt in einem Zyklus.
  return remaining.size > 0;
}

// ────────────────────────────────────────────────────────────────────────────
// Card-Live-Update-Helper
// ────────────────────────────────────────────────────────────────────────────

/**
 * Emittiert (oder aktualisiert) die `subplan`-Card im Chat-Stream.
 * stepStatuses = aktueller Stand aller Step-IDs (pending/active/done/failed).
 */
async function updateCard(opts: {
  workspaceId: string;
  workstreamId: string;
  planId: string;
  coordKey: string;
  steps: readonly WorkstreamPlanStepRow[];
  stepStatuses: Record<string, string>;
  originalIntent: string;
  /**
   * W2.2 (2026-05-30): Step-IDs, die JETZT auf ein blockierendes Gate warten
   * (z.B. das Experten-Review-Gate). Diese Steps bleiben in der DB 'active',
   * tragen aber im Flow-Graph den `needs-input`-Status (→ aktionierbarer Node).
   * Optional — fehlt das Set, ist das Rendering identisch zum Vor-Stand.
   */
  gateWaitingStepIds?: ReadonlySet<string>;
  /**
   * W2.2: pro gate-wartendem Step der Gate-Kind, auf den der Node tappt
   * (DASSELBE Gate wie der ActionDeck-Pin → ein executeGateAction-Pfad, kein
   * Doppel-Routing). Default 'human-decision' (Experten-Gate).
   */
  gateKindByStep?: ReadonlyMap<string, string>;
}): Promise<void> {
  const { workspaceId, workstreamId, planId, steps, stepStatuses, originalIntent } = opts;
  const gateWaitingStepIds = opts.gateWaitingStepIds ?? null;
  const gateKindByStep = opts.gateKindByStep ?? null;

  const rootPlanPayload = {
    id: planId,
    originalIntent,
    estimatedComplexity: 'L' as const,
    proposedAt: Date.now(),
    steps: steps.map((s) => ({
      id: s.id,
      index: s.stepIndex,
      title: s.title,       // N1: verbatim
      rationale: s.rationale, // N1: verbatim
      subagentRole: s.subagentRole ?? undefined,
      groupId: readGroupId(s),
    })),
    depth: 0,
    awaitingApproval: false,
    workstreamId,
    stepStatuses,
  };

  const preamble =
    `Plan wird ausgeführt.\n\n`;

  try {
    await emitOrUpdateCard({
      coords: { workspaceId, workstreamId, surfaceKind: 'subplan' },
      content:
        preamble +
        '<surface:subplan>' +
        JSON.stringify(rootPlanPayload) +
        '</surface:subplan>',
      actor: 'system',
    });
  } catch (err) {
    // Card-Update ist best-effort — darf den Step-Loop nicht killen.
    console.warn('[plan-executor] emitOrUpdateCard failed (non-fatal):', err);
  }

  // Flow Studio (2026-05-27): ADDITIV denselben Run als <surface:flow-graph>
  // emittieren (n8n-Stil-Visualisierung; die subplan-Card bleibt unberührt).
  // Eigener best-effort try — darf den Step-Loop NIE killen.
  try {
    // W2.2 (2026-05-30): `needs-input` ergänzt. Ein Step ist `needs-input`, wenn
    // er auf ein blockierendes Gate wartet (gateWaitingStepIds) — er bleibt in
    // der DB 'active', wird im Graph aber aktionierbar (Detail-Panel → der EINE
    // executeGateAction-Pfad). Der explizite 'needs-input'-Roh-Status wird
    // ebenfalls durchgereicht (Vorwärts-Kompatibilität), falls je persistiert.
    const mapFlowStatus = (stepId: string, s: string | undefined): string => {
      if (gateWaitingStepIds && gateWaitingStepIds.has(stepId)) return 'needs-input';
      return s === 'active'
        ? 'running'
        : s === 'done'
          ? 'done'
          : s === 'failed'
            ? 'failed'
            : s === 'needs-input'
              ? 'needs-input'
              : 'idle';
    };
    const nodes = steps.map((s) => {
      let tool: string | undefined;
      const m = /\|\s*flow:(\{.*\})\s*$/.exec(s.rationale ?? '');
      if (m) {
        try {
          const parsed = JSON.parse(m[1]) as { tool?: string };
          if (parsed.tool) tool = parsed.tool;
        } catch { /* ignore */ }
      }
      const status = mapFlowStatus(s.id, stepStatuses[s.id]);
      // W2.2: ein needs-input-Node trägt den Gate-Kind, auf den er tappt — der
      // Node-Tap zielt auf DIESELBE Stream-Card wie der ActionDeck-Pin
      // (executeGateAction(gate.kind) → ein POST-Pfad, kein Drift).
      const gateKind =
        status === 'needs-input'
          ? (gateKindByStep?.get(s.id) ?? 'human-decision')
          : undefined;
      return {
        id: s.id,
        label: s.title,
        ...(s.subagentRole ? { skill: s.subagentRole } : {}),
        ...(tool ? { tool } : {}),
        status,
        ...(gateKind ? { gateKind } : {}),
      };
    });
    const edges: Array<{ from: string; to: string }> = [];
    for (const s of steps) {
      const raw = (s as { dependsOn?: string | null }).dependsOn;
      if (typeof raw === 'string' && raw.length > 0) {
        try {
          const deps = JSON.parse(raw);
          if (Array.isArray(deps)) {
            for (const d of deps) if (typeof d === 'string') edges.push({ from: d, to: s.id });
          }
        } catch { /* ignore */ }
      }
    }
    const vals = Object.values(stepStatuses);
    const runStatus = vals.includes('failed')
      ? 'failed'
      : vals.includes('active')
        ? 'running'
        : vals.length > 0 && vals.every((x) => x === 'done')
          ? 'done'
          : 'idle';

    // C1: nur (re-)emittieren, wenn sich STRUKTUR (Knoten/Kanten/Tools) ODER
    // runStatus seit dem letzten Emit geändert haben. Eine reine Status-
    // Wiederholung (z.B. zweiter updateCard-Aufruf im finally) erzeugt KEINEN
    // redundanten Emit; eine Struktur-Erweiterung (neue Steps / geänderte
    // depends_on / geänderte Tools) löst dagegen IMMER eine neue Visualisierung
    // aus — auch wenn der runStatus gleich bleibt. Owner-SOLL: "immer auch
    // visualisieren wenn sich was ändert/erweitert".
    const structureHash = computeFlowStructureHash(nodes, edges);
    const cacheKey = `${workspaceId}/${workstreamId}`;
    // W2.2: ein Wechsel in/aus `needs-input` ändert den FlowRunStatus NICHT
    // (Run läuft weiter), muss aber re-emittieren — sonst sieht der Owner den
    // gerade aufgegangenen, aktionierbaren Gate-Node nicht. Die needs-input-
    // Signatur (sortierte IDs) wird deshalb in den Emit-Schlüssel gefaltet.
    const needsInputSig = nodes
      .filter((n) => n.status === 'needs-input')
      .map((n) => n.id)
      .sort()
      .join(',');
    const emitKey = needsInputSig ? `${runStatus}#ni:${needsInputSig}` : runStatus;
    if (shouldEmitFlowGraph(cacheKey, structureHash, emitKey)) {
      await emitOrUpdateCard({
        coords: { workspaceId, workstreamId, surfaceKind: 'flow-graph' },
        content:
          '<surface:flow-graph>' +
          JSON.stringify({
            workstreamId,
            // C3: workspaceId in der Payload → die FlowGraphCard kann
            // "Als Prozess speichern" (POST /api/flow/from-workstream) auslösen,
            // ohne den Workspace aus dem URL/Context raten zu müssen.
            workspaceId,
            title: originalIntent,
            runStatus,
            nodes,
            edges,
          }) +
          '</surface:flow-graph>',
        actor: 'system',
      });
    }
  } catch (err) {
    console.warn('[plan-executor] flow-graph emit failed (non-fatal):', err);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Kern-Executor
// ────────────────────────────────────────────────────────────────────────────

export async function executePlan(args: ExecutePlanArgs): Promise<void> {
  const { workstreamId, workspaceId, planId, coordKey } = args;

  // 1. Steps lesen — geordnet nach stepIndex (plan-repo: listRootPlanSteps).
  const allRootSteps = listRootPlanSteps(workstreamId);
  const filtered = allRootSteps.filter((s) => s.planId === planId);
  const steps = filtered.length > 0 ? filtered : allRootSteps;
  if (filtered.length === 0 && allRootSteps.length > 0) {
    console.warn(
      `[plan-executor] planId=${planId} matcht keine Steps in ws=${workstreamId} — ` +
        `führe alle ${allRootSteps.length} root-Steps aus.`,
    );
  }

  if (steps.length === 0) {
    console.warn(`[plan-executor] workstream=${workstreamId} hat keine root Steps (planId=${planId})`);
    return;
  }

  // originalIntent — Workstream-Description verbatim (N1) oder Fallback-Label.
  let originalIntent = `Plan ${planId}`;
  try {
    const { getWorkstream } = await import('@/lib/workstreams/service');
    const ws = await getWorkstream(workstreamId);
    if (ws?.description) originalIntent = ws.description;
    else if (ws?.name) originalIntent = ws.name;
  } catch {
    /* nicht-fatal — Fallback-Label greift */
  }

  // 1b. Workspace-Permission-Mode lesen (A2 / A·EXEC).
  //     Default (kein Row) → null → resolveAllowedToolsForMode(null) → plan-only.
  //     Echte Tool-Ausführung NUR bei explizit gesetztem FreeRein/Lane.
  let workspaceMode: import('@/lib-v1/permission/settings/schema').PermissionMode | null = null;
  try {
    const { getDb } = await import('@/db/client');
    workspaceMode = readWorkspacePermissionMode(getDb().$raw, workspaceId);
    console.info(
      `[plan-executor] workspace=${workspaceId} permission_mode=${workspaceMode ?? '(unset→plan-only)'}`,
    );
  } catch (modeErr) {
    // DB-Fehler bei Mode-Read → fail-closed: null → plan-only Default bleibt.
    console.warn('[plan-executor] permission-mode read failed — falling back to plan-only:', modeErr);
  }

  // FreeRein/Lane gewähren echte Tools → wir brauchen den repoPath für die
  // R1-Worktree-Isolation. NUR dann auflösen (text-only-Pfad bleibt DB-frei).
  const modeGrantsTools =
    workspaceMode === 'freerein' ||
    workspaceMode === 'freerein-with-audit' ||
    workspaceMode === 'lane';
  let repoPath: string | null = null;
  if (modeGrantsTools) {
    try {
      repoPath = await resolveWorkspacePath(workspaceId);
    } catch (e) {
      console.warn('[plan-executor] resolveWorkspacePath failed — falling back to text-only:', e);
      repoPath = null;
    }
  }

  // 2. Engine wählen. codex AUSSCHLIESSEN (Code-Mode-Agent → bricht Isolation /
  //    Nicht-Destruktiv-Gebot). Erlaubt: claude-cli (--print, tool-fähig via
  //    tmux-spawn-flags) + ollama (reiner /api/chat-POST, text-only).
  const selection = await detectEngines();
  // PII vault: wrap at the engine boundary. The text-only step branch sends the
  // step prompt (built from the verbatim user intent, N1) straight to claude-cli
  // (cloud) without going through spawnInTmux — so tokenize/rehydrate here. The
  // real-spawn branch is already covered by spawnInTmux; pass-through for ollama.
  const engine = protectEngine(workspaceId, pickEngine(selection, ['codex-cli']));

  if (!engine) {
    console.error(`[plan-executor] Keine Engine verfügbar. Alle Steps werden auf 'failed' gesetzt.`);
    const failStatuses: Record<string, string> = {};
    for (const step of steps) {
      try { setPlanStepStatus(step.id, 'failed'); } catch { /* ignore */ }
      failStatuses[step.id] = 'failed';
    }
    await updateCard({ workspaceId, workstreamId, planId, coordKey, steps, stepStatuses: failStatuses, originalIntent }).catch(() => undefined);
    return;
  }

  // Echte Tool-Spawns laufen über tmux (claude-CLI). Ollama kann keinen
  // --allowedTools-Spawn → text-only. Bash/Writes brauchen claude-cli + repoPath.
  const canRealSpawn = engine.id === 'claude-cli' && repoPath !== null;

  // ── AKKUMULATION (2026-05-29): stabiler runId + Run-Branch + Merge-Mutex ────
  //
  // EIN runId pro PLAN-LAUF (nicht pro Step) — er anchort den akkumulierenden
  // Run-Branch lazing/run/<runId>. Jeder Step branched VOM Run-Tip (nicht von
  // Live-HEAD) und merged seine Arbeit seriell zurück → Step N sieht Step <N
  // (zusammengesetzte Website). SAFE_ID_RE-konform (planId/workstreamId sind
  // bereits ULID-artig; defensiv sanitisiert).
  // 2026-05-29 (Opus 4.8) — workstreamId ZUERST: der Run-Branch wird per
  // workstreamId nachgeschlagen (findRunBranchForWorkstream / merge-run-API).
  // Bei {planId}-{workstreamId} schnitt der 56er-slice die workstreamId hinten
  // ab → Lookup schlug fehl. workstreamId vorn ⇒ intakt; ggf. planId-Tail wird
  // gekürzt (kein Lookup-Key).
  const runId = `prun-${`${workstreamId}-${planId}`
    .replace(/[^A-Za-z0-9_:.\-]/g, '-')
    .slice(0, 56)}`;

  // Run-Branch EINMAL pro Lauf anlegen — VOR dem Scheduler, NUR wenn echte
  // Spawns möglich sind (text-only-Pfad bleibt DB-/git-frei). Idempotent
  // (createOrReuseRunWorktree): bei Retry desselben Laufs wird der Branch mit
  // seiner akkumulierten Arbeit wiederverwendet, KEIN Reset auf HEAD.
  let runBranch: string | null = null;
  if (canRealSpawn && repoPath) {
    try {
      const wsIdForBranch =
        workspaceId.replace(/[^A-Za-z0-9_:.\-]/g, '-').slice(0, 50) || 'ws';
      const r = await createOrReuseRunWorktree({
        repoPath,
        workspaceId: wsIdForBranch,
        runId,
      });
      runBranch = r.runBranch;
      console.info(
        `[plan-executor][accumulate] run-branch=${runBranch} runId=${runId} ` +
          `(Steps branchen vom Run-Tip, mergen seriell zurück; Live-Checkout unberührt)`,
      );
    } catch (e) {
      // Run-Branch-Setup fehlgeschlagen → KEINE Akkumulation möglich. Wir
      // degradieren NICHT auf den alten per-Step-von-HEAD-Pfad (das wäre still
      // ein Komposition-Verlust). Statt dessen läuft der Run text-only weiter
      // (sicher, kein Datenverlust) — die Spawns fallen auf engine.chat zurück,
      // weil runBranch null bleibt (siehe considerRealSpawn-Guard unten).
      console.error(
        `[plan-executor][accumulate] Run-Branch-Setup fehlgeschlagen — ` +
          `Spawns fallen auf text-only zurück (keine Akkumulation): ` +
          (e instanceof Error ? e.message : String(e)),
      );
      runBranch = null;
    }
  }

  // Per-runId-Merge-Mutex: serialisiert mergeStepIntoRun (Git erlaubt keinen
  // parallelen Merge in denselben Branch; serielle Merges = deterministische
  // Komposition). Promise-Chain — jeder Merge wartet auf den vorherigen.
  let mergeChain: Promise<void> = Promise.resolve();
  const runSerializedMerge = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = mergeChain.then(fn, fn);
    // Chain weiterführen, Fehler schlucken (der Aufrufer behandelt sie via result).
    mergeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  // SLOT-DECOUPLING: NUR echte heavy-Ollama-Nutzung zieht den N11-heavy-Slot
  // (ollama-heavy, Cap 2). claude-cli-Steps (text-only --print ODER
  // Worktree-isolierter Spawn) ziehen KEINEN heavy-Slot mehr — ihre
  // Parallelität ist durch die Scheduler-Breite (text/spawnConcurrency) bzw.
  // den Worktree-Cap (5) gebunden, NICHT durch die künstliche 2er-Kappung.
  const usesHeavyOllama = engine.id === 'ollama';

  // M2-Fix: Gesamt-Deadline-Controller.
  const execCtl = new AbortController();
  const execDeadline = setTimeout(() => execCtl.abort(), EXEC_TOTAL_DEADLINE_MS);

  // Status-Map: alle pending.
  const stepStatuses: Record<string, StepStatus> = {};
  for (const step of steps) {
    stepStatuses[step.id] = (step.status as StepStatus) ?? 'pending';
  }

  // W2.2 (2026-05-30): Steps, die auf ein blockierendes Gate warten. Der Step
  // bleibt in der DB 'active' (er hat seine Arbeit getan und wartet auf die
  // menschliche Freigabe) — im Flow-Graph wird er aber `needs-input` und damit
  // aktionierbar. gateKindByStep merkt sich, auf welche Gate-Card der Node-Tap
  // zielt → DERSELBE executeGateAction-Pfad wie der ActionDeck-Pin.
  const gateWaitingStepIds = new Set<string>();
  const gateKindByStep = new Map<string, string>();

  // Sammelt die Outputs pro Step für die Abschluss-Card (group-sortiert).
  const stepOutputs: Array<{ step: WorkstreamPlanStepRow; text: string }> = [];

  // ── Dependency-Graph aufbauen (Aufgabe B) ─────────────────────────────────
  const depsById = new Map<string, string[]>();
  for (const s of steps) depsById.set(s.id, parseDependsOn(s));

  const cycle = hasCycleOrDanglingDep(steps, depsById);
  if (cycle) {
    console.warn(
      `[plan-executor] depends_on-Graph hat Zyklus/dangling-dep in ws=${workstreamId} — ` +
        `Fallback auf sequenzielle Ausführung (alle Deps ignoriert).`,
    );
  }
  // Im Cycle-Fallback ignorieren wir alle Deps (sequenziell in stepIndex-Order).
  const effectiveDeps = (stepId: string): string[] =>
    cycle ? [] : (depsById.get(stepId) ?? []);

  // ── Step-Klasse PRO STEP bestimmen (SLOT-DECOUPLING) ───────────────────────
  //
  // Ein Step ist 'spawn' (claude-cli write/bash → Worktree-isoliert) wenn der
  // Modus Tools gewährt UND ein echter Spawn-Pfad existiert UND die
  // (deterministische, N6) Tool-Auflösung für die Step-Rolle nicht-leer ist.
  // Sonst 'text' (text-only engine.chat — kein Worktree, kein heavy-Ollama).
  // Das spiegelt EXAKT die `considerRealSpawn`-Logik in runStep (single source:
  // resolveAllowedToolsForMode) — wir berechnen sie hier nur vorab, um die
  // richtige Parallelitäts-Klasse pro Step zu wählen.
  // AKKUMULATION: ein echter Spawn ist nur möglich, wenn der Run-Branch steht
  // (sonst kann der Step nicht vom Run-Tip branchen) — sonst text-only.
  const canAccumulate = canRealSpawn && runBranch !== null;

  // ── W2.1: Website-Run? → verbindliches Design-System vorwärts verketten ─────
  // Nur bei website-artigem Intent. Der vom design-Step gewählte Akzent wird
  // beim ersten erkannten design-Output geparst + danach an alle folgenden
  // Steps vorwärts gereicht. State pro Run (kein Modul-State).
  const websiteRun = isWebsiteIntent(originalIntent);
  let chosenAccent = 'own'; // laz.ing Default-Akzent bis der design-Step wählt.

  type StepClass = 'text' | 'spawn';
  const classOf = (step: WorkstreamPlanStepRow): StepClass => {
    if (!modeGrantsTools || !canAccumulate) return 'text';
    const stepRole = step.subagentRole ?? 'reviewer';
    const res = resolveAllowedToolsForMode(workspaceMode, stepRole);
    return res.allowedTools.length > 0 ? 'spawn' : 'text';
  };
  const stepClassById = new Map<string, StepClass>();
  for (const s of steps) stepClassById.set(s.id, classOf(s));

  // Getrennte Budget-Klassen lesen — NICHT mehr heavyTotal als Universal-Bremse.
  //   - text-Steps  → textConcurrency (Cores-abgeleitet, ~6)
  //   - spawn-Steps → spawnConcurrency (== Worktree-Cap 5)
  // Cycle-Fallback erzwingt Breite 1 (sequenziell, alle Deps ignoriert).
  const cb = resourcePool.getConcurrencyBudget();
  const textConcurrency = cycle ? 1 : Math.max(1, cb.textConcurrency);
  const spawnConcurrency = cycle ? 1 : Math.max(1, cb.spawnConcurrency);

  // ── Per-Step-Runner (R2-Gate → Spawn-oder-Chat) ───────────────────────────
  const runStep = async (step: WorkstreamPlanStepRow): Promise<void> => {
    const stepLabel = `plan-step:${step.id}`;
    let slot: Awaited<ReturnType<typeof resourcePool.acquireSlot>> | null = null;

    try {
      // SLOT-DECOUPLING: Der heavy-Engine-Slot (ollama-heavy, N11-Cap 2) wird
      // NUR für echte heavy-Ollama-Nutzung erworben. claude-cli-Steps (text
      // oder Worktree-Spawn) erwerben hier KEINEN Slot — ihre Parallelität ist
      // schon durch die Scheduler-Breite (text/spawnConcurrency) + den
      // Worktree-Cap gebunden. Das war der Bug: ein text-only-Step durfte nie
      // einen der 2 heavy-Ollama-Slots verbrauchen.
      if (usesHeavyOllama) {
        slot = await resourcePool.acquireSlot({
          kind: 'ollama-heavy',
          subagentId: stepLabel,
          priority: 'normal',
          timeoutMs: 20_000,
          signal: execCtl.signal,
        });
      }
      await waitForBudget(`plan-exec:${workspaceId}`);

      setPlanStepStatus(step.id, 'active');
      stepStatuses[step.id] = 'active';
      await updateCard({ workspaceId, workstreamId, planId, coordKey, steps, stepStatuses, originalIntent, gateWaitingStepIds, gateKindByStep });

      // ── BAHN-2: DETERMINISTISCHER PV-STRINGING-STEP (VOR jedem Spawn) ───────
      //
      // Ein pv-stringing-Step läuft NICHT als claude-cli-Worktree-Spawn. Er ruft
      // den deterministischen Producer (N6) und legt sein PvArtifact als Step-
      // Output ab — von dort konsumiert from-artifact.ts → evaluate.ts (G5) das
      // elektrische Modell. Weil dieser Pfad den Spawn-Zweig GAR NICHT erreicht,
      // kann der Step auch nicht fälschlich am W1.1-Non-empty-Diff-Gate als
      // no_artifact failen (das Gate greift nur im Spawn-Pfad).
      if (isPvStringingStep(step)) {
        const pvOutput = runPvStringingStep(step);
        stepOutputs.push({ step, text: pvOutput });

        // N8: deterministischen Producer-Lauf auditieren (durchsuchbar, hash-
        // gekettet). actor='policy' (kein User, kein LLM). Best-effort.
        try {
          writeDecision({
            workspaceId,
            workstreamId,
            coordKey,
            decisionKind: 'route',
            actor: 'policy',
            rationale:
              `pv_stringing_producer=true step=${step.id} role=${step.subagentRole ?? '(none)'} ` +
              `deterministic=true no_spawn=true no_worktree=true — Producer-Output ` +
              `(verbatim, N1):\n${pvOutput}`,
          });
        } catch { /* writeDecision best-effort */ }

        // ── W3.2: EXPERTEN-GATE bei install-grade ohne expertReviewed ────────
        //
        // buildExpertReviewGate liefert eine HumanDecisionGatePayload, WENN ein
        // install-grade-Approval ohne Review angefordert wird (sonst null). Wir
        // lesen den angeforderten Grade + Review-Status aus der configJson-
        // Annotation; fehlt sie, ist kein install-grade angefordert → kein Gate.
        try {
          const cfgRaw = parseFlowAnnotation(step.rationale ?? '').annotation?.configJson ?? null;
          if (cfgRaw) {
            const cfg = JSON.parse(cfgRaw) as Record<string, unknown>;
            const requestedGrade = cfg.requestedGrade;
            if (requestedGrade === 'sales' || requestedGrade === 'proposal' || requestedGrade === 'install') {
              const gate = buildExpertReviewGate({
                requestedGrade,
                expertReviewed: cfg.expertReviewed === true,
                ...(typeof cfg.quoteId === 'string' ? { quoteId: cfg.quoteId } : {}),
                ...(typeof cfg.approvalId === 'string' ? { approvalId: cfg.approvalId } : {}),
                ...(Array.isArray(cfg.reviewItems)
                  ? { reviewItems: (cfg.reviewItems as unknown[]).filter((x): x is string => typeof x === 'string') }
                  : {}),
              });
              if (gate) {
                // W2.2: der Step wartet jetzt auf die menschliche Freigabe →
                // im Flow-Graph `needs-input` (aktionierbarer Node) statt
                // unsichtbar weiterzulaufen. Der Node-Tap zielt auf DIESELBE
                // <surface:human-decision>-Card → ein executeGateAction-Pfad.
                gateWaitingStepIds.add(step.id);
                gateKindByStep.set(step.id, 'human-decision');
                await updateCard({
                  workspaceId,
                  workstreamId,
                  planId,
                  coordKey,
                  steps,
                  stepStatuses,
                  originalIntent,
                  gateWaitingStepIds,
                  gateKindByStep,
                }).catch(() => undefined);

                // Emittiere die Gate-Payload über den bestehenden Surface-Emit-
                // Pfad als <surface:human-decision>. Der ActionDeck/executeGate-
                // Action-Pfad (Bahn 1) rendert + verarbeitet Approve: er wendet
                // setsFieldOnApprove (approval.expertReviewed=true) an und
                // erntet grantsDecisionsOnApprove in workstream_decisions —
                // genau diese Decisions heben expert-review-optional in der Eval
                // auf. N8: die Gate-Begründung ist verbatim Owner-lesbar.
                await emitChatMessageCompleted({
                  workspaceId,
                  entityId: ulid(),
                  content: `<surface:human-decision>${JSON.stringify(gate)}</surface:human-decision>`,
                  actor: 'system',
                  outcome: 'ok',
                  metadata: {
                    surfaceKind: 'human-decision',
                    workstreamId,
                    planId,
                    gateId: gate.gateId,
                  },
                }).catch(() => undefined);
                console.info(
                  `[plan-executor][pv-stringing] step=${step.id} EXPERT-GATE emittiert ` +
                    `(install-grade ohne expertReviewed) gateId=${gate.gateId}`,
                );
              }
            }
          }
        } catch { /* Gate-Emit best-effort — kein Step-Fail */ }

        // W2.2: Step ist abgeschlossen → Gate-Wartemarke löschen, damit der
        // finale Flow-Graph-Emit den Node als `done` (nicht `needs-input`)
        // zeigt. Idempotent: delete ohne vorheriges add ist ein No-op.
        gateWaitingStepIds.delete(step.id);
        gateKindByStep.delete(step.id);
        setPlanStepStatus(step.id, 'done');
        stepStatuses[step.id] = 'done';
        return;
      }

      // LOW #5: Default-Rolle für die Tool-Auflösung ist 'reviewer' (read-only).
      const stepRole = step.subagentRole ?? 'reviewer';
      const modeResolution = resolveAllowedToolsForMode(workspaceMode, stepRole);
      const resolvedExecutionMode = modeResolution.executionMode;

      // Soll dieser Step ÜBERHAUPT echte Tools laufen lassen? NUR wenn:
      //   - der Modus Tools gewährt (FreeRein/Lane, NICHT unset/ask),
      //   - die Tool-Auflösung nicht-leer ist, UND
      //   - ein echter Spawn möglich ist (claude-cli + repoPath aufgelöst).
      // Sonst → DEFAULT-SICHER: text-only engine.chat (heutiges Verhalten,
      // bit-gleich). KEIN R2-Gate als Step-Blocker im Default — text-only ist
      // tool-los (kein Write, keine Shell) und damit per se unkritisch.
      const considerRealSpawn =
        modeGrantsTools &&
        modeResolution.allowedTools.length > 0 &&
        canAccumulate;

      let wantsRealSpawn = false;
      let gateReason = '(text-only — Modus gewährt keine Tools / kein Spawn-Pfad)';

      if (considerRealSpawn) {
        // R2-Gate ist die AUTORISIERUNG für den echten Tool-Spawn (N6).
        // R2 entscheidet über fs-Read/fs-Write; Bash wird separat als
        // permissionMode durchgereicht (nicht in requestedTools).
        const stepAllowedToolsNoShell = modeResolution.allowedTools.filter(
          (t) => t !== 'Bash' && t !== 'Shell' && t !== 'Exec',
        );
        const gateMode: PermissionModeForGate | undefined =
          workspaceMode === 'freerein' ||
          workspaceMode === 'freerein-with-audit' ||
          workspaceMode === 'lane'
            ? workspaceMode
            : undefined;

        const policyDecision = enforceExecutionStep({
          role: stepRole,
          executionMode: resolvedExecutionMode,
          requestedTools:
            stepAllowedToolsNoShell.length > 0 ? stepAllowedToolsNoShell : ['Read', 'Grep'],
          workspaceId,
          ...(gateMode ? { permissionMode: gateMode } : {}),
        });
        // Bei R2-Deny → DEFENSE-IN-DEPTH: KEIN Crash, KEIN Tool-Spawn,
        // sondern Rückfall auf den sicheren text-only-Pfad.
        wantsRealSpawn = policyDecision.allow;
        gateReason = policyDecision.reason;
      }

      // N8: Entscheidung auditieren (stdout-Audit; DB-Audit = R3-Aufgabe).
      const auditLine = `[plan-executor][security-gate] step=${step.id} ` +
        `role=${stepRole} ` +
        `workspace_mode=${modeResolution.resolvedMode} ` +
        `executionMode=${resolvedExecutionMode} ` +
        `consider_spawn=${considerRealSpawn} ` +
        `real_spawn=${wantsRealSpawn} ` +
        `mode_tools=${JSON.stringify(modeResolution.allowedTools)} ` +
        `reason="${gateReason}"`;
      if (wantsRealSpawn) console.info(auditLine);
      else console.warn(auditLine);

      let outputText: string;

      if (wantsRealSpawn && repoPath && runBranch) {
        // ── N8/N10: TAMPER-EVIDENTE DB-DECISION VOR DEM ECHTEN TOOL-LAUF ──────
        //
        // Jeder echte Tool-Lauf (inkl. Bash) MUSS eine durchsuchbare, hash-
        // gekettete Entscheidung in `workstream_decisions` hinterlassen — nicht
        // nur flüchtigen stdout. writeDecision schreibt content_hash =
        // sha256(canonicalJson({workstream_id, decision_kind, rationale,
        // evidence_refs})) + eine Sentinel-Evidence-Row (N10-Kettung).
        // decision_kind='route' (Gate-Routing/Spawn-Autorisierung, wie in
        // plan-dispatch). actor='policy' (deterministisches R2-Gate, kein User).
        // N1: rationale VERBATIM, KEIN .slice — die gewährten Tools (inkl. Bash)
        // stehen vollständig drin. Best-effort: writeDecision wirft nie.
        const decisionRationale =
          `real_spawn=true mode=${modeResolution.resolvedMode} step=${step.id} ` +
          `role=${stepRole} coordKey=${coordKey} ` +
          `granted_tools=${JSON.stringify(modeResolution.allowedTools)} ` +
          `executionMode=${resolvedExecutionMode} ` +
          `worktree_isolated=true merge_gated=true ` +
          `reason=${gateReason}`;
        const decisionId = writeDecision({
          workspaceId,
          workstreamId,
          coordKey,
          decisionKind: 'route',
          actor: 'policy',
          rationale: decisionRationale,
        });
        console.info(
          `[plan-executor][decision] step=${step.id} workstream_decisions.id=${decisionId ?? '(write-failed)'} content_hash-chained=true`,
        );

        // ── ECHTER TOOL-SPAWN — ZWINGEND R1-WORKTREE-ISOLIERT ────────────────
        //
        // Bash/Writes passieren im isolierten Worktree (createRunWorktree),
        // NIE am Live-Checkout. Merge bleibt gated (mergeRunWorktree wirft in R1).
        // ENV `env -i`-gescrubbt + K1 `--disallowedTools` (hart) sind in
        // tmux-spawn. Fehler-isoliert: ein Spawn-Fehler killt nur diesen Step.
        // W2.1: bei website-Runs das verbindliche Design-System + die bisher
        // produzierten Artefakte vorwärts reichen. Sonst undefined → bit-
        // identischer Prompt (rückwärtskompatibel).
        const sharedDesignContext = websiteRun
          ? renderDesignSystemPrompt(chosenAccent)
          : undefined;
        const priorArtifacts = websiteRun
          ? summarizePriorArtifacts(stepOutputs)
          : undefined;

        outputText = await runRealSpawnIsolated({
          step,
          stepRole,
          repoPath,
          workspaceId,
          workstreamId,
          coordKey,
          runBranch, // AKKUMULATION: Step branched vom Run-Tip, merged zurück
          serializeMerge: runSerializedMerge,
          allowedTools: modeResolution.allowedTools, // inkl. Bash bei FreeRein
          originalIntent,
          stepNumber: steps.indexOf(step) + 1,
          totalSteps: steps.length,
          signal: execCtl.signal,
          ...(sharedDesignContext ? { sharedDesignContext } : {}),
          ...(priorArtifacts ? { priorArtifacts } : {}),
        });
      } else {
        // ── TEXT-ONLY (Default sicher / ollama / lane-ohne-spawn) ────────────
        // Reine Chat-Completion, KEINE Tool-Calls, KEINE Datei-Writes.
        const stepPrompt = buildStepPrompt({
          role: step.subagentRole ?? 'coder',
          originalIntent,
          stepIndex: steps.indexOf(step) + 1,
          totalSteps: steps.length,
          title: step.title,
          rationale: step.rationale,
        });
        const response = await engine.chat({
          messages: [{ role: 'user', content: stepPrompt }],
          timeoutMs: 60_000,
          signal: execCtl.signal,
        });
        outputText = response.text;
      }

      stepOutputs.push({ step, text: outputText });
      // W2.1: vom design-Step gewählten Akzent extrahieren → vorwärts reichen.
      if (websiteRun) {
        const role = (step.subagentRole ?? '').toLowerCase();
        const isDesignStep =
          role === 'design' ||
          /\b(design|style|styling|visual|theme|farb|gestalt|branding)\b/i.test(step.title);
        if (isDesignStep) chosenAccent = parseChosenAccent(outputText);
      }
      setPlanStepStatus(step.id, 'done');
      stepStatuses[step.id] = 'done';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[plan-executor] Step ${step.id} (${step.title}) failed: ${msg}`);
      try { setPlanStepStatus(step.id, 'failed'); } catch { /* ignore */ }
      stepStatuses[step.id] = 'failed';
      stepOutputs.push({ step, text: `[Fehler: ${msg}]` });
    } finally {
      if (slot) {
        try { resourcePool.releaseSlot(slot.slotId); } catch { /* ignore */ }
      }
      await updateCard({ workspaceId, workstreamId, planId, coordKey, steps, stepStatuses, originalIntent, gateWaitingStepIds, gateKindByStep }).catch(() => undefined);
    }
  };

  // ── Parallel-Scheduler: Ready-Queue, getrennte Klassen-Budgets ─────────────
  //
  // Ein Step ist READY, wenn alle seine effektiven Deps 'done' sind. Steps,
  // deren Dep 'failed' ist, werden NICHT gestartet (fehler-isoliert): sie
  // bleiben 'pending' und werden am Ende als blockiert auf 'failed' gesetzt.
  //
  // Die Breite ist plan-abgeleitet: bis zu `textConcurrency` text-Steps UND
  // bis zu `spawnConcurrency` spawn-Steps laufen gleichzeitig (orthogonal).
  await runReadyQueue({
    steps,
    effectiveDeps,
    stepStatuses,
    classOf: (id: string): 'text' | 'spawn' => stepClassById.get(id) ?? 'text',
    limits: { text: textConcurrency, spawn: spawnConcurrency },
    runStep,
  });

  // Steps, die nie ready wurden (Dep failed) → blockiert → failed markieren.
  for (const step of steps) {
    if (stepStatuses[step.id] === 'pending') {
      const reason = '[übersprungen — eine Voraussetzung (depends_on) ist fehlgeschlagen]';
      try { setPlanStepStatus(step.id, 'failed'); } catch { /* ignore */ }
      stepStatuses[step.id] = 'failed';
      stepOutputs.push({ step, text: reason });
    }
  }
  await updateCard({ workspaceId, workstreamId, planId, coordKey, steps, stepStatuses, originalIntent, gateWaitingStepIds, gateKindByStep }).catch(() => undefined);

  clearTimeout(execDeadline);

  // ── A5 + A4: Post-Prozess-IST/SOLL-Reconciliation (additiv, fail-soft) ─────
  //
  // NACH Run-Abschluss (Step-Status final): das Gesamt-Outcome bestimmen +
  // recordOutcome, Drift Decision↔aktive-Belief → begründeter Belief-Update
  // (supersede, Historie bleibt), und — bei begründungsloser/abweichender
  // Entscheidung — eine OPTIONALE WARUM-Frage erzeugen. Genau das fehlte im
  // PA-Chat: das heygen-Dead-End wurde nur als orphan aufgeräumt, kein Lern-
  // Eintrag. Die WARUM-Frage wird unten an den Abschluss-Content gehängt, damit
  // der bestehende Open-Questions-Pill sie zeigt (extractOpenQuestionsFromContent).
  //
  // NICHT-BLOCKIEREND: ein Fehler im Reconcile darf den Run-Abschluss NIE kippen
  // (try/catch + log). Die Flow-Graph-/Parallel-Logik bleibt unberührt.
  let reconcileWhyQuestion: string | null = null;
  try {
    const { getDb } = await import('@/db/client');
    const { reconcileWorkstream } = await import('@/lib/reasoning/reconcile');
    const reconcileResult = reconcileWorkstream(getDb().$raw, {
      workspaceId,
      workstreamId,
      coordKey,
      stepStatuses,
    });
    reconcileWhyQuestion = reconcileResult.whyQuestion;
    console.info(
      `[plan-executor][reconcile] ws=${workstreamId} outcome=${reconcileResult.outcome} ` +
        `already=${reconcileResult.alreadyReconciled} ` +
        `beliefUpdates=${reconcileResult.beliefUpdates} ` +
        `drifts=${reconcileResult.drifts.length} ` +
        `unjustified=${reconcileResult.unjustified.length} ` +
        `whyQuestion=${reconcileWhyQuestion ? 'yes' : 'no'}`,
    );
  } catch (err) {
    console.warn('[plan-executor] Reconcile fehlgeschlagen (non-fatal):', err);
  }

  // ── E5.1: Auto-Workspace-Handoff persistieren (additiv, fail-soft) ─────────
  //
  // DIREKT nach dem A5-Reconcile: den UI-sichtbaren Workspace-Handoff in
  // `workspaces.notes` schreiben. buildWorkspaceHandoff aggregiert den read-back-
  // Trail (recentRationales + aktive Beliefs + offene Decisions) scope-isoliert
  // über workspaceId; persistWorkspaceHandoff schreibt ihn als notes_source=
  // 'ai-summary'. Bisher hatte persistWorkspaceHandoff KEINEN Aufrufer → die
  // notes-Spalte wurde nie auto-befüllt (die Start-Einspeisung in workspace-
  // session läuft unabhängig live-aggregiert und ist NICHT betroffen).
  //
  // REPLACE-Schutz (verlasse dich darauf, dokumentiert): persistWorkspaceHandoff
  //   - schreibt NUR, wenn notes_source ∈ {NULL, 'ai-summary'} — eine vom User
  //     gepflegte 'manual'-Note bleibt IMMER unangetastet (foreign-notes-source);
  //   - REPLACEt die ai-summary komplett (kein Append-Wachstum, idempotent);
  //   - schreibt bei leerem Handoff (isEmpty) GAR NICHT (kein Clobbern einer
  //     früheren Zusammenfassung mit Leerstring).
  //
  // NICHT-BLOCKIEREND: ein Fehler hier darf den Run-Abschluss NIE kippen (eigener
  // try/catch + log). Idempotent / Last-Write-Wins ist ok (es ist ein REPLACE der
  // ai-summary). Eigener Block (nicht im Reconcile-catch), damit ein Reconcile-
  // Fehler den Handoff nicht verschluckt und umgekehrt.
  try {
    const { getDb } = await import('@/db/client');
    const { buildWorkspaceHandoff, persistWorkspaceHandoff } = await import(
      '@/lib/reasoning/auto-handoff'
    );
    const raw = getDb().$raw;
    const handoff = buildWorkspaceHandoff(raw, workspaceId);
    const handoffResult = persistWorkspaceHandoff(raw, workspaceId, handoff);
    console.info(
      `[plan-executor][handoff] ws=${workspaceId} ` +
        `written=${handoffResult.written} ` +
        `skipped=${handoffResult.skippedReason ?? 'none'}`,
    );
  } catch (err) {
    console.warn('[plan-executor] Handoff-Persist fehlgeschlagen (non-fatal):', err);
  }

  // ── Self-Learning: Workflow-Repetition-Detektor (Slice 1, additiv, fail-soft) ─
  //
  // Owner-Vision (2026-06-03): „Dieses Self Learning und Repetitors zu erkennen
  // ist absolut wichtig." NACH Run-Abschluss berechnet detectWorkflowRepetition
  // eine kanonische Struktur-Signatur des gelaufenen Ablaufs, zählt frühere
  // gleiche Läufe (append-only `workflow.structure_seen`-Events, N8/N9) und
  // entscheidet deterministisch (Score ≥ 3, frühestens 3. gleicher Lauf + komplex
  // mehrstufig), ob die KI „Als wiederverwendbaren Workflow speichern?"
  // vorschlagen soll. NIE Auto-Save: bei `suggest` wird genau EINE klickbare
  // <surface:flow-recurrence>-Karte emittiert; das Speichern läuft über den
  // bestehenden /api/flow/from-workstream-Pfad (C3), Owner-gated.
  //
  // NICHT-BLOCKIEREND: eigener try/catch — ein Detektor-Fehler darf den
  // Run-Abschluss NIE kippen (gleiches Muster wie Reconcile-/Handoff-Block).
  try {
    const { getDb } = await import('@/db/client');
    const { detectWorkflowRepetition } = await import('@/lib/flow/repetition-detect');
    const rep = detectWorkflowRepetition(getDb().$raw, { workspaceId, workstreamId });
    if (rep) {
      console.info(
        `[plan-executor][repetition] ws=${workspaceId} ws_id=${workstreamId} ` +
          `seen=${rep.seenCount} score=${rep.score} suggest=${rep.suggest}`,
      );
      if (rep.suggest) {
        await emitChatMessageCompleted({
          workspaceId,
          entityId: ulid(),
          actor: 'system',
          outcome: 'ok',
          content:
            '<surface:flow-recurrence>' +
            JSON.stringify({
              workstreamId,
              workspaceId,
              title: originalIntent,
              seenCount: rep.seenCount,
              stepCount: rep.stepCount,
              summary: rep.stepSummary,
            }) +
            '</surface:flow-recurrence>',
        }).catch(() => undefined);
      }
    }
  } catch (err) {
    console.warn('[plan-executor] Repetition-Detektor fehlgeschlagen (non-fatal):', err);
  }

  // 4. Abschluss-Card — nach group_id gruppiert (Zugehörigkeit).
  // 2026-05-29 (Opus 4.8) — Owner-Befund (2×): die WARUM-/Drift-Reflexionen des
  // Self-Learning-Loops gehören NICHT in die Chat-UI (weder als Offene-Frage noch
  // als Counter-Evidence-Card) — sie sind System-interne Selbst-Reflexion über
  // Routing-Entscheidungen, kein User-Input. Das LERNEN passiert ohnehin im Trace
  // (reconcileWorkstream schreibt die Drift-Beliefs); wir surfacen es schlicht
  // NICHT. reconcileWhyQuestion wird daher bewusst NICHT mehr an die Summary
  // gehängt (war Quelle der „Warum diesmal anders?"-Pollution). `void` markiert
  // die bewusste Nicht-Nutzung (Loop-Wirkung bleibt, Surface verschwindet).
  void reconcileWhyQuestion;
  const summaryContent = buildSummaryContent(originalIntent, stepOutputs);
  try {
    await emitChatMessageCompleted({
      workspaceId,
      entityId: ulid(),
      content: summaryContent,
      actor: 'system',
      outcome: 'ok',
      metadata: {
        surfaceKind: 'plan-exec-summary',
        workstreamId,
        planId,
      },
    });
  } catch (err) {
    console.warn('[plan-executor] Abschluss-Emit fehlgeschlagen (non-fatal):', err);
  }

  // ── W1.3 (2026-05-30) — AUTO-MERGE (Owner-Entscheidung, flag-gated) ────────
  //
  // Bei `LAZYOS_AUTO_MERGE_RUN='on'` UND „alle Steps done" UND nicht-leerem
  // Run-Diff wird der zusammengesetzte Run AUTOMATISCH in den Live-Checkout
  // gemergt (commitGatedMerge) — kein Owner-Tap. Das W1.1-Diff-Gate hat bereits
  // alle Leer-No-op-Steps eliminiert, sodass nur echte Arbeit ankommt. Die
  // <surface:merge-offer>-Karte (unten) bleibt als Fallback/Audit erhalten; im
  // Auto-Merge-Erfolgsfall wird sie übersprungen (autoMerged=true). Default
  // (Flag off) = bisheriges member-gated Verhalten (nur Karte). N8-Decision je
  // Auto-Merge. R1-Disziplin bewusst zugunsten Autonomie aufgeweicht (Owner-mandatiert).
  let autoMerged = false;
  if (
    process.env.LAZYOS_AUTO_MERGE_RUN === 'on' &&
    canAccumulate &&
    runBranch &&
    repoPath
  ) {
    const allDone = steps.every((s) => stepStatuses[s.id] === 'done');
    if (allDone) {
      try {
        const { getRunBranchDiffStat, commitGatedMerge } = await import(
          '@/lib/agents/worktree-manager'
        );
        const diff = await getRunBranchDiffStat(repoPath, runBranch);
        if (diff.aheadBy > 0 && diff.files.length > 0) {
          const merge = await commitGatedMerge({ repoPath, runBranch });
          // N8: Auto-Merge auditieren (tamper-evidente Decision, verbatim).
          try {
            writeDecision({
              workspaceId,
              workstreamId,
              coordKey,
              decisionKind: 'route',
              actor: 'policy',
              rationale: merge.merged
                ? `auto_merge=true (LAZYOS_AUTO_MERGE_RUN=on) run_branch=${runBranch} ` +
                  `files=${diff.files.length} aheadBy=${diff.aheadBy} → in Live gemergt ` +
                  `(${merge.sha ?? 'sha?'}). Owner-mandatierte Voll-Autonomie; ` +
                  `W1.1-Diff-Gate garantiert nicht-leere Steps.`
                : `auto_merge ABGEBROCHEN: run_branch=${runBranch} → Konflikt, Live ` +
                  `unverändert. ${merge.conflict ?? ''}`,
            });
          } catch { /* writeDecision best-effort */ }
          if (merge.merged) {
            autoMerged = true;
            console.info(
              `[plan-executor][auto-merge] ws=${workstreamId} runBranch=${runBranch} ` +
                `files=${diff.files.length} sha=${merge.sha ?? '?'} — automatisch in Live gemergt`,
            );
            // W1.4: nach erfolgreichem Auto-Merge serven + Preview emittieren.
            await emitPreviewAfterMerge({
              workspaceId,
              workstreamId,
              planId,
              repoPath,
              title: originalIntent,
            });
          } else {
            console.warn(
              `[plan-executor][auto-merge] ws=${workstreamId} KONFLIKT — fällt auf ` +
                `Merge-Offer-Karte zurück. ${merge.conflict ?? ''}`,
            );
          }
        }
      } catch (err) {
        console.warn('[plan-executor] Auto-Merge fehlgeschlagen (non-fatal):', err);
      }
    }
  }

  // A4 (2026-05-29) — Merge-Offer: wenn die Akkumulation echte Arbeit auf dem
  // Run-Branch hinterlassen hat (≥1 Commit ahead), dem Owner sichtbar machen,
  // dass die zusammengesetzte Arbeit zum gated Merge in den Live-Checkout bereit
  // ist. Der Merge selbst passiert NUR per Owner-Klick (POST .../merge-run, R1).
  // Best-effort, wirft nie. Emittiert die klickbare <surface:merge-offer>-Card
  // (Surface-Welle 2026-05-29): [In Live mergen] POSTet /api/workstreams/[id]/
  // merge-run — der EINZIGE gated Schreib-Pfad in den Live-Checkout (R1/R3).
  // W1.3: bei erfolgreichem Auto-Merge wird die Karte übersprungen.
  if (!autoMerged && canAccumulate && runBranch && repoPath) {
    try {
      const { getRunBranchDiffStat } = await import('@/lib/agents/worktree-manager');
      const diff = await getRunBranchDiffStat(repoPath, runBranch);
      if (diff.aheadBy > 0 && diff.files.length > 0) {
        const mergeOfferPayload = {
          runBranch,
          fileCount: diff.files.length,
          files: diff.files,
          workstreamId,
          workspaceId,
        };
        await emitChatMessageCompleted({
          workspaceId,
          entityId: ulid(),
          content: `<surface:merge-offer>${JSON.stringify(mergeOfferPayload)}</surface:merge-offer>`,
          actor: 'system',
          outcome: 'ok',
          metadata: {
            surfaceKind: 'merge-offer',
            workstreamId,
            planId,
          },
        });
        console.info(
          `[plan-executor][merge-offer] ws=${workstreamId} runBranch=${runBranch} ` +
            `files=${diff.files.length} aheadBy=${diff.aheadBy} — bereit für gated Merge`,
        );
      }
    } catch (err) {
      console.warn('[plan-executor] Merge-Offer-Emit fehlgeschlagen (non-fatal):', err);
    }
  }

  // ── RUN-ABSCHLUSS-STATUS (2026-05-30) ──────────────────────────────────────
  // executePlan setzte den Workstream/flow_run NIE auf einen Terminal-Status →
  // ein erfolgreicher Lauf (alle Steps done, Auto-Merge auf main, Website live)
  // blieb 'active' und wurde vom Recovery-Sweep fälschlich als 'stuck' markiert
  // (irreführende „unterbrochen"-Karte trotz geliefertem Ergebnis). Jetzt: alle
  // Steps terminal → workstream 'done' (mind. 1 done) bzw. 'failed' (alle failed),
  // + flow_runs analog. Fail-soft, idempotent; cancelled/archived/bereits-terminal
  // werden NICHT überschrieben.
  try {
    const { getDb } = await import('@/db/client');
    const raw = getDb().$raw;
    const allTerminal =
      steps.length > 0 &&
      steps.every((s) =>
        ['done', 'failed', 'skipped'].includes(stepStatuses[s.id] ?? ''),
      );
    if (allTerminal) {
      const anyDone = steps.some((s) => stepStatuses[s.id] === 'done');
      const finalStatus = anyDone ? 'done' : 'failed';
      const now = Date.now();
      raw
        .prepare(
          "UPDATE workstreams SET status=?, updated_at=? WHERE id=? AND status NOT IN ('cancelled','archived','done','failed')",
        )
        .run(finalStatus, now, workstreamId);
      raw
        .prepare(
          "UPDATE flow_runs SET status=?, updated_at=? WHERE workstream_id=? AND status IN ('running','pending')",
        )
        .run(finalStatus, now, workstreamId);
      console.info(
        `[plan-executor][complete] ws=${workstreamId} status=${finalStatus} ` +
          `(alle ${steps.length} Steps terminal) — Run abgeschlossen, kein Recovery-Sweep-stuck.`,
      );
    }
  } catch (err) {
    console.warn(
      '[plan-executor] Run-Abschluss-Status-Set fehlgeschlagen (non-fatal):',
      err,
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Parallel-Scheduler
// ────────────────────────────────────────────────────────────────────────────

/**
 * Ready-Queue-Scheduler mit GETRENNTEN Klassen-Budgets (SLOT-DECOUPLING).
 *
 * Startet ready-Steps, sobald deren Deps 'done' sind — bis zu `limits.text`
 * text-Steps UND bis zu `limits.spawn` spawn-Steps GLEICHZEITIG (orthogonal:
 * die Klassen teilen sich KEINEN gemeinsamen Topf mehr). Mehr ready-Steps als
 * das Klassen-Budget → die übrigen warten in der Queue (NICHT droppen).
 *
 * Deterministische Start-Reihenfolge: ready-Steps werden in stepIndex-Order
 * geprüft (stabil + reproduzierbar). Im Cycle-Fallback sind beide Limits 1 +
 * effectiveDeps=[] → reiner sequenzieller stepIndex-Loop.
 *
 * KEIN Deadlock/Race: rein synchroner launchReady-Fastpath; bei jedem
 * Step-Done (Promise.race) wird neu eingeplant.
 */
async function runReadyQueue(opts: {
  steps: readonly WorkstreamPlanStepRow[];
  effectiveDeps: (stepId: string) => string[];
  stepStatuses: Record<string, string>;
  classOf: (stepId: string) => 'text' | 'spawn';
  limits: { text: number; spawn: number };
  runStep: (step: WorkstreamPlanStepRow) => Promise<void>;
}): Promise<void> {
  const { steps, effectiveDeps, stepStatuses, classOf, limits, runStep } = opts;
  const ordered = [...steps].sort((a, b) => a.stepIndex - b.stepIndex);
  const started = new Set<string>();
  const inflight = new Set<Promise<void>>();
  // Pro-Klasse-Zähler — die beiden Budgets sind orthogonal (kein gemeinsamer Topf).
  const running: Record<'text' | 'spawn', number> = { text: 0, spawn: 0 };

  const isReady = (step: WorkstreamPlanStepRow): boolean => {
    if (started.has(step.id)) return false;
    if (stepStatuses[step.id] !== 'pending') return false;
    const deps = effectiveDeps(step.id);
    // Alle Deps müssen 'done' sein. Eine 'failed'-Dep → niemals ready
    // (Step bleibt pending → wird am Ende als blockiert markiert).
    return deps.every((d) => stepStatuses[d] === 'done');
  };

  const launchReady = (): void => {
    for (const step of ordered) {
      if (!isReady(step)) continue;
      const cls = classOf(step.id);
      // Klassen-Budget voll → diesen Step (noch) NICHT starten; ein späterer
      // Step der anderen Klasse darf in derselben Welle trotzdem starten.
      if (running[cls] >= limits[cls]) continue;
      started.add(step.id);
      running[cls] += 1;
      const p = runStep(step).finally(() => {
        running[cls] -= 1;
        inflight.delete(p);
      });
      inflight.add(p);
    }
  };

  launchReady();
  while (inflight.size > 0) {
    // Auf den nächsten fertigen Step warten, dann neu-ready-gewordene starten.
    await Promise.race(inflight);
    launchReady();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Echter Tool-Spawn (R1-isoliert)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Führt einen Step als echten claude-CLI-Tool-Spawn aus — ZWINGEND in einem
 * isolierten Git-Step-Worktree. Der Live-Checkout (main) wird NIE berührt.
 *
 * AKKUMULATION (2026-05-29 — Owner-Kern-Feature, zusammengesetzte Website):
 *   1. createStepWorktree(baseBranch=runBranch) — throwaway Step-Worktree +
 *      lazing/step/<stepId>-Branch, gebrancht VOM RUN-TIP (nicht von Live-HEAD).
 *      Dadurch enthält der Worktree alle vorher in den Run gemergten Steps →
 *      Step N sieht Step <N (Komposition). N11-Cap (max 5) wird hier geprüft.
 *   2. spawnInTmux({ workspacePath: worktreePath, allowedTools }) — der CLI
 *      läuft im isolierten Worktree mit --allowedTools <mode-tools> (inkl. Bash
 *      bei FreeRein). ENV env -i-gescrubbt, K1 --disallowedTools hart.
 *   3. exit=0 → mergeStepIntoRun(runBranch ← stepBranch) UNTER dem Per-runId-
 *      Mutex (serialiserter --no-ff Merge). Konflikt → Step 'failed' +
 *      writeDecision(Konflikt-Diff). Der Run-Branch akkumuliert so Schritt für
 *      Schritt die gesamte Website.
 *   4. finally: captureWorktreeDiff (BLEIBT, N8-Trace) + discardStepWorktree
 *      (nur Step-Worktree+Step-Branch). Der RUN-Branch wird NIE verworfen.
 *
 * Merge in den Live-Baum (main) ist weiterhin GATED (mergeRunWorktree wirft;
 * Operator-Merge = Schritt 4, nicht hier).
 *
 * Fehler-isoliert: wirft bei Worktree-Cap/Spawn-Fehler — der Caller (runStep)
 * fängt das und markiert NUR diesen Step 'failed'.
 */
async function runRealSpawnIsolated(opts: {
  step: WorkstreamPlanStepRow;
  stepRole: string;
  repoPath: string;
  workspaceId: string;
  workstreamId: string;
  coordKey: string;
  /** AKKUMULATION: der akkumulierende Run-Branch (lazing/run/<runId>). */
  runBranch: string;
  /** Per-runId-Mutex: serialisiert mergeStepIntoRun (Git-Index-Lock). */
  serializeMerge: <T>(fn: () => Promise<T>) => Promise<T>;
  allowedTools: readonly string[];
  originalIntent: string;
  stepNumber: number;
  totalSteps: number;
  signal: AbortSignal;
  /** W2.1: verbindliches Design-System (gerendert) — nur bei website-Runs. */
  sharedDesignContext?: string;
  /** W2.1: bisherige Artefakte (Pfad-Hints) — nur bei website-Runs. */
  priorArtifacts?: string;
}): Promise<string> {
  const {
    step, stepRole, repoPath, workspaceId, workstreamId, coordKey,
    runBranch, serializeMerge,
    allowedTools, originalIntent, stepNumber, totalSteps,
    sharedDesignContext, priorArtifacts,
  } = opts;

  // stepId: stabil + SAFE_ID_RE-konform (createStepWorktree validiert hart).
  // Step-IDs haben Form 'STEP-<ulid>' → bereits [A-Za-z0-9-]; defensiv sanitisiert.
  const stepIdSafe = step.id.replace(/[^A-Za-z0-9_:.\-]/g, '-').slice(0, 56) || 'step';
  const wsId = workspaceId.replace(/[^A-Za-z0-9_:.\-]/g, '-').slice(0, 50) || 'ws';

  // 1. Step-Worktree VOM RUN-TIP erzeugen (N11-Cap hier; wirft bei Erschöpfung).
  const { worktreePath, stepBranch } = await createStepWorktree({
    repoPath,
    workspaceId: wsId,
    stepId: stepIdSafe,
    baseBranch: runBranch,
  });
  console.info(
    `[plan-executor][accumulate] step=${step.id} worktree=${worktreePath} ` +
      `step-branch=${stepBranch} base=${runBranch} ` +
      `allowedTools=${JSON.stringify(allowedTools)} (vom Run-Tip gebrancht; Live unberührt)`,
  );

  // Basis-SHA = aktueller Run-Tip (NICHT Live-HEAD). So erfasst der Diff in der
  // verlustfreien Persistenz nur die DELTA-Arbeit dieses Steps gegen den Run.
  let baseSha: string | null = null;
  try {
    const r = await execFileAsync('git', ['-C', repoPath, 'rev-parse', runBranch]);
    baseSha = (r.stdout || '').trim() || null;
  } catch {
    baseSha = null;
  }

  // Wird im try gesetzt, im finally für den Merge-vor-discard-Entscheid gelesen.
  let spawnSucceeded = false;

  try {
    const systemPrompt = buildExecSystemPrompt({ role: stepRole });
    const userPrompt = buildStepPrompt({
      role: stepRole,
      originalIntent,
      stepIndex: stepNumber,
      totalSteps,
      title: step.title,
      rationale: step.rationale,
      execute: true,
      ...(sharedDesignContext ? { sharedDesignContext } : {}),
      ...(priorArtifacts ? { priorArtifacts } : {}),
    });

    // FS-2/FS-3 (2026-05-26): FS-Sandbox-Spec — DARK-BUT-READY. Vollständig
    // verdrahtet, aber NUR aktiv wenn LAZYOS_FS_SANDBOX='on' explizit gesetzt
    // ist. Ziel-Posture ist enforce-by-default (eine Sicherheits-Restriktion
    // gehört nicht hinter ein Opt-in); dieser ERSTE Executor-Rollout ist bewusst
    // konservativ opt-in, bis MAX-Auth-unter-Sandbox im echten claude+tmux-Pfad
    // empirisch verifiziert ist — sonst Risiko, Live-Spawns zu brechen, während
    // der Owner testet. Flip zu enforce-default = diese eine Bedingung lockern.
    let sandboxSpec:
      | import('@/lib/security/fs-sandbox').FsSandboxSpec
      | undefined;
    if (process.env.LAZYOS_FS_SANDBOX === 'on') {
      try {
        const { buildSandboxSpec } = await import('@/lib/security/fs-sandbox');
        const { resolveWorkspaceRoots } = await import('@/lib/workspaces/fs-roots');
        const { getDb } = await import('@/db/client');
        // FS-2: voller Pfad-Satz des Workspace (primary + ro/rw-Roots).
        const resolved = resolveWorkspaceRoots(getDb().$raw, workspaceId);
        sandboxSpec = buildSandboxSpec({
          worktreePath, // rw, isoliert — NIE der Live-Root
          roRoots: resolved.roRoots.map((r) => r.absPath),
          liveGitDir: `${repoPath}/.git`, // sonst brechen git-Ops im Worktree
          homeDir: process.env.HOME ?? '/root',
        });
      } catch (e) {
        // Fail-open auf das HEUTIGE Verhalten (env -i + K1, ohne FS-Grenze) —
        // NICHT fail-closed: ein Spec-Bau-Fehler darf den Spawn nicht töten.
        console.warn('[plan-executor][fs-sandbox] spec build failed — spawning WITHOUT sandbox:', e);
        sandboxSpec = undefined;
      }
    }

    // 2. Tool-Spawn im ISOLIERTEN Worktree. Bash nur, wenn in allowedTools
    //    (FreeRein). tmux-spawn sanitisiert via SAFE_TOOLS + env -i + K1.
    const result = await spawnInTmux({
      workspaceId,
      workspacePath: worktreePath, // ← Isolation: NIE der Live-repoPath
      workstreamId,
      // Owner-Direktive (2026-05-29): ausschließlich Opus für agentische Arbeit
      // (MAX-Plan, Qualität vor Kosten). MODEL_NAMES.opus = single source of truth.
      tier: 'opus',
      agentIdx: 0,
      model: MODEL_NAMES.opus,
      systemPrompt,
      userPrompt,
      // 2026-05-29 (empirisch): ein realer Coding-Step (z.B. Motion-Layer) braucht
      // ~120s, größere Steps (Hero-Section, App-Scaffold, Multi-File-Komponenten)
      // 5–15 min. Mit --output-format json gibt es bis zum Ende KEIN Teil-Log →
      // ein zu kurzer Timeout killt echte, laufende Arbeit mittendrin (exit=-1,
      // 0 Tokens) UND der Worktree wird verworfen → Arbeit verloren. Owner-Prinzip
      // Qualität>Tempo (Wochen ok) ⇒ großzügige 20 min/Step.
      timeoutMs: 1_200_000,
      maxTurns: 30,
      allowedTools: [...allowedTools], // inkl. Bash bei FreeRein
      sandboxSpec, // FS-3: undefined außer LAZYOS_FS_SANDBOX='on'
    });

    // N8: echter Tool-Lauf auditiert.
    console.info(
      `[plan-executor][tool-run] step=${step.id} exit=${result.exitCode} ` +
        `tokensOut=${result.tokens.output} timedOut=${result.timedOut} rateLimited=${result.rateLimited}`,
    );

    // ── AKKUMULATION: bei exit=0 die Step-Arbeit in den Run-Branch mergen ─────
    //
    // Nur ein erfolgreicher Spawn (exitCode 0, kein Timeout) darf akkumulieren.
    // Wir committen die (ggf. uncommitteten) Änderungen des Agenten auf den
    // Step-Branch, dann mergen wir SERIELL (Per-runId-Mutex) --no-ff in den
    // Run-Branch. Konflikt → Step failt + writeDecision(Konflikt-Diff, N8/N1).
    if (result.exitCode === 0 && !result.timedOut) {
      // ── W1.1 NON-EMPTY-DIFF-GATE (2026-05-30) ────────────────────────────
      // Der schwache `exit=0`-Gate winkte bisher leere No-op-Merges durch (der
      // Coder schrieb nur eine .md-Notiz oder gar nichts → Run-Tip blieb stehen).
      // Jetzt: nach `git add -A` prüfen, ob der Worktree-Diff gegen den Run-Tip
      // (baseSha) NICHT-LEER ist. Leerer Diff → Step `failed` (no_artifact),
      // KEIN stiller Merge. Reuse captureWorktreeDiff (fail-soft, wirft nie).
      await execFileAsync('git', ['-C', worktreePath, 'add', '-A']).catch(() => {});
      const artifactDiff = await captureWorktreeDiff(worktreePath, baseSha);
      // ROLLEN-AUSNAHME (Critic 2026-05-30): das Gate gilt NUR für Rollen, von
      // denen ein Datei-Artefakt erwartet wird (describeArtifactContract != null —
      // coder/architect/copy/design/assembly). reviewer/tester/analyst schreiben
      // bewusst nichts → kein no_artifact-Fail (sonst blockieren sie die Kette).
      const expectsArtifact =
        describeArtifactContract(step.subagentRole ?? '', step.title) !== null;
      if (expectsArtifact && !artifactDiff) {
        try {
          writeDecision({
            workspaceId,
            workstreamId,
            coordKey,
            decisionKind: 'route',
            actor: 'policy',
            rationale:
              `no_artifact=true step=${step.id} step_branch=${stepBranch} ` +
              `run_branch=${runBranch} — exit=0 aber LEERER Worktree-Diff gegen den ` +
              `Run-Tip (keine Datei geschrieben). Step gilt als fehlgeschlagen; ` +
              `KEIN No-op-Merge. (W1.1 Artefakt-Vertrag verletzt.)`,
          });
        } catch { /* writeDecision best-effort */ }
        console.warn(
          `[plan-executor][accumulate] step=${step.id} NO_ARTIFACT — exit=0, aber leerer ` +
            `Diff gegen ${runBranch}. Step failt, kein Merge.`,
        );
        throw new Error(
          `NO_ARTIFACT: step ${step.id} (${step.title}) hat exit=0, aber KEINE Datei ` +
            `geschrieben (leerer Worktree-Diff). Artefakt-Vertrag verletzt — ` +
            `kein No-op-Merge.`,
        );
      }

      spawnSucceeded = true;

      // 1. Step-Arbeit committen, damit der Merge sie trägt (der Agent committet
      //    nicht zwingend selbst). add -A schon oben erledigt. Der Diff ist
      //    garantiert nicht-leer (Gate oben), commit kann also nur durch echte
      //    Konflikte/Lock fehlschlagen — dann fail-soft (Merge-Gate fängt's).
      try {
        await execFileAsync('git', [
          '-C', worktreePath, '-c', 'user.name=lazing', '-c', 'user.email=lazing@local',
          'commit', '-m', `step ${step.id}: ${step.title}`,
        ]).catch(() => { /* defensiv: ggf. schon committet → Merge trägt es */ });
      } catch (e) {
        console.warn(
          `[plan-executor][accumulate] step=${step.id} commit-staging failed (non-fatal): ` +
            (e instanceof Error ? e.message : String(e)),
        );
      }

      // 2. SERIELLER Merge in den Run-Branch (Mutex hält Git-Index-Lock fern).
      const merge = await serializeMerge(() =>
        mergeStepIntoRun({ repoPath, runBranch, stepBranch }),
      );

      if (!merge.merged) {
        // Konflikt: NICHT akkumuliert. Tamper-evidente Decision (N8/N10) mit
        // verbatim Konflikt-Diff (N1), dann Step als failed signalisieren
        // (throw → runStep-catch setzt 'failed').
        const conflictDetail = merge.conflict ?? '(kein Detail)';
        try {
          writeDecision({
            workspaceId,
            workstreamId,
            coordKey,
            decisionKind: 'route',
            actor: 'policy',
            rationale:
              `merge_conflict=true step=${step.id} step_branch=${stepBranch} ` +
              `run_branch=${runBranch} — Step NICHT in den Run akkumuliert. ` +
              `conflict_detail (verbatim, N1):\n${conflictDetail}`,
          });
        } catch { /* writeDecision best-effort */ }
        console.warn(
          `[plan-executor][accumulate] step=${step.id} MERGE-KONFLIKT gegen ${runBranch} — ` +
            `Step failt, Arbeit bleibt im Trace (captureWorktreeDiff). Detail: ${conflictDetail}`,
        );
        throw new Error(
          `MERGE_CONFLICT: step ${step.id} (${stepBranch}) konnte nicht in ${runBranch} ` +
            `gemergt werden:\n${conflictDetail}`,
        );
      }

      console.info(
        `[plan-executor][accumulate] step=${step.id} in ${runBranch} gemergt (--no-ff) — ` +
          `nachfolgende Steps sehen diese Arbeit.`,
      );
    }

    const head = spawnSucceeded
      ? `[ausgeführt + in Run-Branch ${runBranch} akkumuliert — Merge in Live bleibt gated]\n`
      : `[ausgeführt im Step-Worktree ${stepBranch} (exit=${result.exitCode}) — NICHT akkumuliert]\n`;
    return head + (result.text || '(kein Output)');
  } finally {
    // 2b. VERLUSTFREIE PERSISTENZ vor dem discard (Schritt 1 Akkumulations-Plan,
    //     BLEIBT): die Delta-Arbeit des Step-Worktrees (gegen den Run-Tip) als
    //     Patch in den Trace (workstream_evidence, N8) sichern, BEVOR der
    //     Step-Worktree verworfen wird. Bei erfolgreichem Merge ist die Arbeit
    //     ohnehin im Run-Branch (recoverbar); bei Konflikt/Fehler ist DAS hier
    //     die Recovery-Quelle. Strikt fail-soft (captureWorktreeDiff wirft nie).
    try {
      const captured = await captureWorktreeDiff(worktreePath, baseSha);
      if (captured) {
        const snippet =
          `[step-worktree-diff] step=${step.id} branch=${stepBranch} merged=${spawnSucceeded}\n` +
          `--- stat ---\n${captured.stat}\n--- diff (verbatim, N1) ---\n${captured.diff}`;
        writeEvidence({
          workspaceId,
          workstreamId,
          coordKey: `${workspaceId}/${workstreamId}`,
          sourceKind: 'spawn',
          sourceId: step.id,
          snippet, // N1: verbatim, kein slice
          actor: 'agent',
        });
        console.info(
          `[plan-executor][persist] step=${step.id} Step-Diff im Trace gesichert ` +
            `(${captured.diff.length} bytes; recoverbar trotz discard)`,
        );
      }
    } catch (capErr) {
      console.warn(
        `[plan-executor][persist] Diff-Capture best-effort failed for step=${step.id}: ` +
          `${capErr instanceof Error ? capErr.message : String(capErr)}`,
      );
    }

    // 3. NUR den Step-Worktree + Step-Branch verwerfen. Der RUN-Branch (mit der
    //    akkumulierten Arbeit) BLEIBT — er ist das Kompositions-Ziel. Best-effort.
    await discardStepWorktree({ repoPath, stepBranch, deleteBranch: true }).catch(
      (err: unknown) => {
        console.warn(
          `[plan-executor][accumulate] discardStepWorktree best-effort failed for ` +
            `step=${step.id} stepBranch=${stepBranch}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      },
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Prompt-Builder
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// W1.4 — Serve + Preview-Emit nach (Auto-)Merge (2026-05-30)
// ────────────────────────────────────────────────────────────────────────────
//
// NACH erfolgreichem Merge die zusammengesetzte Website statisch serven (lokal +
// optional Tailscale via LAZYOS_SERVE_LOCAL) und eine tappbare <surface:preview>-
// Karte emittieren (reuse renderPreview, SurfaceRenderer NICHT editiert). Strikt
// best-effort/fail-soft: ein Serve-/Emit-Fehler darf den Merge-Pfad nie kippen.
// Gemeinsamer Einhängepunkt für den Auto-Merge-Pfad (W1.3) UND die merge-run-API.
export async function emitPreviewAfterMerge(opts: {
  workspaceId: string;
  workstreamId: string;
  planId?: string;
  repoPath: string;
  title: string;
}): Promise<void> {
  const { workspaceId, workstreamId, planId, repoPath, title } = opts;
  try {
    const { serveWorkspaceStatic } = await import('@/lib/deploy/serve-local');
    const serve = await serveWorkspaceStatic({ repoPath, workspaceId });
    // Preview-URL-Priorität:
    //  1. LAZYOS_PREVIEW_BASE_URL (expliziter Reverse-Proxy/Tunnel-Base, z.B. eine
    //     Cloudflare-/ngrok-URL die den Workspace-Serve am Handy erreichbar macht —
    //     umgeht CGNAT/IPv6, wo tailnet/funnel scheitern). Mappt den ganzen Serve
    //     auf die Tunnel-Wurzel (kein :port). Trailing-Slash getrimmt.
    //  2. publicUrl (Tailscale, mobil nur im Tailnet),
    //  3. localUrl (nur lokal).
    // ENV → Laufzeit-Datei `data/public-url` (vom Tunnel-Manager live aktualisiert)
    // → Tailscale-publicUrl → localUrl.
    const previewBase = readPublicBaseOverride();
    const url = previewBase ?? serve.publicUrl ?? serve.localUrl;
    const payload: Record<string, unknown> = {
      url,
      title,
      status: 'ready',
    };
    if (serve.note) payload.note = serve.note;
    await emitChatMessageCompleted({
      workspaceId,
      entityId: ulid(),
      content: `<surface:preview>${JSON.stringify(payload)}</surface:preview>`,
      actor: 'system',
      outcome: 'ok',
      metadata: {
        surfaceKind: 'preview',
        workstreamId,
        ...(planId ? { planId } : {}),
      },
    });
    console.info(
      `[plan-executor][preview] ws=${workspaceId} url=${url} ` +
        `port=${serve.port} spawned=${serve.spawned} public=${serve.publicUrl ?? '(none)'}`,
    );
  } catch (err) {
    console.warn('[plan-executor] Preview-Emit fehlgeschlagen (non-fatal):', err);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// W1.1 — Artefakt-Vertrag pro Skill/Rolle (2026-05-30)
// ────────────────────────────────────────────────────────────────────────────
//
// Jeder Step bekommt einen verbindlichen Ziel-Pfad + Artefakt-Format. Der
// schwache `exit=0`-Gate winkte bisher .md-Notizen als „Erfolg" durch. Mit dem
// Vertrag + dem Non-empty-Diff-Gate (Spawn-Erfolgs-Prüfung) wird ein Step ohne
// echtes Datei-Artefakt als `no_artifact` failed markiert.
//
// Die Skill/Rolle wird heuristisch aus role + title abgeleitet (DE+EN, gegen die
// compose.ts-assignSkill-Keys). N6 deterministisch.

// ───────────────────────────────────────────────────────────────────────────
// BAHN-2 (2026-05-30): PV-Stringing-Step-Erkennung + deterministische Ausführung
// ════════════════════════════════════════════════════════════════════════════
//
// Ein pv-stringing-Step trägt in der DB NUR `subagentRole='coder'` (closed enum,
// db/schema/workstream_plan_steps.ts) — der ORIGINAL-Skill 'pv-stringing' lebt in
// der `| flow:{...}`-Annotation der rationale (lib/flow/execute.ts::annotateRationale).
// Wir erkennen den Step robust über parseFlowAnnotation; ein Titel-Pattern-Fallback
// fängt freie Decompose-Pläne ohne Flow-Annotation (gegen die compose.ts-Keys).
//
// Der Producer (lib/eval/demo-pv/producer.ts) ist DETERMINISTISCH (N6, kein
// LLM/I/O). Er läuft DESHALB im plan-executor VOR dem claude-cli-Spawn-Zweig — er
// schreibt KEINE Datei in den Worktree, sondern erzeugt sein PvArtifact und legt
// es serialisiert als Step-Output ab. Damit umgeht er auch das W1.1-Non-empty-Diff-
// Gate (das nur für echte Spawn-Steps greift); ein deterministischer Producer-Step
// erreicht den Spawn-Pfad gar nicht und kann folglich nicht als no_artifact failen.

/** Marker, mit dem ein deterministisch produziertes PV-Artefakt im Step-Output-Text
 *  serialisiert wird. from-artifact.ts → evaluate.ts liest das geparste Objekt
 *  (surfacePayload.strings[]/inverters[]) als elektrisches Modell. */
export const PV_STRINGING_OUTPUT_MARKER = '<pv-stringing-artifact>';
const PV_STRINGING_OUTPUT_MARKER_END = '</pv-stringing-artifact>';

// Dasselbe Pattern wie die compose.ts-SKILL_RULE für 'pv-stringing' — als Titel-
// Fallback, wenn keine Flow-Annotation vorliegt (freier Decompose-Plan).
const PV_STRINGING_TITLE_RE =
  /\b(string|stringing|wechselrichter|inverter|pv-?auslegung|modulbelegung|photovoltaik|dachbelegung)\b/i;

/**
 * Erkennt deterministisch, ob ein Step der PV-Stringing-Producer-Step ist.
 * Primär über die `| flow:{...}`-Annotation (skill==='pv-stringing'), Fallback
 * über das Titel-Pattern. Exportiert für den Wiring-Test.
 */
export function isPvStringingStep(step: WorkstreamPlanStepRow): boolean {
  try {
    const { annotation } = parseFlowAnnotation(step.rationale ?? '');
    if (annotation?.skill && annotation.skill.trim().toLowerCase() === 'pv-stringing') {
      return true;
    }
  } catch {
    /* defensiv: kaputte rationale → Titel-Fallback */
  }
  return PV_STRINGING_TITLE_RE.test(step.title ?? '');
}

/**
 * Extrahiert die Producer-Inputs (RoofPlane[]/Modul/Inverter) aus dem Step-
 * Kontext. Quelle: die `configJson` der `| flow:{...}`-Annotation (Owner-/Flow-
 * gegebene Hardware). §15.6-EHRLICH: fehlt configJson oder eine Eingabe, geben
 * wir KEINE erfundene Default-Hardware zurück — der Producer läuft dann mit
 * leeren/fehlenden Eingaben und erzeugt (gewollt) 0 Strings + verbatim-Grund.
 * Deterministisch (N6), wirft nie.
 *
 * Exportiert für den Wiring-Test.
 */
export function extractStringingInput(
  step: WorkstreamPlanStepRow,
): StringingProducerInput {
  // Default: leere Eingaben → Producer meldet ehrlich „kein Inverter/Modul/Dach".
  const empty: StringingProducerInput = {
    roofPlanes: [],
    module: undefined as unknown as StringingProducerInput['module'],
    inverter: undefined as unknown as StringingProducerInput['inverter'],
  };

  // DEMO-FALLBACK (2026-05-30): Weist der Intent SICH SELBST explizit als
  // Beispiel/Demo/Muster-PV-Lauf aus (Keyword „beispiel"/„demo"/„muster" + PV)
  // UND liegt KEINE owner-gegebene Hardware vor, verwenden wir ein klar
  // ausgewiesenes Demo-Hardware-Set (RoofPlane/Modul/Inverter). §15.6: das ist
  // KEIN heimliches Raten — jede Demo-Größe erscheint als sichtbare
  // `assumptions:[…DEMO-Annahme…]` im Producer-Output. So liefert ein
  // „Erstelle ein Beispiel-PV-Projekt" ein demonstrierbares, G5-PASSendes Paket;
  // für echte Projekte bleibt die Hardware owner-input-abhängig (fehlt sie →
  // ehrlich leer → G5 BLOCKt). Die Demo greift NUR als letzter Ausweg, NIE wenn
  // echte Hardware in der configJson steht.
  const intentText = step.title ?? '';
  const demoFallback = (): StringingProducerInput =>
    isDemoPvIntent(intentText) ? buildDemoStringingInput() : empty;

  let configJson: string | null = null;
  try {
    configJson = parseFlowAnnotation(step.rationale ?? '').annotation?.configJson ?? null;
  } catch {
    configJson = null;
  }
  if (!configJson) return demoFallback();
  try {
    const parsed: unknown = JSON.parse(configJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return demoFallback();
    const o = parsed as Record<string, unknown>;
    // Echte Hardware gegeben? Nur dann reichen wir die configJson durch. Fehlt
    // sowohl Modul als auch Inverter (kein echter Hardware-Input), fällt ein
    // Demo-PV-Intent auf das Demo-Set zurück (echter Intent ohne Hardware bleibt
    // ehrlich leer).
    const hasRealHardware =
      (o.module && typeof o.module === 'object') ||
      (o.inverter && typeof o.inverter === 'object');
    if (!hasRealHardware) return demoFallback();
    // Wir reichen die gegebenen Felder 1:1 DURCH (der Producer ist defensiv und
    // lässt fehlende/kaputte Eingaben ehrlich leer; KEIN Auffüllen hier).
    return {
      roofPlanes: Array.isArray(o.roofPlanes)
        ? (o.roofPlanes as StringingProducerInput['roofPlanes'])
        : [],
      module: o.module as StringingProducerInput['module'],
      inverter: o.inverter as StringingProducerInput['inverter'],
      ...(o.modulesPerPlane && typeof o.modulesPerPlane === 'object'
        ? { modulesPerPlane: o.modulesPerPlane as Record<string, number> }
        : {}),
      ...(typeof o.tMinC === 'number' ? { tMinC: o.tMinC } : {}),
      ...(typeof o.tMaxC === 'number' ? { tMaxC: o.tMaxC } : {}),
      ...(typeof o.vmpTempCoeffPctPerC === 'number'
        ? { vmpTempCoeffPctPerC: o.vmpTempCoeffPctPerC }
        : {}),
      ...(typeof o.stringIdPrefix === 'string'
        ? { stringIdPrefix: o.stringIdPrefix }
        : {}),
    };
  } catch {
    return demoFallback();
  }
}

/**
 * Führt den deterministischen PV-Stringing-Producer für einen Step aus und
 * serialisiert das Ergebnis als Step-Output-Text. Der Text enthält:
 *   • einen menschen-lesbaren Kopf (Strings/Annahmen/Auslassungen, N1 verbatim),
 *   • einen maschinen-lesbaren `<pv-stringing-artifact>{...}</…>`-Block, dessen
 *     JSON exakt der GenericBuildArtifact-Form entspricht, die from-artifact.ts
 *     konsumiert (surfacePayload.strings[]/inverters[]).
 *
 * Reine Funktion (N6) — kein I/O, kein Spawn, kein Worktree. Exportiert für den
 * Wiring-Test.
 */
export function runPvStringingStep(step: WorkstreamPlanStepRow): string {
  const input = extractStringingInput(step);
  const result = produceStringingPlan(input);

  const headLines: string[] = [
    `[pv-stringing · deterministischer Producer — kein LLM, kein Worktree-Spawn]`,
    `Strings erzeugt: ${result.strings.length}` +
      (result.strings.length > 0
        ? ` (${result.strings.map((s) => `${s.id}:${s.moduleCount}×Modul`).join(', ')})`
        : ''),
    `Stringing-Regel-Verletzungen (Selbst-Verifikation): ${
      result.ruleViolations.length === 0 ? '0 (PASS)' : result.ruleViolations.join(' | ')
    }`,
  ];
  if (result.assumptions.length > 0) {
    headLines.push(
      `Annahmen (sichtbar, §15.6): ` +
        result.assumptions.map((a) => `${a.field}=${a.value} (${a.reason})`).join(' | '),
    );
  }
  if (result.omissions.length > 0) {
    headLines.push(
      `Ausgelassen (ehrlich leer, kein Raten): ` +
        result.omissions
          .map((om) => `${om.roofPlaneId ?? '(global)'}: ${om.reason}`)
          .join(' | '),
    );
  }

  const artifactJson = JSON.stringify(result.artifact);
  return (
    headLines.join('\n') +
    '\n' +
    PV_STRINGING_OUTPUT_MARKER +
    artifactJson +
    PV_STRINGING_OUTPUT_MARKER_END
  );
}

/**
 * Liest ein zuvor von runPvStringingStep serialisiertes PvArtifact-JSON wieder
 * aus dem Step-Output-Text. Gibt das geparste GenericBuildArtifact-kompatible
 * Objekt zurück oder null (kein Marker / kaputtes JSON). Deterministisch, wirft
 * nie. Exportiert für den Wiring-Test (der die G5-Eval über genau diesen Output
 * laufen lässt).
 */
export function parsePvStringingOutput(text: string): unknown | null {
  if (typeof text !== 'string') return null;
  const start = text.indexOf(PV_STRINGING_OUTPUT_MARKER);
  if (start === -1) return null;
  const from = start + PV_STRINGING_OUTPUT_MARKER.length;
  const end = text.indexOf(PV_STRINGING_OUTPUT_MARKER_END, from);
  if (end === -1) return null;
  try {
    return JSON.parse(text.slice(from, end));
  } catch {
    return null;
  }
}

/**
 * W2.1 (2026-05-30): fasst die bisher produzierten Step-Outputs als kompakte
 * „bisherige Artefakte"-Liste zusammen (Titel + erwarteter Ziel-Pfad), damit der
 * nächste Step weiß, worauf er aufbaut. N1: Titel verbatim (kein .slice).
 */
function summarizePriorArtifacts(
  outputs: ReadonlyArray<{ step: WorkstreamPlanStepRow; text: string }>,
): string | undefined {
  if (outputs.length === 0) return undefined;
  const lines = outputs.map((o) => {
    const contract = describeArtifactContract(o.step.subagentRole ?? '', o.step.title);
    const pathHint = contract ? contract.split('\n')[0] : '(kein Datei-Artefakt)';
    return `- Schritt „${o.step.title}" → ${pathHint}`;
  });
  return lines.join('\n');
}

/**
 * Liefert den verbindlichen Artefakt-Vertrag (Pfad + Format) für einen Step.
 * Exportiert für den W1.1-Test (Artefakt-Vertrag ist Teil des Gates).
 */
export function describeArtifactContract(role: string, title: string): string | null {
  const r = (role || '').toLowerCase();
  const t = (title || '').toLowerCase();

  // assembly — der finale Zusammenbau (eigener Skill, höchste Priorität).
  if (r === 'assembly' || /\b(assembl|zusammenbau|zusammensetz|finale.+seite|index\.html)\b/.test(t)) {
    return [
      `Ziel-Datei: \`index.html\` im Workspace-Root.`,
      `Lies ALLE Fragmente im Worktree (\`design/tokens.css\`, \`content/site.config.json\`,`,
      `etwaige Sektions-Dateien) und baue daraus EINE ansehbare, in sich vollständige`,
      `\`index.html\`: verlinke/inline \`design/tokens.css\`, rendere die Sektionstexte aus`,
      `\`content/site.config.json\` gegen den Sektions-Katalog des Design-Systems.`,
      `Plain HTML/CSS — im Browser OHNE Build-Tool ansehbar. Platzhalter-Bilder =`,
      `CSS-Gradient oder inline-SVG (KEINE externen/Connector-Assets).`,
    ].join('\n');
  }
  // design → CSS-Custom-Properties.
  if (r === 'design' || /\b(design|style|styling|visual|theme|farb|gestalt|branding|mockup)\b/.test(t)) {
    return [
      `Ziel-Datei: \`design/tokens.css\` (CSS-Custom-Properties unter \`:root\`).`,
      `Tokenisiere das verbindliche Design-System als echte CSS-Variablen (--ink,`,
      `--accent, --sheet, Spacing-Scale, Type-Scale …). KEINE Markdown-Datei,`,
      `KEINE Erklärung. Wähle NUR Akzent + Stimme INNERHALB des Systems`,
      `(nenne deinen gewählten Akzent als \`/* accent: <key> */\`).`,
    ].join('\n');
  }
  // copywriting → site.config.json.
  if (r === 'copy' || r === 'copywriting' || /\b(copy|text|texte|caption|headline|slogan|wording|inhalt)\b/.test(t)) {
    return [
      `Ziel-Datei: \`content/site.config.json\` (gültiges JSON).`,
      `Schreibe die Sektions-Texte als JSON-Objekt, je Sektion (hero/features/proof/`,
      `cta/footer) die im Design-System genannten Inhalts-Felder. KEINE Prosa-Datei,`,
      `KEIN Markdown — striktes JSON, das der Assembly-Step parsen kann.`,
    ].join('\n');
  }
  // architecture/aufbau → index.html-Gerüst.
  if (r === 'architect' || r === 'architecture' || /\b(aufbau|struktur|architektur|architecture|setup|layout|gerüst|scaffold)\b/.test(t)) {
    return [
      `Ziel-Datei: \`index.html\` im Workspace-Root — das STRUKTUR-Gerüst.`,
      `Lege das semantische HTML-Skelett der Seite an: \`<section>\`-Container für`,
      `hero/features/proof/cta/footer (in dieser Reihenfolge), \`<link>\` auf`,
      `\`design/tokens.css\`. Noch keine finalen Texte (die füllt copy/assembly) —`,
      `aber valide, im Browser ladbare HTML-Datei. KEINE Markdown-Notiz.`,
    ].join('\n');
  }
  // coder / generischer Worker → konkrete Datei im Workspace-Root.
  if (r === 'coder' || r === 'build') {
    return [
      `Ziel: eine konkrete, ladbare Datei im Workspace-Root (z.B. ein HTML/CSS/JS-`,
      `Fragment dieser Sektion). KEINE Markdown-Notiz, KEIN reiner Vorschlags-Text —`,
      `schreibe das Artefakt als echte Datei mit dem \`Write\`-Tool.`,
    ].join('\n');
  }
  // reviewer/tester u.a. — kein Datei-Artefakt erzwungen (Default-Verhalten).
  return null;
}

/**
 * Baut den Prompt für einen einzelnen Plan-Step.
 *
 * `execute: false` (Default / text-only): das Prompt verbietet explizit
 *   Code-Ausführung, Datei-Writes oder Shell-Calls — rein textueller Vorschlag.
 * `execute: true` (echter Tool-Spawn im isolierten Worktree): das Prompt
 *   erlaubt die Umsetzung mit den gewährten Tools, weist aber darauf hin, dass
 *   alles im isolierten Worktree passiert (kein Merge ohne Operator-Gate).
 */
function buildStepPrompt(opts: {
  role: string;
  originalIntent: string;
  stepIndex: number;
  totalSteps: number;
  title: string;
  rationale: string;
  execute?: boolean;
  /**
   * W2.1 (2026-05-30): das verbindliche Website-Design-System +
   * der vom design-Step gewählte Akzent — vorwärts gereicht an JEDEN
   * nachfolgenden coder/copy/assembly-Step. Nur gesetzt für website-artige
   * Runs (sonst undefined → bit-identisch zum Vor-W2.1-Verhalten).
   */
  sharedDesignContext?: string;
  /**
   * W2.1 (2026-05-30): die bisher produzierten Artefakte (Pfad → kurze
   * Beschreibung), die der Step lesen/respektieren soll. Vorwärts-Verkettung
   * der schon gesammelten stepOutputs. Nur gesetzt für website-artige Runs.
   */
  priorArtifacts?: string;
}): string {
  // W1.1 (2026-05-30): pro Skill ein verbindlicher Artefakt-Vertrag. Der Step
  // MUSS eine konkrete Datei schreiben — keine .md-Erklärung. Das Artefakt IST
  // das Ergebnis. Leerer Worktree-Diff → der Spawn-Gate failt den Step
  // (no_artifact) statt eines stillen No-op-Merge.
  const artifactContract = describeArtifactContract(opts.role, opts.title);

  if (opts.execute) {
    const lines: string[] = [
      `Du bist ein ${opts.role}-Agent im laz.ing Swarm Runtime.`,
      ``,
      `Plan-Kontext: "${opts.originalIntent}"`,
      ``,
      `Schritt ${opts.stepIndex}/${opts.totalSteps}: ${opts.title}`,
      `Begründung: ${opts.rationale}`,
      ``,
    ];
    if (opts.sharedDesignContext) {
      lines.push(opts.sharedDesignContext, ``);
    }
    if (opts.priorArtifacts) {
      lines.push(
        `── BISHERIGE ARTEFAKTE (lies + respektiere sie, baue darauf auf) ──`,
        opts.priorArtifacts,
        `── ENDE ARTEFAKTE ──`,
        ``,
      );
    }
    if (artifactContract) {
      lines.push(
        `── ARTEFAKT-VERTRAG (VERBINDLICH) ──`,
        artifactContract,
        `WICHTIG: Schreibe mit dem \`Write\`-Tool die oben genannte Datei.`,
        `Das ARTEFAKT (die Datei) IST das Ergebnis — KEINE Markdown-Erklärung,`,
        `KEINE Notiz-Datei, KEIN Vorschlags-Text. Wenn am Ende keine Datei`,
        `geschrieben wurde, gilt der Schritt als FEHLGESCHLAGEN (no_artifact).`,
        `── ENDE VERTRAG ──`,
        ``,
      );
    }
    lines.push(
      `Setze diesen Schritt mit den dir gewährten Tools um.`,
      `WICHTIG: Du arbeitest in einem ISOLIERTEN Git-Worktree (throwaway).`,
      `Der Live-Code-Baum ist NICHT betroffen — ein Merge passiert nur nach`,
      `expliziter Operator-Freigabe. Mache fokussierte, nachvollziehbare Änderungen.`,
    );
    return lines.join('\n');
  }
  return [
    `Du bist ein ${opts.role}-Agent im laz.ing Swarm Runtime.`,
    ``,
    `Plan-Kontext: "${opts.originalIntent}"`,
    ``,
    `Schritt ${opts.stepIndex}/${opts.totalSteps}: ${opts.title}`,
    `Begründung: ${opts.rationale}`,
    ``,
    `Skizziere KURZ (max 8 Zeilen) konkret WIE du diesen Schritt umsetzen würdest:`,
    `- Welche Dateien / Module wären betroffen?`,
    `- Welches Vorgehen (in 2-3 Stichwörtern)?`,
    `- Welche Risiken oder offene Fragen gibt es?`,
    ``,
    `WICHTIG: KEINE Code-Ausführung, KEINE Datei-Writes, KEINE Shell-Befehle.`,
    `Nur ein knapper Textvorschlag.`,
  ].join('\n');
}

/** System-Prompt für den echten Tool-Spawn (knapp, rollen-spezifisch). */
function buildExecSystemPrompt(opts: { role: string }): string {
  return [
    `Du bist ein ${opts.role}-Subagent im laz.ing Swarm Runtime.`,
    `Du arbeitest in einem isolierten Git-Worktree. Bleibe beim aktuellen Schritt,`,
    `vermeide Seiteneffekte außerhalb des Worktrees, dokumentiere deine Änderungen knapp.`,
  ].join('\n');
}

// ────────────────────────────────────────────────────────────────────────────
// Summary-Builder (nach group_id gruppiert)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Baut den Content für die abschließende Assistant-Nachricht.
 * "Nach Fertigstellung aller Subpläne nach Zugehörigkeit sortieren" =
 * gruppiert nach group_id; Steps ohne Gruppe landen unter "(ungruppiert)".
 */
function buildSummaryContent(
  originalIntent: string,
  outputs: Array<{ step: WorkstreamPlanStepRow; text: string }>,
): string {
  // Nach group_id bucketieren — Reihenfolge der Gruppen = erstes Auftreten.
  const groupOrder: string[] = [];
  const buckets = new Map<string, Array<{ step: WorkstreamPlanStepRow; text: string }>>();
  for (const o of outputs) {
    const key = readGroupId(o.step) ?? '(ungruppiert)';
    if (!buckets.has(key)) {
      buckets.set(key, []);
      groupOrder.push(key);
    }
    buckets.get(key)!.push(o);
  }

  const lines: string[] = [
    `Plan-Ausführung abgeschlossen.`,
    `Vorhaben: ${originalIntent}`,
    ``,
  ];

  const multiGroup = groupOrder.length > 1;
  for (const groupKey of groupOrder) {
    if (multiGroup) {
      lines.push(`### Gruppe: ${groupKey}`, ``);
    }
    const bucket = buckets.get(groupKey)!;
    // Innerhalb der Gruppe nach stepIndex stabil sortieren.
    bucket.sort((a, b) => a.step.stepIndex - b.step.stepIndex);
    for (const { step, text } of bucket) {
      lines.push(
        `**Schritt ${step.stepIndex}: ${step.title}**`,
        `Rolle: ${step.subagentRole ?? 'coder'} | Begründung: ${step.rationale}`,
        ``,
        text.trim(),
        ``,
      );
    }
  }
  return lines.join('\n');
}
