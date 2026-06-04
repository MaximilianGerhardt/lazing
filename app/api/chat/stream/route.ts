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
import { piiVaultEnabled, tokenizeMessagesAsync } from "@/lib/privacy/protect";
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

// Accepts real workspace IDs, the __root__ cross-workspace pseudo, and
// parenthesized IDs from the sessions registry ((root)/(tmp)).
const WorkspaceIdSchema = z
  .string()
  .min(1)
  .max(96)
  // Org-root scope `__org_root__:<orgId>` (Phase IA.1) allowed — otherwise
  // the `:` rejects the workspaceId → 400. max(96) covers the prefix overhead.
  .regex(/^(?:__org_root__:)?[a-z0-9_()][a-z0-9_()-]{0,63}$/i);

const BodySchema = z.object({
  messages: z.array(MessageSchema).min(1).max(40),
  workspaceId: WorkspaceIdSchema,
  /** Reserved for the approval-gate (Stream H). Forwarded as-is. */
  sensitivityFloor: z.enum(["low", "med", "high"]).optional(),
  /**
   * Engine routing (engine pill, C6 entgate · 2026-05-25).
   *
   * All four modes are now routable:
   *   'claude-cli'   — existing agent-server path (default).
   *   'ollama'       — buildOrchestratorSse(mode:'ollama') — local HTTP text chat.
   *   'parallel-all' — buildOrchestratorSse(mode:'parallel-all') — race claude+ollama+codex-READ.
   *   'codex-cli'    — buildOrchestratorSse(mode:'codex-cli', codexMode:'read') — read-only sandbox.
   *
   * Security guarantee: codex-cli in the chat path ALWAYS runs with codexMode:'read'
   * (OS-level sandbox, no write, no shell side effect). Write-codex is physically
   * unreachable via this path — the orchestrate() call forces 'read'
   * at the engine level (resolveSandboxFlags), regardless of the caller.
   */
  engineMode: z
    .enum(["parallel-all", "claude-cli", "codex-cli", "ollama", "ultracoding"])
    .optional(),
  /**
   * Two-stage model (owner 2026-06-03): if the client detected a multi-step
   * intent (ChatShell `shouldDecompose`), it sets `thinking:true`.
   * In the claude-cli default path this is forwarded to :4201 → sendPrompt → `--effort`.
   * If the field is missing → fast turn (today's behavior).
   */
  thinking: z.boolean().optional(),
  thinkingBudget: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
});

/** Timeout for getting the *first byte* from the agent. After that, the
 *  upstream stream dictates pacing and we just pipe through. 20s matches
 *  the agent's own cold-start budget for the Claude CLI. */
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * TD-4 fix 2026-04-26: strip UI/agent hint markers from the content before we
 * persist. Conservative — only the exact strings ChatShell appends today;
 * no fuzzy RegExp that could also match user text.
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
  // Default to the local agent-server if the env is missing (the VPS Next.js runs
  // next to the agent-server, 127.0.0.1:4201 is directly reachable). On Vercel
  // LAZYOS_AGENT_URL must be set (external URL); on the VPS local is enough.
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

  // ---- 2.5 Persist the user message (Phase MS) -------------------------
  // BEFORE the agent call, write the user message as a chat_message_sent
  // event so it survives even if the agent-server
  // hangs or the client disconnects immediately. Cross-device visible
  // via /api/events/stream and /api/chat/history.
  //
  // pendingPromptId is returned to the client in the very first SSE frame
  // ("event: pending_id"). The client remembers this ID and
  // ignores its own echo when the chat_message_sent event comes back live
  // via the event stream (otherwise double render).
  const lastUserMessage = [...body.messages].reverse().find((m) => m.role === "user");
  // Bug-C-RACE fix 2026-04-26: if the client sends a pendingPromptId via
  // the header `X-LazyOS-Pending-Id`, we use it — the client
  // then already has it in its `ownPendingIdsRef` set BEFORE the
  // chat_message_sent live event arrives. The echo filter applies immediately.
  // Validation: max 64 characters, safe chars only (UUID/ULID format).
  const headerPid = req.headers.get("x-lazyos-pending-id");
  const isValidPid =
    typeof headerPid === "string" &&
    headerPid.length > 0 &&
    headerPid.length <= 64 &&
    /^[A-Za-z0-9_-]+$/.test(headerPid);
  const pendingPromptId = isValidPid ? headerPid! : ulid();

  // ---- Actor detection: Cookie -> user:max, Bearer -> agent:* ----------
  // Cookie first (user-typed prompts). If no cookie but a Bearer is
  // present -> Bearer-auth call (CLI / test script / terminal Claude).
  // The header override `X-LazyOS-Caller` allows an explicit actor tag (e.g.
  // 'agent:terminal-claude'). Default for Bearer-without-header: 'agent:api'.
  const actor: `user:${string}` | `agent:${string}` = detectActor(req);

  if (lastUserMessage) {
    try {
      // TD-4 fix 2026-04-26: `[Auto-Mode aktiv]` is a UI/agent hint and
      // has no business in the persisted chat_message_sent history
      // — the user saw the trailer in old messages after every reload. Strip it
      // BEFORE emit; the forward to the agent (body.messages, further below)
      // stays unchanged, otherwise we lose the mode hint in the
      // workspace-session.ts system prompt.
      const cleanedContent = stripAgentHints(lastUserMessage.content);
      await emitChatMessageSent({
        workspaceId: body.workspaceId,
        content: cleanedContent,
        pendingPromptId,
        actor,
      });
    } catch (err) {
      // Best-effort. If the DB is not reachable, we let the
      // stream continue anyway — the UI keeps writing the user message
      // local-first, and the chat_turn audit log keeps the audit
      // separate. But log it so Max sees it in the health check.
      console.warn(
        "[chat/stream] emitChatMessageSent failed:",
        err instanceof Error ? err.message : String(err),
      );
    }

    // N8 trace · chat_ledger user message (BACKPORT-01 · 2026-05-24)
    // Best-effort — a ledger error must NEVER kill the chat stream.
    // contentFull = lastUserMessage.content VERBATIM (N1 — no stripAgentHints
    // here; the ledger should hold the real user words, hints and all, so the
    // trace row reflects exactly what the user actually sent).
    // coordKey = workspaceId (minimal ManifestCoord, N9).
    // conversationThreadId = pendingPromptId (per-turn key; links the
    // user message and assistant response in one thread group).
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

  // ---- 2.7 N6 hybrid plan dispatch — „Hybrid sanft" (Slice 2, 2026-05-23) -
  // On complex intent we decompose in the BACKGROUND into plan+subplans and
  // emit a `subplan` surface (path B → broadcast → /api/events/stream,
  // same Next process → reaches the live client). The normal claude turn
  // continues ANYWAY (no return) — the user ALWAYS gets an answer
  // AND additionally the plan card. Fire-and-forget with its own 40s deadline,
  // deliberately NOT coupled to req.signal so the plan also finishes
  // when the response stream is already closed. Gate miss/error = no-op.
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

  // ---- 2.8 ACL5-E auto-connect — hybrid (2026-05-24) ----------------------
  // Deterministic connector gate in the BACKGROUND (fire-and-forget).
  // Pattern: identical to plan-dispatch (Next process, best-effort, non-fatal).
  //
  // maybeAutoConnect makes NO real call — only detect/setup/preview:
  //   missing='no-connector' → no-op
  //   missing='profile'      → onboarding toast card
  //   missing='credential'   → credential-request card
  //   missing='none'         → connector-call-preview card (approve action)
  //
  // A real call ONLY after user approve via POST /api/connectors/invoke.
  // Codex stays excluded (B1 security fix, analogous to plan-dispatch).
  // NOT coupled to req.signal — the card should also arrive when the stream
  // is already closed.
  if (lastUserMessage) {
    const connectPrompt = lastUserMessage.content;
    const connectWorkspaceId = body.workspaceId;
    // Derive userId from actor (pattern: user:<ulid> → <ulid>).
    // For 'agent:*' or 'user:max-bootstrap' → leave empty (no-op for ACL5-E).
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

  // ---- 2.9 Engine-mode branch (C6 entgate · 2026-05-25) -----------------
  //
  // Routing table:
  //   'claude-cli' (default) → agent-server forward (unchanged, line ~325+)
  //   'ollama'               → buildOrchestratorSse(mode:'ollama')
  //   'parallel-all'         → buildOrchestratorSse(mode:'parallel-all')
  //   'codex-cli'            → buildOrchestratorSse(mode:'codex-cli', codexMode:'read')
  //
  // Security guarantee codex-cli:
  //   codexMode:'read' is set EXPLICITLY as an argument — the orchestrator
  //   and the engine ignore any other value in the req body (there is
  //   none). resolveSandboxFlags in the codex engine forces OS-level read-only
  //   (`-s read-only -a never`) — no write, no shell side effect.
  //   Write-codex is physically unreachable via this path.
  //
  //   Parallel race: parallel-all passes codexMode:'read' as the default in the
  //   EngineChatRequest. The orchestrator does not set it explicitly per engine —
  //   but the types.ts default is 'read' (undefined === read). For clarity:
  //   buildOrchestratorSse passes codexMode:'read' into the orchestrate call.
  // Availability-aware default (2026-06-03, owner): if the client specifies no engine,
  // pick the best AVAILABLE one — Opus(claude) first, then Codex
  // (fast gpt-5.5), then Ollama. Covers OSS users who have only Claude OR only
  // Codex. If the client sets an engine, that one wins. None available →
  // claude-cli (the not_configured path then returns the honest message).
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

  // ---- 2.95 RAG retrieve in orchestrator paths (TG-1 audit fix · 2026-05-28) -
  // Prepare a workspace-scoped RAG block BEFORE the spawn. Only prepended in the
  // orchestrator branches (ollama / parallel-all / codex-cli) as an additional
  // 'system' message; the claude-cli branch stays bit-identical,
  // because there `server/workspace-session.ts:1299` already injects RAG
  // (avoid double injection).
  //
  // Fail-soft posture (identical to workspace-session.ts:1299):
  //   - Cheap COUNT guard on rag_chunks WHERE workspace_id=? (0 chunks → no
  //     embed call → zero extra latency).
  //   - Any error (DB, embed, module init) → empty block → behavior
  //     bit-identical to the pre-fix world (no behavior regression).
  //   - Cross-scope is never triggered automatically HERE (N2 fail-closed) —
  //     the `retrieve()` used is workspace-isolated via a view filter
  //     (workspace_id + sensitivity!='high'). A cross-workspace read would
  //     need a Bridge approve + audit row.
  //   - No schema change, no auth bypass.
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
      // codexMode:'read' is set explicitly — the parallel race may only start
      // codex in the read-only sandbox. The orchestrator layer additionally
      // forces it at the engine level (resolveSandboxFlags).
      codexMode: "read",
    });
  }
  if (engineMode === "codex-cli") {
    return buildOrchestratorSse({
      mode: "codex-cli",
      messages: orchestratorMessages,
      pendingPromptId,
      workspaceId: body.workspaceId,
      // SECURITY: codexMode:'read' is required for the chat path.
      // No caller can set codexMode:'write' via this branch
      // — the value comes exclusively from here, not from body.
      codexMode: "read",
    });
  }
  if (engineMode === "ultracoding") {
    // Ultracoding (multi-agent · 2026-06-02): NOT via buildOrchestratorSse
    // (that emits only ONE token chunk) — Ultracoding needs streaming
    // lane events. Gate: claude-cli must be available (detectEngines is
    // 60s-cached + cheap). On miss: a clean SSE error frame (NO 500),
    // so useAgentStream shows the gate message via the existing error path.
    // The pendingPromptId header is preserved.
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
      // The RAG block is already prepended via isOrchestratorMode.
      messages: orchestratorMessages,
      pendingPromptId,
      workspaceId: body.workspaceId,
    });
  }
  // 'claude-cli' and everything else → existing agent-server forward.
  // RAG is injected in the claude-cli path downstream in server/workspace-session.ts:1299
  // — this block must NOT be rendered here, otherwise
  // double context in the prompt.

  // ---- 3. Outbound fetch (NO abort-propagation) ------------------------
  // 2026-04-25: user feedback - when Max closes the PWA, the agent should
  // keep running, not be aborted. The output lands in the
  // chat event log + tmux transcript anyway; on reopening he sees the
  // answer there. Only the connect timeout still aborts (otherwise the
  // request handling hangs on dead agents).
  const targetUrl = joinUrl(agentUrl, "/chat");
  const outboundCtl = new AbortController();
  // Deliberately NO req.signal listener — a client disconnect no longer
  // aborts the agent.
  const clientAbort = (): void => undefined;

  // Connect-timeout. Once we *start* receiving bytes we no longer police
  // pacing here — the upstream stream governs it.
  const connectTimer = setTimeout(() => {
    if (!outboundCtl.signal.aborted) outboundCtl.abort(new DOMException("connect_timeout", "TimeoutError"));
  }, CONNECT_TIMEOUT_MS);

  let upstream: Response;
  try {
    // Phase MU.3 (activate switch) — pass the logged-in user through,
    // so the agent-server may use the user's own MAX-Plan credentials per spawn.
    // The header is only informational; Bearer auth stays the cap.
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${chatKey}`,
    };
    const subjectHeader = req.headers.get("x-lazyos-subject");
    if (subjectHeader && subjectHeader.startsWith("user:")) {
      headers["x-lazyos-acting-user-id"] = subjectHeader.slice("user:".length);
    }

    // PII vault: tokenize personal entities OUT of the prompt before it is
    // forwarded to the agent server (Claude CLI → cloud), including the optional
    // local-LLM name detection. Pure pass-through when LAZYOS_PII_VAULT is off.
    const forwardMessages = await tokenizeMessagesAsync(
      body.workspaceId,
      body.messages,
    );
    upstream = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages: forwardMessages,
        workspaceId: body.workspaceId,
        // Passed through; agent-server ignores unknown keys today.
        sensitivityFloor: body.sensitivityFloor,
        // Streaming recovery V2 (2026-04-27): the agent-server uses the
        // pendingPromptId as the PK for `streaming_snapshots` UPSERTs.
        // Without it the stream continues, but a reload shows nothing
        // (no recovery — just no crash).
        pendingPromptId,
        // Two-stage model: pass intent-driven deep thinking to :4201.
        // undefined is dropped by JSON.stringify → agent-server default
        // (no --effort = fast). N11: claude-cli, not deepseek.
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
  // P1-4: the pendingPromptId is ALWAYS returned as a header — even
  // on 5xx — so the client can keep its echo set even though the
  // SSE frame `pending_id` never arrived.
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
    // The agent rejected the request structurally (e.g. invalid workspaceId).
    // Passes the 400 + payload through — the UI can show this as a user error
    // instead of a server crash.
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
  // Native chat feeling (2026-05-01): initial heartbeat + 2KB comment padding
  // right after the pending_id frame. Two goals:
  //   1) iOS Safari + various proxies (Cloudflare/nginx) buffer SSE frames
  //      until a minimum volume is reached. 2 KB of comment padding (`: ...`)
  //      forces them to flush the header block immediately — TTFB < 100ms.
  //   2) The client can immediately render the status "Liest deine Frage …" without
  //      waiting for the first token (which often takes 2-5s on a cold CLI).
  const PADDING = ":" + " ".repeat(2048) + "\n\n";
  const initialHeartbeat = `event: heartbeat\ndata: ${JSON.stringify({
    phase: "reading",
    ts: Date.now(),
  })}\n\n`;
  // Heartbeat every 5s while we wait for the agent-server — prevents
  // proxy idle timeouts and gives the client a sign of life during long
  // tool calls between tokens.
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

      // Phase MS: the first SSE event is the pending_id, so the client
      // recognizes its own chat_message_sent echo via /api/events/stream
      // and does not render twice.
      // Addition 2026-05-01: pending_id + 2KB padding + heartbeat in ONE
      // enqueue() — so the TLS/HTTP stack sends it as one packet
      // and the browser sees the first frame immediately.
      try {
        controller.enqueue(encoder.encode(pendingPrologue + PADDING + initialHeartbeat));
      } catch {
        /* socket already gone */
      }

      // Periodic heartbeat comment until the first upstream byte arrives.
      // Once tokens flow, we no longer need a heartbeat — the
      // token stream itself keeps the connection alive.
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
      // P1-4: pendingPromptId also as a header — recovery path for
      // edge cases where the SSE pending_id frame does not arrive.
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
 * Workspace-scoped RAG block for the system prompt of the orchestrator paths
 * (TG-1 audit fix · 2026-05-28).
 *
 * Pattern + posture mirror server/workspace-session.ts:1299 (claude-cli path)
 * + server/agents/tier-orchestrator.ts:138 (injectRagContextWithSources):
 *
 *   1. Cheap COUNT guard on rag_chunks WHERE workspace_id=? — zero embed
 *      call if the workspace has indexed nothing yet (the default state for
 *      fresh workspaces). Saves the ~120ms embedder latency when idle.
 *   2. `retrieve()` is workspace-isolated (the view `v_rag_chunks_workspace`
 *      filters workspace_id + sensitivity!='high'). No cross-scope, no
 *      Bridge needed — this is the N2-compliant single-tenant variant.
 *   3. Best-effort: any error (DB unreachable, embedder dead,
 *      sanitiseFtsQuery fail, …) → empty string → the caller treats this as
 *      "no RAG block" → behavior bit-identical to the pre-fix world.
 *
 * NO auto cross-scope. NO schema change. NO audit insert here — the
 * workspace-scoped `retrieve()` path writes no audit row (only cross-WS
 * does that via `writeAudit()`, atomic with the transaction). A Bridge approve
 * is the only door to cross-WS, and it does NOT go through this helper.
 *
 * @param workspaceId  The caller workspace from the validated BodySchema.
 * @param query        The last user prompt (lastUserMessage.content) — the
 *                     same source workspace-session.ts uses.
 * @returns            Markdown block for the system message, or '' on
 *                     no-hit / empty index / error.
 */
async function buildRagSystemBlock(
  workspaceId: string,
  query: string,
): Promise<string> {
  const parts: string[] = [];

  // Always-on subchat context (2026-06-03, owner directive): the most recent
  // customer communication of this workspace — injected UNCONDITIONALLY, independent
  // of the query-driven RAG hit, so the main chat ALWAYS knows the subchat
  // knowledge („muss erkannt werden"). Fail-soft, workspace-isolated (N2).
  try {
    const { formatSubchatContextBlock } = await import("@/lib/subchats/service");
    const sc = formatSubchatContextBlock(workspaceId);
    if (sc) parts.push(sc);
  } catch {
    /* fail-soft — no stream kill */
  }

  // Query-driven RAG (as before), workspace-isolated via the view filter.
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
      // Fail-soft — no stream kill on a RAG problem.
      console.warn(
        "[chat/stream] buildRagSystemBlock RAG failed (non-fatal):",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return parts.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Orchestrator SSE adapter (C6 entgate · 2026-05-25)
// ---------------------------------------------------------------------------

interface OrchestratorSseArgs {
  /**
   * Engine mode for orchestrate(). All three orchestrator paths allowed:
   *   'ollama'       — single-engine HTTP text chat, no spawn.
   *   'parallel-all' — race of all available engines, fastest wins.
   *   'codex-cli'    — single-engine, MUST receive codexMode:'read'.
   *
   * 'claude-cli' is NOT here — that goes through the normal agent-server
   * forward path (existing code stays bit-identical, unchanged).
   */
  mode: "ollama" | "parallel-all" | "codex-cli";
  /**
   * The 'system' role is optionally supported — set by the caller (engine-mode
   * branch) when a RAG context block is prepended (TG-1).
   */
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  pendingPromptId: string;
  workspaceId: string;
  /**
   * Codex safety flag. Forwarded to orchestrate().
   * For mode:'codex-cli' and mode:'parallel-all' ALWAYS set 'read'.
   * Omit (undefined) for 'ollama' — Ollama ignores the field.
   */
  codexMode?: "read" | "write";
}

/**
 * Calls lib/llm/orchestrator.orchestrate() single-shot and builds from it
 * an SSE ReadableStream whose frame format EXACTLY matches the agent-server path.
 * The client parser (useAgentStream.ts) sees no difference.
 *
 * Frame sequence:
 *   1. pending_id  — as in the agent-server path (echo-filter dedup)
 *   2. ready       — sessionId: null (no agent-server session object)
 *   3. token       — delta: result.text (a single chunk, no streaming)
 *   4. done        — duration_ms, num_turns: 1, is_error: false
 *
 * On error:
 *   error frame   — message from the catch
 *   done frame    — is_error: true
 *
 * Best-effort: an orchestrate error produces an error frame instead of a 500.
 * Headers are bit-identical with the normal SSE path.
 *
 * N11 resource-budget note: parallel-all starts up to 3 engine requests
 * simultaneously (claude-cli, codex-cli-read, ollama). The orchestrator itself
 * manages no slot pool — that is the subagent-pool's job. The text race is
 * lightweight (no worktree spawns, no heavy Ollama model by default).
 * If deepseek-r1:14b is configured as the Ollama model, that counts against the
 * heavy budget (N11: max 2 heavy jobs) — keep in mind for parallel chat turns.
 */
function buildOrchestratorSse(args: OrchestratorSseArgs): Response {
  const { mode, messages, pendingPromptId, workspaceId, codexMode } = args;
  const enc = new TextEncoder();

  const frame = (event: string, data: unknown): Uint8Array =>
    enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Frame 1: pending_id (same structure as the normal path)
      controller.enqueue(
        enc.encode(
          `event: pending_id\ndata: ${JSON.stringify({ pendingPromptId, workspaceId })}\n\n`,
        ),
      );

      const t0 = Date.now();
      // orchestrate type: OrchestratorRequest expects EngineMessage (role:
      // 'system'|'user'|'assistant'). Our BodySchema messages type only has
      // 'user'|'assistant' — that is a subset, the cast is safe.
      void (async () => {
        try {
          const { orchestrate } = await import("@/lib/llm/orchestrator");
          const { tokenizeMessagesAsync, rehydrate } = await import(
            "@/lib/privacy/protect"
          );
          const result = await orchestrate({
            mode,
            // PII vault: replace personal entities with local tokens BEFORE the
            // prompt reaches any cloud engine — including the optional local-LLM
            // name detection. Pure pass-through when LAZYOS_PII_VAULT is off.
            messages: await tokenizeMessagesAsync(workspaceId, messages),
            // codexMode is only set when the caller passed it explicitly ('read'
            // for codex-cli / parallel-all). No path here can set 'write'.
            ...(codexMode !== undefined ? { codexMode } : {}),
          });

          // Detokenize ONCE: real values for the user-visible frame AND for
          // persistence below (the cloud only ever saw the tokens).
          const shownText = rehydrate(workspaceId, result.text);

          // Frame 2: ready (sessionId null — no persistent agent-server
          // session context, just a single-shot answer)
          controller.enqueue(frame("ready", { sessionId: null }));

          // Frame 3: token (full answer as one delta chunk) — real values.
          controller.enqueue(frame("token", { delta: shownText }));

          // Frame 4: done
          controller.enqueue(
            frame("done", {
              duration_ms: result.latencyMs,
              num_turns: 1,
              is_error: false,
            }),
          );

          // Persistence (N8 trace): otherwise a reload / cross-device loses the
          // answer + the ledger thread would stay halved.
          // emitChatMessageCompleted = history event (broadcast), appendLedgerRow
          // = N8 trace. Both best-effort — no stream kill on a DB error.
          try {
            await emitChatMessageCompleted({
              workspaceId,
              entityId: ulid(),
              content: shownText,
              actor: "system",
              outcome: "ok",
              // result.engine = the winning engine (parallel-all: fastest);
              // mode = what the caller requested.
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
              contentFull: shownText,
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
          // Error frame + done (no 500 — best-effort)
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
      // P1-4: pendingPromptId also as a header — recovery path for edge cases
      // where the SSE pending_id frame does not arrive.
      "x-lazyos-pending-id": pendingPromptId,
    },
  });
}

// ---------------------------------------------------------------------------
// Ultracoding SSE adapter (multi-agent · 2026-06-02)
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
      // Frame 1: pending_id (identical to buildOrchestratorSse).
      controller.enqueue(frame("pending_id", { pendingPromptId, workspaceId }));
      const t0 = Date.now();
      void (async () => {
        try {
          // Frame 2: ready (sessionId null — no agent-server session context).
          controller.enqueue(frame("ready", { sessionId: null }));
          const { runUltracoding } = await import(
            "@/server/agents/ultracoding-orchestrator"
          );
          const result = await runUltracoding({
            messages,
            workspaceId,
            // Frames 3..N: one subagent_lane frame per lane event.
            onLaneEvent: (ev: SubagentLaneEvent) => {
              try {
                controller.enqueue(frame("subagent_lane", ev));
              } catch {
                /* socket gone */
              }
            },
          });
          // Frame N+1: token (aggregated Markdown summary).
          controller.enqueue(frame("token", { delta: result.text }));
          // Frame N+2: done.
          controller.enqueue(
            frame("done", {
              duration_ms: result.latencyMs,
              num_turns: 1,
              is_error: false,
            }),
          );
          // Persistence — same posture as buildOrchestratorSse (best-effort,
          // non-fatal). The engine is always claude-cli (gate), mode 'ultracoding'.
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
 * Gate-miss stream for Ultracoding when claude-cli is not available.
 * A clean SSE error frame (NO 500/crash) → useAgentStream shows the
 * gate message via the existing `case 'error'` path. The header is
 * preserved so the echo-filter recovery applies.
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
 * Who triggered the /api/chat/stream call?
 *
 * Phase ORG (2026-04-27): we read the `x-lazyos-subject` header that the
 * edge middleware set after cookie/bearer verify. This replaces the
 * earlier hardcoded `user:max` mapping.
 *
 * P0-#1b / F-1b (2026-05-25): the earlier `x-lazyos-caller` override is
 * removed. This inbound header was an audit-spoof class — a
 * bearer-authenticated caller could write any `agent:<name>` label
 * into the audit trail. The middleware now strips the header
 * unconditionally (step 0); the actor is derived exclusively from the
 * cryptographically verified `x-lazyos-subject` that the middleware
 * set after cookie/bearer verify.
 *
 * Order (everything from a VERIFIED source):
 *   1) `user:<ulid>`  → verified session cookie (currentSubject user).
 *   2) `agent:cli`    → verified agent/CLI bearer (currentSubject agent).
 *                        Replaces the previously spoofable `agent:<name>` with the
 *                        verified token label — the audit shows the
 *                        verified instead of the claimed identity.
 *   3) `system:<id>`  → Bridge / cron (currentSubject system) -> mapped as
 *                        `agent:<id>` into the event-actor schema.
 *   4) Cookie fallback (no subject header, only a direct VPS call without
 *      middleware preamble) -> 'user:max-bootstrap'.
 *   5) Defensive (the middleware otherwise lets no unauth calls through) ->
 *      'agent:api'.
 */
export function detectActor(req: Request): `user:${string}` | `agent:${string}` {
  // Phase ORG / P0-#1b: the subject header is the only trust anchor.
  const subject = currentSubject(req);
  if (subject.kind === "user") {
    return `user:${subject.userId}`;
  }
  if (subject.kind === "agent") {
    // Verified agent/CLI bearer label (e.g. 'cli'). NO more inbound override
    // — the x-lazyos-caller header is stripped by the middleware.
    return `agent:${subject.agentId}`;
  }
  if (subject.kind === "system") {
    // Map Bridge/cron as agent:<systemId> into the event-actor schema.
    return `agent:${subject.systemId}`;
  }
  // subject.kind === "anon" — no verified subject in the header.
  const cookieHeader = req.headers.get("cookie") ?? "";
  // Legacy fallback when there is no subject header (should only occur on direct
  // VPS calls without a middleware preamble). Cookie existence check.
  // Phase AU.4: stays „user:max-bootstrap" as a marker for now — the real
  // ULID resolution happens one layer further up in the routes that
  // emit chat_message_sent.
  if (/(^|;\s*)lazyos_session=/.test(cookieHeader)) {
    return "user:max-bootstrap";
  }
  // Should not happen — the middleware lets no unauthenticated
  // calls through. Defensive: agent:api.
  return "agent:api";
}
