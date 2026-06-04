/**
 * GET    /api/workspaces/[id]   — Workspace-Detail inkl. notes
 * PATCH  /api/workspaces/[id]   — Manuelles Update (label, description, notes,
 *                                  sensitivity)
 *
 * Auth: Cookie-Session (Middleware). Single-User-PWA, kein Bearer noetig.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getDb } from '@/db/client';
import { findUserOrgMembership } from '@/lib/orgs/repo';
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
import { currentSubject } from '@/lib/security/subject';
import { currentUserIdResolved } from '@/lib/security/subject-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ id: string }>;
}

interface WorkspaceRow {
  id: string;
  label: string;
  accent: string;
  path: string;
  sensitivity: string | null;
  archived: number | null;
  description: string | null;
  notes: string | null;
  notes_updated_at: number | null;
  notes_source: string | null;
  organization_id: string | null;
  logo_url: string | null;
  wordmark_url: string | null;
  brand_colors: string | null;
  brand_voice: string | null;
  email_signature: string | null;
  canonical_domain: string | null;
  created_at: number;
  updated_at: number;
}

function toApiShape(row: WorkspaceRow) {
  return {
    id: row.id,
    label: row.label,
    accent: row.accent,
    path: row.path,
    sensitivity: row.sensitivity ?? 'low',
    archived: Boolean(row.archived),
    description: row.description ?? null,
    notes: row.notes ?? null,
    notesUpdatedAt: row.notes_updated_at ?? null,
    notesSource: row.notes_source ?? null,
    organizationId: row.organization_id ?? null,
    logoUrl: row.logo_url ?? null,
    wordmarkUrl: row.wordmark_url ?? null,
    brandColors: row.brand_colors ? safeParseColors(row.brand_colors) : [],
    brandVoice: row.brand_voice ?? null,
    emailSignature: row.email_signature ?? null,
    canonicalDomain: row.canonical_domain ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeParseColors(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)).slice(0, 3);
  } catch {
    return [];
  }
}

export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  if (!isValidWorkspaceId(id)) {
    return NextResponse.json({ error: 'invalid_workspace_id' }, { status: 400 });
  }
  try {
    const db = getDb();
    const row = db.$raw
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .get(id) as WorkspaceRow | undefined;
    if (!row) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ workspace: toApiShape(row) });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'read_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

interface PatchBody {
  label?: unknown;
  description?: unknown;
  notes?: unknown;
  sensitivity?: unknown;
  accent?: unknown;
  organizationId?: unknown;
  logoUrl?: unknown;
  wordmarkUrl?: unknown;
  brandColors?: unknown;
  brandVoice?: unknown;
  emailSignature?: unknown;
  canonicalDomain?: unknown;
}

/**
 * Phase OS.1 — Permission-Check für organizationId-Wechsel.
 *
 * Regel:
 *   - Set: User muss in Ziel-Org Mitglied mit role ∈ {founder, admin} sein.
 *   - Unset (null): User muss in der aktuellen Org Mitglied mit role ∈
 *     {founder, admin} sein. (Wenn Workspace heute ohne Org → trivially ok.)
 *   - Move: User muss in beiden Mitglied mit founder/admin sein.
 *
 * Editor + Member dürfen Inhalte bearbeiten, aber nicht die Org-Zuordnung —
 * das ist eine Struktur-Entscheidung.
 */
function canManageOrgLink(userId: string, orgId: string | null): boolean {
  if (!orgId) return true;
  const m = findUserOrgMembership(userId, orgId);
  if (!m) return false;
  return m.role === 'founder' || m.role === 'admin';
}

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  if (!isValidWorkspaceId(id)) {
    return NextResponse.json({ error: 'invalid_workspace_id' }, { status: 400 });
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // Phase MU.5 — Content-Permission-Check (≥ member).
  // Service-Subjects (agent:cli, system:bridge) bleiben durch — die haben
  // bereits ihre eigenen Bearer-Gates auf Middleware-Ebene.
  const subj = currentSubject(req);
  if (subj.kind === 'user') {
    const resolvedUserId = currentUserIdResolved(req);
    if (resolvedUserId) {
      const role = getEffectiveWorkspaceRole(resolvedUserId, id);
      if (!canEditWorkspaceContent(role)) {
        return NextResponse.json(
          {
            error: 'forbidden',
            hint: 'Du hast keine Berechtigung diesen Workspace zu bearbeiten.',
          },
          { status: 403 },
        );
      }
    }
  }

  const updates: string[] = [];
  const values: (string | number | null)[] = [];
  const now = Date.now();

  if (typeof body.label === 'string' && body.label.trim().length > 0) {
    updates.push('label = ?');
    values.push(body.label.trim().slice(0, 120));
  }
  if (body.description === null || body.description === '') {
    updates.push('description = NULL');
  } else if (typeof body.description === 'string') {
    updates.push('description = ?');
    values.push(body.description.trim().slice(0, 240));
  }
  if (body.notes === null || body.notes === '') {
    updates.push('notes = NULL');
    updates.push('notes_updated_at = NULL');
    updates.push('notes_source = NULL');
  } else if (typeof body.notes === 'string') {
    updates.push('notes = ?');
    updates.push('notes_updated_at = ?');
    updates.push('notes_source = ?');
    values.push(body.notes.slice(0, 50_000));
    values.push(now);
    values.push('manual');
  }
  if (typeof body.sensitivity === 'string' &&
      ['low', 'normal', 'high'].includes(body.sensitivity)) {
    updates.push('sensitivity = ?');
    values.push(body.sensitivity);
  }
  if (typeof body.accent === 'string') {
    updates.push('accent = ?');
    values.push(body.accent);
  }

  // Phase OS.1 — Org-Zuordnung mit Permission-Check.
  if (body.organizationId !== undefined) {
    const userId = currentUserIdResolved(req);
    if (!userId) {
      return NextResponse.json(
        { error: 'auth-required', hint: 'Org-Zuordnung erfordert Login.' },
        { status: 401 },
      );
    }

    // Phase IA.6 — Orphan-Verbot: organizationId DARF NICHT mehr null sein.
    // Wer einen WS „entkoppeln" will, archiviert ihn oder verschiebt ihn
    // in eine andere Org. Versuche null zu setzen → 400.
    if (body.organizationId === null || body.organizationId === '') {
      return NextResponse.json(
        {
          error: 'orphan-forbidden',
          hint: 'Workspaces müssen einer Organisation zugeordnet sein. Verschiebe in eine andere Org oder archiviere.',
        },
        { status: 400 },
      );
    }
    const newOrgId =
      typeof body.organizationId === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(body.organizationId)
        ? body.organizationId
        : undefined;
    if (newOrgId === undefined) {
      return NextResponse.json(
        { error: 'invalid-organization-id', hint: 'organizationId muss valider slug sein' },
        { status: 400 },
      );
    }

    const db = getDb();
    const currentRow = db.$raw
      .prepare('SELECT organization_id FROM workspaces WHERE id = ?')
      .get(id) as { organization_id: string | null } | undefined;
    if (!currentRow) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    const currentOrg = currentRow.organization_id;

    if (!canManageOrgLink(userId, newOrgId)) {
      return NextResponse.json(
        {
          error: 'forbidden',
          hint: 'Du musst founder/admin der Ziel-Org sein.',
        },
        { status: 403 },
      );
    }
    if (currentOrg && currentOrg !== newOrgId && !canManageOrgLink(userId, currentOrg)) {
      return NextResponse.json(
        {
          error: 'forbidden',
          hint: 'Du musst founder/admin der aktuellen Org sein um den Workspace zu lösen.',
        },
        { status: 403 },
      );
    }

    updates.push('organization_id = ?');
    values.push(newOrgId);
  }

  // Brand-Felder (Phase 2026-04-25, Business-Branding pro Workspace)
  if (body.logoUrl === null || body.logoUrl === '') {
    updates.push('logo_url = NULL');
  } else if (typeof body.logoUrl === 'string' && /^https?:\/\//.test(body.logoUrl)) {
    updates.push('logo_url = ?');
    values.push(body.logoUrl.slice(0, 500));
  }
  if (body.wordmarkUrl === null || body.wordmarkUrl === '') {
    updates.push('wordmark_url = NULL');
  } else if (typeof body.wordmarkUrl === 'string' && /^https?:\/\//.test(body.wordmarkUrl)) {
    updates.push('wordmark_url = ?');
    values.push(body.wordmarkUrl.slice(0, 500));
  }
  if (Array.isArray(body.brandColors)) {
    const valid = body.brandColors
      .filter((c): c is string => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c))
      .slice(0, 3);
    updates.push('brand_colors = ?');
    values.push(valid.length > 0 ? JSON.stringify(valid) : null);
  }
  if (body.brandVoice === null || body.brandVoice === '') {
    updates.push('brand_voice = NULL');
  } else if (typeof body.brandVoice === 'string') {
    updates.push('brand_voice = ?');
    values.push(body.brandVoice.slice(0, 20_000));
  }
  if (body.emailSignature === null || body.emailSignature === '') {
    updates.push('email_signature = NULL');
  } else if (typeof body.emailSignature === 'string') {
    updates.push('email_signature = ?');
    values.push(body.emailSignature.slice(0, 5000));
  }
  if (body.canonicalDomain === null || body.canonicalDomain === '') {
    updates.push('canonical_domain = NULL');
  } else if (typeof body.canonicalDomain === 'string') {
    updates.push('canonical_domain = ?');
    values.push(body.canonicalDomain.trim().slice(0, 200));
  }

  if (updates.length === 0) {
    return NextResponse.json({ error: 'no_updates' }, { status: 400 });
  }

  updates.push('updated_at = ?');
  values.push(now);
  values.push(id);

  try {
    const db = getDb();
    const sql = `UPDATE workspaces SET ${updates.join(', ')} WHERE id = ?`;
    db.$raw.prepare(sql).run(...values);
    const row = db.$raw
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .get(id) as WorkspaceRow | undefined;
    if (!row) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ workspace: toApiShape(row) });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'update_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

function isValidWorkspaceId(id: string): boolean {
  return /^[a-z0-9_(][a-z0-9_()-]{0,63}$/i.test(id);
}
