/**
 * GET /api/agents/status
 *
 * BACKPORT-02 (2026-05-23) — Returns the live fleet roster. Pass
 * `?fleetId=…` to get a single fleet; otherwise returns the full list.
 *
 *   {
 *     "budget": { "heavyTotal": 2, "perKind": { ... } },
 *     "inflight": [ ... PoolSlot[] ],
 *     "fleets":   [ { fleetId, intentText, panes, updatedAt } ]
 *   }
 */

import { NextResponse } from 'next/server';

import { resourcePool } from '@/lib/agents';
import { getFleet, listFleets } from '@/lib/agents/fleet-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const fleetId = url.searchParams.get('fleetId');

  const budget = resourcePool.getBudget();
  const inflight = resourcePool.getInflight();

  if (fleetId) {
    const fleet = getFleet(fleetId);
    if (!fleet) {
      return NextResponse.json(
        { error: 'fleet-not-found', fleetId, budget, inflight, fleets: [] },
        { status: 404 },
      );
    }
    return NextResponse.json({ budget, inflight, fleets: [fleet] }, { status: 200 });
  }

  return NextResponse.json({ budget, inflight, fleets: listFleets() }, { status: 200 });
}
