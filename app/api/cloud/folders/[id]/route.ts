/**
 * PATCH /api/cloud/folders/[id]  { name }   — rename
 *
 * Day-1 nur Rename (im gleichen Parent). Move (parent-change) ist
 * Phase-N — erfordert rekursives materialized-path-Update mit Cycle-Check.
 */

import { NextResponse, type NextRequest } from "next/server";

import { resolveActor } from "@/lib/cloud/actor";
import { CloudError, renameFolder } from "@/lib/cloud/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const actor = resolveActor(req);
  let body: { name?: string };
  try {
    body = (await req.json()) as { name?: string };
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }
  if (!body.name || body.name.trim().length === 0) {
    return NextResponse.json({ error: "missing-name" }, { status: 400 });
  }
  try {
    const updated = await renameFolder({
      folderId: id,
      newName: body.name,
      actor,
    });
    return NextResponse.json({
      folder: {
        id: updated.id,
        name: updated.name,
        path: updated.path,
      },
    });
  } catch (err) {
    if (err instanceof CloudError) {
      const status =
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
    return NextResponse.json(
      { error: "internal", message: (err as Error).message },
      { status: 500 },
    );
  }
}
