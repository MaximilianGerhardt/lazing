/**
 * POST /api/skills/sync — alle Store-Skills erneut in die Engine-Verzeichnisse
 * verteilen (claude + codex). Auth: eingeloggt.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { currentUserIdResolved } from '@/lib/security/subject-server';
import { syncSkillsToEngines } from '@/lib/skills/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  if (!currentUserIdResolved(req)) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }
  const synced = syncSkillsToEngines().map((s) => ({
    engine: s.engine,
    dir: s.dir,
    linked: s.linked,
    skipped: s.skipped,
  }));
  return NextResponse.json({ synced }, { headers: { 'Cache-Control': 'no-store' } });
}
