/**
 * /api/cloud/[id]
 *   GET    — stream-download (Content-Disposition: attachment)
 *   PATCH  — rename / move (Phase ORG+4)
 *   DELETE — soft-delete via deletedAt timestamp
 */

import { NextResponse, type NextRequest } from "next/server";

import { resolveActor } from "@/lib/cloud/actor";
import {
  CloudError,
  deleteArtifact,
  moveArtifact,
  renameArtifact,
  streamArtifact,
} from "@/lib/cloud/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    return new Response(stream as unknown as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": row.mime,
        "Content-Length": String(row.bytes),
        "Content-Disposition": `attachment; filename="${encodeRFC5987(row.filename)}"`,
        "Cache-Control": "private, no-store",
        "X-Lazyos-Artifact-Id": row.id,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const actor = resolveActor(req);
  let body: { filename?: string; folderId?: string | null };
  try {
    body = (await req.json()) as { filename?: string; folderId?: string | null };
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }
  try {
    let updated;
    if (typeof body.filename === "string" && body.filename.trim().length > 0) {
      updated = await renameArtifact({
        artifactId: id,
        newFilename: body.filename,
        actor,
      });
    }
    if (Object.prototype.hasOwnProperty.call(body, "folderId")) {
      updated = await moveArtifact({
        artifactId: id,
        targetFolderId: body.folderId ?? null,
        actor,
      });
    }
    if (!updated) {
      return NextResponse.json(
        { error: "no-op", hint: "send 'filename' or 'folderId'" },
        { status: 400 },
      );
    }
    return NextResponse.json({
      artifact: {
        id: updated.id,
        filename: updated.filename,
        folderId: updated.folderId,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const actor = resolveActor(req);
  try {
    await deleteArtifact(id, actor);
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return errorResponse(err);
  }
}

function encodeRFC5987(s: string): string {
  return encodeURIComponent(s)
    .replace(/['()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/\*/g, "%2A");
}

function errorResponse(err: unknown): Response {
  if (err instanceof CloudError) {
    const status =
      err.code === "artifact-not-found" ||
      err.code === "workspace-not-found" ||
      err.code === "folder-not-found"
        ? 404
        : err.code === "validation"
          ? 400
          : err.code === "sensitivity-blocked" ||
              err.code === "archived-blocked"
            ? 403
            : 500;
    return NextResponse.json(
      { error: err.code, message: err.message },
      { status },
    );
  }
  console.error("[/api/cloud/[id]] unexpected error:", err);
  return NextResponse.json(
    {
      error: "internal",
      message: err instanceof Error ? err.message : "unknown",
    },
    { status: 500 },
  );
}
