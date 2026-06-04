/**
 * /api/cloud/[id]/preview
 *
 * GET — inline stream for browser preview. Identical to /api/cloud/[id]
 * but with `Content-Disposition: inline` instead of `attachment`. The frontend
 * embeds this in an iframe or pdf.js viewer.
 */

import { NextResponse, type NextRequest } from "next/server";

import { resolveActor } from "@/lib/cloud/actor";
import { CloudError, streamArtifact, writeAudit } from "@/lib/cloud/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * MIME whitelist for inline preview. Only these mime types may be
 * served with `Content-Disposition: inline` — anything else
 * would execute same-origin in the browser (HTML/SVG → XSS, JS
 * shenanigans). Whitelist misses get `attachment` + octet-stream,
 * so the browser does not render but downloads.
 */
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
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const actor = resolveActor(req);
  const ip = req.headers.get("x-forwarded-for") ?? null;
  const ua = req.headers.get("user-agent") ?? null;

  try {
    const { row, stream } = await streamArtifact(id, actor, {
      ip,
      userAgent: ua,
    });
    // Audit as "preview" additionally, so the audit log distinguishes the
    // read pattern (download vs preview render).
    writeAudit({
      workspaceId: row.workspaceId,
      artifactId: row.id,
      action: "preview",
      actor,
      ip,
      userAgent: ua,
    });
    const inlineSafe = PREVIEW_INLINE_WHITELIST.has(row.mime);
    const safeMime = inlineSafe ? row.mime : "application/octet-stream";
    const disposition = inlineSafe
      ? `inline; filename="${encodeRFC5987(row.filename)}"`
      : `attachment; filename="${encodeRFC5987(row.filename)}"`;

    return new Response(stream as unknown as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": safeMime,
        "Content-Length": String(row.bytes),
        "Content-Disposition": disposition,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    if (err instanceof CloudError) {
      const status =
        err.code === "artifact-not-found" || err.code === "workspace-not-found"
          ? 404
          : err.code === "sensitivity-blocked" || err.code === "archived-blocked"
            ? 403
            : 500;
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status },
      );
    }
    return NextResponse.json(
      { error: "internal", message: (err as Error).message },
      { status: 500 },
    );
  }
}

function encodeRFC5987(s: string): string {
  return encodeURIComponent(s)
    .replace(/['()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/\*/g, "%2A");
}
