/**
 * GET /api/terminal/[workspaceId]
 *
 * SSE-Stream für den Terminal-View (Phase T). Liefert ANSI-Output der
 * tmux-Session-Pane (interaktive Bash). Polling-basiert: alle 200 ms ein
 * Snapshot via capturePane, voller Pane-Inhalt geht durch xterm.js.
 *
 * Auth: Cookie-Session (lazyos-Auth). Whitelisting in middleware nicht
 * nötig, das default-API-Auth-Pattern greift.
 *
 * Output-Format (SSE event "snapshot"):
 *   data: {"content": "<ansi-text>"}
 *
 * Heartbeats alle 15 s als ":\n\n" comments — verhindert dass Cloudflare
 * den Stream kappt.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { capturePane } from '@/server/tmux-controller';
import { ensureSession, tmuxSessionName } from '@/server/workspace-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POLL_INTERVAL_MS = 200;
const HEARTBEAT_INTERVAL_MS = 15_000;
const PANE_INDEX = 2; // Interaktive Bash, von splitWindow als zweite Pane

interface Ctx {
  params: Promise<{ workspaceId: string }>;
}

function isValidWorkspaceId(id: string): boolean {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 64 &&
    /^[a-z0-9_()][a-z0-9_()-]{0,63}$/i.test(id)
  );
}

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { workspaceId } = await ctx.params;
  if (!isValidWorkspaceId(workspaceId)) {
    return NextResponse.json({ error: 'invalid_workspace_id' }, { status: 400 });
  }

  // Stelle sicher dass die tmux-Session existiert (creates wenn nötig).
  try {
    await ensureSession(workspaceId);
  } catch (err) {
    return NextResponse.json(
      {
        error: 'session_unavailable',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 503 },
    );
  }

  const session = tmuxSessionName(workspaceId);
  const target = `${session}.${PANE_INDEX}`;

  const encoder = new TextEncoder();
  let lastSnapshot = '';
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (eventName: string, data: unknown): void => {
        if (closed) return;
        try {
          const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch {
          /* controller closed — cleanup läuft via abort */
        }
      };

      const sendHeartbeat = (): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': hb\n\n'));
        } catch {
          /* ignore */
        }
      };

      const poll = async (): Promise<void> => {
        if (closed) return;
        try {
          const snap = await capturePane(target, { ansi: true });
          if (snap !== lastSnapshot) {
            lastSnapshot = snap;
            send('snapshot', { content: snap });
          }
        } catch (err) {
          send('error', {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      };

      send('hello', { workspaceId, session, pane: PANE_INDEX });
      await poll();

      pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
      heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    },
    cancel() {
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    },
  });

  req.signal.addEventListener('abort', () => {
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    },
  });
}
