/**
 * GET /api/skills/installed — list cross-engine skills (store).
 *
 * Lists the SKILL.md skills installed in the laz.ing skill store
 * (~/.lazyos/skills) and shows which engine directories they are synced into.
 * Auth: logged in.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { currentUserIdResolved } from '@/lib/security/subject-server';
import { getSkillsDir, listInstalledSkills } from '@/lib/skills/store';
import { engineSkillDir } from '@/lib/skills/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  if (!currentUserIdResolved(req)) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }
  const claudeDir = engineSkillDir('claude-cli');
  const codexDir = engineSkillDir('codex-cli');
  const skills = listInstalledSkills().map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    source: s.source ?? null,
    engines: {
      'claude-cli': existsSync(join(claudeDir, s.id)),
      'codex-cli': existsSync(join(codexDir, s.id)),
    },
  }));
  return NextResponse.json(
    { store: getSkillsDir(), engines: { 'claude-cli': claudeDir, 'codex-cli': codexDir }, skills },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
