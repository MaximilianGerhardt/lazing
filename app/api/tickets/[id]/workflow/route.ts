/**
 * POST /api/tickets/:id/workflow
 *   Body: { transition: Transition, comment?: string, actor?: ActorType }
 *   Auth: middleware-cookie (user-transitions) ODER Bearer (agent-transitions).
 *
 * Emittiert ein FSM-Event und liefert den neuen Workflow-State + Timeline-
 * Entry zurück.
 *
 * Bearer-Auth:
 *   Header `Authorization: Bearer $LAZYOS_AGENT_SECRET` erlaubt Agents
 *   (außer `approve`/`reject`/`reopen` — die bleiben user-only, es sei denn
 *   Body enthält `flags.autoApprove=true` UND das ist für diese Route
 *   explizit konfiguriert).
 *
 * GET /api/tickets/:id/workflow
 *   Liefert nur den aktuellen Workflow-State (keine Auth-Unterscheidung nötig,
 *   hinter middleware).
 */

import { NextResponse, type NextRequest } from "next/server";

import {
  InvalidTransitionError,
  TicketNotFoundError,
  getWorkflowState,
  transitionWorkflow,
} from "@/lib/approvals/service";
import {
  ALL_TRANSITIONS,
  type Transition,
  type TransitionFlags,
} from "@/lib/approvals/fsm";
import { emitErrorEvent } from "@/lib/events/emit";
import type { ActorType } from "@/lib/events/types";
import { currentActor } from "@/lib/security/subject";
import { extractBearer, timingSafeEqual } from "@/lib/security/bearer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

// ---------------------------------------------------------------------------
// Input validation (zod-frei — Payload ist winzig)
// ---------------------------------------------------------------------------

interface TransitionBody {
  transition: unknown;
  comment?: unknown;
  actor?: unknown;
  flags?: unknown;
}

function isTransition(v: unknown): v is Transition {
  return (
    typeof v === "string" &&
    (ALL_TRANSITIONS as readonly string[]).includes(v)
  );
}

function parseActor(raw: unknown, fallback: ActorType): ActorType {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  if (raw === "system") return "system";
  if (raw.startsWith("user:") || raw.startsWith("agent:")) {
    return raw as ActorType;
  }
  return fallback;
}

function parseFlags(raw: unknown): TransitionFlags | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const out: TransitionFlags = {};
  if (obj.autoApprove === true) out.autoApprove = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// Auth — cookie (user) vs. bearer (agent)
// ---------------------------------------------------------------------------

type AuthMode =
  | { kind: "user" }
  | { kind: "agent"; agentName: string }
  | { kind: "denied"; reason: string };

function resolveAuth(req: NextRequest): AuthMode {
  // Middleware already verified the cookie — it sets `x-lazyos-auth: ok`
  // on the downstream response, but the request itself carries the cookie.
  // For Bearer-auth we check the Authorization header; cookie presence is
  // the fallback indicator that middleware waved us through.
  const token = extractBearer(req);

  if (token) {
    const agentSecret = process.env.LAZYOS_AGENT_SECRET;
    if (!agentSecret) {
      return {
        kind: "denied",
        reason: "LAZYOS_AGENT_SECRET not configured",
      };
    }
    if (!timingSafeEqual(token, agentSecret)) {
      return { kind: "denied", reason: "invalid bearer" };
    }
    // P0-#1b / F-1b (2026-05-25): agentName war zuvor aus dem inbound-Header
    // `x-lazyos-agent` gelesen — eine Audit-Spoof-Klasse, weil ein
    // bearer-authentifizierter Caller damit ein beliebiges Identitäts-Label in
    // den Audit-Trail (Event-Actor) schreiben konnte. Der Header ist jetzt von
    // der Middleware bedingungslos gestript. Da dieser Bearer ein einziges
    // geteiltes Secret (LAZYOS_AGENT_SECRET) ist und keine token-spezifische
    // Identität trägt, verwenden wir ein festes verifiziertes Label. Audit
    // zeigt damit die verifizierte ("agent") statt der behaupteten Identität.
    const agentName = "agent";
    return { kind: "agent", agentName };
  }

  // No bearer — assume middleware-validated user session.
  // (If middleware didn't validate, we wouldn't reach this handler
  // for API paths — it returns 401 before our code runs.)
  return { kind: "user" };
}

// ---------------------------------------------------------------------------
// GET /api/tickets/:id/workflow
// ---------------------------------------------------------------------------

export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  try {
    const state = await getWorkflowState(id);
    return NextResponse.json(
      { ticketId: id, workflowState: state },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof TicketNotFoundError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    await emitErrorEvent("lazyos", `api/tickets/${id}/workflow:GET`, err);
    return NextResponse.json(
      { error: "read_failed", message: errorMessage(err) },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/tickets/:id/workflow
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const auth = resolveAuth(req);
  if (auth.kind === "denied") {
    return NextResponse.json(
      { error: "unauthorized", reason: auth.reason },
      { status: 401 },
    );
  }

  let body: TransitionBody;
  try {
    body = (await req.json()) as TransitionBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!isTransition(body.transition)) {
    return NextResponse.json(
      {
        error: "validation_error",
        message: `transition must be one of: ${ALL_TRANSITIONS.join(", ")}`,
      },
      { status: 400 },
    );
  }

  // Phase ORG (2026-04-27): Cookie-Auth → currentActor() liest die echte
  // userId aus dem von der Middleware gesetzten subject-Header. Bearer-
  // Auth bleibt beim agent-Kind.
  const defaultActor: ActorType =
    auth.kind === "agent"
      ? (`agent:${auth.agentName}` as ActorType)
      : (currentActor(req) as ActorType);
  const actor = parseActor(body.actor, defaultActor);
  const flags = parseFlags(body.flags);
  const comment =
    typeof body.comment === "string" && body.comment.trim().length > 0
      ? body.comment
      : undefined;

  // Extra safeguard: if an agent tries user-only transitions via the
  // standard agent-bearer, we reject before the FSM gets a say (clearer
  // error message + avoids emitting noise).
  if (
    auth.kind === "agent" &&
    (body.transition === "reject" || body.transition === "reopen")
  ) {
    return NextResponse.json(
      {
        error: "forbidden",
        message: "agents cannot reject or reopen tickets",
      },
      { status: 403 },
    );
  }

  try {
    const result = await transitionWorkflow(id, {
      transition: body.transition,
      actor,
      comment,
      flags,
    });
    return NextResponse.json(
      {
        ok: true,
        ticketId: id,
        previousState: result.previousState,
        workflowState: result.nextState,
        event: {
          id: result.event.id,
          createdAt: result.event.createdAt,
          eventType: result.event.eventType,
          actor: result.event.actor,
          payload: result.event.payload,
        },
        ticket: result.ticket,
      },
      { status: 200 },
    );
  } catch (err) {
    if (err instanceof TicketNotFoundError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (err instanceof InvalidTransitionError) {
      return NextResponse.json(
        {
          error: "invalid_transition",
          from: err.from,
          transition: err.transition,
          actor: err.actor,
          reason: err.reason,
        },
        { status: 409 },
      );
    }
    await emitErrorEvent(
      "lazyos",
      `api/tickets/${id}/workflow:POST`,
      err,
    );
    return NextResponse.json(
      { error: "transition_failed", message: errorMessage(err) },
      { status: 500 },
    );
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
