/**
 * GET /api/quota/tpm-status
 *
 * Phase QA · 2026-04-28. TPM-Budget-Status für TopNav-Pill.
 * No-auth: Diagnose-Read, kein Secret. Wenn das System unter Last
 * ist, soll JEDER Tab den Status sehen können (auch ungetypter Caller).
 *
 * Response:
 *   { current, max, pct, level, recentSpawns, recommendedDelayMs }
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getDb } from '@/db/client';
import { getTpmStatus } from '@/lib/agents/tpm-budget';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { getClaudeMaxBinding } from '@/lib/users/repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  try {
    // Phase MU.4 — Wenn der eingeloggte User `claude_max_status='own'` hat,
    // zeigen wir seinen privaten TPM-Verbrauch (rolling 60s seiner eigenen
    // Spawns). Sonst: globale Sicht (shared MAX-Plan).
    const userId = currentUserIdResolved(req);
    let scope: 'shared' | 'own' = 'shared';
    let scopeUserId: string | null = null;
    if (userId) {
      const binding = getClaudeMaxBinding(userId);
      if (binding?.status === 'own') {
        scope = 'own';
        scopeUserId = userId;
      }
    }

    const status =
      scope === 'own'
        ? getTpmStatus(undefined, { userId: scopeUserId })
        : getTpmStatus();

    // Sprint C (2026-04-29) — Top-Consumers (Sub-Workstreams) der letzten 60s.
    // Quelle: workstreams-Rows die im Window upgedated wurden, sortiert nach
    // tokens_in+tokens_out DESC. Cap 3.
    const topConsumers = computeTopConsumers();

    return NextResponse.json(
      { ...status, scope, topConsumers },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (err) {
    return NextResponse.json(
      {
        error: 'tpm_status_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

interface TopConsumerRow {
  id: string;
  role: string | null;
  name: string;
  tokens_in: number;
  tokens_out: number;
  cost_cents_aggregated: number;
  workspace_id: string;
}

interface TopConsumer {
  id: string;
  role: string | null;
  name: string;
  tokens: number;
  costCents: number;
  workspaceId: string;
}

function computeTopConsumers(): TopConsumer[] {
  try {
    const db = getDb();
    const sixtySecAgo = Date.now() - 60_000;
    const rows = db.$raw
      .prepare(
        `SELECT id, role, name, tokens_in, tokens_out,
                cost_cents_aggregated, workspace_id
           FROM workstreams
          WHERE parent_workstream_id IS NOT NULL
            AND updated_at >= ?
            AND (tokens_in + tokens_out) > 0
          ORDER BY (tokens_in + tokens_out) DESC
          LIMIT 3`,
      )
      .all(sixtySecAgo) as TopConsumerRow[];
    return rows.map((r) => ({
      id: r.id,
      role: r.role,
      name: r.name,
      tokens: (r.tokens_in ?? 0) + (r.tokens_out ?? 0),
      costCents: r.cost_cents_aggregated ?? 0,
      workspaceId: r.workspace_id,
    }));
  } catch {
    return [];
  }
}
