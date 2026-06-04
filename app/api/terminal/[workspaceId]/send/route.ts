/**
 * POST /api/terminal/[workspaceId]/send
 *
 * Body: { data: string } for literal characters
 *   OR { key: 'Enter' | 'Tab' | 'Up' | 'Down' | 'Left' | 'Right' | 'Backspace' | 'Escape' | 'C-c' | 'C-d' | 'C-z' | ... }
 *
 * Rate limit: per-IP 600/min via the global middleware.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { sendKeysToPane, sendControl, sendNamedKeyToPane } from '@/server/tmux-controller';
import { tmuxSessionName } from '@/server/workspace-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PANE_INDEX = 2;

const SAFE_NAMED_KEYS = new Set([
  'Enter',
  'Tab',
  'BTab',
  'Up',
  'Down',
  'Left',
  'Right',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Backspace',
  'BSpace',
  'Escape',
  'Space',
  'Delete',
  'DC',
  'Insert',
]);

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

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { workspaceId } = await ctx.params;
  if (!isValidWorkspaceId(workspaceId)) {
    return NextResponse.json({ error: 'invalid_workspace_id' }, { status: 400 });
  }

  let body: { data?: unknown; key?: unknown };
  try {
    body = (await req.json()) as { data?: unknown; key?: unknown };
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const session = tmuxSessionName(workspaceId);

  if (typeof body.data === 'string') {
    if (body.data.length > 4096) {
      return NextResponse.json({ error: 'too_long' }, { status: 400 });
    }
    try {
      // sendKeysToPane with -l flag = literal (safe against tmux special characters)
      await sendKeysToPane(session, PANE_INDEX, body.data, false);
      return NextResponse.json({ ok: true });
    } catch (err) {
      return NextResponse.json(
        { error: 'send_failed', detail: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  }

  if (typeof body.key === 'string') {
    const key = body.key;
    // Validate strictly — either a named key or a C-X / M-X / S-X modifier
    const isNamed = SAFE_NAMED_KEYS.has(key);
    const isControl = /^[CMS]-[a-zA-Z]$/.test(key);
    if (!isNamed && !isControl) {
      return NextResponse.json({ error: 'unsafe_key' }, { status: 400 });
    }
    try {
      if (isControl) {
        await sendControl(session, key);
      } else {
        await sendNamedKeyToPane(session, PANE_INDEX, key);
      }
      return NextResponse.json({ ok: true });
    } catch (err) {
      return NextResponse.json(
        { error: 'send_failed', detail: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ error: 'missing_data_or_key' }, { status: 400 });
}
