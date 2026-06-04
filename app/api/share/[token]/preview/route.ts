/**
 * GET /api/share/[token]/preview
 *   PUBLIC. Inline-Preview wenn MIME whitelisted, sonst attachment-Fallback.
 */

import { NextResponse, type NextRequest } from "next/server";

import { writeAudit } from "@/lib/audit/write";
import {
  getEncryptedStorageBackend,
  getStorageBackend,
} from "@/lib/cloud/storage";
import { resolveAndConsumeShare, ShareError } from "@/lib/cloud/share";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PREVIEW_INLINE_WHITELIST = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "text/plain",
]);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const password =
    req.nextUrl.searchParams.get("password") ??
    req.headers.get("x-lazyos-share-password") ??
    null;
  const ip = req.headers.get("x-forwarded-for") ?? null;
  const ua = req.headers.get("user-agent") ?? null;

  let resolved;
  try {
    resolved = await resolveAndConsumeShare(token, { password });
  } catch (err) {
    if (err instanceof ShareError) {
      const status =
        err.code === "password-required" || err.code === "wrong-password"
          ? 401
          : err.code === "expired" || err.code === "view-cap-reached"
            ? 410
            : err.code === "revoked"
              ? 403
              : 404;
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status },
      );
    }
    throw err;
  }
  const { token: tokenRow, artifact } = resolved;

  const storage =
    artifact.encryptionVersion >= 1
      ? getEncryptedStorageBackend()
      : getStorageBackend();
  const stream = await storage.getStream(artifact.storagePath);

  const inlineSafe = PREVIEW_INLINE_WHITELIST.has(artifact.mime);
  const safeMime = inlineSafe ? artifact.mime : "application/octet-stream";
  const disposition = inlineSafe
    ? `inline; filename="${encodeRFC5987(artifact.filename)}"`
    : `attachment; filename="${encodeRFC5987(artifact.filename)}"`;

  writeAudit({
    actor: `anon-share-token:${tokenRow.id}`,
    action: "preview",
    workspaceId: artifact.workspaceId,
    artifactId: artifact.id,
    payload: { via: "share-token", shareTokenId: tokenRow.id },
    ip,
    userAgent: ua,
  });

  return new Response(stream as unknown as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": safeMime,
      "Content-Length": String(artifact.bytes),
      "Content-Disposition": disposition,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function encodeRFC5987(s: string): string {
  return encodeURIComponent(s)
    .replace(/['()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/\*/g, "%2A");
}
