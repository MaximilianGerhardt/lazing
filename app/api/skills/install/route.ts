/**
 * POST /api/skills/install — einen Skill installieren (lokal/Git) + cross-engine syncen.
 *   Body: { source: string }  (Pfad ODER owner/repo[/unterpfad] ODER git-URL)
 *
 * Auth: eingeloggt (Owner). Führt server-seitig ggf. git clone aus.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { currentUserIdResolved } from '@/lib/security/subject-server';
import { installSkill, SkillInstallError } from '@/lib/skills/install';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

export async function POST(req: NextRequest): Promise<Response> {
  if (!currentUserIdResolved(req)) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }
  let body: { source?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid-json' }, { status: 400 });
  }
  const source = (body.source ?? '').trim();
  if (!source) {
    return NextResponse.json({ error: 'missing-source' }, { status: 400 });
  }
  try {
    const res = await installSkill(source);
    return NextResponse.json(
      {
        installed: res.installed,
        synced: res.sync.map((s) => ({ engine: s.engine, linked: s.linked, skipped: s.skipped })),
      },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    const status = err instanceof SkillInstallError ? 400 : 500;
    return NextResponse.json(
      { error: 'install-failed', message: err instanceof Error ? err.message : 'unknown' },
      { status },
    );
  }
}
