/**
 * GET /api/events/stream
 *
 * Server-Sent Events. Streams every new `LazyEvent` published via
 * `broadcast.publish()`. On connect, we flush the last `limit` events
 * (filtered by segment + sinceId) so the client can catch up.
 *
 * Query params:
 *   - segment?: SegmentId  (e.g. "@north")
 *   - sinceId?: string     (ULID; return events STRICTLY AFTER this id)
 *   - limit?:   number     (initial replay window, default 50, max 500)
 *
 * Message format:
 *   data: <JSON LazyEvent>\n\n
 *
 * Heartbeat every 30s as a comment line (`: heartbeat\n\n`) to keep the
 * connection alive through proxies (Vercel/Cloudflare idle timeout).
 */

import { broadcast } from "../../../../lib/events/broadcast";
import { getEventStream } from "../../../../lib/events/project";
import { emitErrorEvent } from "../../../../lib/events/emit";
import {
  readSessionConfig,
  readSessionCookie,
  verifySessionCookieValue,
} from "../../../../lib/security/session";
import type { LazyEvent, Sensitivity, SegmentId } from "../../../../lib/events/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_SEGMENTS: SegmentId[] = ["@north", "@clientb", "@own", "@private", "@system"];
const VALID_SENSITIVITIES: Sensitivity[] = ["low", "medium", "high"];

function parseSegment(v: string | null): SegmentId | undefined {
  if (!v) return undefined;
  return VALID_SEGMENTS.includes(v as SegmentId) ? (v as SegmentId) : undefined;
}

function parseLimit(v: string | null): number {
  if (!v) return 50;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(n, 500);
}

function parseSensitivities(v: string | null): Set<Sensitivity> | undefined {
  if (!v) return undefined;
  const out = new Set<Sensitivity>();
  for (const raw of v.split(",")) {
    const trimmed = raw.trim() as Sensitivity;
    if (VALID_SENSITIVITIES.includes(trimmed)) out.add(trimmed);
  }
  return out.size > 0 ? out : undefined;
}

export async function GET(req: Request): Promise<Response> {
  // Defense-in-depth: middleware already gates this route, but we
  // re-verify here so if middleware is ever misconfigured we still
  // strip `high` events from un-authenticated requests.
  const cookieCfg = readSessionConfig();
  let isAuthed = false;
  if (cookieCfg) {
    const value = readSessionCookie(req.headers.get("cookie"));
    const verified = await verifySessionCookieValue(value, cookieCfg);
    isAuthed = verified.ok;
  }

  const url = new URL(req.url);
  const segment = parseSegment(url.searchParams.get("segment"));
  const sinceId = url.searchParams.get("sinceId") ?? undefined;
  const limit = parseLimit(url.searchParams.get("limit"));
  const sensitivityFilter = parseSensitivities(url.searchParams.get("sensitivity"));

  const allow = (ev: LazyEvent): boolean => {
    if (segment && ev.segmentId !== segment) return false;
    if (!isAuthed && ev.sensitivity === "high") return false;
    if (sensitivityFilter && !sensitivityFilter.has(ev.sensitivity)) return false;
    return true;
  };

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (data: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          closed = true;
        }
      };

      // 1. Initial: last N events.
      try {
        const initial = await getEventStream(segment, sinceId, limit);
        for (const ev of initial) {
          if (!allow(ev)) continue;
          send(`id: ${ev.id}\n`);
          send(`data: ${JSON.stringify(ev)}\n\n`);
        }
      } catch (err) {
        await emitErrorEvent(segment ?? "@system", "sse/initial", err);
        send(`event: error\ndata: ${JSON.stringify({ message: "initial_replay_failed" })}\n\n`);
      }

      // 2. Subscribe to live events.
      const unsubscribe = broadcast.subscribe((ev: LazyEvent) => {
        if (!allow(ev)) return;
        send(`id: ${ev.id}\n`);
        send(`data: ${JSON.stringify(ev)}\n\n`);
      });

      // 3. Heartbeat every 30s.
      const heartbeat = setInterval(() => {
        if (closed) return;
        send(`: heartbeat ${Date.now()}\n\n`);
      }, 30_000);

      // 4. Cleanup on abort.
      const onAbort = (): void => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      req.signal.addEventListener("abort", onAbort);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
