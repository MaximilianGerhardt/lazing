/**
 * GET /api/sops — list active (non-archived) SOPs for the SOP picker.
 *
 * SP-10 (2026-06-05): the "Mitarbeiter anlegen" customize path replaces the
 * free-text "Pflicht-SOPs" CSV field with a curated multi-select. This route
 * exposes the SOP registry (lib/sop/registry.listSops) as a small list.
 *
 * Returns global SOPs (workspace_id IS NULL) always, plus workspace-scoped SOPs
 * when `?workspaceId=…` is passed (registry handles the scope filter). Steps are
 * NOT included — the picker only needs id/name/description.
 *
 * Auth: logged in.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { listSops } from '@/lib/sop/registry';
import { currentUserIdResolved } from '@/lib/security/subject-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface SopListItem {
  /** SOP id — the value sent back in the profile's sops[]. */
  id: string;
  name: string;
  description: string | null;
  builtIn: boolean;
}

export async function GET(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) return NextResponse.json({ error: 'auth-required' }, { status: 401 });

  const workspaceId = req.nextUrl.searchParams.get('workspaceId') ?? undefined;

  const rows = listSops(workspaceId);
  const sops: SopListItem[] = rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description ?? null,
      builtIn: Boolean(r.builtIn),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json(
    { sops },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
