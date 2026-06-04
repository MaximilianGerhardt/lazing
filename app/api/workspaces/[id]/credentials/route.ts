/**
 * GET    /api/workspaces/[id]/credentials       — Liste mit masked-preview
 * GET    /api/workspaces/[id]/credentials?reveal=<credId>
 *                                                — einzelner Klartext
 * POST   /api/workspaces/[id]/credentials       — { name, value, description }
 * DELETE /api/workspaces/[id]/credentials/<credId> — eigene Route weiter unten
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
 * Defense-in-depth Cross-Org-Check (Security-Critic M-1).
 *
 * Bei isolierten Workspaces (credential_isolation='isolated') darf NUR ein
 * tatsächliches Mitglied der zugehörigen Org Credentials lesen/revealen —
 * unabhängig vom (potenziell mehrdeutigen) getEffectiveWorkspaceRole bei
 * Multi-Org-Membership. Liefert true wenn der Kontext PASST (Zugriff ok),
 * false wenn er NICHT passt (→ Route gibt 403).
 *
 * Wenn der Workspace zu KEINER Org gehört → kein Org-Kontext zu prüfen → ok.
 * Wenn nicht isoliert → dieser Extra-Gate greift nicht (return true).
 *
 * credential_isolation wird FAIL-CLOSED gelesen: nur explizit 'inherit' gilt
 * als nicht-isoliert; fehlende Spalte/null/garbage → isoliert (strenger Check).
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
    // Spalte fehlt (ACL-3 nicht gelandet) → fail-closed: behandeln wie isoliert.
    isolationRaw = null;
  }
  const isolated = isolationRaw !== 'inherit';
  if (!isolated) return true; // 'inherit' → kein verschärfter Org-Check.

  const org = findOrgForWorkspace(wsId);
  if (!org) return true; // org-loser Workspace → kein Org-Kontext zu prüfen.

  // Isolierter Org-Workspace: User MUSS Mitglied genau dieser Org sein.
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
  // Auth-Gate (schließt bestehende Lücke — Vorlage: link-repo/route.ts).
  // GET reveal und GET listing offenbaren verschlüsselte Werte → mindestens member.
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

  // M-1: Defense-in-depth Cross-Org-Check für isolierte Workspaces.
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
        // M-2: Decrypt-Detail (AES-Tag-Mismatch etc.) NIEMALS ans Frontend —
        // das ist Info-Disclosure. Nur generischer Fehler raus, Detail ins Log.
        console.error(
          `[credentials] decrypt_failed cred=${reveal} ws=${wsId}:`,
          err instanceof Error ? err.message : String(err),
        );
        // L-1: fehlgeschlagener Reveal-Versuch wird auch audit-iert (N8).
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
      // L-1: jede Klartext-Offenbarung schreibt eine 'reveal'-Audit-Row (N8).
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
  // Auth-Gate: POST schreibt Credentials → mindestens member.
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

  // M-1: Defense-in-depth Cross-Org-Check für isolierte Workspaces.
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
