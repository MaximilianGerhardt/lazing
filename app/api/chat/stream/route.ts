/**
 * POST /api/chat/stream
 *
 * Proxy to the lazyOS agent-server (`server/agent-server.ts`, usually at
 * `LAZYOS_AGENT_URL`). The agent-server orchestrates the Claude Code CLI
 * per workspace under Max's MAX-Plan — lazyOS itself burns no API credits.
 *
 * ## Auth
 *   - Inbound auth is handled by `middleware.ts` via the session cookie.
 *     By the time we reach this handler the request is authenticated.
 *   - Outbound: we attach a server-side-only Bearer token
 *     (`LAZYOS_CHAT_KEY`) to reach the agent-server. This token is never
 *     exposed to the client.
 *
 * ## Streaming
 *   The agent emits `text/event-stream` with named events:
 *     ready | token | tool_call | tool_result | permission_denied |
 *     error | too_many_turns | done
 *   We pass the body through verbatim so the client parser can consume
 *   it as-is. No decoding, no transformation.
 *
 * ## Error mapping
 *   - `LAZYOS_AGENT_URL` not set         → 503 agent_not_configured
 *   - fetch timeout / network            → 504 agent_timeout
 *   - upstream 401                       → 500 agent_auth_misconfig
 *     (our outbound Bearer is wrong — not a user fault)
 *   - upstream 404 (workspace_not_found) → 404 workspace_not_found
 *   - upstream 5xx                       → 502 agent_error + reqId
 *
 * ## Abort
 *   `req.signal` → outbound `AbortController.abort()` → agent-server
 *   notices client disconnect and aborts the Claude CLI subprocess.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { emitChatMessageSent, emitChatMessageCompleted } from "@/lib/events/emit";
import { piiVaultEnabled, tokenizeMessages } from "@/lib/privacy/protect";
import { makeSseDetokenizer } from "@/lib/privacy/sse-detokenize";
import { ulid } from "@/lib/ulid";
import { appendLedgerRow } from "@/lib/chat/ledger";
import { getDb } from "@/db/client";
import { currentSubject } from "@/lib/security/subject";
// Type-only (erased at compile) — annotates the ultracoding lane-event sink so
// the SSE bridge stays typed regardless of cross-slice module landing order.
import type { SubagentLaneEvent } from "@/lib/agents/spawner-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(32_000),
});

// Akzeptiert echte Workspace-IDs, __root__ Cross-Workspace-Pseudo, und
// Klammer-IDs aus dem Sessions-Registry ((root)/(tmp)).
const WorkspaceIdSchema = z
  .string()
  .min(1)
  .max(96)
  // Org-Root-Scope `__org_root__:<orgId>` (Phase IA.1) zugelassen — sonst
  // verwirft der `:` die workspaceId → 400. max(96) deckt den Prefix-Overhead.
  .regex(/^(?:__org_root__:)?[a-z0-9_()][a-z0-9_()-]{0,63}$/i);

const BodySchema = z.object({
  messages: z.array(MessageSchema).min(1).max(40),
  workspaceId: WorkspaceIdSchema,
  /** Reserved for the approval-gate (Stream H). Forwarded as-is. */
  sensitivityFloor: z.enum(["low", "med", "high"]).optional(),
  /**
   * Engine-Routing (Engine-Pill, C6 entgate · 2026-05-25).
   *
   * Alle vier Modi sind jetzt routbar:
   *   'claude-cli'   — bestehender agent-server-Pfad (default).
   *   'ollama'       — buildOrchestratorSse(mode:'ollama') — lokaler HTTP-Text-Chat.
   *   'parallel-all' — buildOrchestratorSse(mode:'parallel-all') — Race claude+ollama+codex-READ.
   *   'codex-cli'    — buildOrchestratorSse(mode:'codex-cli', codexMode:'read') — read-only sandbox.
   *
   * Sicherheitsgarantie: codex-cli im Chat-Pfad läuft IMMER mit codexMode:'read'
   * (OS-Level-Sandbox, kein Write, kein Shell-Side-Effect). Write-codex ist über
   * diesen Pfad physisch nicht erreichbar — der orchestrate()-Call erzwingt 'read'
   * auf Engine-Ebene (resolveSandboxFlags), unabhängig vom Caller.
   */
  engineMode: z
    .enum(["parallel-all", "claude-cli", "codex-cli", "ollama", "ultracoding"])
    .optional(),
  /**
   * 2-Stufen-Modell (Owner 2026-06-03): wenn der Client einen mehrstufigen
   * Intent erkannt hat (ChatShell `shouldDecompose`), setzt er `thinking:true`.
   * Im claude-cli-Default-Pfad wird das an :4201 → sendPrompt → `--effort`
   * weitergereicht. Fehlt das Feld → schneller Turn (heutiges Verhalten).
   */
  thinking: z.boolean().optional(),
  thinkingBudget: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
});

/** Timeout for getting the *first byte* from the agent. After that, the
 *  upstream stream dictates pacing and we just pipe through. 20s matches
 *  the agent's own cold-start budget for the Claude CLI. */
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * TD-4 fix 2026-04-26: Strip UI-/Agent-Hint-Marker aus dem Content bevor wir
 * persistieren. Konservativ — nur die exakten Strings die ChatShell heute
 * anhaengt; keine fuzzy-RegExp die auch User-Text matchen koennte.
 */
const AGENT_HINT_TRAILERS: RegExp[] = [
  /\n\n\[Auto-Mode aktiv\]\s*$/,
];

function stripAgentHints(content: string): string {
  let out = content;
  for (const re of AGENT_HINT_TRAILERS) {
    out = out.replace(re, "");
  }
  return out;
}


export async function POST(req: Request): Promise<Response> {
  // ---- 1. Env gate -----------------------------------------------------
  // Default auf lokalen Agent-Server wenn env fehlt (VPS-Next.js läuft neben
  // dem Agent-Server, 127.0.0.1:4201 ist direkt erreichbar). Auf Vercel
  // muss LAZYOS_AGENT_URL gesetzt sein (externe URL), auf VPS reicht local.
  const agentUrl = (process.env.LAZYOS_AGENT_URL ?? "http://127.0.0.1:4201").trim();
  const chatKey = (process.env.LAZYOS_CHAT_KEY ?? "").trim();

  if (!agentUrl) {
    return NextResponse.json(
      {
        error: "agent_not_configured",
        hint: "LAZYOS_AGENT_URL ist nicht gesetzt. Setze den Cloudflare-Tunnel in der Vercel-Env.",
      },
      { status: 503 },
    );
  }
  if (!chatKey) {
    return NextResponse.json(
      {
        error: "agent_auth_misconfig",
        hint: "LAZYOS_CHAT_KEY fehlt in der Vercel-Env.",
      },
      { status: 500 },
    );
  }

  // ---- 2. Body parse ---------------------------------------------------
  let body: z.infer<typeof BodySchema>;
  try {
    const raw: unknown = await req.json();
    body = BodySchema.parse(raw);
  } catch (err) {
    return NextResponse.json(
      {
        error: "invalid_request",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 400 },
    );
  }

  // ---- 2.5 Persistiere User-Message (Phase MS) -------------------------
  // VOR dem Agent-Call die User-Message als chat_message_sent-Event
  // schreiben, damit sie auch dann ueberlebt wenn der Agent-Server
  // haengt oder der Client sofort disconnected. Cross-Device-sichtbar
  // ueber /api/events/stream und /api/chat/history.
  //
  // pendingPromptId wird im allerersten SSE-Frame an den Client zurueck
  // geliefert ("event: pending_id"). Der Client merkt sich diese ID und
  // ignoriert sein eigenes Echo wenn das chat_message_sent-Event live
  // ueber den Event-Stream zurueckkommt (sonst Doppel-Render).
  const lastUserMessage = [...body.messages].reverse().find((m) => m.role === "user");
  // Bug-C-RACE Fix 2026-04-26: Wenn der Client eine pendingPromptId per
  // Header `X-LazyOS-Pending-Id` mitschickt, nutzen wir die — der Client
  // hat sie dann schon in seinem `ownPendingIdsRef`-Set, BEVOR der
  // chat_message_sent-Live-Event ankommt. Echo-Filter greift sofort.
  // Validierung: max 64 Zeichen, nur safe-chars (UUID/ULID-Format).
  const headerPid = req.headers.get("x-lazyos-pending-id");
  const isValidPid =
    typeof headerPid === "string" &&
    headerPid.length > 0 &&
    headerPid.length <= 64 &&
    /^[A-Za-z0-9_-]+$/.test(headerPid);
  const pendingPromptId = isValidPid ? headerPid! : ulid();

  // ---- Actor-Detection: Cookie -> user:max, Bearer -> agent:* ----------
  // Cookie zuerst (User-typed prompts). Wenn kein Cookie aber Bearer
  // vorhanden -> Bearer-Auth-Call (CLI / Test-Skript / Terminal-Claude).
  // Header-Override `X-LazyOS-Caller` erlaubt expliziten Actor-Tag (z.B.
  // 'agent:terminal-claude'). Default fuer Bearer-without-header: 'agent:api'.
  const actor: `user:${string}` | `agent:${string}` = detectActor(req);

  if (lastUserMessage) {
    try {
      // TD-4 fix 2026-04-26: `[Auto-Mode aktiv]` ist ein UI-/Agent-Hint und
      // hat in der persistierten chat_message_sent-History nichts zu suchen
      // — User sah den Trailer in alten Messages nach jedem Reload. Strippen
      // VOR emit; der Forward an den Agent (body.messages, weiter unten)
      // bleibt unveraendert, sonst verlieren wir den Mode-Hint im
      // workspace-session.ts-System-Prompt.
      const cleanedContent = stripAgentHints(lastUserMessage.content);
      await emitChatMessageSent({
        workspaceId: body.workspaceId,
        content: cleanedContent,
        pendingPromptId,
        actor,
      });
    } catch (err) {
      // Best-effort. Wenn die DB nicht erreichbar ist, lassen wir den
      // Stream trotzdem weiterlaufen — die UI schreibt die User-Message
      // local-first weiter, und das chat_turn-Audit-Log haelt Audit
      // separat. Aber loggen damit Max das im Health-Check sieht.
      console.warn(
        "[chat/stream] emitChatMessageSent failed:",
        err instanceof Error ? err.message : String(err),
      );
    }

    // N8-Trace · chat_ledger User-Message (BACKPORT-01 · 2026-05-24)
    // Best-effort — ein Ledger-Fehler darf den Chat-Stream NIEMALS killen.
    // contentFull = lastUserMessage.content VERBATIM (N1 — kein stripAgentHints
    // hier; das Ledger soll das echte User-Wort, Hints und alles, damit die
    // Trace-Zeile exakt das wiedergibt, was der User tatsächlich gesendet hat).
    // coordKey = workspaceId (minimaler ManifestCoord, N9).
    // conversationThreadId = pendingPromptId (per-Turn-Schlüssel; verbindet
    // User-Message und Assistant-Response in einer Thread-Gruppe).
    try {
      appendLedgerRow(getDb().$raw, {
        coordKey: body.workspaceId,
        role: "user",
        contentFull: lastUserMessage.content,
        conversationThreadId: pendingPromptId,
      });
    } catch (err) {
      console.warn(
        "[chat/stream] appendLedgerRow(user) failed (non-fatal):",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // ---- 2.7 N6-Hybrid Plan-Dispatch — „Hybrid sanft" (Slice 2, 2026-05-23) -
  // Bei komplexem Intent zerlegen wir im HINTERGRUND in Plan+Subpläne und
  // emittieren eine `subplan`-Surface (Pfad B → broadcast → /api/events/stream,
  // selber Next-Prozess → erreicht den Live-Client). Der normale claude-Turn
  // läuft TROTZDEM weiter (kein return) — der User bekommt IMMER eine Antwort
  // UND zusätzlich die Plan-Karte. Fire-and-forget mit eigener 40s-Deadline,
  // bewusst NICHT an req.signal gekoppelt, damit der Plan auch fertig wird,
  // wenn der Antwort-Stream schon geschlossen ist. Gate-Miss/Fehler = no-op.
  if (lastUserMessage) {
    const planPrompt = lastUserMessage.content;
    void (async () => {
      try {
        const { tryPlanDispatch } = await import("@/lib/plan-first/plan-dispatch");
        const r = await tryPlanDispatch({
          workspaceId: body.workspaceId,
          prompt: planPrompt,
        });
        if (r.decomposed) {
          console.info(
            `[chat/stream] plan-dispatch(bg): decomposed ws=${r.workstreamId} ` +
              `steps=${r.rootSteps}+${r.subSteps} (${r.reason})`,
          );
        }
      } catch (err) {
        console.warn(
          "[chat/stream] plan-dispatch(bg) failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    })();
  }

  // ---- 2.8 ACL5-E Auto-Connect — Hybrid (2026-05-24) ----------------------
  // Deterministisches Connector-Gate im HINTERGRUND (fire-and-forget).
  // Muster: identisch zu plan-dispatch (Next-Prozess, best-effort, non-fatal).
  //
  // maybeAutoConnect macht KEINEN echten Call — nur detect/setup/preview:
  //   missing='no-connector' → no-op
  //   missing='profile'      → Onboarding-Toast-Card
  //   missing='credential'   → credential-request-Card
  //   missing='none'         → connector-call-preview-Card (Approve-Action)
  //
  // Echter Call NUR nach User-Approve via POST /api/connectors/invoke.
  // Codex bleibt ausgeschlossen (B1-Sicherheits-Fix, analog plan-dispatch).
  // NICHT an req.signal gekoppelt — Card soll auch ankommen wenn der Stream
  // schon geschlossen ist.
  if (lastUserMessage) {
    const connectPrompt = lastUserMessage.content;
    const connectWorkspaceId = body.workspaceId;
    // userId aus actor ableiten (Pattern: user:<ulid> → <ulid>).
    // Bei 'agent:*' oder 'user:max-bootstrap' → leer lassen (no-op für ACL5-E).
    const connectUserId = actor.startsWith("user:") ? actor.slice("user:".length) : "";

    if (connectUserId) {
      void (async () => {
        try {
          const { maybeAutoConnect } = await import("@/lib/connectors/auto-connect");
          const r = await maybeAutoConnect(connectPrompt, {
            workspaceId: connectWorkspaceId,
            userId: connectUserId,
          });
          if (r.acted) {
            console.info(
              `[chat/stream] auto-connect(bg): action=${r.action} provider=${r.provider}`,
            );
          }
        } catch (err) {
          console.warn(
            "[chat/stream] auto-connect(bg) failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      })();
    }
  }

  // ---- 2.9 Engine-Mode Branch (C6 entgate · 2026-05-25) -----------------
  //
  // Routing-Tabelle:
  //   'claude-cli' (default) → agent-server-Forward (unverändert, Zeile ~325+)
  //   'ollama'               → buildOrchestratorSse(mode:'ollama')
  //   'parallel-all'         → buildOrchestratorSse(mode:'parallel-all')
  //   'codex-cli'            → buildOrchestratorSse(mode:'codex-cli', codexMode:'read')
  //
  // Sicherheitsgarantie codex-cli:
  //   codexMode:'read' wird EXPLIZIT als Argument gesetzt — der Orchestrator
  //   und die Engine ignorieren ggf. einen anderen Wert im req-Body (es gibt
  //   keinen). resolveSandboxFlags im codex-Engine forciert OS-Level read-only
  //   (`-s read-only -a never`) — kein Write, kein Shell-Side-Effect.
  //   Write-codex ist über diesen Pfad physisch nicht erreichbar.
  //
  //   Parallel-Race: parallel-all übergibt codexMode:'read' als Default im
  //   EngineChatRequest. Der Orchestrator setzt es nicht explizit pro Engine —
  //   aber types.ts default ist 'read' (undefined === read). Zur Klarheit:
  //   buildOrchestratorSse gibt codexMode:'read' in den orchestrate-Call.
  // Availability-aware Default (2026-06-03, Owner): wenn der Client keine Engine
  // vorgibt, die beste VERFÜGBARE wählen — Opus(claude) zuerst, sonst Codex
  // (fast gpt-5.5), sonst Ollama. Deckt OSS-User ab, die nur Claude ODER nur
  // Codex haben. Setzt der Client eine Engine, gewinnt die. Keine verfügbar →
  // claude-cli (der not_configured-Pfad liefert dann die ehrliche Meldung).
  let engineMode: string = body.engineMode ?? "";
  if (!engineMode) {
    try {
      const { detectEngines } = await import("@/lib/llm/engines/selector");
      const sel = await detectEngines();
      const has = (id: string) =>
        sel.available.some((a) => a.engine === id && a.available);
      engineMode = has("claude-cli")
        ? "claude-cli"
        : has("codex-cli")
          ? "codex-cli"
          : has("ollama")
            ? "ollama"
            : "claude-cli";
    } catch {
      engineMode = "claude-cli";
    }
  }

  // ---- 2.95 RAG-Retrieve in Orchestrator-Pfaden (TG-1 Audit-Fix · 2026-05-28) -
  // Workspace-scoped RAG-Block VOR den Spawn vorbereiten. Wird NUR in den
  // Orchestrator-Branches (ollama / parallel-all / codex-cli) als zusätzliche
  // 'system'-Message prepended; der claude-cli-Branch bleibt bit-identisch,
  // weil dort `server/workspace-session.ts:1299` schon RAG injiziert
  // (Doppel-Injection vermeiden).
  //
  // Fail-soft Posture (identisch zu workspace-session.ts:1299):
  //   - Cheap COUNT-Guard auf rag_chunks WHERE workspace_id=? (0 Chunks → kein
  //     embed-Call → null Zusatz-Latenz).
  //   - Jeder Fehler (DB, Embed, Module-Init) → leerer Block → Verhalten
  //     bit-identisch zur Pre-Fix-Welt (keine Verhaltens-Regression).
  //   - Cross-Scope wird HIER nie automatisch ausgelöst (N2 fail-closed) —
  //     der verwendete `retrieve()` ist workspace-isoliert via View-Filter
  //     (workspace_id + sensitivity!='high'). Cross-Workspace-Read würde
  //     einen Bridge-Approve + Audit-Row brauchen.
  //   - Kein Schema-Change, kein Auth-Bypass.
  let ragSystemBlock = "";
  const isOrchestratorMode =
    engineMode === "ollama" ||
    engineMode === "parallel-all" ||
    engineMode === "codex-cli" ||
    // Ultracoding agents run in worktrees WITHOUT server/workspace-session.ts,
    // so the route must supply the RAG block itself (the claude-cli-direct path
    // injects RAG downstream; ultracoding does not pass through that path).
    engineMode === "ultracoding";
  if (isOrchestratorMode && lastUserMessage) {
    ragSystemBlock = await buildRagSystemBlock(
      body.workspaceId,
      lastUserMessage.content,
    );
  }

  const orchestratorMessages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }> = ragSystemBlock
    ? [
        { role: "system", content: ragSystemBlock },
        ...body.messages,
      ]
    : (body.messages as Array<{
        role: "system" | "user" | "assistant";
        content: string;
      }>);

  if (engineMode === "ollama") {
    return buildOrchestratorSse({
      mode: "ollama",
      messages: orchestratorMessages,
      pendingPromptId,
      workspaceId: body.workspaceId,
    });
  }
  if (engineMode === "parallel-all") {
    return buildOrchestratorSse({
      mode: "parallel-all",
      messages: orchestratorMessages,
      pendingPromptId,
      workspaceId: body.workspaceId,
      // codexMode:'read' wird explizit gesetzt — parallel-race darf codex
      // nur im read-only-Sandbox starten. Der orchestrator-Layer erzwingt
      // es auf Engine-Ebene zusätzlich (resolveSandboxFlags).
      codexMode: "read",
    });
  }
  if (engineMode === "codex-cli") {
    return buildOrchestratorSse({
      mode: "codex-cli",
      messages: orchestratorMessages,
      pendingPromptId,
      workspaceId: body.workspaceId,
      // SICHERHEIT: codexMode:'read' ist Pflicht für den Chat-Pfad.
      // Kein Caller kann über diesen Branch codexMode:'write' setzen
      // — der Wert kommt ausschliesslich von hier, nicht aus body.
      codexMode: "read",
    });
  }
  if (engineMode === "ultracoding") {
    // Ultracoding (Multi-Agent · 2026-06-02): NICHT über buildOrchestratorSse
    // (das emittiert nur EINEN token-Chunk) — Ultracoding braucht streaming
    // Lane-Events. Gate: claude-cli muss verfügbar sein (detectEngines ist
    // 60s-gecacht + günstig). Bei Miss: sauberer SSE-error-Frame (KEIN 500),
    // sodass useAgentStream die Gate-Message über den bestehenden error-Pfad
    // zeigt. pendingPromptId-Header bleibt erhalten.
    const { detectEngines } = await import("@/lib/llm/engines/selector");
    const sel = await detectEngines();
    const claudeOk = sel.available.some(
      (a) => a.engine === "claude-cli" && a.available,
    );
    if (!claudeOk) {
      const reason =
        sel.available.find((a) => a.engine === "claude-cli")?.reason ??
        "unbekannt";
      return buildUltracodingGateError(pendingPromptId, body.workspaceId, reason);
    }
    return buildUltracodingSse({
      // RAG-Block ist via isOrchestratorMode bereits prepended.
      messages: orchestratorMessages,
      pendingPromptId,
      workspaceId: body.workspaceId,
    });
  }
  // 'claude-cli' und alles andere → bestehender agent-server-Forward.
  // RAG wird im claude-cli-Pfad downstream in server/workspace-session.ts:1299
  // injiziert — dieser Block muss hier NICHT gerendert werden, sonst
  // doppelter Kontext im Prompt.

  // ---- 3. Outbound fetch (NO abort-propagation) ------------------------
  // 2026-04-25: User-Feedback - wenn Max die PWA schliesst, soll der Agent
  // weiterlaufen, nicht abgebrochen werden. Output landet ohnehin im
  // chat-event-log + tmux-transcript; beim Wieder-Oeffnen sieht er die
  // Antwort dort. Nur connect-timeout aborted noch (sonst haengt das
  // request-handling bei toten Agents).
  const targetUrl = joinUrl(agentUrl, "/chat");
  const outboundCtl = new AbortController();
  // Bewusst KEIN req.signal-listener — client-disconnect aborted den Agent
  // nicht mehr.
  const clientAbort = (): void => undefined;

  // Connect-timeout. Once we *start* receiving bytes we no longer police
  // pacing here — the upstream stream governs it.
  const connectTimer = setTimeout(() => {
    if (!outboundCtl.signal.aborted) outboundCtl.abort(new DOMException("connect_timeout", "TimeoutError"));
  }, CONNECT_TIMEOUT_MS);

  let upstream: Response;
  try {
    // Phase MU.3 (Activate-Switch) — den eingeloggten User durchreichen,
    // sodass agent-server pro Spawn ggf. user-eigene MAX-Plan-Credentials
    // nutzt. Header ist nur informational; Bearer-Auth bleibt der Cap.
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${chatKey}`,
    };
    const subjectHeader = req.headers.get("x-lazyos-subject");
    if (subjectHeader && subjectHeader.startsWith("user:")) {
      headers["x-lazyos-acting-user-id"] = subjectHeader.slice("user:".length);
    }

    upstream = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        // PII vault: tokenize personal entities OUT of the prompt before it is
        // forwarded to the agent server (Claude CLI → cloud). Pure pass-through
        // when LAZYOS_PII_VAULT is off.
        messages: tokenizeMessages(body.workspaceId, body.messages),
        workspaceId: body.workspaceId,
        // Passed through; agent-server ignores unknown keys today.
        sensitivityFloor: body.sensitivityFloor,
        // Streaming-Recovery V2 (2026-04-27): Agent-Server nutzt die
        // pendingPromptId als PK fuer `streaming_snapshots`-UPSERTs.
        // Ohne sie laeuft der Stream weiter, aber Reload zeigt nichts
        // (kein Recovery — nur kein Crash).
        pendingPromptId,
        // 2-Stufen-Modell: Intent-getriebenes tiefes Denken an :4201 reichen.
        // undefined wird von JSON.stringify gedroppt → agent-server-Default
        // (kein --effort = schnell). N11: claude-cli, nicht deepseek.
        ...(body.thinking
          ? { thinking: true, ...(body.thinkingBudget ? { thinkingBudget: body.thinkingBudget } : {}) }
          : {}),
      }),
      signal: outboundCtl.signal,
      // Node's fetch does streaming by default — no buffering here.
      cache: "no-store",
    });
  } catch (err) {
    clearTimeout(connectTimer);
    req.signal.removeEventListener("abort", clientAbort);

    const name = err instanceof Error ? err.name : "Error";
    const message = err instanceof Error ? err.message : String(err);

    if (req.signal.aborted) {
      return new Response(null, {
        status: 499,
        headers: { "x-lazyos-pending-id": pendingPromptId },
      });
    }
    if (name === "TimeoutError" || message.includes("connect_timeout")) {
      return NextResponse.json(
        { error: "agent_timeout", hint: "Agent antwortet nicht innerhalb von 20s." },
        { status: 504, headers: { "x-lazyos-pending-id": pendingPromptId } },
      );
    }
    return NextResponse.json(
      {
        error: "agent_unreachable",
        detail: message.slice(0, 300),
      },
      { status: 502, headers: { "x-lazyos-pending-id": pendingPromptId } },
    );
  }

  clearTimeout(connectTimer);

  // ---- 4. Error-status mapping -----------------------------------------
  // P1-4: pendingPromptId wird IMMER als Header zurueckgegeben — auch
  // bei 5xx — damit der Client sein Echo-Set vorhalten kann obwohl der
  // SSE-Frame `pending_id` nie ankam.
  const pendingHeader = { "x-lazyos-pending-id": pendingPromptId };

  if (upstream.status === 401) {
    // Our outbound Bearer is wrong. User-facing message makes that clear.
    await drainBody(upstream);
    req.signal.removeEventListener("abort", clientAbort);
    return NextResponse.json(
      {
        error: "agent_auth_misconfig",
        hint: "LAZYOS_CHAT_KEY stimmt nicht mit dem Agent-Server überein.",
      },
      { status: 500, headers: pendingHeader },
    );
  }
  if (upstream.status === 404) {
    const payload = await safeJson(upstream);
    req.signal.removeEventListener("abort", clientAbort);
    return NextResponse.json(
      {
        error:
          (payload && typeof payload === "object" && "error" in payload
            ? String((payload as Record<string, unknown>).error)
            : "workspace_not_found"),
      },
      { status: 404, headers: pendingHeader },
    );
  }
  if (upstream.status === 400) {
    // Agent hat den Request strukturell abgelehnt (z.B. invalid workspaceId).
    // Reicht den 400 + payload durch — UI kann das als User-Fehler zeigen
    // statt als Server-Crash.
    const payload = await safeJson(upstream);
    req.signal.removeEventListener("abort", clientAbort);
    const detail =
      payload && typeof payload === "object" ? payload : { error: "agent_bad_request" };
    return NextResponse.json(
      {
        ...detail,
        upstream_status: 400,
      },
      { status: 400, headers: pendingHeader },
    );
  }
  if (upstream.status >= 500) {
    const payload = await safeJson(upstream);
    req.signal.removeEventListener("abort", clientAbort);
    const detail = payload && typeof payload === "object" ? payload : { error: "agent_error" };
    return NextResponse.json(
      {
        error: "agent_error",
        upstream_status: upstream.status,
        ...detail,
        reqId: upstream.headers.get("x-request-id") ?? undefined,
      },
      { status: 502, headers: pendingHeader },
    );
  }
  if (upstream.status !== 200) {
    await drainBody(upstream);
    req.signal.removeEventListener("abort", clientAbort);
    return NextResponse.json(
      { error: "agent_unexpected_status", upstream_status: upstream.status },
      { status: 502, headers: pendingHeader },
    );
  }

  // ---- 5. Pipe SSE bytes through unchanged -----------------------------
  if (!upstream.body) {
    req.signal.removeEventListener("abort", clientAbort);
    return NextResponse.json(
      { error: "agent_empty_body" },
      { status: 502, headers: pendingHeader },
    );
  }

  // Wrap the upstream body so we can detach the abort-listener when the
  // stream closes either naturally or via error.
  const encoder = new TextEncoder();
  const pendingPrologue = `event: pending_id\ndata: ${JSON.stringify({
    pendingPromptId,
    workspaceId: body.workspaceId,
  })}\n\n`;
  // Native-chat-feeling (2026-05-01): Initial-Heartbeat + 2KB-Comment-Padding
  // direkt nach dem pending_id-Frame. Zwei Ziele:
  //   1) iOS Safari + diverse Proxies (Cloudflare/nginx) buffern SSE-Frames
  //      bis ein Mindest-Volumen erreicht ist. 2 KB Comment-Padding (`: ...`)
  //      zwingt sie sofort den Header-Block zu flushen — TTFB < 100ms.
  //   2) Der Client kann sofort Status "Liest deine Frage …" rendern, ohne
  //      auf das erste Token zu warten (das oft 2-5s dauert bei kalter CLI).
  const PADDING = ":" + " ".repeat(2048) + "\n\n";
  const initialHeartbeat = `event: heartbeat\ndata: ${JSON.stringify({
    phase: "reading",
    ts: Date.now(),
  })}\n\n`;
  // Heartbeat alle 5s waehrend wir auf den agent-server warten — verhindert
  // Proxy-Idle-Timeouts und gibt dem Client Lebenszeichen waehrend langer
  // Tool-Calls zwischen Tokens.
  const HEARTBEAT_INTERVAL_MS = 5_000;

  // PII vault: when on, detokenize the streamed agent deltas back to real values
  // locally — buffering placeholders that split across frames. Off → raw forward.
  const sseDetok = piiVaultEnabled()
    ? makeSseDetokenizer(getDb().$raw, body.workspaceId)
    : null;
  const pass = new ReadableStream<Uint8Array>({
    start(controller) {
      let firstUpstreamByteSeen = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      // Phase MS: erstes SSE-Event ist die pending_id, damit der Client
      // sein eigenes chat_message_sent-Echo ueber /api/events/stream
      // erkennt und nicht doppelt rendert.
      // Zusatz 2026-05-01: pending_id + 2KB-Padding + heartbeat in EINEM
      // enqueue() — sodass der TLS/HTTP-Stack das als ein Paket sendet
      // und der Browser sofort den ersten Frame sieht.
      try {
        controller.enqueue(encoder.encode(pendingPrologue + PADDING + initialHeartbeat));
      } catch {
        /* socket already gone */
      }

      // Periodischer Heartbeat-Comment bis der erste Upstream-Byte ankommt.
      // Sobald Tokens fliessen, brauchen wir keinen Heartbeat mehr — der
      // Token-Stream selbst haelt die Connection alive.
      heartbeatTimer = setInterval(() => {
        if (firstUpstreamByteSeen) {
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
          return;
        }
        try {
          controller.enqueue(
            encoder.encode(`event: heartbeat\ndata: ${JSON.stringify({ phase: "waiting", ts: Date.now() })}\n\n`),
          );
        } catch {
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
        }
      }, HEARTBEAT_INTERVAL_MS);

      const reader = upstream.body!.getReader();
      (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              if (!firstUpstreamByteSeen) {
                firstUpstreamByteSeen = true;
                if (heartbeatTimer) {
                  clearInterval(heartbeatTimer);
                  heartbeatTimer = null;
                }
              }
              const chunk = sseDetok ? sseDetok.push(value) : value;
              if (chunk.length > 0) controller.enqueue(chunk);
            }
          }
          if (sseDetok) {
            const tail = sseDetok.flush();
            if (tail.length > 0) controller.enqueue(tail);
          }
          controller.close();
        } catch (err) {
          if (!req.signal.aborted) controller.error(err);
        } finally {
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
          req.signal.removeEventListener("abort", clientAbort);
          try {
            reader.releaseLock();
          } catch {
            /* ignore */
          }
        }
      })();
    },
    cancel(reason) {
      // Client reader closed early → abort upstream too.
      outboundCtl.abort(reason as Error | undefined);
      req.signal.removeEventListener("abort", clientAbort);
    },
  });

  return new Response(pass, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      // P1-4: pendingPromptId auch als Header — Recovery-Pfad fuer
      // Edge-Cases wo der SSE-pending_id-Frame nicht ankommt.
      "x-lazyos-pending-id": pendingPromptId,
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function joinUrl(base: string, path: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function drainBody(res: Response): Promise<void> {
  try {
    await res.text();
  } catch {
    /* ignore */
  }
}

/**
 * Workspace-scoped RAG-Block für den System-Prompt der Orchestrator-Pfade
 * (TG-1 Audit-Fix · 2026-05-28).
 *
 * Pattern + Posture spiegeln server/workspace-session.ts:1299 (claude-cli-Pfad)
 * + server/agents/tier-orchestrator.ts:138 (injectRagContextWithSources):
 *
 *   1. Cheap COUNT-Guard auf rag_chunks WHERE workspace_id=? — null Embed-
 *      Call wenn der Workspace noch nichts indexiert hat (Default-Zustand bei
 *      frischen Workspaces). Spart die ~120ms Embedder-Latenz im Leerlauf.
 *   2. `retrieve()` ist workspace-isoliert (View `v_rag_chunks_workspace`
 *      filtert workspace_id + sensitivity!='high'). Kein Cross-Scope, kein
 *      Bridge nötig — das hier ist die N2-konforme single-tenant-Variante.
 *   3. Best-effort: jeder Fehler (DB nicht erreichbar, Embedder dead,
 *      sanitiseFtsQuery fail, …) → leerer String → Caller behandelt das als
 *      "kein RAG-Block" → Verhalten bit-identisch zur Pre-Fix-Welt.
 *
 * KEIN auto-cross-scope. KEIN Schema-Change. KEIN Audit-Insert hier — der
 * workspace-scoped `retrieve()`-Pfad schreibt keine Audit-Row (nur cross-WS
 * tut das via `writeAudit()`, atomar mit der Transaktion). Bridge-Approve
 * ist die einzige Tür zu Cross-WS, und die geht NICHT durch diesen Helper.
 *
 * @param workspaceId  Der Caller-Workspace aus dem geprüften BodySchema.
 * @param query        Letzter User-Prompt (lastUserMessage.content) — die
 *                     gleiche Quelle wie workspace-session.ts nutzt.
 * @returns            Markdown-Block für die system-Message, oder '' bei
 *                     kein-Hit / leerem Index / Fehler.
 */
async function buildRagSystemBlock(
  workspaceId: string,
  query: string,
): Promise<string> {
  const parts: string[] = [];

  // Always-on Subchat-Kontext (2026-06-03, Owner-Direktive): die jüngste
  // Kundenkommunikation dieses Workspaces — UNCONDITIONAL injiziert, unabhängig
  // vom query-getriebenen RAG-Treffer, damit der Hauptchat das Subchat-Wissen
  // IMMER kennt („muss erkannt werden"). Fail-soft, workspace-isoliert (N2).
  try {
    const { formatSubchatContextBlock } = await import("@/lib/subchats/service");
    const sc = formatSubchatContextBlock(workspaceId);
    if (sc) parts.push(sc);
  } catch {
    /* fail-soft — kein Stream-Kill */
  }

  // Query-getriebenes RAG (wie bisher), workspace-isoliert via View-Filter.
  if (workspaceId && query && query.trim().length >= 3) {
    try {
      const { getDb: getRagDb } = await import("@/db/client");
      const row = getRagDb().$raw
        .prepare("SELECT COUNT(*) AS n FROM rag_chunks WHERE workspace_id = ?")
        .get(workspaceId) as { n?: number } | undefined;
      const n = row?.n ?? 0;
      if (n > 0) {
        const { retrieve, formatForPrompt } = await import("@/lib/rag/retriever");
        const result = await retrieve({ workspaceId, query, topK: 8, tokenCap: 4000 });
        const rag = formatForPrompt(result);
        if (rag) parts.push(rag);
      }
    } catch (err) {
      // Fail-soft — kein Stream-Kill bei RAG-Problem.
      console.warn(
        "[chat/stream] buildRagSystemBlock RAG failed (non-fatal):",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return parts.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Orchestrator-SSE-Adapter (C6 entgate · 2026-05-25)
// ---------------------------------------------------------------------------

interface OrchestratorSseArgs {
  /**
   * Engine-Mode für orchestrate(). Alle drei Orchestrator-Pfade erlaubt:
   *   'ollama'       — single-engine HTTP-Text-Chat, kein Spawn.
   *   'parallel-all' — Race aller verfügbaren Engines, fastest wins.
   *   'codex-cli'    — single-engine, MUSS codexMode:'read' mitbekommen.
   *
   * 'claude-cli' ist NICHT hier — der geht über den normalen agent-server-
   * Forward-Pfad (bestehender Code bleibt bit-identisch unverändert).
   */
  mode: "ollama" | "parallel-all" | "codex-cli";
  /**
   * 'system'-Role ist optional unterstützt — wird vom Caller (Engine-Mode-
   * Branch) gesetzt wenn ein RAG-Kontext-Block prepended wird (TG-1).
   */
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  pendingPromptId: string;
  workspaceId: string;
  /**
   * Codex-Safety-Flag. Wird an orchestrate() weitergereicht.
   * Bei mode:'codex-cli' und mode:'parallel-all' IMMER 'read' setzen.
   * Omit (undefined) für 'ollama' — Ollama ignoriert das Feld.
   */
  codexMode?: "read" | "write";
}

/**
 * Ruft lib/llm/orchestrator.orchestrate() single-shot auf und baut daraus
 * einen SSE-ReadableStream, dessen Frame-Format EXAKT dem agent-server-Pfad
 * entspricht. Der Client-Parser (useAgentStream.ts) sieht keinen Unterschied.
 *
 * Frame-Sequenz:
 *   1. pending_id  — wie im agent-server-Pfad (Echo-Filter-Dedup)
 *   2. ready       — sessionId: null (kein agent-server-Session-Objekt)
 *   3. token       — delta: result.text (ein einziger Chunk, kein Streaming)
 *   4. done        — duration_ms, num_turns: 1, is_error: false
 *
 * Bei Fehler:
 *   error-Frame   — message aus dem Catch
 *   done-Frame    — is_error: true
 *
 * Best-effort: ein orchestrate-Fehler produziert ein error-Frame statt 500.
 * Headers sind bit-identisch mit dem normalen SSE-Pfad.
 *
 * N11-Ressource-Budget-Note: parallel-all startet bis zu 3 Engine-Requests
 * gleichzeitig (claude-cli, codex-cli-read, ollama). Der Orchestrator selbst
 * verwaltet keinen Slot-Pool — das ist der Subagent-Pool-Job. Text-Race ist
 * leichtgewichtig (keine Worktree-Spawns, kein Heavy-Ollama-Modell per default).
 * Wird deepseek-r1:14b als Ollama-Modell konfiguriert, zählt das gegen das
 * Heavy-Budget (N11: max 2 heavy jobs) — bei parallelen Chat-Turns beachten.
 */
function buildOrchestratorSse(args: OrchestratorSseArgs): Response {
  const { mode, messages, pendingPromptId, workspaceId, codexMode } = args;
  const enc = new TextEncoder();

  const frame = (event: string, data: unknown): Uint8Array =>
    enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Frame 1: pending_id (gleiche Struktur wie normaler Pfad)
      controller.enqueue(
        enc.encode(
          `event: pending_id\ndata: ${JSON.stringify({ pendingPromptId, workspaceId })}\n\n`,
        ),
      );

      const t0 = Date.now();
      // orchestrate-Typ: OrchestratorRequest erwartet EngineMessage (role:
      // 'system'|'user'|'assistant'). Unser BodySchema-Messages-Typ hat nur
      // 'user'|'assistant' — das ist ein Subset, der Cast ist sicher.
      void (async () => {
        try {
          const { orchestrate } = await import("@/lib/llm/orchestrator");
          const { tokenizeMessages, rehydrate } = await import(
            "@/lib/privacy/protect"
          );
          const result = await orchestrate({
            mode,
            // PII vault: replace personal entities with local tokens BEFORE the
            // prompt reaches any cloud engine. Pure pass-through when
            // LAZYOS_PII_VAULT is off (originals are untouched; persistence above
            // already used the real text).
            messages: tokenizeMessages(workspaceId, messages),
            // Sicherheit: codexMode wird nur dann gesetzt wenn der Caller es
            // explizit mitgegeben hat. Für 'codex-cli' und 'parallel-all' kommt
            // immer 'read' (aus dem engineMode-Branch oben). Für 'ollama'
            // bleibt undefined — Ollama ignoriert das Feld vollständig.
            // Kein Pfad hier kann codexMode:'write' setzen.
            ...(codexMode !== undefined ? { codexMode } : {}),
          });

          // Frame 2: ready (sessionId null — kein persistenter agent-server-
          // Session-Context, nur Single-Shot-Antwort)
          controller.enqueue(frame("ready", { sessionId: null }));

          // Frame 3: token (full answer as one delta chunk). Detokenize locally
          // so the user sees the real values; the cloud only ever saw the tokens.
          controller.enqueue(
            frame("token", { delta: rehydrate(workspaceId, result.text) }),
          );

          // Frame 4: done
          controller.enqueue(
            frame("done", {
              duration_ms: result.latencyMs,
              num_turns: 1,
              is_error: false,
            }),
          );

          // Persistenz (N8-Trace): sonst verliert ein Reload / Cross-Device die
          // Antwort + der Ledger-Thread bliebe halbiert.
          // emitChatMessageCompleted = History-Event (broadcast), appendLedgerRow
          // = N8-Trace. Beide best-effort — kein Stream-Kill bei DB-Fehler.
          try {
            await emitChatMessageCompleted({
              workspaceId,
              entityId: ulid(),
              content: result.text,
              actor: "system",
              outcome: "ok",
              // result.engine = die Engine die gewonnen hat (bei parallel-all:
              // fastest), mode = was der Caller angefordert hat.
              metadata: { engine: result.engine, mode, codexMode: codexMode ?? "read" },
            });
          } catch (persistErr) {
            console.warn(
              "[chat/stream] buildOrchestratorSse emitChatMessageCompleted failed (non-fatal):",
              persistErr instanceof Error ? persistErr.message : String(persistErr),
            );
          }
          try {
            appendLedgerRow(getDb().$raw, {
              coordKey: workspaceId,
              role: "assistant",
              contentFull: result.text,
              conversationThreadId: pendingPromptId,
            });
          } catch (ledgerErr) {
            console.warn(
              "[chat/stream] buildOrchestratorSse assistant-ledger failed (non-fatal):",
              ledgerErr instanceof Error ? ledgerErr.message : String(ledgerErr),
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn("[chat/stream] buildOrchestratorSse orchestrate-Fehler:", msg);
          // Fehler-Frame + done (kein 500 — best-effort)
          controller.enqueue(frame("error", { message: msg }));
          controller.enqueue(
            frame("done", { duration_ms: Date.now() - t0, num_turns: 1, is_error: true }),
          );
        } finally {
          controller.close();
        }
      })();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      // P1-4: pendingPromptId auch als Header — Recovery-Pfad fuer Edge-Cases
      // wo der SSE-pending_id-Frame nicht ankommt.
      "x-lazyos-pending-id": pendingPromptId,
    },
  });
}

// ---------------------------------------------------------------------------
// Ultracoding-SSE-Adapter (Multi-Agent · 2026-06-02)
// ---------------------------------------------------------------------------

/**
 * Bridges Ultracoding's worktree-isolated multi-agent run to SSE frames.
 *
 * Unlike {@link buildOrchestratorSse} (one `token` chunk), this streams live
 * `SubagentLaneEvent`s as a NEW additive event name `subagent_lane` so the
 * fleet UI's reducer (`reduceSubagentFleet`) can slot each lane into a pane.
 * The standard `pending_id` / `ready` / `token` / `done` / `error` frames stay
 * byte-identical to `buildOrchestratorSse`, so `useAgentStream` renders the
 * final assistant bubble unchanged and IGNORES the unknown `subagent_lane`
 * name (`coerceEvent` returns `null` for unknown events → no parser change).
 *
 * Frame contract:
 *   1     pending_id    { pendingPromptId, workspaceId }   — echo-dedup
 *   2     ready         { sessionId: null }                — handshake
 *   3..N  subagent_lane <raw SubagentLaneEvent>            — fleet reducer input
 *   N+1   token         { delta: <aggregated summary text> } — final bubble
 *   N+2   done          { duration_ms, num_turns:1, is_error:false } — terminal
 *
 * On error: `error` { message } then `done` { is_error:true } — mirrors
 * buildOrchestratorSse's catch posture. Persistence (emitChatMessageCompleted
 * + appendLedgerRow) is best-effort and non-fatal, identical to that helper.
 *
 * SAFETY: ultracoding spawns run in isolated git worktrees (createRunWorktree)
 * and are discarded in the module's `finally`; merge to the live checkout stays
 * USER-GATED via the separate operator-merge route — this path never merges.
 */
function buildUltracodingSse(args: {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  pendingPromptId: string;
  workspaceId: string;
}): Response {
  const { messages, pendingPromptId, workspaceId } = args;
  const enc = new TextEncoder();
  const frame = (event: string, data: unknown): Uint8Array =>
    enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Frame 1: pending_id (identisch zu buildOrchestratorSse).
      controller.enqueue(frame("pending_id", { pendingPromptId, workspaceId }));
      const t0 = Date.now();
      void (async () => {
        try {
          // Frame 2: ready (sessionId null — kein agent-server-Session-Context).
          controller.enqueue(frame("ready", { sessionId: null }));
          const { runUltracoding } = await import(
            "@/server/agents/ultracoding-orchestrator"
          );
          const result = await runUltracoding({
            messages,
            workspaceId,
            // Frames 3..N: ein subagent_lane-Frame pro Lane-Event.
            onLaneEvent: (ev: SubagentLaneEvent) => {
              try {
                controller.enqueue(frame("subagent_lane", ev));
              } catch {
                /* socket gone */
              }
            },
          });
          // Frame N+1: token (aggregierte Markdown-Zusammenfassung).
          controller.enqueue(frame("token", { delta: result.text }));
          // Frame N+2: done.
          controller.enqueue(
            frame("done", {
              duration_ms: result.latencyMs,
              num_turns: 1,
              is_error: false,
            }),
          );
          // Persistenz — gleiche Posture wie buildOrchestratorSse (best-effort,
          // non-fatal). Engine ist immer claude-cli (Gate), mode 'ultracoding'.
          try {
            await emitChatMessageCompleted({
              workspaceId,
              entityId: ulid(),
              content: result.text,
              actor: "system",
              outcome: "ok",
              metadata: { engine: "claude-cli", mode: "ultracoding" },
            });
          } catch (persistErr) {
            console.warn(
              "[chat/stream] ultracoding emitChatMessageCompleted failed (non-fatal):",
              persistErr instanceof Error ? persistErr.message : String(persistErr),
            );
          }
          try {
            appendLedgerRow(getDb().$raw, {
              coordKey: workspaceId,
              role: "assistant",
              contentFull: result.text,
              conversationThreadId: pendingPromptId,
            });
          } catch (ledgerErr) {
            console.warn(
              "[chat/stream] ultracoding assistant-ledger failed (non-fatal):",
              ledgerErr instanceof Error ? ledgerErr.message : String(ledgerErr),
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn("[chat/stream] buildUltracodingSse run-Fehler:", msg);
          controller.enqueue(frame("error", { message: msg }));
          controller.enqueue(
            frame("done", {
              duration_ms: Date.now() - t0,
              num_turns: 1,
              is_error: true,
            }),
          );
        } finally {
          controller.close();
        }
      })();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-lazyos-pending-id": pendingPromptId,
    },
  });
}

/**
 * Gate-Miss-Stream für Ultracoding wenn claude-cli nicht verfügbar ist.
 * Sauberer SSE-error-Frame (KEIN 500/Crash) → useAgentStream zeigt die
 * Gate-Message über den bestehenden `case 'error'`-Pfad. Header bleibt
 * erhalten, damit der Echo-Filter-Recovery greift.
 */
function buildUltracodingGateError(
  pendingPromptId: string,
  workspaceId: string,
  reason: string,
): Response {
  const enc = new TextEncoder();
  const frame = (event: string, data: unknown): Uint8Array =>
    enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frame("pending_id", { pendingPromptId, workspaceId }));
      controller.enqueue(
        frame("error", {
          message: `Ultra (Multi-Agent) braucht eine verbundene Claude-Engine. Aktuell nicht verfügbar: ${reason}`,
        }),
      );
      controller.enqueue(
        frame("done", { duration_ms: 0, num_turns: 1, is_error: true }),
      );
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-lazyos-pending-id": pendingPromptId,
    },
  });
}

/**
 * Wer hat den /api/chat/stream-Call ausgeloest?
 *
 * Phase ORG (2026-04-27): Wir lesen den `x-lazyos-subject`-Header, den die
 * Edge-Middleware nach Cookie/Bearer-Verify gesetzt hat. Das ersetzt das
 * frühere hardgecodete `user:max`-Mapping.
 *
 * P0-#1b / F-1b (2026-05-25): Der frühere `x-lazyos-caller`-Override ist
 * entfernt. Dieser inbound-Header war eine Audit-Spoof-Klasse — ein
 * bearer-authentifizierter Caller konnte ein beliebiges `agent:<name>`-Label
 * in den Audit-Trail schreiben. Die Middleware stripped den Header jetzt
 * bedingungslos (Step 0); der Actor leitet sich ausschliesslich aus dem
 * kryptographisch verifizierten `x-lazyos-subject` ab, den die Middleware
 * nach Cookie-/Bearer-Verify gesetzt hat.
 *
 * Reihenfolge (alles aus VERIFIZIERTER Quelle):
 *   1) `user:<ulid>`  → verifizierter Session-Cookie (currentSubject user).
 *   2) `agent:cli`    → verifizierter Agent/CLI-Bearer (currentSubject agent).
 *                        Ersetzt das vorher spoofbare `agent:<name>` durch das
 *                        verifizierte Token-Label — Audit zeigt die
 *                        verifizierte statt der behaupteten Identität.
 *   3) `system:<id>`  → Bridge / Cron (currentSubject system) -> als
 *                        `agent:<id>` ins Event-Actor-Schema gemappt.
 *   4) Cookie-Fallback (kein Subject-Header, nur direkter VPS-Call ohne
 *      Middleware-Vorlauf) -> 'user:max-bootstrap'.
 *   5) Defensiv (middleware laesst sonst keine unauth Calls durch) ->
 *      'agent:api'.
 */
export function detectActor(req: Request): `user:${string}` | `agent:${string}` {
  // Phase ORG / P0-#1b: subject-Header ist der einzige Trust-Anchor.
  const subject = currentSubject(req);
  if (subject.kind === "user") {
    return `user:${subject.userId}`;
  }
  if (subject.kind === "agent") {
    // Verifiziertes Agent/CLI-Bearer-Label (z.B. 'cli'). KEIN inbound-Override
    // mehr — der x-lazyos-caller-Header ist von der Middleware gestript.
    return `agent:${subject.agentId}`;
  }
  if (subject.kind === "system") {
    // Bridge/Cron als agent:<systemId> ins Event-Actor-Schema mappen.
    return `agent:${subject.systemId}`;
  }
  // subject.kind === "anon" — kein verifiziertes Subject im Header.
  const cookieHeader = req.headers.get("cookie") ?? "";
  // Legacy-Fallback wenn kein Subject-Header (sollte nur bei direkten
  // VPS-Calls ohne Middleware-Vorlauf vorkommen). Cookie-Existence-Check.
  // Phase AU.4: bleibt vorerst „user:max-bootstrap" als Marker — die echte
  // ULID-Auflösung passiert eine Schicht weiter oben in den Routen, die
  // chat_message_sent emitten.
  if (/(^|;\s*)lazyos_session=/.test(cookieHeader)) {
    return "user:max-bootstrap";
  }
  // Sollte nicht passieren — middleware laesst keine unauthentifizierten
  // Calls durch. Defensiv: agent:api.
  return "agent:api";
}
