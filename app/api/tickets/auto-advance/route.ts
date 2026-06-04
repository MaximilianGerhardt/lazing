/**
 * POST|GET /api/tickets/auto-advance
 *
 * Triggered by systemd-Timer (or manually) — läuft den Stale-Check
 * über alle offenen Tickets und markiert sie mit Tag 'stale' wenn
 * länger als N Tage keine Aktivität. Query-Param `?days=N` (default 14).
 *
 * Auth (Bearer):
 *   - `Authorization: Bearer <LAZYOS_CRON_KEY>`   (cron preferred)
 *   - `Authorization: Bearer <LAZYOS_CHAT_KEY>`   (agent fallback)
 */

import { NextResponse, type NextRequest } from 'next/server';

import { checkStaleTickets } from '@/lib/tickets/auto-advance';
import { extractBearer, timingSafeEqual } from '@/lib/security/bearer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function authorized(req: NextRequest): {
  ok: boolean;
  reason?: 'no_secret' | 'no_bearer' | 'bad_secret';
} {
  const cronKey = process.env.LAZYOS_CRON_KEY ?? '';
  const chatKey = process.env.LAZYOS_CHAT_KEY ?? '';
  if (cronKey.length === 0 && chatKey.length === 0) {
    return { ok: false, reason: 'no_secret' };
  }
  const token = extractBearer(req);
  if (!token) return { ok: false, reason: 'no_bearer' };
  if (cronKey.length > 0 && timingSafeEqual(token, cronKey)) return { ok: true };
  if (chatKey.length > 0 && timingSafeEqual(token, chatKey)) return { ok: true };
  return { ok: false, reason: 'bad_secret' };
}

async function run(req: NextRequest): Promise<Response> {
  const daysParam = req.nextUrl.searchParams.get('days');
  const days = daysParam ? Math.max(1, Math.min(365, Number(daysParam) || 14)) : 14;
  const workspaceId = req.nextUrl.searchParams.get('workspace') ?? undefined;
  const startedAt = Date.now();
  try {
    const results = await checkStaleTickets(days, workspaceId);
    return NextResponse.json({
      ok: true,
      marked: results.length,
      tickets: results,
      days,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        ok: false,
        error: 'advance_failed',
        message: msg,
        duration_ms: Date.now() - startedAt,
      },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const auth = authorized(req);
  if (!auth.ok) {
    const status = auth.reason === 'no_secret' ? 503 : 401;
    return NextResponse.json(
      {
        ok: false,
        error: auth.reason === 'no_secret' ? 'server_not_configured' : 'unauthorized',
        reason: auth.reason,
      },
      { status },
    );
  }
  return run(req);
}

export async function GET(req: NextRequest): Promise<Response> {
  const auth = authorized(req);
  if (!auth.ok) {
    const status = auth.reason === 'no_secret' ? 503 : 401;
    return NextResponse.json(
      {
        ok: false,
        error: auth.reason === 'no_secret' ? 'server_not_configured' : 'unauthorized',
        reason: auth.reason,
      },
      { status },
    );
  }
  return run(req);
}
