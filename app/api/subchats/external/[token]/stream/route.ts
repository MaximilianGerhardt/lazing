/**
 * GET /api/subchats/external/[token]/stream  — token-gated realtime SSE
 * for external guests (NO login).
 *
 * Previously the external `/c/[token]` chat deliberately relied on 4s polling,
 * because the internal SSE endpoint (`/api/events/stream`) is authed and guests
 * have no session. This endpoint broadcasts exclusively `subchat_message` (and
 * `subchat_typing`) events of THIS one sub-chat — gated solely by the
 * share token (resolveExternalToken). No leak of other workspaces/sub-chats:
 * the filter matches hard on `entityId === sc.id` AND `segmentId === workspaceId`.
 *
 * Payload deliberately minimal (a "ping"): `{ type, subchatId, authorKind, ts }`.
 * On each ping the client reloads the (token-gated) message GET —
 * so the render/sanitize logic stays in ONE place and nothing
 * internal is leaked over the stream.
 *
 * Public route (middleware PUBLIC_PREFIXES `/api/subchats/external/`),
 * additionally contained by the prefix rate-limit policy (120/min).
 * Gathering-Intelligence goal · external realtime (2026-06-03).
 */

import { broadcast } from '@/lib/events/broadcast';
import { resolveExternalToken } from '@/lib/subchats/service';
import type { LazyEvent } from '@/lib/events/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ token: string }>;
}

/**
 * Global upper bound of simultaneously open guest SSE connections (Security-Review
 * Finding #1): the rate limit caps the FREQUENCY of new connections, not the
 * NUMBER of permanently open ones. Each open connection attaches a listener to the
 * global `broadcast` (publish() iterates synchronously over ALL) + a 30s interval.
 * Without a cap, an attacker with held-open sockets could degrade the realtime of
 * the (single-instance) server. 200 is generous for a one-person agency.
 */
const MAX_OPEN_GUEST_STREAMS = 200;
const streamCounter = globalThis as unknown as { __lazyosGuestSSE?: number };

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const { token } = await ctx.params;
  const sc = resolveExternalToken(token);
  if (!sc) {
    return new Response('not found', {
      status: 404,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  if ((streamCounter.__lazyosGuestSSE ?? 0) >= MAX_OPEN_GUEST_STREAMS) {
    return new Response('busy', {
      status: 503,
      headers: { 'Retry-After': '30', 'Cache-Control': 'no-store' },
    });
  }

  const subchatId = sc.id;
  const workspaceId = sc.workspaceId;

  // Only events of THIS sub-chat, only the event types relevant to guests.
  const relevant = (ev: LazyEvent): boolean => {
    if (ev.entityId !== subchatId) return false;
    if (ev.segmentId !== workspaceId) return false; // Defense-in-depth
    return ev.eventType === 'subchat_message' || ev.eventType === 'subchat_typing';
  };

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      // `released` is the ONE-TIME teardown idempotency (counter decrement,
      // unsubscribe, clearInterval) — separate from `closed` (write error), so
      // that a failed send() does not swallow the decrement (leak).
      let released = false;
      streamCounter.__lazyosGuestSSE = (streamCounter.__lazyosGuestSSE ?? 0) + 1;
      const send = (data: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          closed = true;
        }
      };

      // No initial replay — the client fetches the initial state via GET.
      // A comment frame right away so proxies flush the stream immediately.
      send(`: connected ${Date.now()}\n\n`);

      const unsubscribe = broadcast.subscribe((ev: LazyEvent) => {
        if (!relevant(ev)) return;
        const authorKind =
          (ev.payload?.authorKind as string | undefined) ?? 'unknown';
        const ping = JSON.stringify({
          type: ev.eventType,
          subchatId,
          authorKind,
          ts: ev.createdAt,
        });
        send(`id: ${ev.id}\n`);
        send(`data: ${ping}\n\n`);
      });

      const heartbeat = setInterval(() => {
        if (closed) return;
        send(`: heartbeat ${Date.now()}\n\n`);
      }, 30_000);

      const onAbort = (): void => {
        if (released) return;
        released = true;
        closed = true;
        streamCounter.__lazyosGuestSSE = Math.max(
          0,
          (streamCounter.__lazyosGuestSSE ?? 1) - 1,
        );
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener('abort', onAbort);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      // Never pass the token via referer (same hardening as the media route).
      'Referrer-Policy': 'no-referrer',
    },
  });
}
