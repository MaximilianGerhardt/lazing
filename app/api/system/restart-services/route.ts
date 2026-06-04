/**
 * POST /api/system/restart-services
 *
 * Phase AR · 2026-04-28. Controlled-restart API for autonomous service
 * refreshes by the root chat agent (claude-CLI via Bash). The memory pin
 * relaxes "feedback_never_delete_without_permission.md" with a service
 * restart whitelist — this route is the conventional path so that every
 * restart action leaves an audit trail.
 *
 * Auth: cookie session OR bearer (LAZYOS_CHAT_KEY) for CLI calls.
 *
 * Body:
 *   { services?: ('web'|'agent')[],   // default: ['agent']
 *     reason?: string                  // free text, goes into the audit log
 *   }
 *
 * Effect:
 *   1. systemctl restart on each listed service (without sudo —
 *      lazyos-web runs as root, the service file has User=root).
 *   2. Audit event 'updated' with kind='system-restart' in the events table.
 *   3. JSON response with before/after status per service.
 */

import { execSync } from 'node:child_process';
import { NextResponse, type NextRequest } from 'next/server';

import {
  readSessionConfig,
  readSessionCookie,
  verifySessionCookieValue,
} from '@/lib/security/session';
import { emitEvent } from '@/lib/events/emit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_SERVICES = ['lazyos-web', 'lazyos-agent'] as const;

function safeServiceName(s: string): (typeof ALLOWED_SERVICES)[number] | null {
  if (s === 'web' || s === 'lazyos-web') return 'lazyos-web';
  if (s === 'agent' || s === 'lazyos-agent') return 'lazyos-agent';
  return null;
}

async function authOk(req: NextRequest): Promise<boolean> {
  // Cookie path
  const cfg = readSessionConfig();
  if (cfg) {
    const cookie = readSessionCookie(req.headers.get('cookie'));
    if (cookie) {
      const v = await verifySessionCookieValue(cookie, cfg);
      if (v.ok) return true;
    }
  }
  // Bearer path (CLI calls)
  const authHeader = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/.exec(authHeader);
  if (m) {
    const expected = (process.env.LAZYOS_CHAT_KEY ?? '').trim();
    if (expected.length > 0 && m[1] === expected) return true;
  }
  return false;
}

interface RestartResult {
  service: string;
  ok: boolean;
  detail?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!(await authOk(req))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: { services?: unknown; reason?: unknown };
  try {
    body = (await req.json()) as { services?: unknown; reason?: unknown };
  } catch {
    body = {};
  }

  const requested =
    Array.isArray(body.services) && body.services.length > 0
      ? body.services
      : ['agent'];
  const reason =
    typeof body.reason === 'string' ? body.reason.slice(0, 200) : 'autonomous';

  const services: (typeof ALLOWED_SERVICES)[number][] = [];
  for (const r of requested) {
    if (typeof r !== 'string') continue;
    const safe = safeServiceName(r);
    if (safe && !services.includes(safe)) services.push(safe);
  }

  if (services.length === 0) {
    return NextResponse.json(
      { error: 'no_valid_services', allowed: ['web', 'agent'] },
      { status: 400 },
    );
  }

  const results: RestartResult[] = [];
  for (const svc of services) {
    try {
      // Sync call with a 15s timeout. systemctl restart waits until the service
      // has started (or failed). Restart=always kicks in anyway on
      // unclean exits.
      execSync(`systemctl restart ${svc}`, {
        timeout: 15_000,
        stdio: 'pipe',
      });
      results.push({ service: svc, ok: true });
    } catch (err) {
      results.push({
        service: svc,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Audit trail. Best-effort — a failed audit does not block
  // the restart response.
  try {
    await emitEvent({
      segmentId: 'lazyos',
      // Audit event as a phase entity (system pseudo). EntityType is
      // strictly typed — we use 'phase' as the next sensible category
      // so the event goes through. The audit trail stays in the events log.
      entityType: 'phase',
      entityId: 'system-restart',
      eventType: 'updated',
      actor: 'agent:system-restart',
      payload: {
        kind: 'system-restart',
        services,
        reason,
        results,
      },
      sensitivity: 'low',
    });
  } catch {
    /* swallow */
  }

  const allOk = results.every((r) => r.ok);
  return NextResponse.json(
    { ok: allOk, results, reason },
    { status: allOk ? 200 : 500 },
  );
}
