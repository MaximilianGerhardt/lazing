/**
 * GET /api/subchats/[subchatId]/thumb/[artifactId]
 * Member-gegatete kleine Bild-Vorschau (256px cover) für die INTERNE Sub-Chat-Ansicht.
 * Sicherheitsgrenze: das Artifact muss in DIESEM Sub-Chat referenziert sein (N2).
 * Best-effort: non-image / sharp-fail → Original-Bytes streamen.
 * EXTERN ist NICHT hier — externe Gäste nutzen .../external/[token]/media (parallel session).
 *
 * Gathering-Intelligence-Goal (2026-06-02).
 */
import { type NextRequest } from 'next/server';
import sharp from 'sharp';

import { canEditWorkspaceContent, getEffectiveWorkspaceRole } from '@/lib/security/permissions';
import { hasRealWorkspaceMembership } from '@/lib/security/membership';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { CloudError, streamArtifactUnchecked } from '@/lib/cloud/service';
import { getSubchat, subchatReferencesArtifact } from '@/lib/subchats/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const THUMB_PX = 256;

async function bufferStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) {
    // Node-Streams liefern string ODER Buffer/Uint8Array — beide robust normalisieren.
    chunks.push(Buffer.isBuffer(c) ? c : typeof c === 'string' ? Buffer.from(c) : Buffer.from(c as Uint8Array));
  }
  return Buffer.concat(chunks);
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ subchatId: string; artifactId: string }> },
): Promise<Response> {
  const { subchatId, artifactId } = await ctx.params;
  if (!/^SC-[A-Za-z0-9]{1,40}$/.test(subchatId)) return new Response('bad request', { status: 400 });

  const sc = getSubchat(subchatId);
  if (!sc) return new Response('not found', { status: 404 });

  const userId = currentUserIdResolved(req);
  if (!userId) return new Response('auth-required', { status: 401 });
  const role = getEffectiveWorkspaceRole(userId, sc.workspaceId);
  if (!canEditWorkspaceContent(role) || !hasRealWorkspaceMembership(userId, sc.workspaceId)) {
    return new Response('forbidden', { status: 403 });
  }

  // N2-Grenze: das Artifact muss in DIESEM Sub-Chat hängen.
  if (!subchatReferencesArtifact(subchatId, artifactId)) {
    return new Response('not found', { status: 404 });
  }

  let row: import('@/db/schema/cloud').CloudArtifactRow;
  let raw: Buffer;
  try {
    const out = await streamArtifactUnchecked(artifactId);
    row = out.row;
    // Defense-in-depth: streamArtifactUnchecked umgeht Membership absichtlich.
    if (row.workspaceId !== sc.workspaceId) return new Response('not found', { status: 404 });
    raw = await bufferStream(out.stream);
  } catch (err) {
    if (err instanceof CloudError) return new Response('not found', { status: 404 });
    console.error('[subchat thumb] read', err);
    return new Response('error', { status: 500 });
  }

  const mime = row.mime || 'application/octet-stream';
  const isImage = mime.startsWith('image/') && mime !== 'image/svg+xml';

  // Best-effort: nur Bilder thumbnailen; sonst Original streamen.
  if (isImage) {
    try {
      const thumb = await sharp(raw)
        .rotate() // EXIF auto-orient
        .resize({ width: THUMB_PX, height: THUMB_PX, fit: 'cover', position: 'center' })
        .jpeg({ quality: 72 })
        .toBuffer();
      return new Response(thumb as unknown as ArrayBuffer, {
        status: 200,
        headers: {
          'Content-Type': 'image/jpeg',
          // Long cache: artifactId ist immutabel (content-addressed Upload).
          'Cache-Control': 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Referrer-Policy': 'no-referrer',
        },
      });
    } catch (err) {
      console.warn('[subchat thumb] sharp-fail, falling back to original:', err);
      // fall through to original-bytes fallback
    }
  }

  // Fallback: Original-Bytes (non-image ODER sharp-fail).
  return new Response(raw as unknown as ArrayBuffer, {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Referrer-Policy': 'no-referrer',
    },
  });
}
