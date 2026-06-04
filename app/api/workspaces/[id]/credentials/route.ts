/**
 * GET    /api/workspaces/[id]/credentials       — list with masked preview
 * GET    /api/workspaces/[id]/credentials?reveal=<credId>
 *                                                — single plaintext value
 * POST   /api/workspaces/[id]/credentials       — { name, value, description }
 * DELETE /api/workspaces/[id]/credentials/<credId> — separate route further below
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getDb } from '@/db/client';
import {
  decryptCredential,
  encryptCredential,
  maskedPreview,
  newCredentialId,
} from '@/lib/security/credentials';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
import { findOrgForWorkspace, findUserOrgMembership } from '@/lib/orgs/repo';
import { recordRevealAudit } from '@/lib/credentials/vault';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Defense-in-depth cross-org check (Security-Critic M-1).
 *
 * For isolated workspaces (credential_isolation='isolated'), ONLY an
 * actual member of the associated org may read/reveal credentials —
 * independent of the (potentially ambiguous) getEffectiveWorkspaceRole under
 * multi-org membership. Returns true if the context FITS (access ok),
 * false if it does NOT fit (→ route returns 403).
 *
 * If the workspace belongs to NO org → no org context to check → ok.
 * If not isolated → this extra gate does not apply (return true).
 *
 * credential_isolation is read FAIL-CLOSED: only an explicit 'inherit' counts
 * as non-isolated; missing column/null/garbage → isolated (strict check).
 */
function passesOrgContextCheck(userId: string, wsId: string): boolean {
  const db = getDb();
  let isolationRaw: string | null = null;
  try {
    const row = db.$raw
      .prepare('SELECT credential_isolation FROM workspaces WHERE id = ? LIMIT 1')
      .get(wsId) as { credential_isolation?: string | null } | undefined;
    isolationRaw = row?.credential_isolation ?? null;
  } catch {
    // Column missing (ACL-3 not landed) → fail-closed: treat as isolated.
    isolationRaw = null;
  }
  const isolated = isolationRaw !== 'inherit';
  if (!isolated) return true; // 'inherit' → no tightened org check.

  const org = findOrgForWorkspace(wsId);
  if (!org) return true; // org-less workspace → no org context to check.

  // Isolated org workspace: the user MUST be a member of exactly this org.
  return findUserOrgMembership(userId, org.id) !== null;
}

interface Ctx {
  params: Promise<{ id: string }>;
}

interface CredRow {
  id: string;
  workspace_id: string;
  name: string;
  encrypted_value: string;
  description: string | null;
  created_at: number;
  updated_at: number;
  last_revealed_at: number | null;
}

function isValidWorkspaceId(id: string): boolean {
  return /^[a-z0-9_(][a-z0-9_()-]{0,63}$/i.test(id);
}

function isValidCredName(n: string): boolean {
  return /^[A-Z][A-Z0-9_]{0,127}$/.test(n);
}

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  // Auth gate (closes an existing gap — template: link-repo/route.ts).
  // GET reveal and GET listing expose encrypted values → at least member.
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }

  const { id: wsId } = await ctx.params;
  if (!isValidWorkspaceId(wsId)) {
    return NextResponse.json({ error: 'invalid_workspace_id' }, { status: 400 });
  }

  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, wsId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // M-1: defense-in-depth cross-org check for isolated workspaces.
  if (!passesOrgContextCheck(userId, wsId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const reveal = req.nextUrl.searchParams.get('reveal');

  try {
    const db = getDb();
    if (reveal) {
      const row = db.$raw
        .prepare(
          'SELECT * FROM workspace_credentials WHERE id = ? AND workspace_id = ?',
        )
        .get(reveal, wsId) as CredRow | undefined;
      if (!row) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }
      let plaintext: string;
      try {
        plaintext = decryptCredential(row.encrypted_value);
      } catch (err) {
        // M-2: NEVER send decrypt details (AES tag mismatch etc.) to the frontend —
        // that is info disclosure. Only a generic error goes out, the detail into the log.
        console.error(
          `[credentials] decrypt_failed cred=${reveal} ws=${wsId}:`,
          err instanceof Error ? err.message : String(err),
        );
        // L-1: a failed reveal attempt is also audited (N8).
        recordRevealAudit({
          scopeKind: 'workspace',
          scopeId: wsId,
          provider: row.name,
          userId,
          source: 'api.workspaces.credentials.reveal',
          success: false,
          reason: 'decrypt-error',
        });
        return NextResponse.json({ error: 'decrypt_failed' }, { status: 500 });
      }
      const now = Date.now();
      db.$raw
        .prepare(
          'UPDATE workspace_credentials SET last_revealed_at = ? WHERE id = ?',
        )
        .run(now, reveal);
      // L-1: every plaintext reveal writes a 'reveal' audit row (N8).
      recordRevealAudit({
        scopeKind: 'workspace',
        scopeId: wsId,
        provider: row.name,
        userId,
        source: 'api.workspaces.credentials.reveal',
        success: true,
        reason: 'revealed',
      });
      return NextResponse.json({
        credential: {
          id: row.id,
          name: row.name,
          value: plaintext,
          description: row.description ?? null,
        },
      });
    }

    const rows = db.$raw
      .prepare(
        'SELECT * FROM workspace_credentials WHERE workspace_id = ? ORDER BY name ASC',
      )
      .all(wsId) as CredRow[];
    const credentials = rows.map((r) => {
      let preview = '••••••';
      try {
        preview = maskedPreview(decryptCredential(r.encrypted_value));
      } catch {
        preview = 'Entschlüsseln fehlgeschlagen';
      }
      return {
        id: r.id,
        name: r.name,
        preview,
        description: r.description ?? null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        lastRevealedAt: r.last_revealed_at ?? null,
      };
    });
    return NextResponse.json({ credentials });
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

interface PostBody {
  name?: unknown;
  value?: unknown;
  description?: unknown;
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  // Auth gate: POST writes credentials → at least member.
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }

  const { id: wsId } = await ctx.params;
  if (!isValidWorkspaceId(wsId)) {
    return NextResponse.json({ error: 'invalid_workspace_id' }, { status: 400 });
  }

  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, wsId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // M-1: defense-in-depth cross-org check for isolated workspaces.
  if (!passesOrgContextCheck(userId, wsId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const value = typeof body.value === 'string' ? body.value : '';
  const description =
    typeof body.description === 'string' && body.description.trim().length > 0
      ? body.description.trim().slice(0, 500)
      : null;

  if (!isValidCredName(name)) {
    return NextResponse.json(
      {
        error: 'invalid_name',
        message: 'name muss UPPER_SNAKE_CASE sein, max 128 Zeichen',
      },
      { status: 400 },
    );
  }
  if (value.length === 0 || value.length > 50_000) {
    return NextResponse.json(
      { error: 'invalid_value', message: 'value: 1-50000 Zeichen' },
      { status: 400 },
    );
  }

  let encrypted: string;
  try {
    encrypted = encryptCredential(value);
  } catch (err) {
    return NextResponse.json(
      {
        error: 'encrypt_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 503 },
    );
  }

  try {
    const db = getDb();
    const now = Date.now();
    const existing = db.$raw
      .prepare(
        'SELECT id FROM workspace_credentials WHERE workspace_id = ? AND name = ?',
      )
      .get(wsId, name) as { id?: string } | undefined;

    if (existing?.id) {
      db.$raw
        .prepare(
          `UPDATE workspace_credentials
              SET encrypted_value = ?, description = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(encrypted, description, now, existing.id);
      return NextResponse.json({
        credential: { id: existing.id, name, description },
      });
    }
    const id = newCredentialId();
    db.$raw
      .prepare(
        `INSERT INTO workspace_credentials
           (id, workspace_id, name, encrypted_value, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, wsId, name, encrypted, description, now, now);
    return NextResponse.json(
      { credential: { id, name, description } },
      { status: 201 },
    );
  } catch (err) {
    return NextResponse.json(
      {
        error: 'write_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
