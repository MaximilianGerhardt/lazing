/**
 * GET /api/share/[token]?password=...
 *   PUBLIC. Streamed das Artifact mit Content-Disposition: attachment.
 *   Password (optional) als Query-Param oder Header `x-lazyos-share-password`.
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

  // Bytes ausliefern — Encrypted-Backend wenn artifact encrypted ist.
  const storage =
    artifact.encryptionVersion >= 1
      ? getEncryptedStorageBackend()
      : getStorageBackend();
  const stream = await storage.getStream(artifact.storagePath);

  writeAudit({
    actor: `anon-share-token:${tokenRow.id}`,
    action: "download",
    workspaceId: artifact.workspaceId,
    artifactId: artifact.id,
    payload: {
      via: "share-token",
      shareTokenId: tokenRow.id,
      currentViews: tokenRow.currentViews + 1,
    },
    ip,
    userAgent: ua,
  });

  return new Response(stream as unknown as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": artifact.mime,
      "Content-Length": String(artifact.bytes),
      "Content-Disposition": `attachment; filename="${encodeRFC5987(artifact.filename)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}

function encodeRFC5987(s: string): string {
  return encodeURIComponent(s)
    .replace(/['()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/\*/g, "%2A");
}
