/**
 * GET  /api/push/rules
 *   Lists all PUSH_RULES + their current override status.
 *   Response: { rules: [{ id, defaultPriority, level, locked, enabled }] }
 *   - enabled = level !== 'silent'
 *
 * PATCH /api/push/rules
 *   Body: { ruleId: string, enabled: boolean }
 *   Sets level='silent' + locked=1 when enabled=false (user explicitly
 *   turns the rule off). Sets locked=0 (clears the pin) when
 *   enabled=true — the decay algorithm takes over again.
 *
 * Authentication: OPEN (MVP, single-user).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { pushRuleOverrides } from '@/db/schema/push_rule_overrides';
import { PUSH_RULES } from '@/lib/push/rules';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RuleStatus {
  id: string;
  defaultPriority: 'p0' | 'p1' | 'p2';
  level: string;
  locked: boolean;
  enabled: boolean;
}

export async function GET(): Promise<NextResponse> {
  try {
    const db = getDb();
    const overrides = await db.select().from(pushRuleOverrides);
    const overrideMap = new Map(overrides.map((o) => [o.ruleId, o]));
    const rules: RuleStatus[] = PUSH_RULES.map((r) => {
      const ov = overrideMap.get(r.id);
      const level = ov?.level ?? r.priority ?? 'p1';
      const locked = ov?.locked === 1;
      return {
        id: r.id,
        defaultPriority: r.priority ?? 'p1',
        level,
        locked,
        enabled: level !== 'silent',
      };
    });
    return NextResponse.json({ rules }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'list failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

interface PatchBody {
  ruleId?: unknown;
  enabled?: unknown;
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  const body = json as PatchBody;
  if (typeof body.ruleId !== 'string' || typeof body.enabled !== 'boolean') {
    return NextResponse.json(
      { ok: false, error: 'ruleId (string) + enabled (boolean) required' },
      { status: 400 },
    );
  }
  const rule = PUSH_RULES.find((r) => r.id === body.ruleId);
  if (!rule) {
    return NextResponse.json({ ok: false, error: 'unknown ruleId' }, { status: 404 });
  }

  try {
    const db = getDb();
    const now = Date.now();
    const existing = await db
      .select()
      .from(pushRuleOverrides)
      .where(eq(pushRuleOverrides.ruleId, body.ruleId))
      .limit(1);
    const prev = existing[0];
    const newLevel = body.enabled ? (rule.priority ?? 'p1') : 'silent';
    const newLocked = body.enabled ? 0 : 1;
    const newRow = {
      ruleId: body.ruleId,
      level: newLevel,
      locked: newLocked,
      reason: body.enabled ? 'manual-enabled' : 'manual-disabled',
      prevLevel: prev?.level ?? rule.priority ?? 'p1',
      decayedAt: now,
      decayedUntil: null,
    };
    if (prev) {
      await db
        .update(pushRuleOverrides)
        .set(newRow)
        .where(eq(pushRuleOverrides.ruleId, body.ruleId));
    } else {
      await db.insert(pushRuleOverrides).values(newRow);
    }
    return NextResponse.json({
      ok: true,
      rule: {
        id: body.ruleId,
        level: newLevel,
        locked: newLocked === 1,
        enabled: body.enabled,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'update failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
