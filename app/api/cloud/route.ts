/**
 * Cloud Collection API
 * --------------------
 *   GET  /api/cloud?workspace=<id>&folder=<id|root>      — list artifacts
 *   POST /api/cloud  (multipart/form-data: workspace, file, folder?, metadata?)
 *
 * Auth: Edge-Middleware-gated (Session-Cookie ODER Bearer). Kein Auth-Check
 * im Route-Handler nötig — wenn der Request ankommt, ist er authentisch.
 * Actor wird aus Header abgeleitet für Audit-Log.
 *
 * VPS-Only-Hinweis: Der File-Upload schreibt aufs lokale Filesystem
 * (VPS-Disk-Backend). Auf Vercel scheitert der Constructor mit
 * `StorageBackendError`. Damit gilt: Cloud-Routen MÜSSEN auf der VPS-
 * Instanz laufen. Phase-N: Vercel-Edge-Stream-Proxy zur VPS.
 */

import { NextResponse, type NextRequest } from "next/server";

import {
  CloudError,
  listArtifacts,
  uploadArtifact,
} from "@/lib/cloud/service";
import { resolveActor } from "@/lib/cloud/actor";
import { getStorageBackend } from "@/lib/cloud/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ----------------------- GET (list) ----------------------- */

export async function GET(req: NextRequest): Promise<Response> {
  const sp = req.nextUrl.searchParams;
  const workspace = sp.get("workspace");
  const folderRaw = sp.get("folder");
  const limitRaw = sp.get("limit");

  if (!workspace) {
    return NextResponse.json(
      { error: "missing-workspace" },
      { status: 400 },
    );
  }

  const folderId =
    folderRaw === null
      ? undefined
      : folderRaw === "root" || folderRaw === ""
        ? null
        : folderRaw;

  const actor = resolveActor(req);
  const limit = limitRaw ? Math.min(Number(limitRaw) || 200, 1000) : 200;

  try {
    const rows = await listArtifacts(workspace, {
      folderId,
      actor,
      limit,
    });
    return NextResponse.json({
      workspace,
      folder: folderId ?? null,
      artifacts: rows.map(toApiShape),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/* ----------------------- POST (upload) ----------------------- */

/** Day-1 Hard-Cap: 50 MB per Upload. Phase-N: Stream-Upload via VPS-Bridge. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export async function POST(req: NextRequest): Promise<Response> {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.startsWith("multipart/form-data")) {
    return NextResponse.json(
      {
        error: "expected-multipart",
        hint: "POST mit multipart/form-data: file=<File>, workspace=<id>",
      },
      { status: 415 },
    );
  }

  // Pre-Check Content-Length BEVOR wir formData() lesen — sonst hätte ein
  // 5GB-Upload den Server schon RAM-allokiert bevor wir 413 schicken können.
  const contentLengthRaw = req.headers.get("content-length");
  if (contentLengthRaw) {
    const cl = Number(contentLengthRaw);
    if (Number.isFinite(cl) && cl > MAX_UPLOAD_BYTES + 64 * 1024) {
      return NextResponse.json(
        { error: "file-too-large", maxBytes: MAX_UPLOAD_BYTES },
        { status: 413 },
      );
    }
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return NextResponse.json(
      { error: "form-parse-failed", message: (err as Error).message },
      { status: 400 },
    );
  }

  const workspace = String(form.get("workspace") ?? "").trim();
  const folder = form.get("folder");
  const folderId =
    folder === null || folder === "" || folder === "root"
      ? null
      : String(folder);
  const file = form.get("file");

  if (!workspace) {
    return NextResponse.json(
      { error: "missing-workspace" },
      { status: 400 },
    );
  }
  if (!(file instanceof Blob)) {
    return NextResponse.json(
      { error: "missing-file", hint: "form-field 'file' (Blob)" },
      { status: 400 },
    );
  }

  const filename = (file as File).name ?? "upload.bin";
  const mime = file.type || "application/octet-stream";
  const buffer = Buffer.from(await file.arrayBuffer());

  if (buffer.byteLength === 0) {
    return NextResponse.json({ error: "empty-file" }, { status: 400 });
  }
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: "file-too-large", maxBytes: MAX_UPLOAD_BYTES },
      { status: 413 },
    );
  }

  const actor = resolveActor(req);

  let metadata: Record<string, unknown> | undefined;
  const metaRaw = form.get("metadata");
  if (typeof metaRaw === "string" && metaRaw.length > 0) {
    try {
      metadata = JSON.parse(metaRaw);
    } catch {
      return NextResponse.json(
        { error: "invalid-metadata", hint: "metadata muss valid JSON sein" },
        { status: 400 },
      );
    }
  }

  try {
    const row = await uploadArtifact({
      workspaceId: workspace,
      filename,
      mime,
      data: buffer,
      folderId,
      createdBy: actor,
      metadata,
    });
    return NextResponse.json({ artifact: toApiShape(row) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

/* ----------------------- helpers ----------------------- */

function toApiShape(
  row: import("@/db/schema/cloud").CloudArtifactRow,
): Record<string, unknown> {
  // Absoluter Pfad für den Agent-Prompt (`[Angehängt: <abs-pfad>]`), damit
  // der Agent das File per Read/Vision nutzen kann. Nur unverschlüsselte
  // Artefakte (encryptionVersion=0) liegen plain auf der Disk; verschlüsselte
  // haben keinen direkt-lesbaren Pfad → absPath bleibt null.
  let absPath: string | null = null;
  if (row.encryptionVersion === 0) {
    try {
      const backend = getStorageBackend();
      absPath = backend.absolutePath?.(row.storagePath) ?? null;
    } catch {
      absPath = null;
    }
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    folderId: row.folderId,
    filename: row.filename,
    mime: row.mime,
    bytes: row.bytes,
    sha256: row.sha256,
    pages: row.pages,
    encryptionVersion: row.encryptionVersion,
    metadata: row.metadata ? safeJson(row.metadata) : null,
    createdBy: row.createdBy,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
    storagePath: row.storagePath,
    absPath,
    downloadUrl: `/api/cloud/${row.id}`,
    previewUrl: `/api/cloud/${row.id}/preview`,
    thumbnailUrl: `/api/cloud/${row.id}/thumb`,
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof CloudError) {
    const status =
      err.code === "workspace-not-found" || err.code === "artifact-not-found"
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
  console.error("[/api/cloud] unexpected error:", err);
  return NextResponse.json(
    {
      error: "internal",
      message: err instanceof Error ? err.message : "unknown",
    },
    { status: 500 },
  );
}
