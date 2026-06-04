/**
 * GET /api/terminal/[workspaceId]
 *
 * SSE stream for the terminal view (Phase T). Delivers ANSI output of the
 * tmux session pane (interactive bash). Polling-based: every 200 ms a
 * snapshot via capturePane, the full pane content goes through xterm.js.
 *
 * Auth: cookie session (lazyos auth). Whitelisting in middleware is not
 * needed, the default API auth pattern applies.
 *
 * Output format (SSE event "snapshot"):
 *   data: {"content": "<ansi-text>"}
 *
 * Heartbeats every 15 s as ":\n\n" comments — prevents Cloudflare from
 * cutting the stream.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { capturePane } from '@/server/tmux-controller';
import { ensureSession, tmuxSessionName } from '@/server/workspace-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POLL_INTERVAL_MS = 200;
const HEARTBEAT_INTERVAL_MS = 15_000;
const PANE_INDEX = 2; // Interactive bash, created by splitWindow as the second pane

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

  // Make sure the tmux session exists (creates it if needed).
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
          /* controller closed — cleanup runs via abort */
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
