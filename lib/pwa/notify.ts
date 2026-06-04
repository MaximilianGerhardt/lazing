/**
 * Server-side helper to trigger review pushes directly from code paths
 * (event handlers, cron jobs, agent callbacks).
 *
 * Bypasses the HTTP layer (no self-fetch needed) and invokes the event log +
 * push directly. Consistent with `/api/push/notify-review` —
 * identical logging, identical send behavior.
 *
 * Important: use ONLY from the server (route handlers, server actions,
 * cron jobs). Never import from client components — it would
 * pull the VAPID private key and subscription store into the browser bundle.
 */
import type { SegmentId } from "@/lib/events/types";
import { emitEvent } from "@/lib/events/emit";
import { list, remove } from "./store";
import { getPushClient } from "./pushServer";

export interface NotifyReviewInput {
  title: string;
  body: string;
  url: string;
  ticketId?: string;
  segmentId?: SegmentId;
}

export interface NotifyReviewResult {
  sent: number;
  removed: number;
  failures: number;
}

export async function notifyReview(
  opts: NotifyReviewInput,
): Promise<NotifyReviewResult> {
  const { title, body, url, ticketId } = opts;
  const segmentId: SegmentId = opts.segmentId ?? "@system";

  if (!url.startsWith("/")) {
    throw new Error("notifyReview: url muss mit / beginnen");
  }
  if (!title || !body) {
    throw new Error("notifyReview: title und body sind Pflicht");
  }

  // 1) Event log: review_request (if ticket) + push_sent
  if (ticketId) {
    await emitEvent({
      segmentId,
      entityType: "ticket",
      entityId: ticketId,
      eventType: "review_request",
      actor: "system",
      payload: { title, body, url },
      sensitivity: "low",
    });
  }

  await emitEvent({
    segmentId,
    entityType: ticketId ? "ticket" : "phase",
    entityId: ticketId ?? "system",
    eventType: "push_sent",
    actor: "system",
    payload: { title, body, url },
    sensitivity: "low",
  });

  // 2) Push raus
  const subs = await list();
  if (subs.length === 0) {
    return { sent: 0, removed: 0, failures: 0 };
  }

  const client = getPushClient();
  const notif = JSON.stringify({
    title,
    body,
    url,
    tag: ticketId ? `lazyos-review-${ticketId}` : "lazyos-review",
  });

  let sent = 0;
  let removed = 0;
  let failures = 0;

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
        failures += 1;
        const statusCode =
          err && typeof err === "object" && "statusCode" in err
            ? (err as { statusCode?: number }).statusCode
            : undefined;
        if (statusCode === 404 || statusCode === 410) {
          await remove(sub.endpoint).catch(() => undefined);
          removed += 1;
        }
      }
    }),
  );

  return { sent, removed, failures };
}
