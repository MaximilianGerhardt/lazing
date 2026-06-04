/**
 * GET /api/subchats/external/[token]/media/[artifactId]  — Anhang ausliefern
 *
 * Token-gegatetes Media-Serving für externe Gäste (kein Login). Sicherheits-
 * grenze: das Artifact MUSS in genau diesem Sub-Chat referenziert sein (egal ob
 * extern oder vom Team hochgeladen) — sonst 404. Streamt die rohen Bytes.
 * `?download=1` erzwingt einen Download statt Inline-Anzeige.
 * Public-Route (middleware PUBLIC_PREFIXES `/api/subchats/external/`).
 *
 * Gathering-Intelligence-Goal (2026-06-02).
 */

import { type NextRequest } from 'next/server';

import { CloudError, streamArtifactUnchecked } from '@/lib/cloud/service';
import { resolveExternalToken, subchatReferencesArtifact } from '@/lib/subchats/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Nur diese Typen dürfen inline angezeigt werden; alles andere → Download. */
const INLINE_SAFE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']);

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ token: string; artifactId: string }> },
): Promise<Response> {
  const { token, artifactId } = await ctx.params;
  const sc = resolveExternalToken(token);
  if (!sc) return new Response('not found', { status: 404 });
  // Sicherheitsgrenze: nur Medien, die in DIESEM Sub-Chat hängen.
  if (!subchatReferencesArtifact(sc.id, artifactId)) {
    return new Response('not found', { status: 404 });
  }
  try {
    const { row, stream } = await streamArtifactUnchecked(artifactId);
    // Defense-in-depth: das Artifact MUSS zum Workspace des Sub-Chats gehören
    // (streamArtifactUnchecked umgeht den Membership-Check absichtlich).
    if (row.workspaceId !== sc.workspaceId) {
      return new Response('not found', { status: 404 });
    }
    const mime = row.mime || 'application/octet-stream';
    const inlineSafe = INLINE_SAFE.has(mime);
    const forceDownload = req.nextUrl.searchParams.get('download') === '1' || !inlineSafe;
    const headers: Record<string, string> = {
      'Content-Type': mime,
      'Cache-Control': 'private, max-age=300, no-transform',
      // Härtung: kein MIME-Sniffing, sandboxed, kein Referer-Leak des Tokens.
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Referrer-Policy': 'no-referrer',
    };
    if (forceDownload) {
      const safe = (row.filename || 'datei').replace(/["\\\r\n]/g, '_');
      headers['Content-Disposition'] = `attachment; filename="${safe}"`;
    }
    return new Response(stream as unknown as ReadableStream, { status: 200, headers });
  } catch (err) {
    if (err instanceof CloudError) return new Response('not found', { status: 404 });
    console.error('[subchat external media]', err);
    return new Response('error', { status: 500 });
  }
}
