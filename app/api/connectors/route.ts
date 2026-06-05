/**
 * GET /api/connectors — list platform-global connector/MCP-server profiles.
 *
 * SP-10 (2026-06-05): the "Mitarbeiter anlegen" customize path needs a curated
 * MCP/connector picker instead of a free-text CSV field. This route exposes the
 * platform-global connector catalog (lib/connectors/catalog.listConnectors) as a
 * small, non-sensitive list.
 *
 * The catalog is platform-global by design (no workspace/org/user scope, see
 * db/schema/connectors.ts D1) — it carries only public API contracts, never
 * credentials. "Connected vs. needs-credential" is therefore PER WORKSPACE:
 * when the caller passes `?workspaceId=…`, each connector is enriched with a
 * `connected` flag via credentialExists(); without it the flag is null (unknown
 * at the global level). `authKind === 'none'` connectors never need a credential.
 *
 * Auth: logged in. No secrets are ever returned (catalog stores none; the
 * credential check returns only existence, never the secret).
 */

import { NextResponse, type NextRequest } from 'next/server';

import { listConnectors } from '@/lib/connectors/catalog';
import { credentialExists } from '@/lib/credentials/vault';
import { currentUserIdResolved } from '@/lib/security/subject-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface ConnectorListItem {
  /** Provider slug — the value sent back in the profile's mcpServers[]. */
  provider: string;
  displayName: string;
  description: string | null;
  /** 'api_key' | 'oauth' | 'pat' | 'none' | 'custom'. */
  authKind: string;
  /** True if this connector needs no credential at all (authKind 'none'). */
  needsCredential: boolean;
  /**
   * Per-workspace connection status:
   *   true  → a credential exists for this workspace (or via org fallback),
   *   false → no credential found,
   *   null  → not evaluated (no workspaceId passed, or authKind 'none').
   */
  connected: boolean | null;
}

export async function GET(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) return NextResponse.json({ error: 'auth-required' }, { status: 401 });

  const workspaceId = req.nextUrl.searchParams.get('workspaceId');

  const rows = listConnectors();
  const connectors: ConnectorListItem[] = rows
    .map((r) => {
      const needsCredential = r.authKind !== 'none';
      let connected: boolean | null = null;
      if (needsCredential && workspaceId) {
        try {
          connected = credentialExists(workspaceId, r.provider).exists;
        } catch {
          connected = null; // vault unavailable → leave unknown, never throw
        }
      } else if (!needsCredential) {
        connected = true; // 'none' auth → always usable
      }
      return {
        provider: r.provider,
        displayName: r.displayName,
        description: r.description ?? null,
        authKind: r.authKind,
        needsCredential,
        connected,
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  return NextResponse.json(
    { connectors },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
