/**
 * POST /api/feedback
 * ------------------
 * Nimmt User-Feedback zu einem Ticket entgegen und persistiert es als
 * append-only Event ins Event-Log. Wenn der User "adjust" oder "reject"
 * waehlt, wird zusaetzlich ein `fix_agent_triggered` Event geschrieben —
 * der echte Agent-Spawn folgt in Phase 5.
 *
 * Auth: MVP offen. TODO Phase-6-Haertung: Auth-Gate (Same-Origin + CSRF-
 * Token fuer Browser-Calls, Bearer-Token fuer Script/Agent-Calls).
 *
 * Shared Schema: `FeedbackRequest` in lib/events/types.ts.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { emitEvent } from "@/lib/events/emit";
import { SEGMENTS, type ActorType, type SegmentId } from "@/lib/events/types";
import { currentActor } from "@/lib/security/subject";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuickActionSchema = z.enum(["ok", "adjust", "reject"]);
const SegmentSchema = z.enum(SEGMENTS as unknown as [SegmentId, ...SegmentId[]]);

const FeedbackRequestSchema = z
  .object({
    ticketId: z.string().min(1, "ticketId erforderlich"),
    segmentId: SegmentSchema.optional(),
    quickAction: QuickActionSchema.optional(),
    text: z.string().max(4000).optional(),
    checkedItems: z.array(z.string()).max(64).optional(),
    triggerFixAgent: z.boolean().optional(),
  })
  .strict();

type FeedbackBody = z.infer<typeof FeedbackRequestSchema>;

function shouldTriggerFixAgent(body: FeedbackBody): boolean {
  if (body.triggerFixAgent === false) return false;
  return body.quickAction === "adjust" || body.quickAction === "reject";
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid json" },
      { status: 400 },
    );
  }

  const parsed = FeedbackRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "validation failed",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  const body = parsed.data;
  const segmentId = body.segmentId ?? "@system";
  const submittedAt = Date.now();
  const actor = currentActor(req) as ActorType;

  // 1) User-Feedback-Event schreiben
  const feedbackEvent = await emitEvent({
    segmentId,
    entityType: "ticket",
    entityId: body.ticketId,
    eventType: "user_feedback",
    actor,
    payload: {
      quickAction: body.quickAction,
      text: body.text,
      checkedItems: body.checkedItems,
      submittedAt,
    },
    sensitivity: "low",
  });

  // 2) Fix-Agent-Trigger bei adjust/reject (Phase-5-Platzhalter)
  let triggered = false;
  if (shouldTriggerFixAgent(body)) {
    await emitEvent({
      segmentId,
      entityType: "ticket",
      entityId: body.ticketId,
      eventType: "fix_agent_triggered",
      actor: "system",
      payload: {
        reason: body.quickAction,
        ticketId: body.ticketId,
        parentEventId: feedbackEvent.id,
      },
      sensitivity: "low",
    });
    triggered = true;
    // Phase-5-Platzhalter: hier wird kuenftig der echte Claude-Agent gespawnt
    console.info(
      `[lazyos] Fix-Agent simuliert — Phase 5 spawnt echten Claude-Agent hier (ticket=${body.ticketId}, reason=${body.quickAction})`,
    );
  }

  return NextResponse.json(
    {
      ok: true,
      eventId: feedbackEvent.id,
      triggered,
    },
    { status: 201 },
  );
}
