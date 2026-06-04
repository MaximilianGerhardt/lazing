/**
 * GET /api/subchats/external/[token]/media/[artifactId]  — serve attachment
 *
 * Token-gated media serving for external guests (no login). Security
 * boundary: the artifact MUST be referenced in exactly this sub-chat (whether
 * uploaded externally or by the team) — otherwise 404. Streams the raw bytes.
 * `?download=1` forces a download instead of inline display.
 * Public route (middleware PUBLIC_PREFIXES `/api/subchats/external/`).
 *
 * Gathering-Intelligence goal (2026-06-02).
 */

import { type NextRequest } from 'next/server';

import { CloudError, streamArtifactUnchecked } from '@/lib/cloud/service';
import { resolveExternalToken, subchatReferencesArtifact } from '@/lib/subchats/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Only these types may be displayed inline; everything else → download. */
const INLINE_SAFE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']);

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ token: string; artifactId: string }> },
): Promise<Response> {
  const { token, artifactId } = await ctx.params;
  const sc = resolveExternalToken(token);
  if (!sc) return new Response('not found', { status: 404 });
  // Security boundary: only media that belongs to THIS sub-chat.
  if (!subchatReferencesArtifact(sc.id, artifactId)) {
    return new Response('not found', { status: 404 });
  }
  try {
    const { row, stream } = await streamArtifactUnchecked(artifactId);
    // Defense-in-depth: the artifact MUST belong to the sub-chat's workspace
    // (streamArtifactUnchecked bypasses the membership check on purpose).
    if (row.workspaceId !== sc.workspaceId) {
      return new Response('not found', { status: 404 });
    }
    const mime = row.mime || 'application/octet-stream';
    const inlineSafe = INLINE_SAFE.has(mime);
    const forceDownload = req.nextUrl.searchParams.get('download') === '1' || !inlineSafe;
    const headers: Record<string, string> = {
      'Content-Type': mime,
      'Cache-Control': 'private, max-age=300, no-transform',
      // Hardening: no MIME sniffing, sandboxed, no referer leak of the token.
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
