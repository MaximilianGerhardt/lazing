// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// lib/features/catalog — feature catalog of the laz.ing add-ons on top of
// Claude Code / Codex (research-first, file:line-backed).
//
// This file is PURE DATA (no I/O, no LLM, no DB). It is the
// canonical index of what laz.ing has built ON TOP of raw `claude` / `codex`
// in terms of feature layers. Each entry carries:
//   - Function (what it does)
//   - Mechanism (how it works, file:line-backed)
//   - Improves (what it improves over the raw CLI)
//   - useCases (concrete owner scenarios)
//   - beforeAfter OR prosCons (1 clear contrast)
//   - refs[] (file:line links for deep research)
//   - status (live | dev | planned | deferred | owner-gated)
//   - onTop (claude-code | codex | both | standalone)
//
// Discipline:
//   - N1 (Detail preservation): no texts shortened; rationale verbatim.
//   - N6 (determinism): pure data — same build → same catalog.
//   - N4 (Recovery before reinvent): file:line refs point exactly at the
//     existing code that carries this feature layer; nothing invented.
//
// Sort order within a category deliberately chosen:
//   live > owner-gated > dev > planned > deferred.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FeatureStatus = 'live' | 'dev' | 'planned' | 'deferred' | 'owner-gated';

export type FeatureCategory =
  | 'CLI-on-Top'
  | 'Chat-Surfaces'
  | 'Workstream/Plan-Executor'
  | 'Swarm/Plan'
  | 'Critic/Devil-Advocate'
  | 'Self-Learning'
  | 'Flow Studio'
  | 'Connectors/SOP'
  | 'Skills/Roles'
  | 'Security/Sandbox'
  | 'RAG/Knowledge';

export type FeatureOnTop = 'claude-code' | 'codex' | 'both' | 'standalone';

export interface FeatureRef {
  /** Human-readable label, e.g. `spawnInTmux` or `SURFACE_KINDS`. */
  readonly label: string;
  /** Relative repo path, optionally with a `:<line>` suffix. */
  readonly path: string;
}

export interface FeatureBeforeAfter {
  readonly before: string;
  readonly after: string;
}

export interface FeatureProsCons {
  readonly pros: readonly string[];
  readonly cons: readonly string[];
}

export interface Feature {
  /** Slug — stable, kebab-case, unique. */
  readonly id: string;
  /** Verbatim name, as it appears in the code/doc (N1). */
  readonly name: string;
  readonly category: FeatureCategory;
  readonly status: FeatureStatus;
  readonly onTop: FeatureOnTop;
  /** What it does. 1-3 sentences. */
  readonly function: string;
  /** How it works, with file:line references in the prose. */
  readonly mechanism: string;
  /** What it improves over the raw CLI / the previous state. */
  readonly improves: string;
  /** Concrete owner scenarios. */
  readonly useCases: readonly string[];
  /** When before/after is clearer. */
  readonly beforeAfter?: FeatureBeforeAfter;
  /** When pros/cons is clearer (not mutually exclusive with beforeAfter). */
  readonly prosCons?: FeatureProsCons;
  /** At least 1 ref. */
  readonly refs: readonly FeatureRef[];
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const FEATURE_CATALOG: readonly Feature[] = [
  // =========================================================================
  // CLI-on-Top — how laz.ing embeds the raw `claude` / `codex`
  // =========================================================================
  {
    id: 'claude-cli-stream-json-session',
    name: 'Claude-CLI Stream-JSON Session-Resume',
    category: 'CLI-on-Top',
    status: 'live',
    onTop: 'claude-code',
    function:
      'Bindet `claude --print --input-format=stream-json --output-format=stream-json --include-partial-messages --session-id=<uuid>` als persistente Pro-Workspace-Session ein. Eine `--session-id` + `--resume <uuid>`-Kombination hält den Context Cross-Request lebendig, ohne dass ein langlebiger `claude`-Prozess im tmux-Pane gehalten werden muss.',
    mechanism:
      'Pro /chat-Request EIN claude-CLI-Aufruf, der die per-Workspace gespeicherte Session-ID resumiert. Der tmux-Pane (`lazyos-ws-<id>`) bleibt parallel als humanes Attach-Surface stehen, ist aber NICHT auf dem Request-Pfad (workspace-session.ts:5-31). Stream-Frames (message_start, content_block_delta, tool_use, tool_result, result-message) werden direkt aus stdout geparst.',
    improves:
      'Statt fragiler tmux-`send-keys`+`capture-pane`-Heuristiken (ANSI-Stripping, ●-Marker-Sniffing, Pane-Wrapping-Probleme) eine robuste JSONL-Stream-Pipeline mit echter Session-Persistenz auf Disk.',
    useCases: [
      'Owner schreibt 10 Nachrichten an einen Workspace — claude erinnert sich nahtlos, ohne dass laz.ing System-Prompts wiederholt einspeist.',
      'Service-Restart von lazyos-web (4200) verliert keinen Workspace-Kontext: Session-ID liegt in der DB.',
      'Owner kann parallel `tmux attach -t lazyos-ws-<id>` für Ad-hoc-Terminal-Work nutzen.',
    ],
    beforeAfter: {
      before:
        'Live-`claude`-Prozess pro Workspace in einem tmux-Pane, gesteuert via send-keys + capture-pane. ANSI-Drift + Wrapping → fragiles Parsing; PWA-Close oder Service-Restart killte den Pane → Kontextverlust.',
      after:
        'Stateless Pro-Request-Invocation mit --resume <session-id>. Session liegt auf Disk in ~/.claude/.../session-<uuid>; Stream-JSON ist stabil über claude-Versionen; tmux-Pane optional.',
    },
    refs: [
      { label: 'workspace-session.ts:5-31 (Architektur-Hinweise)', path: 'server/workspace-session.ts' },
      { label: 'claudeCli engine adapter', path: 'lib/llm/engines/claude-cli.ts' },
    ],
  },
  {
    id: 'chat-tool-access-resolver',
    name: 'Chat-Tool-Access Resolver (--allowedTools für Bash/Web)',
    category: 'CLI-on-Top',
    status: 'owner-gated',
    onTop: 'claude-code',
    function:
      'Stellt sicher, dass im Live-Chat tatsächlich Bash/WebFetch/WebSearch laufen können — gated durch den Workspace-Permission-Modus. Default ohne Mode = nur Edits (heutiges sicheres Verhalten); freerein/freerein-with-audit = volle Tool-Vorab-Genehmigung.',
    mechanism:
      'Bug-Root-Cause (verbatim, workspace-session.ts:116-131): `--print --permission-mode=acceptEdits` ohne `--allowedTools` akzeptiert nur Datei-Edits non-interaktiv; Bash/WebFetch/WebSearch wurden still verweigert. resolveChatToolAccess(workspaceId) liest aus `lazyos_permission_modes` und liefert bei freerein die Allowlist `Read,Edit,Write,Bash,Grep,Glob,WebFetch,WebSearch` als EIN comma-separierter argv-Wert (workspace-session.ts:133-154).',
    improves:
      'Schließt die Lücke "Bash/WebFetch laufen im Live-Chat nicht" ohne Permission-Schutz zu schwächen. Fail-closed: jeder Fehler/fehlende Row → kein Vollzugriff.',
    useCases: [
      'Owner aktiviert FreeRein für einen Workspace → Chat-Agent kann `npm test` ausführen, Logs zeigen, Web-Recherche machen.',
      'Owner lässt Default-Workspace im ask-Mode → Chat-Agent kann nur Markdown schreiben + Edits vorschlagen.',
    ],
    prosCons: {
      pros: [
        'Per-Workspace einzelner Schalter — kein globales Allow/Deny.',
        'Identische allowedTools-Liste wie der Plan-Executor → konsistentes Verhalten.',
        'Fail-closed bei DB-Fehlern.',
      ],
      cons: [
        'FreeRein-Bash ist ECHTE System-Bash mit Prozess-UID — nicht OS-Sandbox. Die Bash-Path-Policy (siehe Security) ist der pragmatische Guardrail.',
      ],
    },
    refs: [
      { label: 'resolveChatToolAccess', path: 'server/workspace-session.ts:133' },
      { label: 'fullAccess-Spawn-Wiring', path: 'server/workspace-session.ts:1185-1194' },
    ],
  },
  {
    id: 'codex-sandbox-flags',
    name: 'Codex-CLI Dual-Mode Sandbox-Flags',
    category: 'CLI-on-Top',
    status: 'live',
    onTop: 'codex',
    function:
      'Bindet `codex exec` deterministisch in 2 strikt getrennten Modi ein: READ (`-s read-only -a never`, Default für ALLE Caller) und WRITE (`-s workspace-write -a never`, gated durch codexMode==="write" UND ENV LAZYOS_CODEX_WRITE).',
    mechanism:
      'resolveSandboxFlags(codexMode) (codex.ts:55-82): Double-Gate für Write — fehlt eines der beiden Gates → fallback zu read-only mit console.warn. `-s read-only` aktiviert die OS-Level-Codex-Sandbox die alle FS-Writes + Shell-Side-Effects blockt; `-a never` deaktiviert Approval-Prompts (non-interaktiv).',
    improves:
      'Der alte `approval_policy="never"`-`-c`-Override deaktivierte NUR Approvals, aber sandbox-te NICHT die Writes. Das neue Modell trennt Sandbox-Härte (FS-Blocking) von Approval-Polling. Default ist sicher.',
    useCases: [
      'Codex als Read-only-Sparring-Partner im Chat (system-health, parallel-race in orchestrator.ts, smoke-tests).',
      'Codex als gated Write-Executor NUR im R1-Worktree mit explizitem ENV-Gate (kein Live-Checkout).',
    ],
    beforeAfter: {
      before:
        '`approval_policy="never"` per `-c` — Approvals weg, aber Writes ungebremst. Versehentliche Writes in Live-Repo möglich.',
      after:
        'Strikte 2-Modi mit Double-Gate. Default = read-only + no-approval. Write nur bei explizitem opt-in. Fail-closed.',
    },
    refs: [
      { label: 'codex.ts:1-31 (Safety-Architecture)', path: 'lib/llm/engines/codex.ts' },
      { label: 'resolveSandboxFlags', path: 'lib/llm/engines/codex.ts:55' },
    ],
  },
  {
    id: 'spawn-in-tmux',
    name: 'spawnInTmux — TMUX-resilient Tier-Spawn',
    category: 'CLI-on-Top',
    status: 'live',
    onTop: 'both',
    function:
      'Startet Claude-CLI/Codex-CLI-Spawns in einer detached tmux-Session statt direktem child_process.spawn. Überlebt lazyos-web-Restart; Wallclock-Timeout + Rate-Limit-Detection + tpm-Budget-Drosselung bereits eingebaut.',
    mechanism:
      "tmux-spawn.ts:1-21: `tmux new-session -d -s <unique-name> \"bash -c ...\"`, Wrapper schreibt stdout in /tmp-Logfile + touch'ed `.done`-Flag, Caller pollt das Flag. Auth-Fix (2026-05-26): innere Command-Kette verwendet `;` statt `&&` (echter Exit-Code statt blindem Timeout); env-Allowlist erhält USER/LOGNAME/TMPDIR/__CF_USER_TEXT_ENCODING (macOS Keychain-Pflicht für MAX-Auth).",
    improves:
      'PWA-Close + lazyos-web-Restart killen den Spawn NICHT mehr. Die env-Allowlist-Lücke ("env -i strippte macOS-Keychain-Pflicht-Vars" → exit 1 → 120s-Timeout statt echtem Fehler) ist geschlossen.',
    useCases: [
      'Multi-Agent-Tier-Spawn (Lead + Roaster + Synthesis) ohne dass PWA-Close den Run abbricht.',
      'Bug-Fix-Swarm 3 parallele Diagnose-Spawns + 1 Fix-Spawn — alle in eigenen tmux-Sessions.',
      'Plan-Executor pro Step ein eigener Spawn unter FreeRein/Lane mit Worktree-Isolation.',
    ],
    refs: [
      { label: 'spawnInTmux', path: 'server/agents/tmux-spawn.ts:127' },
      { label: 'SpawnArgs (Tool-Whitelist, Sandbox-Spec, Sub-Workstream)', path: 'server/agents/tmux-spawn.ts:48' },
    ],
  },
  {
    id: 'engine-selector',
    name: 'ChatEngine Selector + Auth-Detect',
    category: 'CLI-on-Top',
    status: 'live',
    onTop: 'both',
    function:
      'Vereinheitlicht claude-cli, codex und ollama hinter einer ChatEngine-Schnittstelle mit `detect()`-Preflight, das Installation + Auth-Hint (max-plan | api-key | not-authenticated) liefert.',
    mechanism:
      'claude-cli.ts:14-66: Auth-Detect prüft ~/.claude/.credentials.json + ~/.config/claude-code/auth.json + macOS-Keychain ("Claude Code-credentials" via `security find-generic-password`) + ANTHROPIC_API_KEY-Fallback. codex.ts:84-101: prüft ~/.codex/auth.json + OPENAI_API_KEY. selector.ts wählt pro Request die richtige Engine.',
    improves:
      'Vorher waren Auth-Checks im Chat-Pfad verstreut + nicht macOS-Keychain-bewusst (false-negative not-authenticated obwohl MAX-Plan eingeloggt war).',
    useCases: [
      'system-health-Endpoint zeigt Owner zuverlässig welche Engine aktuell verfügbar ist.',
      'Engine-Pill im Chat-Header zeigt Live-Status.',
      'Engine-Adapter ist im Test stubbar (DevilsAdvocateEngine, Plan-Decompose-Wrapper).',
    ],
    refs: [
      { label: 'claude-cli engine + Keychain-Probe', path: 'lib/llm/engines/claude-cli.ts' },
      { label: 'codex-cli engine', path: 'lib/llm/engines/codex.ts' },
      { label: 'engine selector', path: 'lib/llm/engines/selector.ts' },
    ],
  },

  // =========================================================================
  // Chat-Surfaces — the XML-ish surface-tag language + renderer
  // =========================================================================
  {
    id: 'surface-tag-protocol',
    name: '<surface:*>-Tag-Protokoll + Streaming-Parser',
    category: 'Chat-Surfaces',
    status: 'live',
    onTop: 'claude-code',
    function:
      'Lässt den LLM strukturierte UI-Cards inline emittieren über XML-ish Tags wie `<surface:chart>{json}</surface:chart>`. Der Parser ist eine Streaming-State-Machine, die Tokens in arbitrary Chunk-Boundaries verträgt + JSON-Invalid-Fallback auf Plain-Text macht. Eine Whitelist (SURFACE_KINDS) gated welche Kinds gerendert werden — unbekannte kommen als Text durch (forward-compatible).',
    mechanism:
      'surface-parser.ts:30-194: 47 whitelisted Surface-Kinds (chart, decision, ticket, invoice, pipeline, prompt, workflow, flow-graph, flow-coupling, live-warn, counter-evidence, ...). parseSurfaceStream als async-generator mit 3-State-Machine TEXT → MAYBE_OPEN → IN_SURFACE. SurfaceRenderer.tsx mapped jeden Kind auf eine eigene React-Card-Komponente.',
    improves:
      'Statt freiem Markdown-Output + Post-Hoc-Parsing kann der LLM direkt im Stream ein typisiertes UI-Element emittieren. Robust gegen Token-Boundary-Splits + Halluzinations-Tags.',
    useCases: [
      'LLM emittiert `<surface:decision>` während er denkt → UI zeigt eine Decision-Card mit Optionen + Approve-Button.',
      'Bug-Fix-Swarm emittiert `<surface:bug-fix-pipeline>` mit Phase-Stepper.',
      'Owner-Visualisierung: Plan-Steps als `<surface:subplan>` mit collapse-to-pill bei depth >= 2.',
    ],
    prosCons: {
      pros: [
        'Single Stream — kein OOB-Channel für UI-Updates nötig.',
        'Whitelist-gated — kein XSS via halluziniertem Tag.',
        'Streaming-tolerant — JSON kann mid-token splitten.',
      ],
      cons: [
        'Verbose-Tokens für JSON-Payload (Kosten-relevant bei vielen großen Cards).',
        '47 Kinds = viel Renderer-Wartung; Cluster-Merges (workflow, prompt, agent-step) reduzieren das.',
      ],
    },
    refs: [
      { label: 'SURFACE_KINDS', path: 'lib/chat/surface-parser.ts:30' },
      { label: 'parseSurfaceStream State-Machine', path: 'lib/chat/surface-parser.ts:215' },
      { label: 'SurfaceRenderer (alle render*-Cases)', path: 'lib/chat/SurfaceRenderer.tsx' },
    ],
  },
  {
    id: 'open-questions-pill',
    name: 'Open-Questions-Pill + Inline-Surface',
    category: 'Chat-Surfaces',
    status: 'live',
    onTop: 'claude-code',
    function:
      'Wenn der Plan oder ein Agent eine Frage stellt, erscheint sie als Pill im Composer + als persistente Card im Chat — mit QuickChoice-Buttons (wenn options[]) oder Free-Text-Fallback. Tiefe-/Spawn-Fragen werden gefiltert (Depth-Picker besitzt sie eigen).',
    mechanism:
      'open-questions-lifecycle.ts + ChatInlineOpenQuestions.tsx + ChatOpenQuestionsPill.tsx + OpenQuestionsSurface.tsx + PlanOpenQuestionsCard.tsx. De-Dupe (Commit 85c9991, 2026-05-26): Tiefe-/Spawn-Fragen aus Open-Questions gefiltert — kein doppeltes "Build-Tiefe?".',
    improves:
      'Statt Stream-Polling-Toast-Spam landet jede offene Frage als persistente Anker-Card; Owner kann sie auch später aus dem Composer beantworten.',
    useCases: [
      'Plan-Lead fragt "Welche Tiefe für Website-Aufbau?" → Pill + QuickChoice "Klein/Mittel/Groß".',
      'Sniper-Pause: User-Correction-Inject während Iteration ohne Surface-Spam.',
    ],
    refs: [
      { label: 'OpenQuestionsSurface', path: 'lib/chat/OpenQuestionsSurface.tsx' },
      { label: 'ChatOpenQuestionsPill', path: 'lib/chat/ChatOpenQuestionsPill.tsx' },
      { label: 'PlanOpenQuestionsCard', path: 'lib/chat/PlanOpenQuestionsCard.tsx' },
      { label: 'lifecycle', path: 'lib/chat/open-questions-lifecycle.ts' },
    ],
  },
  {
    id: 'flow-graph-surface',
    name: 'flow-graph Surface (visueller DAG)',
    category: 'Chat-Surfaces',
    status: 'live',
    onTop: 'standalone',
    function:
      'Rendert einen Flow als DAG aus Skill/Tool-Nodes mit topologischem Schicht-Layout + SVG-Edges + Status-Dots. Custom-SVG + HTML, KEINE neue Dependency.',
    mechanism:
      'SURFACE_KINDS entry "flow-graph" (surface-parser.ts:161). Payload: { title?, runStatus?, nodes:[{id,label,skill?,tool?,status?}], edges:[{from,to}] }. Mobil-tauglich (schmal → vertikale Stapelung der Ebenen). SurfaceRenderer.tsx::renderFlowGraph. Strukturhash via computeFlowStructureHash (plan-executor.ts:158) + Emit-Cache shouldEmitFlowGraph (plan-executor.ts:183) verhindern Doppel-Emits.',
    improves:
      'n8n/make-Stil-Visualisierung ohne externe Dependency. Erlaubt dem Owner, einen mehrstufigen Flow auf einen Blick zu erfassen.',
    useCases: [
      'Owner sieht "Erstelle eine Webseite"-Flow: Aufbau → Copy → Design → Fotos → Motion → Avatar → Deploy als DAG.',
      'Plan-Executor zeigt Live-Status pro Node während Spawns laufen.',
    ],
    refs: [
      { label: 'SURFACE_KINDS flow-graph', path: 'lib/chat/surface-parser.ts:161' },
      { label: 'renderFlowGraph', path: 'lib/chat/SurfaceRenderer.tsx' },
      { label: 'shouldEmitFlowGraph', path: 'lib/workstreams/plan-executor.ts:183' },
    ],
  },
  {
    id: 'flow-coupling-surface',
    name: 'flow-coupling Surface (Tool-Kopplung)',
    category: 'Chat-Surfaces',
    status: 'live',
    onTop: 'standalone',
    function:
      'Erscheint wenn ein Flow Schritte enthält, deren benötigte Tools/Connectoren noch nicht gekoppelt sind (fehlendes Credential / fehlendes Profil / unbekanntes Tool). Pro fehlendem Tool ein "Koppeln"-Button, der die BESTEHENDE Credential-Eingabe (CredentialRequestCard) öffnet.',
    mechanism:
      'SURFACE_KINDS entry "flow-coupling" (surface-parser.ts:173). Secret geht via POST /api/connectors/[provider]/credential — NIEMALS in Chat/SSE/Ledger. Wiederverwendung des ACL5-B-Pfads. Wenn alles gekoppelt → "Flow starten"-Button → POST /api/flow/[flowId]/run.',
    improves:
      'Vor flow-coupling musste der Owner manuell raten welcher Provider warum nicht ging. Jetzt ist die Kopplungs-Lücke im Chat sichtbar + per-Klick lösbar.',
    useCases: [
      'Flow nutzt Higgsfield, aber kein API-Key da → flow-coupling Card mit "Koppeln"-Button.',
      'Flow nutzt 3 Tools, 2 ok, 1 fehlt → Card listet nur den fehlenden.',
    ],
    refs: [
      { label: 'SURFACE_KINDS flow-coupling', path: 'lib/chat/surface-parser.ts:173' },
      { label: 'compose-and-run route', path: 'app/api/flow/compose-and-run/route.ts' },
    ],
  },
  {
    id: 'counter-evidence-surface',
    name: 'counter-evidence Surface (Devil-Advocate-Output)',
    category: 'Chat-Surfaces',
    status: 'live',
    onTop: 'claude-code',
    function:
      'Zeigt das Ergebnis des Devil-Advocate-Falsifikations-Passes als EIGENE Card — bewusst NICHT in den Synthesis-Stream gemischt. Verdict: falsifiable | unfalsifiable | weak-evidence + rotes Flag wenn unfalsifizierbar.',
    mechanism:
      'SURFACE_KINDS entry "counter-evidence" (surface-parser.ts:192). Payload: { text, verdict, counterEvidenceCount, unfalsifiable, costCents?, durationMs?, workstreamId?, synthesisHash? }. Sicherheits-Hinweis: kein secret-Feld.',
    improves:
      'Bricht die Echo-Chamber bei consensus_level="strong" — der Owner sieht Synthesis UND Falsifikation getrennt + kann entscheiden.',
    useCases: [
      'Plan-Synthesis aller 3 Roaster gleicher Meinung → Devil-Advocate sucht aktiv Gegen-Daten → Counter-Evidence-Card zeigt: "These ist unfalsifizierbar — kein Test denkbar der sie widerlegen würde".',
    ],
    refs: [
      { label: 'SURFACE_KINDS counter-evidence', path: 'lib/chat/surface-parser.ts:192' },
      { label: 'devils-advocate-Modul', path: 'server/agents/devils-advocate.ts' },
    ],
  },
  {
    id: 'live-warn-surface',
    name: 'live-warn Surface (LIVE-Mode One-Shot)',
    category: 'Chat-Surfaces',
    status: 'live',
    onTop: 'standalone',
    function:
      'Erscheint EINMAL pro Workspace beim ersten Anlauf eines echten LIVE-Connector-Calls (LAZYOS_CONNECTOR_LIVE=on + nicht acked). Owner kann "OK weiter" oder "Nein, ich prüfe erst" klicken; Ack wird in workspace_beliefs (topic="live-warn-acked") idempotent persistiert.',
    mechanism:
      'SURFACE_KINDS entry "live-warn" (surface-parser.ts:181). isLiveWarnAcked(workspaceId) (live-warn.ts:57) + recordLiveWarnAck (live-warn.ts:88). Owner-Direktive #3 verbatim (live-warn.ts:1-12): "Alle 3 parallel LIVE flippen" — Card schützt vor versehentlichen Kosten.',
    improves:
      'Vor live-warn konnte der erste LIVE-Lauf still Geld verbrennen (Higgsfield/Heygen). Jetzt: One-Shot-Schutz pro Workspace, idempotent (upsertBelief-supersede).',
    useCases: [
      'Owner flippt LAZYOS_CONNECTOR_LIVE=on und startet einen Flow mit Heygen → Card "Echter externer Call. OK?" → Klick → Ack persistiert → Card kommt nie wieder.',
    ],
    refs: [
      { label: 'SURFACE_KINDS live-warn', path: 'lib/chat/surface-parser.ts:181' },
      { label: 'isLiveWarnAcked', path: 'lib/connectors/live-warn.ts:57' },
      { label: 'recordLiveWarnAck', path: 'lib/connectors/live-warn.ts:88' },
    ],
  },
  {
    id: 'subagent-fleet-surface',
    name: 'subagent-fleet Surface (5 parallele Panes)',
    category: 'Chat-Surfaces',
    status: 'live',
    onTop: 'both',
    function:
      'Rendert bis zu 5 parallele Subagent-Panes mit Status-Pills, Abort- und Diff-Buttons. Eine UI-Anker-Card für den Subagent-Pool.',
    mechanism:
      'SURFACE_KINDS entry "subagent-fleet" (surface-parser.ts:130). Komponenten: SubagentFleetCard.tsx + SubagentFleetCard.types.ts. BACKPORT-02 (2026-05-23) aus Lazing V2.',
    improves:
      'Vorher waren parallele Spawns nur über Logs sichtbar; jetzt sieht der Owner pro Lane Live-Status + kann gezielt abbrechen.',
    useCases: [
      '3 Coder-Lanes parallel an einem komplexen Step → Fleet-Card zeigt jeden Pane separat.',
      'Cross-Roast-Eskalation: 2 Lanes mit konkurrierenden Diffs → Owner sieht beide Diff-Buttons.',
    ],
    refs: [
      { label: 'SURFACE_KINDS subagent-fleet', path: 'lib/chat/surface-parser.ts:130' },
      { label: 'SubagentFleetCard', path: 'lib/chat/SubagentFleetCard.tsx' },
    ],
  },

  // =========================================================================
  // Workstream / Plan-Executor
  // =========================================================================
  {
    id: 'execute-plan-two-mode',
    name: 'executePlan — Zwei-Modi konsent-gated + parallel',
    category: 'Workstream/Plan-Executor',
    status: 'live',
    onTop: 'claude-code',
    function:
      'Führt einen Plan in 2 Modi aus: (A) Default/sicher = pro Step nur engine.chat({messages}) text-only (BIT-IDENTISCH zum Vor-EXEC-Verhalten); (B) Konsentiert (FreeRein/Lane) = echter spawnInTmux mit --allowedTools + acceptEdits, ZWINGEND in R1-Worktree-Isolation. Parallelität via Dependency-Graph + Ready-Queue.',
    mechanism:
      'plan-executor.ts:1-46 + executePlan (plan-executor.ts:426). Per Step: enforceExecutionStep (R2-Gate, execution-policy.ts:239); bei allow + Tools → spawnInTmux in worktree. createRunWorktree → spawnInTmux → discardRunWorktree im finally — Live-Checkout NIE berührt. N8: tamper-evidente workstream_decisions-Row (writeDecision, trace-repo.ts:201) VOR jedem Spawn.',
    improves:
      'Vorher gab es entweder text-only ODER sequenziellen Spawn. Jetzt: parallele Spawns (an worktree-cap 5 + heavy-Ollama 2 budgetiert), per-step R2-Gate, content-hash-verkettetes Audit, isolierte Writes — alles in EINEM Executor.',
    useCases: [
      'Plan mit 5 unabhängigen Steps in FreeRein-Modus → 5 parallele Worktrees + Spawns.',
      'Plan in ask-Mode → 5 text-only Reflexionen, keine Files berührt.',
      'Plan mit Bash-Step + Write-Step + Read-only-Step → R2 entscheidet pro Step deterministisch was läuft.',
    ],
    beforeAfter: {
      before:
        'Sequenzieller Loop, künstliche heavyTotal=2-Kappe für ALLE Steps (vermischte N11-Grenze mit Plan-Step-Parallelität), kein per-Step Audit, kein Worktree.',
      after:
        'Dependency-Graph + 3 orthogonale Budget-Klassen (heavyOllama=2, spawnConcurrency=5, textConcurrency=cores-derived), Worktree pro Step, content-hash-Audit, fehler-isoliert.',
    },
    refs: [
      { label: 'executePlan', path: 'lib/workstreams/plan-executor.ts:426' },
      { label: 'Slot-Decoupling-Begründung', path: 'lib/agents/resource-pool.ts' },
      { label: 'enforceExecutionStep', path: 'lib/security/execution-policy.ts:239' },
      { label: 'writeDecision', path: 'lib/workstreams/trace-repo.ts:201' },
    ],
  },
  {
    id: 'stuck-detector',
    name: 'Stuck-Workstream-Detector',
    category: 'Workstream/Plan-Executor',
    status: 'live',
    onTop: 'standalone',
    function:
      'Findet Workstreams die laut DB "active" sind aber kein Event mehr in den letzten N Minuten produziert haben (Default 5 min). Markiert sie als "stuck" — UI zeigt Resume/Cancel-Action.',
    mechanism:
      'stuck-detector.ts:43 detectStuckWorkstreams + runBootStuckCheck (boot-one-shot) + startStuckDetectorLoop (60s-Interval). Cause meist: Service-Restart während waitForSniperPause lief — DB hängt im active-State.',
    improves:
      'Vorher blieben "tote" Workstreams active hängen und blockierten UI/Owner. Jetzt: automatisch erkannt + recoverable.',
    useCases: [
      'lazyos-web restart mitten in Sniper-Pause → Workstream wird beim nächsten Boot als stuck markiert → Banner zeigt Resume-Button.',
    ],
    refs: [
      { label: 'detectStuckWorkstreams', path: 'lib/workstreams/stuck-detector.ts:43' },
      { label: 'runBootStuckCheck + Loop', path: 'lib/workstreams/stuck-detector.ts:141' },
    ],
  },
  {
    id: 'trace-repo-tamper-evident',
    name: 'Trace-Repo — Evidence + Decisions tamper-evident',
    category: 'Workstream/Plan-Executor',
    status: 'live',
    onTop: 'standalone',
    function:
      'Schreibt zu jedem Step eine Evidence-Row (Quelle, sourceKind: rag_chunk | tool_output | user | spawn) UND eine Decision-Row (rationale verbatim, evidenceRefs, content_hash). N1 + N8 + N10.',
    mechanism:
      'trace-repo.ts:143 writeEvidence + trace-repo.ts:201 writeDecision. content_hash = sha256 über canonical JSON (N10 tamper-evident). N1: rationale verbatim, KEIN .slice.',
    improves:
      'Aus "Telemetrie" wird "Evidence" — jede Entscheidung ist nachvollziehbar; Doppel-Schreibens → idempotent via content_hash.',
    useCases: [
      'Audit-Frage "Warum haben wir damals Higgsfield gewählt?" → Decision-Row mit rationale + evidenceRefs.',
      'Reasoning-Audit-Surface kann den ganzen Trail eines Runs zeigen.',
    ],
    refs: [
      { label: 'writeEvidence', path: 'lib/workstreams/trace-repo.ts:143' },
      { label: 'writeDecision', path: 'lib/workstreams/trace-repo.ts:201' },
    ],
  },

  // =========================================================================
  // Swarm / Plan
  // =========================================================================
  {
    id: 'tier-orchestrator',
    name: 'Tier-Orchestrator (parallele Multi-Agent-Spawns)',
    category: 'Swarm/Plan',
    status: 'live',
    onTop: 'claude-code',
    function:
      'Spawned N×Opus + M×Sonnet + K×Haiku gegen denselben Plan-Prompt mit unterschiedlichen Diversity-Rollen/Skills. Jeder Output landet als commented-Event am Master-Plan-Ticket des Workstreams. Recursion-Guard via LAZYOS_TIER_DEPTH (gespawnte Agents sehen depth=1, können nicht weiter-spawnen).',
    mechanism:
      'tier-orchestrator.ts:1-19 + spawnTier (tier-orchestrator.ts:377). Wallclock-Timeout pro Tier (Opus 5min, Sonnet 3min, Haiku 90s); MAX_CONCURRENT_SPAWNS-Cap mit FIFO-Queue; Rate-Limit-Detection → exponential backoff + skip. injectWhyIntoLeadSystem (tier-orchestrator.ts:200) speist den WhyContext der ReasoningBank in den Lead-Prompt.',
    improves:
      'Statt 1 LLM-Aufruf mit dem Hoffen-Best-Result-Pattern — N parallele Tier-Spawns mit Diversity + Konsens-Detection.',
    useCases: [
      'Plan-Welle 1 = 3×Opus + 2×Sonnet mit Skills [UX, Architecture, Risk, Speed, Cost]; Konsens "strong"/"majority"/"disagreement" treibt nächste Wave.',
      'Sniper-Pause zwischen Wellen: Owner kann inject corrections.',
    ],
    refs: [
      { label: 'spawnTier', path: 'server/agents/tier-orchestrator.ts:377' },
      { label: 'injectWhyIntoLeadSystem (Self-Learning-Wiring)', path: 'server/agents/tier-orchestrator.ts:200' },
    ],
  },
  {
    id: 'recursive-plan',
    name: 'Recursive Plan-in-Plan (Plan-First V2)',
    category: 'Swarm/Plan',
    status: 'live',
    onTop: 'claude-code',
    function:
      'Wraps proposePlan mit einem zwei-Tier-Eagerness-Modell: depth-1 eager (jeder complex-Step bekommt sofort einen Subplan, damit der Owner die ganze Near-Term-Scope in EINER Approval sieht); depth>=2 lazy (Subplans nur on-demand bei subplanTrigger). Hard-Cap MAX_SUBPLAN_DEPTH=3.',
    mechanism:
      'recursive-plan.ts:1-37. cascade vs per-level Approval-Modus. parseProposedPlan (orchestrate-plan.ts:140) ist der deterministische Validator (N6); MAX_STEPS=7 (N11). PlanValidationError bei malformed shape.',
    improves:
      'Statt "ein riesiger Plan ohne Substruktur" oder "endlose Nested-LLM-Calls" — strukturierte Recursion mit klarer Grenze + Owner-Approval-Gate pro Level.',
    useCases: [
      '"Baue eine Website" → root-plan mit 7 steps; jeder complex step (z.B. "Design") bekommt sofort einen Sub-Plan ("Color-System / Layout / Components / Animation").',
      'Owner approved cascade=true → walker auto-approved alle 3 Ebenen.',
    ],
    refs: [
      { label: 'recursive-plan', path: 'lib/plan-first/recursive-plan.ts' },
      { label: 'proposePlan + parseProposedPlan', path: 'lib/plan-first/orchestrate-plan.ts:286' },
      { label: 'MAX_SUBPLAN_DEPTH', path: 'lib/plan-first/recursive-plan.ts:48' },
    ],
  },
  {
    id: 'critic-walker',
    name: 'Critic-Loop Walker',
    category: 'Swarm/Plan',
    status: 'live',
    onTop: 'claude-code',
    function:
      'Treibt den Recursive-Plan-Baum: Depth-First-Traversal, gated jeden Coder/Architect-Step durch den Critic-Loop, proposed lazy deeper Subplans wenn subplanTrigger feuert. Yielded Lifecycle-Events als async-iterable für SSE-Streaming.',
    mechanism:
      'walker.ts:1-25. Jedes Event wird zusätzlich an WalkerHooks → Trace-Tier (N8) geschrieben. requiredCapabilityNames (walker.ts:86) bestimmt pro Subagent-Rolle die nötigen Capabilities.',
    improves:
      'Statt blindem sequenziellem Plan-Step-Loop ein gated Walker, der pro Step entscheiden kann (proceed | request critic | spawn subplan | escalate).',
    useCases: [
      'Plan-Step "implement auth"-Coder-Lane fertig → Walker triggers Critic-Round; bei "needs-rework" → Coder-Lane erneut mit Critic-Notes.',
    ],
    refs: [
      { label: 'walker.ts', path: 'lib/critic-loop/walker.ts' },
      { label: 'requiredCapabilityNames', path: 'lib/critic-loop/walker.ts:86' },
    ],
  },
  {
    id: 'bug-fix-swarm',
    name: 'Bug-Fix-Swarm (3 Diagnose + 1 Fix + 1 RootCause)',
    category: 'Swarm/Plan',
    status: 'live',
    onTop: 'claude-code',
    function:
      'Bei Bug-Reports im Chat startet automatisch ein 3-Phasen-Swarm: Phase 1 = 3 parallele Diagnose-Spawns (senior-dev + code-reviewer + critic, read-only Tools); Phase 2 = Konsens-Detection (≥2 von 3 nennen dieselbe File:Line); Phase 3 = sequentieller Fix-Spawn (build-mode); Phase 4 = Root-Cause-Spawn.',
    mechanism:
      'bug-swarm.ts:1-44 + runBugSwarm (bug-swarm.ts:646) + resumeBugSwarmWithChoice (bug-swarm.ts:815). State liegt in workstreams.iterate_config_json["bug_swarm"]. Bei Disagreement → Surface-Card mit 3 Hypothesen als QuickChoice — Run pausiert bis User wählt.',
    improves:
      'User-Beschwerde verbatim 2026-04-30: "Bug rein, der labert da rum, statt selber zu fixen... ich hätte mir eine Swarming-Analyse gewünscht — 2-3 Modelle wenn die nichts finden oder konsens haben weiter. Aber auch am besten parallel." → exakt das.',
    useCases: [
      'Owner: "Bug — Chat-403 nach build" → Swarm: 3 Diagnosen, Konsens "next-build-cache-corrupt", Fix-Commit mit [skip-mirror], Root-Cause-Pattern erkannt.',
    ],
    refs: [
      { label: 'runBugSwarm', path: 'server/agents/bug-swarm.ts:646' },
      { label: 'resumeBugSwarmWithChoice', path: 'server/agents/bug-swarm.ts:815' },
    ],
  },
  {
    id: 'auto-dispatch-spawner',
    name: 'Auto-Dispatch-Spawner (3-Stage-Pipeline pro Sub-Ticket)',
    category: 'Swarm/Plan',
    status: 'live',
    onTop: 'claude-code',
    function:
      'Pro Sub-Ticket eine sequentielle 3-Stage-Pipeline: senior-dev → code-reviewer → critic. Jede Stage emittiert einen Comment am Sub-Ticket; Stage 2 bekommt Stage-1-Output, Stage 3 bekommt Stage-2-Output.',
    mechanism:
      'auto-dispatch-spawner.ts:1-19 + spawnSubTicketPipeline (auto-dispatch-spawner.ts:583). LAZYOS_TIER_DEPTH=1 in child-env (kein Recursive-Spawn); ANTHROPIC_API_KEY gestrippt (MAX-Plan greift). Unique tmux-Names mit Stage+SubTicket-ID.',
    improves:
      'Built-In Review-Gate pro Sub-Ticket: Owner-Direktive 2026-05-26 "JEDER autonome Build MUSS Review- + Test-Gate vor done" wird hier strukturell durchgesetzt.',
    useCases: [
      'Plan-Approval → 5 Sub-Tickets → pro Ticket: senior-dev implementiert + reviewer prüft + critic challenged.',
    ],
    refs: [
      { label: 'spawnSubTicketPipeline', path: 'server/agents/auto-dispatch-spawner.ts:583' },
    ],
  },
  {
    id: 'spawn-and-audit',
    name: 'spawnAndAudit — automatischer reasoning_audit',
    category: 'Swarm/Plan',
    status: 'live',
    onTop: 'claude-code',
    function:
      'Dünner Wrapper um spawnInTmux der NACH dem Spawn (queueMicrotask, ≈0ms Latenz) automatisch eine reasoning_audit-Row schreibt. Skip wenn rateLimited oder leerer Output.',
    mechanism:
      'spawn-and-audit.ts:1-22. AuditMeta enthält workspaceId, workstreamId, parentTicketId, phase, role, llmProvider, sourceChunks, priorOutputs, userCorrections. Fail-soft (writeReasoningAudit fängt eigene Errors; hier nochmal try).',
    improves:
      'Vorher musste jeder Caller ~20 Zeilen Audit-Boilerplate kopieren; jetzt eine Zeile.',
    useCases: [
      'Jede LLM-Inferenz im Tier-Orchestrator hängt automatisch einen Audit-Trace an.',
    ],
    refs: [
      { label: 'spawnAndAudit', path: 'server/agents/spawn-and-audit.ts' },
    ],
  },
  {
    id: 'subagent-spawner',
    name: 'SubagentSpawner + role-skill-map + Worktree-Wiring',
    category: 'Swarm/Plan',
    status: 'live',
    onTop: 'claude-code',
    function:
      'Spawned typisierte Subagent-Rollen (architect | coder | tester | reviewer | security | perf | …) mit allowlisted Skills pro Rolle (Least-Privilege). Write-mode-Spawns (allowedTools ∩ {Write,Edit,Bash} ≠ ∅) erhalten einen isolierten git worktree; text-only Spawns bleiben BIT-IDENTISCH zum Pre-Wiring-Verhalten.',
    mechanism:
      'lib/agents/spawner.ts (BACKPORT-02 aus Lazing V2). ROLE_SKILL_MAP (role-skill-map.ts:16-51) — z.B. coder: [read, edit, write, grep, glob, bash, sparc:code, sparc:tdd]; security: [read, grep, glob, sparc:security-review, security-review]. createRunWorktree-Wiring (M-WORK-01).',
    improves:
      'Pro Subagent eine engdefinierte Capability-Sicht → kein Bash für reviewer, kein Write für researcher. Worktree-Isolation für jeden Write-Spawn.',
    useCases: [
      'Plan-Step braucht "tester" → bekommt nur read+grep+glob+bash+sparc:tdd+sparc:tester.',
      '"researcher" bekommt web-search + web-fetch, aber kein Bash/Write.',
    ],
    refs: [
      { label: 'spawner.ts', path: 'lib/agents/spawner.ts' },
      { label: 'ROLE_SKILL_MAP', path: 'lib/agents/role-skill-map.ts:16' },
    ],
  },
  {
    id: 'worktree-manager',
    name: 'R1 Worktree-Manager (max 5, fail-closed Sanitisation)',
    category: 'Swarm/Plan',
    status: 'live',
    onTop: 'claude-code',
    function:
      'Jeder destruktive Plan-Run bekommt EINEN isolierten git-worktree, branched von HEAD. Live-Checkout wird NIE berührt. Merge ist Gated-Stub (R1) — return type `Promise<never>` macht Accidental-Depends-On unmöglich.',
    mechanism:
      'worktree-manager.ts:1-50. execFile (nicht exec/shell) → keine Shell-Injection. SAFE_ID_RE-Sanitisation für workspaceId + planRunId. Worktree-Base OUTSIDE des Live-Repos (Sibling-Dir). Path-Escape-Assertion via path.resolve + startsWith (Symlink-resistant). MAX_RUN_WORKTREES=5 (N11) hard-cap (worktree-manager.ts:66).',
    improves:
      'Macht "Subagent darf schreiben" sicher: Schreibt geht NUR in throwaway-Branch im Sibling-Dir. Merge braucht separates Owner-Gate.',
    useCases: [
      'FreeRein-Plan mit 5 parallelen Coder-Lanes → 5 Worktrees, jeder im eigenen Branch.',
      'Owner reviewed je Diff im Worktree, dann manueller Merge.',
    ],
    refs: [
      { label: 'worktree-manager.ts', path: 'lib/agents/worktree-manager.ts' },
      { label: 'MAX_RUN_WORKTREES', path: 'lib/agents/worktree-manager.ts:66' },
    ],
  },
  {
    id: 'resource-pool-slot-decoupling',
    name: 'Resource-Pool — Slot-Decoupling (heavyOllama=2 vs spawnConcurrency=5)',
    category: 'Swarm/Plan',
    status: 'live',
    onTop: 'both',
    function:
      'Drei orthogonale Budget-Klassen statt eines globalen heavyTotal als Universal-Bremse: (1) heavyOllama=2 (echte N11-Grenze für lokale deepseek-r1:14b-Synthese), (2) spawnConcurrency=5 (claude-cli Plan-Step-Spawns mit Write/Bash, an Worktree-Cap gebunden), (3) textConcurrency (text-only Read-Steps, cores-derived).',
    mechanism:
      'lib/agents/resource-pool.ts (BACKPORT-02). PoolSlot + PoolBudget + ConcurrencyBudget. Singleton resourcePool. SLOT-DECOUPLING 2026-05-26-Begründung verbatim im Header.',
    improves:
      'Vor dem Decoupling kappte heavyTotal=2 ALLES auf 2 — inkl. reiner Text-Steps und claude-cli-Spawns. Jetzt: Builder-Breite an die echte Isolations-Grenze (Worktree=5) gebunden, nicht an die Ollama-Grenze.',
    useCases: [
      'Plan mit 5 unabhängigen Bash-Steps + 1 deepseek-Synthesis → alle 5 parallel + Synthesis non-blocking.',
    ],
    refs: [
      { label: 'resource-pool.ts', path: 'lib/agents/resource-pool.ts' },
      { label: 'SLOT-DECOUPLING-Begründung', path: 'lib/agents/resource-pool.ts:20' },
    ],
  },
  {
    id: 'tpm-budget',
    name: 'TPM-Budget-Manager (Tokens-per-Minute Drosselung)',
    category: 'Swarm/Plan',
    status: 'live',
    onTop: 'claude-code',
    function:
      'Globaler Tokens-per-Minute-Tracker. Vor jedem Spawn `waitForBudget(estimatedTokens)`; nach jedem Spawn `recordTokens(input,output,cacheRead)`. Schwellen: <50% sofort spawn, 50-70% 2s sleep, 70-90% 5s sleep, 90-100% 15s sleep, 100%+ hard-block 30s.',
    mechanism:
      'tpm-budget.ts:1-27. getTpmStatus + recordTokens (tpm-budget.ts:170) + canSpawn (tpm-budget.ts:209). MAX_TPM = 350k tokens/60s konservativ (Override via env LAZYOS_MAX_TPM_BUDGET).',
    improves:
      'MAX-Plan-Throttle ("Anthropic temporarily limiting requests") wird proaktiv abgefedert statt reaktiv mit retries verschwendet.',
    useCases: [
      '20 parallele Roaster im Bug-Fix-Swarm → TPM-Manager staffelt sie automatisch.',
    ],
    refs: [
      { label: 'tpm-budget.ts', path: 'lib/agents/tpm-budget.ts' },
      { label: 'recordTokens', path: 'lib/agents/tpm-budget.ts:170' },
    ],
  },

  // =========================================================================
  // Critic / Devil's-Advocate
  // =========================================================================
  {
    id: 'devils-advocate',
    name: "Devil's-Advocate (P13 — Confirmation-Bias-Counter)",
    category: 'Critic/Devil-Advocate',
    status: 'live',
    onTop: 'claude-code',
    function:
      'Falsifikations-Pass NACH einer Synthesis: sucht aktiv Daten, die der These WIDERSPRECHEN. Verdict: falsifiable | unfalsifiable | weak-evidence. Output landet als EIGENE Surface-Card (counter-evidence), NICHT in den Synthesis-Stream gemischt.',
    mechanism:
      'devils-advocate.ts:1-30 + runDevilsAdvocate (devils-advocate.ts:286). E4.1-Gating (shouldRunDevilsAdvocate, devils-advocate.ts:80): NUR bei (1) consensus_level==="strong" — Echo-Chamber-Schutz; ODER (2) whyInjected===true — wenn ein WHY-Block in den Lead-Prompt geflossen ist, kann er Confirmation-Bias verursachen. Engine-Adapter (devils-advocate.ts:53) macht den Kern ohne echtes LLM unit-testbar.',
    improves:
      'Critic fragt "ist das gut?" — Devil-Advocate fragt anders: "welche Daten widerlegen meine These?". Closes Anne-Hauptkritik (verbatim aus dem Header): "wenn ich eine Überzeugung habe, dass ich sehr selektiv neue Informationen so interpretiere, dass sie meine Überzeugung bestätigen".',
    useCases: [
      'Lead+Roaster+Synthesis stimmen alle überein (strong consensus) → DA-Pass findet: "These ist unfalsifizierbar — keinen Test, der sie widerlegen würde" → roter Flag.',
      'WHY-Block speist alte Belief "wir nehmen immer X" ein → DA-Pass challenged das aktiv.',
    ],
    refs: [
      { label: 'shouldRunDevilsAdvocate', path: 'server/agents/devils-advocate.ts:80' },
      { label: 'runDevilsAdvocate', path: 'server/agents/devils-advocate.ts:286' },
      { label: 'parseDevilsAdvocateOutput', path: 'server/agents/devils-advocate.ts:177' },
    ],
  },
  {
    id: 'cross-roast-critic',
    name: 'Cross-Roast Critic (≥2 Lanes Overlap)',
    category: 'Critic/Devil-Advocate',
    status: 'live',
    onTop: 'claude-code',
    function:
      'Aktiviert wenn ein Step >=2 parallele Coder-Lanes gespawned hat, deren Diffs überlappende Files berühren UND der Step `complex` ist. Drei Outcomes: pass/winner (eine Diff dominiert), synthesize (komplementär → Synthesis-Lane), fail/defenseQueue (keiner verteidigt → Operator-Escalation).',
    mechanism:
      'cross-roast-critic.ts:1-28 + runCrossRoastCritic (cross-roast-critic.ts:263). shouldActivateCrossRoast (cross-roast-critic.ts:95) + bothDiffsTouchOverlappingFiles (cross-roast-critic.ts:106). Template aus ~/.claude/skills/lazing-cross-roast/SKILL.md (fallback auf built-in template wenn fehlt → tests laufen offline).',
    improves:
      'Parallele Coder-Lanes werden NICHT blind gemerged — der Cross-Roast erzwingt entweder Verteidigung oder Synthesis.',
    useCases: [
      '2 Coder-Lanes ändern beide auth.ts → Cross-Roast: Lane A passt sauber zu RFC, Lane B macht weniger Lines aber bricht Tests → Outcome pass/winner = Lane A.',
    ],
    refs: [
      { label: 'shouldActivateCrossRoast', path: 'lib/critic-loop/cross-roast-critic.ts:95' },
      { label: 'runCrossRoastCritic', path: 'lib/critic-loop/cross-roast-critic.ts:263' },
    ],
  },

  // =========================================================================
  // Self-Learning / WHY engine (Stream A, 2026-05-27)
  // =========================================================================
  {
    id: 'decisions-read-back',
    name: 'A1 — Decision-Read-Back (workstream_decisions lesbar)',
    category: 'Self-Learning',
    status: 'live',
    onTop: 'standalone',
    function:
      'Macht den write-only Decision-Trail aus workstream_decisions (Migration 0071) lesbar. listDecisions + recentRationales — workspaceId-scoped (N9, via JOIN auf workstreams.workspace_id), stabile ORDER BY, PURE/IO-arm.',
    mechanism:
      'decisions-read.ts:1-33 + listDecisions (decisions-read.ts:131) + recentRationales (decisions-read.ts:181). Roher better-sqlite3-Handle (kein getDb-Singleton, in-memory testbar). Filter optional auf decisionKind, coordKey, recoveredOnly.',
    improves:
      'Vor A1 war `workstream_decisions` write-only — das WARUM jeder Entscheidung lag brach. Jetzt ist die rationale-Historie ein lebender Input für compose, plan, reconcile.',
    useCases: [
      'Plan-Proposer fragt: "warum hat der Owner letztes Mal Higgsfield gegen Heygen entschieden?" → recentRationales liefert verbatim.',
    ],
    refs: [
      { label: 'listDecisions', path: 'lib/reasoning/decisions-read.ts:131' },
      { label: 'recentRationales', path: 'lib/reasoning/decisions-read.ts:181' },
    ],
  },
  {
    id: 'beliefs-repo',
    name: 'A2 — Workspace-ReasoningBank (supersede=EWC++)',
    category: 'Self-Learning',
    status: 'live',
    onTop: 'standalone',
    function:
      'Je Topic je Workspace eine AKTIVE Überzeugung (belief) mit ihrem WARUM (rationale). Eine neue Überzeugung löst die alte NICHT durch Löschen ab, sondern per supersede: alte Row bleibt erhalten, neue referenziert sie via supersedes_id. Append-only "nicht vergessen" — N1-Geist.',
    mechanism:
      'beliefs-repo.ts:1-29 + upsertBelief (beliefs-repo.ts:152) + listBeliefs (beliefs-repo.ts:240) + beliefHistory (beliefs-repo.ts:266) + recallRelevant (beliefs-repo.ts:322) + rankBeliefs (beliefs-repo.ts:384) + reinforceBelief (beliefs-repo.ts:448) + recordOutcome (beliefs-repo.ts:511) + listOutcomes (beliefs-repo.ts:565). content_hash sha256 über canonical JSON (N10).',
    improves:
      'Vor A2: KEIN Lern-Store. System empfahl jedes Mal neu, vergaß alte Owner-Korrekturen. Jetzt: persistente Workspace-ReasoningBank, supersede-Mechanik, abrufbare Historie.',
    useCases: [
      'Owner sagt "wir nehmen für Webdesign immer claymorphism" → upsertBelief(workspaceId, topic="design-style", belief="claymorphism", rationale="Owner-Direktive 2026-05-28").',
      'Outcome eines Runs (success/failure) → recordOutcome + reinforceBelief.',
    ],
    refs: [
      { label: 'upsertBelief (supersede)', path: 'lib/reasoning/beliefs-repo.ts:152' },
      { label: 'recallRelevant', path: 'lib/reasoning/beliefs-repo.ts:322' },
      { label: 'recordOutcome', path: 'lib/reasoning/beliefs-repo.ts:511' },
    ],
  },
  {
    id: 'why-context',
    name: 'A3 — WHY-Einspeisung in compose + plan',
    category: 'Self-Learning',
    status: 'live',
    onTop: 'claude-code',
    function:
      'Aggregiert die bereits gebauten Lese-Surfaces (A1 decisions-read + A2 beliefs-repo) zu EINEM WhyContext und rendert ihn als prompt-einspeisbaren Block, den der Default-Decompose-Wrapper dem proposePlan-Prompt VORANSTELLT. Schließt die Lücke "compose/plan starten amnesisch".',
    mechanism:
      'why-context.ts:1-37 + buildWhyContext (why-context.ts:219) + renderWhyContextForPrompt (why-context.ts:288). Robust gegen leeres Ledger (frischer Workspace → leerer WhyContext, kein Error). N1: buildWhyContext sammelt VERBATIM; Token-Budgeting NUR beim Rendern + transparent markiert ("…(gekürzt)"). N6: WARUM ist NUR Kontext, der deterministische parseProposedPlan-Validator bleibt davor.',
    improves:
      'Schließt die Lücke "Plan-Proposer liest weder workspaces.notes noch frühere Decisions" — jedes Compose startet jetzt mit Workspace-Gedächtnis.',
    useCases: [
      'Plan-Proposer für neuen Run sieht: "letzte 5 rationales: Higgsfield wegen X, claymorphism wegen Y…" → empfiehlt konsistent.',
    ],
    refs: [
      { label: 'buildWhyContext', path: 'lib/reasoning/why-context.ts:219' },
      { label: 'renderWhyContextForPrompt', path: 'lib/reasoning/why-context.ts:288' },
      { label: 'Wiring im Tier-Lead', path: 'server/agents/tier-orchestrator.ts:200' },
    ],
  },
  {
    id: 'reconcile-outcome',
    name: 'A4+A5 — Post-Prozess-IST/SOLL-Reconciliation + WARUM-Frage',
    category: 'Self-Learning',
    status: 'live',
    onTop: 'standalone',
    function:
      'NACH Workstream-Abschluss bestimmt ein Reconciliation-Schritt das Gesamt-Outcome, hält es per recordOutcome fest, und bei Drift zwischen einer getroffenen Entscheidung und einer aktiven Überzeugung schreibt er einen BEGRÜNDETEN Belief-Update (supersede). A4 ergänzt: bei Entscheidung ohne klare Begründung ODER Drift → emittiert eine OPTIONALE WARUM-Frage als open-questions-Surface — blockiert NIE den Run.',
    mechanism:
      'reconcile.ts:1-43 + reconcileWorkstream (reconcile.ts:529). RECONCILE_MARKER_PREFIX (reconcile.ts:63) für Idempotenz — zweiter Lauf in derselben Periode mit gleicher Bilanz → No-Op (kein Schema-Eingriff). determineOutcome (reconcile.ts:85) + detectBeliefDrift (reconcile.ts:154) + buildWhyQuestion (reconcile.ts:425) als reine Funktion (kein DB).',
    improves:
      'Befund verbatim aus dem Header: "Das heygen-Dead-End wurde NUR als orphan aufgeräumt — es entstand KEIN Lern-Eintrag. Niemand verglich die ursprüngliche Vision gegen das Ergebnis; das System konnte denselben Connector-Drift beim nächsten Mal wieder wählen." A5 schließt das.',
    useCases: [
      'Workstream beendet ohne Outcome-Vergleich → reconcileWorkstream: Outcome="failure" + detect-Drift "die These war Higgsfield-Pfad funktioniert, real ging keiner durch" → upsertBelief supersede.',
    ],
    refs: [
      { label: 'reconcileWorkstream', path: 'lib/reasoning/reconcile.ts:529' },
      { label: 'detectBeliefDrift', path: 'lib/reasoning/reconcile.ts:154' },
      { label: 'buildWhyQuestion (reine Funktion)', path: 'lib/reasoning/reconcile.ts:425' },
    ],
  },
  {
    id: 'auto-handoff',
    name: 'A6 — Auto-Workspace-Handoff (cross-session Memory)',
    category: 'Self-Learning',
    status: 'live',
    onTop: 'standalone',
    function:
      'Aggregiert den read-back-Trail zu einem strukturierten Handoff (offene Entscheidungen, etablierte Überzeugungen), schreibt ihn in workspaces.notes (notes_source="ai-summary") und rendert ihn als Einspeise-Block für den nächsten System-Prompt.',
    mechanism:
      'auto-handoff.ts:1-42 + buildWorkspaceHandoff (auto-handoff.ts:199) + persistWorkspaceHandoff (auto-handoff.ts:534) + renderHandoffForSession (auto-handoff.ts:322). Konservativer redactSecrets-Pass (auto-handoff.ts:124) als Defense-in-Depth, falls ein Klartext-Secret versehentlich in einer rationale gelandet ist.',
    improves:
      'Schließt verbatim aus Header: "intent-classifier.ts:180 — lessons learned vorerst nicht persistiert. Eine neue Chat-Session im selben Workspace startet daher amnesisch."',
    useCases: [
      'Session endet → Handoff schreibt in workspaces.notes: "Offene Entscheidungen: 2. Aktive Beliefs: 5. Letztes Outcome: Higgsfield-Pfad gescheitert."',
      'Neue Session beginnt → System-Prompt enthält den gerenderten Handoff.',
    ],
    refs: [
      { label: 'buildWorkspaceHandoff', path: 'lib/reasoning/auto-handoff.ts:199' },
      { label: 'persistWorkspaceHandoff', path: 'lib/reasoning/auto-handoff.ts:534' },
      { label: 'renderHandoffForSession', path: 'lib/reasoning/auto-handoff.ts:322' },
    ],
  },
  {
    id: 'belief-curation',
    name: 'E2 — Periodische Belief-Curation (ExpeL-style)',
    category: 'Self-Learning',
    status: 'live',
    onTop: 'standalone',
    function:
      'Schaut auf den gesammelten Erfahrungs-Pool eines Workspace, clustert nach Topic, bildet je Topic die Erfolg/Fehler-Bilanz und destilliert daraus EINE generalisierte, wiederverwendbare Überzeugung: "Bei <topic>: N Erfolge / M Fehler → bevorzuge <…>".',
    mechanism:
      'curate.ts:1-42 + curateWorkspaceBeliefs (curate.ts:270). Topic-Cluster aus den P0.1-Lehr-Beliefs (TEACH_MARKER_PREFIX=[teach-v1:<wsId>:<outcome>], reconcile.ts:185) — jede trägt topic + outcome → Pool je Topic. Globale Outcome-Bilanz als minOutcomes-Gate. CURATION_MARKER_PREFIX (curate.ts:66) + curationPeriodKey (curate.ts:92) für Idempotenz pro Periode.',
    improves:
      'Run-Completion lernt bereits pro-Run; E2 ergänzt die ÜBERGREIFENDE Distillation über VIELE Outcomes (HERMES "evaluate periodically").',
    useCases: [
      'Workspace hat in 30 Tagen 8× Higgsfield-Versuche (3 success, 5 fail) → Curation destilliert: "bei video-gen: 3 Erfolge / 5 Fehler — bevorzuge Direkt-Heygen-Pfad ohne Higgsfield".',
    ],
    refs: [
      { label: 'curateWorkspaceBeliefs', path: 'lib/reasoning/curate.ts:270' },
      { label: 'tallyTopicsFromTeachBeliefs', path: 'lib/reasoning/curate.ts:143' },
    ],
  },

  // =========================================================================
  // Flow Studio (2026-05-27)
  // =========================================================================
  {
    id: 'flow-compose',
    name: 'composeFlowFromIntent — Intent → wiederverwendbares Template',
    category: 'Flow Studio',
    status: 'live',
    onTop: 'claude-code',
    function:
      'Komponiert aus rohem Operator-Intent ("Erstelle eine Webseite …") ein wiederverwendbares flow_template + seine flow_steps + persistiert es. Pipeline: Intent → Schritt-Liste (Decompose) → Skill-Assignment → Tool-Bedarf erkennen → Persist.',
    mechanism:
      'compose.ts:1-58 + composeFlowFromIntent + makeRecursivePlanDecompose (compose.ts:254) als injizierbarer Wrapper um proposePlan + assignSkill (compose.ts:387) Heuristik + detectMediaSteps (compose.ts:570) + validateCoverage (coverage.ts:116) für fail-closed Connector-Check. Rohes better-sqlite3-Handle (in-memory testbar).',
    improves:
      'Vor Flow Studio gab es nur einmalige Plan-Runs; jetzt: Intent wird zu einem benannten, wieder-anstoßbaren Template.',
    useCases: [
      'Owner: "Erstelle eine Webseite" → composeFlowFromIntent → Template "Website-Aufbau" mit 7 Steps (Aufbau, Copy, Design, Fotos, Motion, Avatar, Deploy) + missingTools-Liste.',
    ],
    refs: [
      { label: 'composeFlowFromIntent (Modul-Header)', path: 'lib/flow/compose.ts:1' },
      { label: 'makeRecursivePlanDecompose', path: 'lib/flow/compose.ts:254' },
      { label: 'assignSkill', path: 'lib/flow/compose.ts:387' },
    ],
  },
  {
    id: 'flow-dispatch',
    name: 'dispatchFlow — Flow → Run-Brücke (bestehende Engine)',
    category: 'Flow Studio',
    status: 'live',
    onTop: 'claude-code',
    function:
      'Brücke vom Flow-Template in einen ECHTEN Run über die BESTEHENDE Orchestrierung (Substrat-Disziplin N4 — KEINE neue Execution-Engine): listFlowSteps → compileFlowToPlanSteps → 1 workstreams-Row → createFlowRun → Plan-Steps persistieren → {runId, workstreamId}.',
    mechanism:
      'execute.ts:1-52 + dispatchFlow (execute.ts:129). Schreibt EXAKT in dieselben Tabellen mit EXAKT demselben content_hash-Payload + derselben 0110-depends_on-Semantik wie insertPlanStep — synchron, ohne Singleton, so dass per-Step depends_on aus dem Flow-DAG 1:1 erhalten bleibt. dispatchFlow BEREITET NUR VOR + PERSISTIERT; den eigentlichen Lauf startet danach der bestehende plan-executor.',
    improves:
      'KEINE neue Execution-Engine; die bestehende workstream-Pipeline trägt Flow ohne Code-Dupe.',
    useCases: [
      'Owner klickt "Run" auf einem Template → dispatchFlow → workstreams-Row + flow_runs-Row + Plan-Steps → der bestehende plan-executor läuft.',
    ],
    refs: [
      { label: 'dispatchFlow', path: 'lib/flow/execute.ts:129' },
      { label: 'Substrat-Disziplin-Begründung', path: 'lib/flow/execute.ts:6' },
    ],
  },
  {
    id: 'flow-from-workstream',
    name: 'compileWorkstreamToFlow — Run → wiederkehrender Prozess',
    category: 'Flow Studio',
    status: 'live',
    onTop: 'standalone',
    function:
      'Reine DB-Operation, die einen bereits gelaufenen (oder laufenden) Workstream-Plan ZURÜCK in ein neues flow_template + flow_steps kompiliert — wiederholbar via dem bestehenden POST /api/flow/[flowId]/run. Owner-SOLL "Run → wiederkehrender Prozess".',
    mechanism:
      'from-workstream.ts:1-37 + compileWorkstreamToFlow (from-workstream.ts:185) + parseFlowAnnotation (from-workstream.ts:118) für Annotations-Parse aus dem "| flow:{…}"-Suffix im rationale, den execute.ts::annotateRationale beim Vorwärts-Dispatch angehängt hat. Fehlt die Annotation → fallback auf subagentRole→skill + keine Tool-Kopplung (verlustfrei für die reine Struktur).',
    improves:
      'Owner kann einen erfolgreichen Run als wiederholbares Standard-Asset speichern, ohne ihn manuell als Flow neu zu komponieren.',
    useCases: [
      'Owner: "Der Webseiten-Aufbau lief gut → speichere als wiederkehrenden Prozess" → POST /api/flow/from-workstream → flowId zurück.',
    ],
    refs: [
      { label: 'compileWorkstreamToFlow', path: 'lib/flow/from-workstream.ts:185' },
      { label: 'parseFlowAnnotation', path: 'lib/flow/from-workstream.ts:118' },
      { label: 'API-Route', path: 'app/api/flow/from-workstream/route.ts' },
    ],
  },
  {
    id: 'flow-templates-repo',
    name: 'flow_templates + flow_steps + flow_runs (Persistenz)',
    category: 'Flow Studio',
    status: 'live',
    onTop: 'standalone',
    function:
      'Persistenz-Layer für Flow-Templates: createFlowTemplate, addFlowStep, getFlowTemplate, listFlowSteps, createFlowRun. Migration 0112.',
    mechanism:
      'lib/flow/templates-repo.ts + db/schema/flow_templates.ts. Rohes better-sqlite3-Handle (testbar). content_hash über canonical JSON.',
    improves:
      'Schreib-Pfad existiert vollständig + getrennt von Engine — saubere Schichten.',
    useCases: [
      'composeFlowFromIntent → createFlowTemplate.',
      'dispatchFlow → createFlowRun.',
      'compileWorkstreamToFlow → createFlowTemplate (zurück).',
    ],
    refs: [
      { label: 'templates-repo.ts', path: 'lib/flow/templates-repo.ts' },
    ],
  },

  // =========================================================================
  // Connectors / SOP
  // =========================================================================
  {
    id: 'auto-connect-acl5',
    name: 'maybeAutoConnect (ACL5-E) — Detect → SOP → Preview → Approve',
    category: 'Connectors/SOP',
    status: 'live',
    onTop: 'standalone',
    function:
      'Hybrid im Chat-Stream-Prozess aufgerufen (fire-and-forget). Macht KEINEN echten Connector-Call — nur Detect / Setup / Preview. Echter Call NUR nach User-Approve via POST /api/connectors/invoke. 4 Pfade: no-connector / profile (SOP) / credential (credential-request-Card) / none (preview-call-Card).',
    mechanism:
      'auto-connect.ts:1-40 + maybeAutoConnect (auto-connect.ts:345). NICHT-DESTRUKTIV; Secret NIE in Card/Transcript/SSE/Log; muss im Next-Prozess (:4200) laufen (broadcast = In-Process-EventEmitter); Codex per B1-Sicherheits-Fix ausgeschlossen; Fire-and-forget (Fehler nie an Chat-Stream propagieren); N8-Audit über previewCall; N6: detectConnector deterministisch.',
    improves:
      'Owner muss nicht mehr selbst raten welcher Provider warum nicht geht — System detect+setup automatisch + zeigt fehlende Gates inline.',
    useCases: [
      'Owner: "Schicke das an die Higgsfield-API" → maybeAutoConnect: missing="credential" → credential-request-Card → Owner trägt Key ein (geht in Vault, nicht in Chat) → Re-trigger → preview-Card → Approve → echter Call.',
    ],
    refs: [
      { label: 'maybeAutoConnect', path: 'lib/connectors/auto-connect.ts:345' },
      { label: 'detectConnector', path: 'lib/connectors/detect.ts:249' },
      { label: 'previewCall', path: 'lib/connectors/invoke.ts:319' },
    ],
  },
  {
    id: 'onboarding-sop-generic',
    name: 'Generic Auto-Onboarding-SOP-Engine (Stream X1)',
    category: 'Connectors/SOP',
    status: 'live',
    onTop: 'standalone',
    function:
      'Generisches SOP-Pattern (nicht Higgsfield-special) das automatisch getriggert wird wenn die flow-coupling-Surface aus compose-and-run emittiert wird. Eine neue Provider-Definition = EIN Eintrag in ONBOARDING_SOPS.',
    mechanism:
      'onboarding-sop.ts:1-44 + getOnboardingSop (onboarding-sop.ts:258) + buildOnboardingSopForMissingTool (onboarding-sop.ts:276) + listOnboardingSops (onboarding-sop.ts:286). N1: jeder Step-Text VERBATIM; N6: pure (kein LLM/Netz/I/O); N4: konsumiert die existierende MissingTool-Reason-Set aus compose.ts. Provider mit verifizierten Public-Signup-URLs: higgsfield (homepage; signup behind sign-in), heygen-avatar (app.heygen.com/login → Settings → API), imagegen2 (engine-backed via Codex/MAX, NO separate signup).',
    improves:
      'Owner-Direktive #1 verbatim (onboarding-sop.ts:8-10): "Onboarding-SOPs sollten ja grundsätzlich sein oder der Flow... nur denk daran, dass das wieder aus Intention und Context selber aufgerufen werden muss." → exakt diese Generizität.',
    useCases: [
      'Flow benötigt Heygen → buildOnboardingSopForMissingTool → SOP mit verifiziertem Signup-Link + Schritt-für-Schritt.',
    ],
    refs: [
      { label: 'getOnboardingSop', path: 'lib/connectors/onboarding-sop.ts:258' },
      { label: 'buildOnboardingSopForMissingTool', path: 'lib/connectors/onboarding-sop.ts:276' },
      { label: 'listOnboardingSops', path: 'lib/connectors/onboarding-sop.ts:286' },
    ],
  },
  {
    id: 'live-warn-state',
    name: 'Connector LIVE-Mode One-Shot Warn-State',
    category: 'Connectors/SOP',
    status: 'live',
    onTop: 'standalone',
    function:
      'Zeigt beim ALLERERSTEN LIVE-Lauf eines Workspace eine live-warn-Surface. Acknowledgement-Belief in workspace_beliefs (topic="live-warn-acked"); zweimal Klick erzeugt nicht zwei Beliefs (upsertBelief-supersede ist append-only).',
    mechanism:
      'live-warn.ts:1-29 + LIVE_WARN_TOPIC (live-warn.ts:37) + isLiveWarnAcked (live-warn.ts:57) + recordLiveWarnAck (live-warn.ts:88). Owner-Direktive #3 verbatim (live-warn.ts:6-8): "Alle 3 parallel LIVE flippen".',
    improves:
      'Schutz vor versehentlichen Kosten beim ersten LIVE-Switch; pro Workspace genau eine Warnung.',
    useCases: [
      'Workspace flippt zu LIVE → erste Card zeigt Warning + 2 Buttons; Klick "OK weiter" → topic acked → kommt nie wieder.',
    ],
    refs: [
      { label: 'isLiveWarnAcked', path: 'lib/connectors/live-warn.ts:57' },
      { label: 'recordLiveWarnAck', path: 'lib/connectors/live-warn.ts:88' },
    ],
  },
  {
    id: 'connector-coverage-validator',
    name: 'validateCoverage — fail-closed Connector-Check',
    category: 'Connectors/SOP',
    status: 'live',
    onTop: 'standalone',
    function:
      'Reine deterministische Funktion: prüft pro Flow-Step ob ein bekannter Connector + ein Credential da sind. Unbekannter/unverbundener Tool-Connector landet IMMER in missingTools (nie still als "ok" durchgewunken).',
    mechanism:
      'coverage.ts:116 validateCoverage. Kein hasCredential-Callback → konservativ als unverbunden behandelt (fail-closed, N2). detectVersionDrift (coverage.ts:189) erkennt Verschiebungen zwischen compose und p5-connectors.',
    improves:
      'Schließt den Connector-Drift-Bug aus dem PA-Chat-IST (verbatim aus MEMORY.md): "compose↔p5-connectors Slug+Capability-Mismatch → validateCoverage immer ok:false" — der Bug war im Schreib-Pfad, der Validator ist die korrekte Sentry-Logik.',
    useCases: [
      'Flow-Compose: 3 Steps brauchen Tools → validateCoverage prüft Katalog + Credential-Existenz → liefert pro Step "ok" oder MissingTool-Reason.',
    ],
    refs: [
      { label: 'validateCoverage', path: 'lib/connectors/coverage.ts:116' },
      { label: 'detectVersionDrift', path: 'lib/connectors/coverage.ts:189' },
    ],
  },
  {
    id: 'sop-registry',
    name: 'SOP Registry + Executor (SAR-2)',
    category: 'Connectors/SOP',
    status: 'live',
    onTop: 'standalone',
    function:
      'CRUD-Surface für SOPs + SOP-Steps; Executor expandSopToPlanNodes mapped SOP-Steps in PlanNodes für den Recursive-Plan-Walker. Jeder SOP-Step wird zu EINEM root-level PlanNode (depth=0).',
    mechanism:
      'registry.ts:1-15 + getSop (registry.ts:136) + listSops (registry.ts:109) + createSop (registry.ts:172) + archiveSop (Soft-Delete, registry.ts:247) + hashSop (content_hash, registry.ts:76). executor.ts:1-30 + expandSopToPlanNodes (executor.ts:82). N1: stepPromptTemplate verbatim weitergereicht; N6 deterministisch (gleicher Input → gleicher Output).',
    improves:
      'SOPs als first-class entity (statt nur als Strings im Prompt); wieder-anstoßbar, archivierbar, soft-deletable.',
    useCases: [
      'Owner definiert SOP "Bug-Report-Triage" → ist als wieder-aufrufbarer Plan-Vorschlag im Plan-Decompose verfügbar.',
    ],
    refs: [
      { label: 'getSop', path: 'lib/sop/registry.ts:136' },
      { label: 'expandSopToPlanNodes', path: 'lib/sop/executor.ts:82' },
    ],
  },

  // =========================================================================
  // Skills / Roles
  // =========================================================================
  {
    id: 'skills-first-class',
    name: 'Skills as First-Class Entity (Phase S)',
    category: 'Skills/Roles',
    status: 'live',
    onTop: 'claude-code',
    function:
      '16 Built-In-Skills (UX, Architecture, Cost, Risk, Speed, Maintenance, Brand, Mobile, Accessibility, Performance, Privacy, Failure, Onboarding, Migrate, Observability, Critic) als first-class DB-Entities. User können beliebig eigene Skills hinzufügen, archivieren, anpassen — Built-Ins read-only.',
    mechanism:
      'built-in.ts BUILT_IN_SKILLS (16 Skills mit name, focusPrompt, preferTier, defaultEffort, defaultCount, description) + service.ts (CRUD + ensureSkillsSeeded boot-one-shot, service.ts:60) + pickActiveSkillForIndex (service.ts:117). Adapter diversity-roles.ts mapped die alte DIVERSITY_ROLES-API auf den Skill-Service ohne Caller-Breaks.',
    improves:
      'Vor Phase S waren Skills hardcoded Strings; jetzt: dynamisch erweiterbar, archivable, per-User. User kann "Demo Fitness-Tonalität" oder "TAP-Compliance" anlegen ohne Code-Change.',
    useCases: [
      'Owner legt Skill "Brand-Voice-laz-ing" mit eigenem focusPrompt an → wird in Tier-Spawns rotiert.',
    ],
    refs: [
      { label: 'BUILT_IN_SKILLS (16)', path: 'lib/agents/skills/built-in.ts' },
      { label: 'pickActiveSkillForIndex', path: 'lib/agents/skills/service.ts:117' },
      { label: 'Adapter diversity-roles', path: 'lib/agents/diversity-roles.ts' },
    ],
  },
  {
    id: 'role-skill-allowlist',
    name: 'ROLE_SKILL_MAP (Least-Privilege per Subagent-Rolle)',
    category: 'Skills/Roles',
    status: 'live',
    onTop: 'claude-code',
    function:
      'Per-Rolle Allow-List der erlaubten Skills/Capabilities. 12 Rollen (architect, coder, tester, reviewer, security, perf, policy-checker, curator, judge, researcher, planner, scribe), jede mit engdefinierter Skill-Liste — z.B. coder darf bash, security NICHT.',
    mechanism:
      'role-skill-map.ts:16-51 ROLE_SKILL_MAP (frozen Record). skillsForRole (role-skill-map.ts:54) Convenience-Accessor. Die forwarded allow-list wird vom Engine-Adapter honoriert wo supported (claude-cli only at present).',
    improves:
      'Least-Privilege strukturell: kein "alle Tools für alle Rollen". Reviewer kann nicht Bash, Researcher nicht Write.',
    useCases: [
      '"security" Rolle in einem Plan → bekommt nur read+grep+glob+sparc:security-review+security-review. Kein Bash.',
    ],
    refs: [
      { label: 'ROLE_SKILL_MAP', path: 'lib/agents/role-skill-map.ts:16' },
    ],
  },

  // =========================================================================
  // Security / Sandbox
  // =========================================================================
  {
    id: 'bash-path-policy-hook',
    name: 'bash-path-policy.cjs — PreToolUse Bash-Hook',
    category: 'Security/Sandbox',
    status: 'live',
    onTop: 'claude-code',
    function:
      'Claude-Code PreToolUse-Hook auf das Bash-Tool. Prüft jeden Shell-Befehl gegen die Pfad-Allowlist des aktiven Workspace und blockt Zugriffe in fremde Workspaces oder Secret-Zonen (~/.ssh, .env, ~/.lazyos/* außer cloud). DETERMINISTISCHER GUARDRAIL gegen VERSEHENTLICHEN Cross-Workspace-/Secret-Zugriff.',
    mechanism:
      'bash-path-policy.cjs:1-58. stdin = JSON {tool_name:"Bash", tool_input:{command}, cwd}. Allow = exit 0 + KEIN stdout. Block = exit 0 + JSON {hookSpecificOutput:{permissionDecision:"deny", permissionDecisionReason}}. Fail-open: interne Fehler (DB nicht lesbar, JSON-Parse) → ERLAUBEN + stderr-Log (Chat niemals wegen Infra-Fehler brechen). ABER: Treffer in SENSITIVE-Zone bleibt deterministischer Kern → blockt auch bei leerer Allowlist.',
    improves:
      'EHRLICHE GRENZE (header verbatim): "KEINE bulletproof-Sandbox gegen absichtliche Obfuskation. Sobald Bash gewährt ist, kann ein böswilliger/halluzinierender Agent die Token-Heuristik umgehen (Variable/$()/base64/printf/Heredoc/eval, Working-Directory wechseln, find /). Solche Fälle fängt nur eine echte Kernel-FS-Sandbox — die hier bewusst NICHT verwendet wird, weil claude unter sandbox-exec beim API-Turn lautlos stumm wird (empirisch verworfen)." Pragmatische 95%-Schutzschicht ohne Chat zu brechen.',
    useCases: [
      'FreeRein-Agent versucht `cat ~/.ssh/id_rsa` → block + Owner-sichtbarer Grund.',
      'Agent versucht `find ~/Documents/anderes-projekt` → block.',
      'Agent legitimerweise `pnpm test` im Workspace-Root → allow.',
    ],
    prosCons: {
      pros: [
        'Kein Sandbox-Stillstand-Risiko (siehe Header: claude unter sandbox-exec wird stumm).',
        'Deterministische Allow/Deny-Logik gegen 95% der Versehen.',
        'Fail-open bei Infra-Fehlern hält Chat lebendig.',
      ],
      cons: [
        'NICHT bulletproof gegen absichtliche Obfuskation (ehrlich dokumentiert).',
        'Token-Heuristik kann via Variable umgangen werden.',
      ],
    },
    refs: [
      { label: 'bash-path-policy.cjs (Kontrakt)', path: 'server/agents/bash-path-policy.cjs' },
      { label: 'buildBashPolicySettingsJson Wiring', path: 'server/workspace-session.ts:189' },
    ],
  },
  {
    id: 'fs-sandbox-seatbelt',
    name: 'FS-Sandbox (macOS seatbelt-Renderer)',
    category: 'Security/Sandbox',
    status: 'owner-gated',
    onTop: 'both',
    function:
      'Optionale OS-Sandbox-Hülle (sandbox-exec/seatbelt auf macOS) um den inneren Agent-Command. rw nur im Worktree, ro auf erlaubten Roots, default-deny für den Rest des FS (Secrets, Live-DB, andere Projekte). KEINE chroot/bindfs/macFUSE.',
    mechanism:
      'lib/security/fs-sandbox/macos.ts:1-65 renderSeatbeltProfile. Seatbelt-Semantik: (deny default) + last-match-wins. Trick für ~/.claude: erst (allow file-read* (subpath ~/.claude)) (OAuth lesbar), dann (deny file-read* (regex #"^~/.claude/credentials.*")) (Secret weg). MACOS_PRIVATE_SYMLINK_PREFIXES emittiert defensiv beide Pfad-Formen (/tmp + /private/tmp) damit Regeln zuverlässig matchen.',
    improves:
      'Echte OS-Level-FS-Grenze (statt nur Token-Heuristik). dark-but-ready: Tests 31/31+8/8 echte Enforcement grün; im plan-executor noch nicht selbst-aktivierend bis MAX-Auth-unter-Sandbox empirisch verifiziert.',
    useCases: [
      'Zukünftig: jeder Spawn unter FreeRein zwingend in Seatbelt → echte Mehrmandanten-Härtung.',
    ],
    prosCons: {
      pros: [
        'Echte OS-FS-Grenze; secret-files unreachable.',
        'Last-match-wins erlaubt sehr feine Permits.',
        'Symlink-resistant via PRIVATE_SYMLINK_PREFIXES.',
      ],
      cons: [
        'sandbox-exec von Apple "deprecated" (aber auf Darwin 25.x funktional — selbe Engine die Apple intern nutzt).',
        'Risiko dass claude unter Sandbox stumm wird (für Chat empirisch verworfen) — hier nur für Plan-Spawns gedacht.',
      ],
    },
    refs: [
      { label: 'renderSeatbeltProfile', path: 'lib/security/fs-sandbox/macos.ts' },
      { label: 'wrapWithSandbox-Integration', path: 'server/agents/tmux-spawn.ts:33' },
    ],
  },
  {
    id: 'k1-deny-patterns',
    name: 'K1 RAG Deny Patterns (Single Source of Truth)',
    category: 'Security/Sandbox',
    status: 'live',
    onTop: 'claude-code',
    function:
      'Zero-Dependency, frozen Set von K1 RAG-Deny-Patterns in canonical mcp__<server>__<tool>-Form. Werden gegen MCP-Tool-Namen geprüft + als --disallowedTools an claude-CLI gepasst.',
    mechanism:
      'k1-deny-patterns.ts:1-30 K1_MCP_QUALIFIED_DENY_PATTERNS (Object.freeze). Consumers: binding-resolver.ts (matchesK1Deny via @/-alias), tmux-spawn.ts (relativer Import), tool-registry-filter.ts (re-export). Drift-test (k1-drift.test.ts) asserts alle 3 Consumer identisch.',
    improves:
      'Vor K1 konnten Agents über MCP-RAG-Tools cross-workspace lesen; K1 sperrt das hart. Single-source-of-truth verhindert Drift.',
    useCases: [
      'Agent versucht mcp__local-rag__search → claude-CLI lehnt ab (disallowedTools).',
    ],
    refs: [
      { label: 'K1_MCP_QUALIFIED_DENY_PATTERNS', path: 'lib/security/k1-deny-patterns.ts:43' },
    ],
  },
  {
    id: 'execution-policy',
    name: 'enforceExecutionStep (R2-Gate)',
    category: 'Security/Sandbox',
    status: 'live',
    onTop: 'both',
    function:
      'Pro Step deterministisch (NICHT per LLM) kategorisieren ob er write / shell / network / secrets / scope berührt. Nicht erlaubte Kategorien → block + operator-sprachliche 1-Satz-Begründung. EXEC-Mode liest den Workspace-Permission-Modus als Einwilligungs-Quelle.',
    mechanism:
      'execution-policy.ts:1-42 + enforceExecutionStep (execution-policy.ts:239). Pure Funktion (keine DB/LLM/IO/child_process). Fail-closed (default-deny, sensitivity ?? "high"). Regeln: plan-only → IMMER deny; Bash → default-deny in R2; Write/Edit nur architect/coder in execute-Modi; Secrets (.env/.credential/.pem/id_rsa-Pfade) → IMMER deny; Scope (.. oder absolute Pfade außerhalb Workspace) → deny + requiresBridge:true.',
    improves:
      'Vorher konnte ein Spawn alle Tools — jetzt: pro Step deterministischer Filter VOR dem Spawn, mit klarem Owner-Grund.',
    useCases: [
      'Step "lese .env.local" → deny: secrets.',
      'Step "schreibe ../other-project/file.ts" → deny: scope + requiresBridge.',
      'Step "rm -rf /" → deny: shell + Bash default-deny.',
    ],
    refs: [
      { label: 'enforceExecutionStep', path: 'lib/security/execution-policy.ts:239' },
      { label: 'PermissionModeForGate', path: 'lib/security/execution-policy.ts:55' },
    ],
  },
  {
    id: 'dataflow-policy-cross-workspace',
    name: 'enforceDataflow — Cross-Workspace-Policy (DSGVO Art. 28+30)',
    category: 'Security/Sandbox',
    status: 'live',
    onTop: 'standalone',
    function:
      'Deterministische Cross-Workspace-Datenfluss-Entscheidung. Pure-Logic ohne DB/LLM/IO. Default-deny; fehlende Felder → reject. System-Actor ist eng begrenzte Ausnahme; high-sensitivity bleibt geblockt. Sub-Agents erben Actor-WS vom Parent (Caller MUSS das durchreichen; Validator prüft).',
    mechanism:
      'dataflow-policy.ts:1-23 + enforceDataflow (dataflow-policy.ts:77). DataflowRequest + DataflowAuditSpec + DataflowDecision. Bei auditRequired oder cross-ws → Audit-Spec → enforceDataflow-Caller schreibt im SAME-TX Audit-Row.',
    improves:
      'DSGVO Art. 28 (Mandant-Trennung) + Art. 30 (VVT) sind hier kodifiziert, nicht inferiert. Verhindert versehentliches Leak zwischen Kunden-Workspaces.',
    useCases: [
      'RAG-Query von Kunde-A-Workspace versucht Kunde-B-Chunks zu lesen → enforceDataflow deny.',
      'System-Cron-Job kann low-sensitivity-Migration anstoßen; high-sensitivity gated.',
    ],
    refs: [
      { label: 'enforceDataflow', path: 'lib/security/dataflow-policy.ts:77' },
    ],
  },
  {
    id: 'credential-vault',
    name: 'API-Credential-Vault (ACL-1, Migration 0100)',
    category: 'Security/Sandbox',
    status: 'live',
    onTop: 'standalone',
    function:
      'Server-only Vault für API-Credentials. putApiCredential (Upsert + encrypt + audit), resolveApiCredential (D2-Policy: workspace-eigenes Cred zuerst → Org-Fallback NUR wenn credential_isolation="inherit"), deleteApiCredential, decryptApiSecret (best-effort, NIEMALS geloggt).',
    mechanism:
      'vault.ts:1-26 + putApiCredential (vault.ts:326) + resolveApiCredential (vault.ts:470) + deleteApiCredential (vault.ts:653) + decryptApiSecret (vault.ts:705) + credentialExists (vault.ts:745) + recordRevealAudit (vault.ts:793). Auth-Gate canEditWorkspaceContent → null (kein Fehler-Leak) bei Deny. N8 Audit-Row bei jedem write/resolve/delete; N9 scope_kind+scope_id Isolation; N10 content_hash.',
    improves:
      'Credentials raus aus dem Code/.env-Files. Owner-Isolation-Modell explizit: "isolated" verhindert dass externer Kunde an Org-Default-Cred kommt.',
    useCases: [
      'Workspace "kunde-A" hat eigenes Higgsfield-Cred; "kunde-B" credential_isolation="isolated" → kein Org-Fallback → eigenes Onboarding pflicht.',
    ],
    refs: [
      { label: 'putApiCredential', path: 'lib/credentials/vault.ts:326' },
      { label: 'resolveApiCredential (D2)', path: 'lib/credentials/vault.ts:470' },
      { label: 'decryptApiSecret', path: 'lib/credentials/vault.ts:705' },
    ],
  },
  {
    id: 'permission-mode-enforcer',
    name: 'Permission-Mode Enforcer (audit | enforce)',
    category: 'Security/Sandbox',
    status: 'live',
    onTop: 'standalone',
    function:
      'enforcePermission({scope, toolClass, op}). Im Default-Modus ("audit") immer allow + schreibt 1 Audit-Row pro Spawn (best-effort, non-fatal — Phase-2 Allowlist-Derivation hat dadurch Daten). Im Modus "enforce" delegiert an resolvePermission und kann deny.',
    mechanism:
      'permission-mode.ts:1-26 + enforcePermissionFromSingleton + getEnforcementMode. N6: resolvePermission deterministisch vor symbolischem Reasoning. N10: content_hash; N8: append-only audit; N5: external callers können force allow=true.',
    improves:
      'Ramp-in-Strategie: erst Audit-Daten sammeln (non-disruptive), dann gezielt enforcen. Kein "alles zu" big-bang.',
    useCases: [
      'Phase 1: alles allow + audit → 30d Daten sammeln.',
      'Phase 2: enforce-Mode für Tool-Klassen ohne audit-Treffer.',
    ],
    refs: [
      { label: 'permission-mode.ts', path: 'lib/security/permission-mode.ts' },
    ],
  },

  // =========================================================================
  // RAG / Knowledge
  // =========================================================================
  {
    id: 'rag-retriever',
    name: 'RAG-Retriever (FTS5 + Cosine-Rerank, workspace-isoliert)',
    category: 'RAG/Knowledge',
    status: 'live',
    onTop: 'both',
    function:
      'Query → FTS5-Lexical → Kandidaten → Cosine-Rerank → Token-Cap → Markdown-Format für Lead-Prompt-Inject. Fallback bei 0 FTS-Treffern auf reinen Cosine-Pfad. workspaceId ist HARTE Pflicht — leer/undefined → RagWorkspaceRequiredError.',
    mechanism:
      'retriever.ts:1-40 + ftsLexicalSearch (retriever.ts:176) + sanitiseFtsQuery (retriever.ts:124) + RagWorkspaceRequiredError (retriever.ts:251) + writeAudit (retriever.ts:884). Read-Pfad über View v_rag_chunks_workspace (sensitivity!="high" doppelt gefiltert — Belt-and-Suspenders/N2). retrieveAcrossWorkspaces schreibt Audit-Row in rag_cross_workspace_audit (DSGVO Art. 30 VVT). Token-Budget 4000/Lead-Call (~16k chars).',
    improves:
      'N7 Lexical-First: bevor Vector-Sophistication kommt, FTS5+BM25. Anti "Plain-Vektor-Search ist die schwächste Form von RAG"-Critique (Anne-Pattern).',
    useCases: [
      'Plan-Lead bekommt Workspace-spezifische Code-Snippets injected; nichts cross-workspace ohne Bridge.',
      'Audit-Row pro Cross-Workspace-Query.',
    ],
    refs: [
      { label: 'ftsLexicalSearch', path: 'lib/rag/retriever.ts:176' },
      { label: 'RagWorkspaceRequiredError', path: 'lib/rag/retriever.ts:251' },
      { label: 'writeAudit', path: 'lib/rag/retriever.ts:884' },
    ],
  },
  {
    id: 'rag-source-router',
    name: 'RAG Source-Router (Pattern 3 — intent-aware weights)',
    category: 'RAG/Knowledge',
    status: 'live',
    onTop: 'standalone',
    function:
      'Klassifiziert Query nach Intent (code | status | history | unknown) via Regex und multipliziert Source-Type-Weights (file | chat | ticket | work-product) auf den Similarity-Score → Re-Sortierung. MVP-Approach (single-user, kein Cross-Encoder nötig).',
    mechanism:
      'source-router.ts:1-15 + classify (source-router.ts:43) + applyRouting (source-router.ts:53). PATTERNS: code-Patterns für "function/class/import…", "*.ts/tsx/js/py/sql"; status für "status/fortschritt/done/blocked/sprint…"; history für "entscheidung/warum/damals…". WEIGHTS für "code" boosten file/work-product, depressen chat/ticket etc.',
    improves:
      'Statt flachem Cosine-Pool, in dem Code-Files mit Chat-Logs konkurrieren — intent-aware re-ranking ohne Cross-Encoder-Aufwand.',
    useCases: [
      'Owner-Query "Wo ist der Bug?" → intent="code" → file/work-product hochgewichtet, chat depressed.',
      '"Warum haben wir damals X entschieden?" → intent="history" → chat-Logs hochgewichtet.',
    ],
    refs: [
      { label: 'classify', path: 'lib/rag/source-router.ts:43' },
      { label: 'applyRouting', path: 'lib/rag/source-router.ts:53' },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// Helpers (PURE)
// ---------------------------------------------------------------------------

/** Stable category order for navigation/anchors. */
export const CATEGORY_ORDER: readonly FeatureCategory[] = [
  'CLI-on-Top',
  'Chat-Surfaces',
  'Workstream/Plan-Executor',
  'Swarm/Plan',
  'Critic/Devil-Advocate',
  'Self-Learning',
  'Flow Studio',
  'Connectors/SOP',
  'Skills/Roles',
  'Security/Sandbox',
  'RAG/Knowledge',
] as const;

const STATUS_RANK: Record<FeatureStatus, number> = {
  live: 0,
  'owner-gated': 1,
  dev: 2,
  planned: 3,
  deferred: 4,
};

/** Group features by category, preserving CATEGORY_ORDER + status-rank. */
export function groupFeaturesByCategory(
  features: readonly Feature[] = FEATURE_CATALOG,
): ReadonlyArray<{ category: FeatureCategory; features: readonly Feature[] }> {
  const out: Array<{ category: FeatureCategory; features: Feature[] }> = [];
  for (const cat of CATEGORY_ORDER) {
    const list = features
      .filter((f) => f.category === cat)
      .slice()
      .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
    if (list.length > 0) out.push({ category: cat, features: list });
  }
  return out;
}

/** Counts per category — useful for the page header summary. */
export function countByCategory(
  features: readonly Feature[] = FEATURE_CATALOG,
): ReadonlyArray<{ category: FeatureCategory; count: number }> {
  return CATEGORY_ORDER.map((cat) => ({
    category: cat,
    count: features.filter((f) => f.category === cat).length,
  })).filter((c) => c.count > 0);
}

/** Counts per status — useful for the page header summary. */
export function countByStatus(
  features: readonly Feature[] = FEATURE_CATALOG,
): ReadonlyArray<{ status: FeatureStatus; count: number }> {
  const order: FeatureStatus[] = ['live', 'owner-gated', 'dev', 'planned', 'deferred'];
  return order
    .map((s) => ({ status: s, count: features.filter((f) => f.status === s).length }))
    .filter((c) => c.count > 0);
}

/** Slugify a category for anchor IDs. */
export function categoryAnchor(c: FeatureCategory): string {
  return c
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
