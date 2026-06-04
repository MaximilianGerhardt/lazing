/**
 * GET /api/subchats/external/[token]/stream  — Token-gegateter Realtime-SSE
 * für externe Gäste (KEIN Login).
 *
 * Bisher hing der externe `/c/[token]`-Chat bewusst auf 4s-Polling, weil der
 * interne SSE-Endpunkt (`/api/events/stream`) authed ist und Gäste keine Session
 * haben. Dieser Endpunkt broadcastet ausschließlich `subchat_message`-(und
 * `subchat_typing`-)Events DIESES einen Sub-Chats — gegated allein durch den
 * Share-Token (resolveExternalToken). Kein Leak anderer Workspaces/Sub-Chats:
 * der Filter matcht hart auf `entityId === sc.id` UND `segmentId === workspaceId`.
 *
 * Payload bewusst minimal (ein „Ping"): `{ type, subchatId, authorKind, ts }`.
 * Der Client lädt bei jedem Ping den (token-gegateten) Nachrichten-GET neu —
 * so bleibt die Render-/Sanitize-Logik an EINER Stelle und es wird nichts
 * Internes über den Stream geleakt.
 *
 * Public-Route (middleware PUBLIC_PREFIXES `/api/subchats/external/`),
 * zusätzlich durch die Prefix-Rate-Limit-Policy (120/min) eingedämmt.
 * Gathering-Intelligence-Goal · Externes Realtime (2026-06-03).
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
 * Globale Obergrenze gleichzeitig offener Gast-SSE-Verbindungen (Security-Review
 * Finding #1): der Rate-Limit deckelt die FREQUENZ neuer Verbindungen, nicht die
 * ANZAHL dauerhaft offener. Jede offene Verbindung hängt einen Listener an das
 * globale `broadcast` (publish() iteriert synchron über ALLE) + ein 30s-Intervall.
 * Ohne Deckel könnte ein Angreifer mit gehaltenen Sockets das Realtime des
 * (Single-Instance-)Servers degradieren. 200 ist für 1-Mann-Agentur großzügig.
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

  // Nur Events DIESES Sub-Chats, nur die für Gäste relevanten Event-Typen.
  const relevant = (ev: LazyEvent): boolean => {
    if (ev.entityId !== subchatId) return false;
    if (ev.segmentId !== workspaceId) return false; // Defense-in-depth
    return ev.eventType === 'subchat_message' || ev.eventType === 'subchat_typing';
  };

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      // `released` ist die EINMAL-Teardown-Idempotenz (Counter-Dekrement,
      // unsubscribe, clearInterval) — getrennt von `closed` (Write-Fehler), damit
      // ein fehlgeschlagener send() den Dekrement nicht verschluckt (Leak).
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

      // Kein Initial-Replay — der Client holt den Anfangszustand per GET.
      // Direkt ein Kommentar-Frame, damit Proxies den Stream sofort flushen.
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
      // Token nie über Referer weitergeben (gleiche Härtung wie Media-Route).
      'Referrer-Policy': 'no-referrer',
    },
  });
}
