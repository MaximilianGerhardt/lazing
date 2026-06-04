/**
 * N6-Hybrid Plan-Dispatch (Slice 2, 2026-05-23).
 *
 * Verbindet das deterministische Entry-Gate (`shouldDecompose`, N6) mit dem
 * LLM-Decomposer (`proposeRecursivePlan`) und macht aus einem komplexen
 * Intent einen persistierten Plan + Subpläne plus eine `subplan`-Surface.
 *
 * Ablauf bei Gate-Treffer:
 *   1. Engine wählen (claude-cli → codex → ollama, Fallback-Kette).
 *   2. `proposeRecursivePlan(maxDepth:1)` — Root-Plan + eager Subpläne der
 *      komplexen Root-Steps (depth-1). Tiefer = Folge-Slice.
 *   3. Workstream anlegen (`createWorkstream`) — Intent verbatim in
 *      `description` (N1).
 *   4. Steps atomar persistieren: Root (depth 0) + Subpläne (depth 1) in
 *      `workstream_plan_steps`, alles in EINER Transaktion (contentHash/N10).
 *   5. `subplan`-Surface via `emitOrUpdateCard` (Pfad B → broadcast →
 *      /api/events/stream → ChatShell).
 *
 * WICHTIG — Prozess-Lokalität: MUSS im **Next-Prozess** laufen (Route
 * `app/api/chat/stream`), NICHT im agent-server (:4201). `broadcast` ist ein
 * In-Process-EventEmitter; nur im Next-Prozess erreicht der Emit die Live-
 * SSE-Listener von `/api/events/stream`. (Cross-Roast-Befund 2026-05-23.)
 *
 * Scope-Cut (Cross-Roast C-E): NUR propose + persist + render
 * (`awaitingApproval:true`). Ausführung (`runWalker` + approve→execute) ist
 * ein getrennter Folge-Slice. tier-choice bleibt LLM-Override.
 *
 * Bekannte Minor (dokumentiert, Folge-Slice): schlägt der Persist-Schritt fehl
 * (extrem selten — der Plan müsste parseProposedPlan passieren aber den
 * insertPlanStep-Hard-Block treffen), bleibt eine leere Workstream-Row liegen.
 * Die Steps selbst sind durch die Transaktion all-or-nothing (kein Teil-Plan).
 */
import { shouldDecompose } from './should-decompose';
import { proposeRecursivePlan } from './recursive-plan';
import { getDb } from '@/db/client';
import { insertProposedPlan } from '@/lib/workstreams/plan-repo';
import { createWorkstream, updateWorkstream } from '@/lib/workstreams/service';
import { emitOrUpdateCard } from '@/lib/events/emit-or-update-card';
import { detectEngines, pickEngine } from '@/lib/llm/engines/selector';
import { resourcePool } from '@/lib/agents/resource-pool';
import type { PoolSlot } from '@/lib/agents/resource-pool';
import { waitForBudget } from '@/lib/agents/tpm-budget';
import { writeDecision } from '@/lib/workstreams/trace-repo';
import { emitAnswerRequired } from '@/lib/push/triggers';
// W1b — Self-Learning P0 (2026-05-28): Read-Back des WARUM-Kontexts (frühere
// Begründungen + aktive Beliefs dieses Workspace) vor jedem Decompose. Vorlage:
// app/api/flow/compose-and-run/route.ts:156-167. proposeRecursivePlan reicht den
// String unverändert auf JEDER Rekursions-Ebene durch (Root + eager Subpläne).
// Leerer/fehlender Block ⇒ bit-identisch zum bisherigen Pfad.
import {
  buildWhyContext,
  renderWhyContextForPrompt,
} from '@/lib/reasoning/why-context';
// Slice C (2026-05-29) — Discovery-Phase VOR Plan-Decompose. Owner-Befund
// (example-website-3, verbatim): „Ich sehe niemanden der die Website recherchiert
// oder sich ansieht, da müsste doch eine Art Browser Bash erstmal kommen usw
// oder nicht?! Analyse, Recherche…". Diese Phase erkennt URLs/Domains/Doku-
// Mentions im Prompt, ruft die URLs fail-soft ab und stellt das Ergebnis als
// Markdown-Block VOR den whyContext-Block — Reihenfolge: Discovery > WHY > Intent.
import { runDiscovery, type DiscoveryResult } from '@/lib/discovery/discovery-phase';

export interface PlanDispatchResult {
  readonly decomposed: boolean;
  readonly reason: string;
  readonly workstreamId?: string;
  readonly planId?: string;
  readonly rootSteps?: number;
  readonly subSteps?: number;
}

/** Per-Call-Soft-Cap für einen einzelnen Planner-LLM-Aufruf (ms). */
const PLANNER_CALL_TIMEOUT_MS = 30_000;
/**
 * Harte Gesamt-Deadline für den ganzen Decompose (Critic-Fix B2, 2026-05-23).
 * proposeRecursivePlan macht bis zu 1+N sequenzielle LLM-Calls; ohne Cap
 * könnte das den Chat minutenlang ohne Lebenszeichen blockieren. Reißt die
 * Deadline, bricht der AbortController alle Engine-Calls ab → tryPlanDispatch
 * wirft → Caller fällt auf den normalen claude-Turn zurück.
 */
const TOTAL_DEADLINE_MS = 40_000;
/**
 * Ultrathink (2026-06-02, default-off-gated). Tieferes Reasoning via
 * `--effort` dauert länger — deshalb hebt der claude-cli-Pfad die Per-Call-
 * und Gesamt-Deadlines an. Gilt AUSSCHLIESSLICH wenn die gewählte Planner-
 * Engine claude-cli ist; jeder andere Pfad (ollama) nutzt unverändert
 * PLANNER_CALL_TIMEOUT_MS / TOTAL_DEADLINE_MS → byte-identisch zu vorher.
 */
const PLANNER_CALL_TIMEOUT_THINKING_MS = 90_000; // vs 30_000 default
const TOTAL_DEADLINE_THINKING_MS = 120_000; // vs 40_000 default

/**
 * Gate + Decompose + Persist + Emit. Gibt `{decomposed:false}` schnell zurück,
 * wenn das Gate nicht feuert (oder keine Engine verfügbar ist) — der Caller
 * macht dann mit dem normalen claude-Turn weiter. Bei Abbruch/Deadline/Fehler
 * im schweren Teil wirft die Funktion; der Caller behandelt das als
 * Fallback-auf-Normal.
 */
export async function tryPlanDispatch(args: {
  workspaceId: string;
  prompt: string;
  /** Client-Disconnect/Request-Abort — bricht den Decompose mit ab (M1). */
  signal?: AbortSignal;
}): Promise<PlanDispatchResult> {
  // 1. Deterministisches N6-Gate (billig, kein LLM, kein I/O).
  const gate = shouldDecompose(args.prompt);
  if (!gate.decompose) {
    return { decomposed: false, reason: gate.reason };
  }

  // 2. Engine wählen. B1-Sicherheits-Fix (Critic, 2026-05-23): codex AUSSCHLIESSEN
  //    — der codex-Adapter läuft im Code-Mode (`approval_policy="never"`, schreibt
  //    Dateien/Shell). Der Planer braucht nur Text (Plan-JSON); claude-cli/ollama
  //    genügen. Keine Engine → kein Decompose, normaler Turn.
  const selection = await detectEngines();
  const engine = pickEngine(selection, ['codex-cli']);
  if (!engine) {
    return { decomposed: false, reason: 'no-engine-available' };
  }
  // N11-Per-Kind-Buchung korrekt: Slot-Kind aus der gewählten Engine.
  const slotKind: 'claude-cli' | 'ollama-heavy' =
    engine.id === 'ollama' ? 'ollama-heavy' : 'claude-cli';

  // Gesamt-Deadline + externes Abort-Signal zu EINEM Controller bündeln.
  const ctl = new AbortController();
  const onExternalAbort = (): void => ctl.abort();
  if (args.signal) {
    if (args.signal.aborted) ctl.abort();
    else args.signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  // Ultrathink: nur der claude-cli-Pfad bekommt die angehobene Gesamt-Deadline;
  // jede andere Engine (ollama) behält TOTAL_DEADLINE_MS → byte-identisch.
  const totalDeadlineMs =
    engine.id === 'claude-cli' ? TOTAL_DEADLINE_THINKING_MS : TOTAL_DEADLINE_MS;
  const deadline = setTimeout(() => ctl.abort(), totalDeadlineMs);

  // Budget-Gate: Slot vom ResourcePool holen (N11-Hard-Cap: max 2 claude-cli-Slots
  // gleichzeitig). Timeout 20s damit ein blockierter Planer den Chat-Turn nicht
  // ewig hängen lässt — bei Timeout graceful auf normalen Turn zurückfallen.
  // TPM-Budget-Check direkt danach: bei hoher Last schläft waitForBudget kurz,
  // bevor der Planer einen weiteren LLM-Call startet.
  let slot: PoolSlot | undefined;
  try {
    slot = await resourcePool.acquireSlot({
      kind: slotKind,
      subagentId: 'planner:' + args.workspaceId,
      priority: 'normal',
      timeoutMs: 20_000,
      signal: ctl.signal,
    });
  } catch (budgetErr) {
    // ResourcePoolTimeout oder Abort — kein Slot verfügbar, graceful Fallback.
    clearTimeout(deadline);
    if (args.signal) args.signal.removeEventListener('abort', onExternalAbort);
    const msg = budgetErr instanceof Error ? budgetErr.message : String(budgetErr);
    return { decomposed: false, reason: 'budget-timeout:' + msg };
  }

  // TPM-Drosselung abwarten (rolling-60s-Window). Bei >100% TPM schläft die
  // Funktion bis zu 30s — das Abort-Signal des Callers stoppt ctl rechtzeitig.
  await waitForBudget('plan-dispatch:' + args.workspaceId);

  try {
    const callEngine = async (prompt: string): Promise<string> => {
      // Ultrathink: nur claude-cli unterstützt `--effort`; strikt auf engine.id
      // gaten. Default-off für ollama (die andere zulässige Planner-Engine) →
      // dort bleiben Prompt-Bytes UND Timeouts byte-identisch zum bisherigen Pfad.
      const useThinking = engine.id === 'claude-cli';
      const r = await engine.chat({
        messages: [{ role: 'user', content: prompt }],
        timeoutMs: useThinking ? PLANNER_CALL_TIMEOUT_THINKING_MS : PLANNER_CALL_TIMEOUT_MS,
        signal: ctl.signal,
        ...(useThinking ? { thinking: true } : {}),
      });
      return r.text;
    };

    // W1b — Self-Learning P0: WARUM-Kontext fail-soft lesen (s. Helper unten).
    const whyContext = readWhyContextForDispatchFailSoft({
      workspaceId: args.workspaceId,
      topic: args.prompt,
    });

    // Slice C (2026-05-29) — Workstream zuerst anlegen, damit wir Discovery
    // als sichtbare Surface (subKey='discovery') unter der KORREKTEN coord-
    // Adresse emittieren können — VOR dem Plan-Decompose / der Tier-Wahl.
    //
    // Trade-off: bei Engine-Failure im proposeRecursivePlan-Call bleibt eine
    // leere Workstream-Row stehen. Der Caller fängt den Throw und der Outer-
    // Fallback nutzt einen normalen claude-Turn. Die leere Row stört nicht
    // (status wird beim cleanup-end auf 'done' gesetzt, oder bleibt
    // 'proposed'/'active' und wird vom heartbeat-Reaper aufgeräumt).
    //
    // 3. Workstream anlegen (Owner des Plans). Intent verbatim (N1).
    const ws = await createWorkstream({
      workspaceId: args.workspaceId,
      name: planName(args.prompt),
      description: args.prompt,
    });
    const workstreamId = ws.id;
    const coordKey = `${args.workspaceId}/${workstreamId}`;

    // 4. Slice C — Discovery-Phase VOR Plan-Decompose. Fail-soft: ein Wurf
    //    darf den Decompose nicht kippen; bei Fehler ⇒ leerer Discovery-
    //    Output ⇒ Plan-Prompt bit-identisch zum Pre-Slice-C-Pfad.
    //
    //    Emit-Pattern (eine Card pro Workstream, subKey='discovery'):
    //      a) pre-emit „running" (eine Zeile, collapsed) — sofort sichtbar.
    //      b) runDiscovery (parallel fetch, 12s pro URL).
    //      c) post-emit „done" — selbe coords, idempotent (emitOrUpdateCard
    //         UPDATEt die Row in-place).
    const discovery = await runDiscoveryAndEmitFailSoft({
      workspaceId: args.workspaceId,
      workstreamId,
      intent: args.prompt,
      signal: ctl.signal,
    });

    // 5. Decompose: Root-Plan + eager depth-1-Subpläne.
    //    Reihenfolge laut Owner-Spec: Discovery > WHY > Intent. proposePlan
    //    stellt den whyContext-String 1:1 vor den Basis-Prompt
    //    (orchestrate-plan.ts:319-323). Wir konkatenieren Discovery + WHY in
    //    derselben Reihenfolge und reichen das Gesamtpaket als „whyContext"
    //    durch — kein neuer Parameter, kein Signatur-Bruch, identisch leerer
    //    Pfad wenn beides leer.
    const composedContext = composeDiscoveryAndWhy(discovery.builtContext, whyContext);
    const recursive = await proposeRecursivePlan(args.prompt, {
      callEngine,
      maxDepth: 1,
      ...(composedContext ? { whyContext: composedContext } : {}),
    });
    const rootPlan = recursive.root.plan;

    // 5. Persistieren: Root (depth 0) + alle eager Subpläne (depth 1) in EINER
    //    äußeren Transaktion → ganzer Plan-Baum all-or-nothing (B1).
    let subSteps = 0;
    const persist = getDb().$raw.transaction((): void => {
      insertProposedPlan({ workstreamId, plan: rootPlan, depth: 0, coordKey });
      for (const [parentStepId, child] of recursive.root.children) {
        insertProposedPlan({
          workstreamId,
          plan: child.plan,
          depth: 1,
          coordKey,
          parentStepId,
        });
        subSteps += child.plan.steps.length;
      }
    });
    persist();

    // N8-Trace (best-effort, non-fatal): Entscheidung „Intent als mehrstufig
    // erkannt → Plan erzeugt" in workstream_decisions festhalten.
    // decision_kind='route' (gate-Routing-Entscheidung), actor='agent'.
    // writeDecision schreibt intern eine Sentinel-Evidence-Row (source_kind='spawn')
    // damit evidence_refs ≥1-Constraint erfüllt ist.
    writeDecision({
      workspaceId: args.workspaceId,
      workstreamId,
      coordKey,
      decisionKind: 'route',
      rationale: `Intent als mehrstufig erkannt → Plan erzeugt: ${gate.reason}`,
      actor: 'agent',
    });

    // 6. subplan-Surface emittieren (Pfad B). Payload = ProposedPlan +
    //    depth/awaitingApproval (s. SurfaceRenderer.renderSubplan).
    const surfacePayload = {
      ...rootPlan,
      depth: 0,
      awaitingApproval: true,
      workstreamId,
    };
    const childCount = recursive.root.children.size;
    await emitOrUpdateCard({
      coords: { workspaceId: args.workspaceId, workstreamId, surfaceKind: 'subplan' },
      content:
        `Das sieht nach einem mehrstufigen Vorhaben aus — hier mein Plan-Vorschlag ` +
        `(${rootPlan.steps.length} Schritte` +
        `${childCount > 0 ? `, ${childCount} davon mit eigenem Subplan` : ''}). ` +
        `Review & freigeben, oder sag mir, was anzupassen ist.\n\n` +
        `<surface:subplan>${JSON.stringify(surfacePayload)}</surface:subplan>`,
      actor: 'system',
    });

    // B2 (2026-05-25): answer_required-Push für awaitingApproval-Subplan.
    // Best-effort / non-fatal — darf emitOrUpdateCard-Ergebnis nie blockieren.
    // Visibility-Gate greift im emitAnswerRequired-Body (kein Push wenn Tab offen).
    emitAnswerRequired({
      workspaceId: args.workspaceId,
      entityId: workstreamId,
      kind: 'approval',
      preview: `Plan "${planName(args.prompt)}" (${rootPlan.steps.length} Schritte) wartet auf Freigabe`,
      url: `/?workspace=${encodeURIComponent(args.workspaceId)}`,
    });

    // 7. Depth-1-Subpläne sichtbar machen: pro Child-Knoten eine eigene
    //    subplan-Card emittieren (subKey='sub:<parentStepId>' — Welle-7-Discriminator).
    //
    //    `parentStep` = der Root-Step, dessen id === parentStepId, damit die
    //    SubplanCard den Kontext-Header „Subplan — <Step-Titel>" rendern kann (N1).
    //    `awaitingApproval: false` — Freigabe läuft über die Root-Card (Schritt 6).
    //
    //    Best-effort: ein Fehler bei einem einzelnen Child-Emit tötet NICHT den
    //    Haupt-Flow (der Plan ist bereits persistiert + die Root-Card emittiert).
    for (const [parentStepId, child] of recursive.root.children) {
      // Root-Step mit passender id suchen (Pflichtfeld: id + title → isPlanStep).
      const parentStep = rootPlan.steps.find((s) => s.id === parentStepId) ?? null;

      const childPayload = {
        ...child.plan,
        depth: 1,
        awaitingApproval: false,
        workstreamId,
        // parentStep wird vom SurfaceRenderer gelesen und als Prop an SubplanCard
        // weitergereicht; dort steuert er den Header „Subplan — <parentStep.title>".
        parentStep: parentStep ?? undefined,
        // Owner-Fix 2026-05-28 (Owner-Live-Test: „extremst viele Surfaces auf
        // einmal"): Child-Subplaene starten EINGEKLAPPT — der Parent-Subplan
        // bleibt offen, jeder Child ist eine Pill mit Chevron, ein-Tap zum
        // Ausklappen. Verhindert dass T+0s 1+N Subplan-Cards gleichzeitig den
        // Strom fluten. Renderer-seitig: SubplanCard.initialCollapsed (read
        // via SurfaceRenderer.renderSubplan).
        collapsed: true,
      };

      try {
        await emitOrUpdateCard({
          coords: {
            workspaceId: args.workspaceId,
            workstreamId,
            surfaceKind: 'subplan',
            // Welle-7-subKey: muss non-empty sein (emitOrUpdateCard wirft sonst).
            subKey: 'sub:' + parentStepId,
          },
          content: `<surface:subplan>${JSON.stringify(childPayload)}</surface:subplan>`,
          actor: 'system',
        });
      } catch (childEmitErr) {
        // Nur loggen — der Haupt-Flow ist nicht betroffen.
        console.warn(
          '[plan-dispatch] Depth-1-Subplan-Emit fehlgeschlagen',
          { parentStepId, err: childEmitErr },
        );
      }
    }

    // #3-Fix (2026-05-23): Proposal-Workstream NICHT als "running" hinterlassen.
    // Er wartet nur auf Freigabe — sonst meldet /api/activity/live ihn ewig als
    // Hintergrund-Aktivität (der "7h37m"-Bug: status IN (active|paused|stuck)).
    // 'done' ist nicht in dieser Menge. Bei echter Ausführung setzt executePlan
    // wieder 'active' und am Ende 'done'.
    try {
      await updateWorkstream(workstreamId, { status: 'done' });
    } catch (statusErr) {
      console.warn(
        '[plan-dispatch] Workstream-Status→done fehlgeschlagen (non-fatal):',
        statusErr instanceof Error ? statusErr.message : String(statusErr),
      );
    }

    return {
      decomposed: true,
      reason: gate.reason,
      workstreamId,
      planId: rootPlan.id,
      rootSteps: rootPlan.steps.length,
      subSteps,
    };
  } finally {
    clearTimeout(deadline);
    if (args.signal) args.signal.removeEventListener('abort', onExternalAbort);
    // Slot freigeben — guard gegen den Timeout-Pfad oben, wo slot undefined bleibt.
    if (slot !== undefined) {
      resourcePool.releaseSlot(slot.slotId);
    }
  }
}

/** Kurzer Workstream-Label aus der ersten Prompt-Zeile (Label, kein Ledger-Feld). */
function planName(prompt: string): string {
  const firstLine = (prompt.trim().split('\n')[0] ?? prompt.trim()).trim();
  if (firstLine.length <= 80) return firstLine || 'Plan';
  return `${firstLine.slice(0, 79)}…`;
}

/**
 * W1b — Self-Learning P0 (2026-05-28). Read-Back des WARUM-Kontexts
 * (frühere Begründungen + aktive Beliefs) als pill-lesbarer String. Strikt
 * fail-soft: jeder Fehler ⇒ undefined ⇒ proposeRecursivePlan sieht KEINEN
 * whyContext ⇒ Prompt-Bytes bit-identisch zum bisherigen Pfad (E1.3).
 *
 * Exportiert für Unit-Tests — der Echt-Aufruf liegt im decomposeAndPersist-
 * Hauptkörper. KEIN getDb-Singleton-Throw bricht die Komposition.
 *
 * Hinweise:
 *  - workspaceId leer/whitespace → buildWhyContext wirft (N9-Scope-Guard) →
 *    catch → undefined (kein Block).
 *  - Leerer/whitespace-only Renderer-Output → undefined (kein Block).
 */
export function readWhyContextForDispatchFailSoft(args: {
  workspaceId: string;
  topic: string;
}): string | undefined {
  try {
    const rendered = renderWhyContextForPrompt(
      buildWhyContext(getDb().$raw, {
        workspaceId: args.workspaceId,
        topic: args.topic,
      }),
    );
    return rendered.trim().length > 0 ? rendered : undefined;
  } catch (whyErr) {
    console.warn(
      '[plan-dispatch] WHY-Read fail-soft (kein Block angehängt):',
      whyErr instanceof Error ? whyErr.message : String(whyErr),
    );
    return undefined;
  }
}

/**
 * Slice C (2026-05-29) — Konkateniert Discovery-Block + WHY-Block in der
 * Reihenfolge „Discovery > WHY > Intent". Strikt fail-soft:
 *   - Beide leer/undefined ⇒ undefined ⇒ proposeRecursivePlan sieht KEINEN
 *     whyContext ⇒ Plan-Prompt bit-identisch zum Pre-Slice-C-Pfad (Identitäts-
 *     Pfad).
 *   - Nur Discovery vorhanden ⇒ nur Discovery.
 *   - Nur WHY vorhanden ⇒ nur WHY (Pre-Slice-C-Verhalten).
 *   - Beide vorhanden ⇒ Discovery + leerzeile + WHY.
 *
 * Exportiert für Unit-Tests.
 */
export function composeDiscoveryAndWhy(
  discoveryBlock: string | undefined,
  whyBlock: string | undefined,
): string | undefined {
  const d = (discoveryBlock ?? '').trim();
  const w = (whyBlock ?? '').trim();
  if (d.length === 0 && w.length === 0) return undefined;
  if (d.length === 0) return w;
  if (w.length === 0) return d;
  return `${d}\n\n${w}`;
}

/**
 * Slice C (2026-05-29) — Discovery-Phase + Emit-Pattern. Wirft NIE; bei
 * Fehler liefert sie einen Discovery-Result mit leeren Listen + leerem
 * Kontextblock, sodass der Plan-Pfad bit-identisch zum Pre-Slice-C-Verhalten
 * läuft.
 *
 * Emit-Sequenz pro Workstream (subKey='discovery'):
 *   1) pre-emit „running" — sichtbar, sofort.
 *   2) runDiscovery (parallel fetch, max 8 URLs, 12s je URL).
 *   3) post-emit „done" — selbe coords ⇒ UPDATE in-place.
 *
 * Idempotenz: emitOrUpdateCard nutzt (workspaceId, workstreamId, surfaceKind,
 * subKey) als Key. Beide Emits matchen denselben Key — kein Doppel-Card-Spam.
 *
 * Exportiert für Unit-Tests.
 */
export async function runDiscoveryAndEmitFailSoft(args: {
  workspaceId: string;
  workstreamId: string;
  intent: string;
  signal?: AbortSignal;
}): Promise<{
  builtContext: string;
  urlCount: number;
  docMentionCount: number;
}> {
  // signal ist Reserve: runDiscovery hat eigene per-Fetch-Timeouts; eine
  // weitere Verkettung wäre Komfort, kein Sicherheits-Gate. Wir markieren
  // den Parameter explizit als noch nicht verwendet (kein lint-warn).
  void args.signal;
  const coords = {
    workspaceId: args.workspaceId,
    workstreamId: args.workstreamId,
    surfaceKind: 'discovery' as const,
    subKey: 'discovery',
  };
  // 1) pre-emit „running".
  try {
    await emitOrUpdateCard({
      coords,
      content:
        `<surface:discovery>${JSON.stringify({
          workspaceId: args.workspaceId,
          workstreamId: args.workstreamId,
          status: 'running',
          urls: [],
        })}</surface:discovery>`,
      actor: 'system',
    });
  } catch (preErr) {
    console.warn(
      '[plan-dispatch] Discovery pre-emit fail-soft:',
      preErr instanceof Error ? preErr.message : String(preErr),
    );
  }

  // 2) runDiscovery.
  let result;
  try {
    result = await runDiscovery({
      workspaceId: args.workspaceId,
      intent: args.intent,
    });
  } catch (runErr) {
    console.warn(
      '[plan-dispatch] runDiscovery fail-soft:',
      runErr instanceof Error ? runErr.message : String(runErr),
    );
    // Fallback: leerer Result ⇒ Plan-Prompt bit-identisch zu Pre-Slice-C.
    result = {
      urls: [] as DiscoveryResult['urls'],
      pendingDocRequests: [] as DiscoveryResult['pendingDocRequests'],
      builtContext: '',
    };
  }

  // 3) post-emit „done" — selbe coords, idempotent.
  const status: 'done' | 'failed' =
    result.urls.length === 0 && result.pendingDocRequests.length === 0
      ? 'done'
      : 'done';
  try {
    await emitOrUpdateCard({
      coords,
      content:
        `<surface:discovery>${JSON.stringify({
          workspaceId: args.workspaceId,
          workstreamId: args.workstreamId,
          status,
          urls: result.urls,
          pendingDocRequests: result.pendingDocRequests,
        })}</surface:discovery>`,
      actor: 'system',
    });
  } catch (postErr) {
    console.warn(
      '[plan-dispatch] Discovery post-emit fail-soft:',
      postErr instanceof Error ? postErr.message : String(postErr),
    );
  }

  return {
    builtContext: result.builtContext,
    urlCount: result.urls.length,
    docMentionCount: result.pendingDocRequests.length,
  };
}
