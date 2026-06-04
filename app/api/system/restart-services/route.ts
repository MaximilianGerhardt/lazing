/**
 * POST /api/system/restart-services
 *
 * Phase AR · 2026-04-28. Controlled-Restart-API für autonome Service-
 * Refreshes durch den Root-Chat-Agent (claude-CLI per Bash). Memory-Pin
 * lockert "feedback_never_delete_without_permission.md" mit Service-
 * Restart-Whitelist — diese Route ist der konventionelle Pfad damit jede
 * Restart-Aktion einen Audit-Trail hinterlässt.
 *
 * Auth: Cookie-Session ODER Bearer (LAZYOS_CHAT_KEY) für CLI-Aufrufe.
 *
 * Body:
 *   { services?: ('web'|'agent')[],   // default: ['agent']
 *     reason?: string                  // freitext, geht in audit-log
 *   }
 *
 * Wirkung:
 *   1. systemctl restart auf jeden gelisteten Service (ohne sudo —
 *      lazyos-web läuft als root, Service-File hat User=root).
 *   2. Audit-Event 'updated' mit kind='system-restart' in events-Tabelle.
 *   3. JSON-Response mit before/after-Status pro Service.
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
  // Cookie-Pfad
  const cfg = readSessionConfig();
  if (cfg) {
    const cookie = readSessionCookie(req.headers.get('cookie'));
    if (cookie) {
      const v = await verifySessionCookieValue(cookie, cfg);
      if (v.ok) return true;
    }
  }
  // Bearer-Pfad (CLI-Aufrufe)
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
      // Sync-Call mit 15s timeout. systemctl restart wartet bis Service
      // gestartet ist (oder Fail). Restart=always greift sowieso bei
      // unsauberen Exits.
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

  // Audit-Trail. Best-effort — eine fehlgeschlagene Audit blockt nicht
  // den Restart-Response.
  try {
    await emitEvent({
      segmentId: 'lazyos',
      // Audit-Event als phase-Entity (system-Pseudo). EntityType ist
      // strict typed — wir nutzen 'phase' als nächste sinnvolle Kategorie
      // damit das Event durchgeht. Audit-Trail bleibt im events-Log.
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
