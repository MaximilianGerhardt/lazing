/**
 * /api/cloud/folders
 *   GET  ?workspace=<id>&parent=<id|root>  — list folders
 *   POST { workspace, name, parentId? }     — create folder
 */

import { NextResponse, type NextRequest } from "next/server";

import { resolveActor } from "@/lib/cloud/actor";
import {
  CloudError,
  createFolder,
  listFolders,
} from "@/lib/cloud/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sp = req.nextUrl.searchParams;
  const workspace = sp.get("workspace");
  const parentRaw = sp.get("parent");
  if (!workspace) {
    return NextResponse.json({ error: "missing-workspace" }, { status: 400 });
  }
  const parentId =
    parentRaw === null
      ? undefined
      : parentRaw === "root" || parentRaw === ""
        ? null
        : parentRaw;
  const actor = resolveActor(req);
  try {
    const rows = await listFolders(workspace, { parentId, actor });
    return NextResponse.json({
      workspace,
      parent: parentId ?? null,
      folders: rows.map(toShape),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: { workspace?: string; name?: string; parentId?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }
  if (!body.workspace || !body.name) {
    return NextResponse.json(
      { error: "missing-fields", required: ["workspace", "name"] },
      { status: 400 },
    );
  }
  const actor = resolveActor(req);
  try {
    const row = await createFolder({
      workspaceId: body.workspace,
      name: body.name,
      parentId: body.parentId ?? null,
      createdBy: actor,
    });
    return NextResponse.json({ folder: toShape(row) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

function toShape(
  row: import("@/db/schema/cloud").CloudFolderRow,
): Record<string, unknown> {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    parentId: row.parentId,
    name: row.name,
    path: row.path,
    createdBy: row.createdBy,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

function errorResponse(err: unknown): Response {
  if (err instanceof CloudError) {
    const status =
      err.code === "workspace-not-found" || err.code === "folder-not-found"
        ? 404
        : err.code === "validation"
          ? 400
          : err.code === "sensitivity-blocked" || err.code === "archived-blocked"
            ? 403
            : 500;
    return NextResponse.json(
      { error: err.code, message: err.message },
      { status },
    );
  }
  console.error("[/api/cloud/folders] unexpected error:", err);
  return NextResponse.json(
    { error: "internal", message: (err as Error).message },
    { status: 500 },
  );
}
