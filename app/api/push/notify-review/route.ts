/**
 * POST /api/push/notify-review
 * ----------------------------
 * Kern-UX-Endpoint: "Push wenn was zu testen ist."
 *
 * Wenn intern ein Review-Ready-Zustand erreicht wird (Phase-Completion,
 * Agent-fertig-Signal, Cron-Job), ruft dieser Endpoint auf:
 *   - schreibt optional `review_request` Event ins Event-Log
 *   - schreibt `push_sent` Event
 *   - sendet Web-Push an alle registrierten Subscriptions (the owner's PWA)
 *
 * Auth: Bearer $LAZYOS_PUSH_SECRET (Pflicht). Endpoint ist
 * fail-closed — ohne gesetztes Secret sind alle Requests 401.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { emitEvent } from "@/lib/events/emit";
import { SEGMENTS, type SegmentId } from "@/lib/events/types";
import { list, remove } from "@/lib/pwa/store";
import { getPushClient } from "@/lib/pwa/pushServer";
import { verifyBearer } from "@/lib/security/bearer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SegmentSchema = z.enum(
  SEGMENTS as unknown as [SegmentId, ...SegmentId[]],
);

const NotifyReviewSchema = z
  .object({
    title: z.string().min(1).max(120),
    body: z.string().min(1).max(500),
    url: z
      .string()
      .min(1)
      .refine((v) => v.startsWith("/"), "url muss mit / beginnen"),
    ticketId: z.string().min(1).max(80).optional(),
    segmentId: SegmentSchema.optional(),
  })
  .strict();

function authorized(req: NextRequest): boolean {
  return verifyBearer(req, process.env.LAZYOS_PUSH_SECRET).ok;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!authorized(req)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid json" },
      { status: 400 },
    );
  }

  const parsed = NotifyReviewSchema.safeParse(raw);
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

  const { title, body, url, ticketId, segmentId } = parsed.data;
  const seg = segmentId ?? "@system";

  // 1) review_request im Event-Log wenn Ticket verknuepft
  if (ticketId) {
    await emitEvent({
      segmentId: seg,
      entityType: "ticket",
      entityId: ticketId,
      eventType: "review_request",
      actor: "system",
      payload: { title, body, url },
      sensitivity: "low",
    });
  }

  // 2) push_sent Event
  await emitEvent({
    segmentId: seg,
    entityType: ticketId ? "ticket" : "phase",
    entityId: ticketId ?? "system",
    eventType: "push_sent",
    actor: "system",
    payload: { title, body, url },
    sensitivity: "low",
  });

  // 3) Subscriptions laden + Push senden
  const subs = await list();
  if (subs.length === 0) {
    return NextResponse.json({
      ok: true,
      sent: 0,
      removed: 0,
      note: "no subscriptions",
    });
  }

  let client: ReturnType<typeof getPushClient>;
  try {
    client = getPushClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "push client init failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }

  const notif = JSON.stringify({
    title,
    body,
    url,
    tag: ticketId ? `lazyos-review-${ticketId}` : "lazyos-review",
  });

  let sent = 0;
  let removed = 0;
  const errors: Array<{
    endpoint: string;
    statusCode?: number;
    message: string;
  }> = [];

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await client.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          notif,
          { TTL: 60 },
        );
        sent += 1;
      } catch (err: unknown) {
        const statusCode =
          err && typeof err === "object" && "statusCode" in err
            ? (err as { statusCode?: number }).statusCode
            : undefined;
        const message = err instanceof Error ? err.message : String(err);
        if (statusCode === 404 || statusCode === 410) {
          await remove(sub.endpoint).catch(() => undefined);
          removed += 1;
        }
        errors.push({
          endpoint: sub.endpoint.slice(0, 60) + "...",
          statusCode,
          message,
        });
      }
    }),
  );

  return NextResponse.json({
    ok: true,
    sent,
    removed,
    failures: errors.length,
    errors: errors.slice(0, 5),
  });
}
