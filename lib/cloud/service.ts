/**
 * Cloud-Service — DB-Operationen + Storage-Wrapper + Audit + Sensitivity-Floor.
 *
 * Single entry point for all cloud operations. API routes do not know
 * `getDb()` directly; they call service functions that always include the
 * audit entry and sensitivity check.
 */

import { createHash } from "node:crypto";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import {
  cloudArtifacts,
  cloudAudit,
  cloudFolders,
  type CloudArtifactRow,
  type CloudFolderRow,
} from "@/db/schema/cloud";
import { ulid } from "@/lib/ulid";
import { getWorkspace } from "@/lib/workspaces";

import {
  isValidWorkspaceId,
  sanitizeFilename,
  sanitizeFolderName,
} from "./sanitize";
import {
  canReadFromCloud,
  canWriteToCloud,
  type CloudWriteCheck,
} from "./sensitivity";
import { getStorageBackend, StorageNotFoundError } from "./storage";

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

// Re-export for other cloud modules (share.ts).
export type { CloudArtifactRow } from "@/db/schema/cloud";

export class CloudError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "workspace-not-found"
      | "artifact-not-found"
      | "folder-not-found"
      | "sensitivity-blocked"
      | "archived-blocked"
      | "validation",
  ) {
    super(message);
    this.name = "CloudError";
  }
}

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface UploadInput {
  workspaceId: string;
  filename: string;
  mime: string;
  data: Buffer;
  folderId?: string | null;
  createdBy: string;
  metadata?: Record<string, unknown>;
}

export interface AuditInput {
  workspaceId: string;
  artifactId?: string | null;
  folderId?: string | null;
  action:
    | "upload"
    | "download"
    | "preview"
    | "list"
    | "delete"
    | "move"
    | "rename"
    | "generate"
    | "thumbnail"
    | "create-folder"
    | "blocked-sensitivity"
    | "blocked-archived"
    | "blocked-not-found";
  actor: string;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

export function writeAudit(input: AuditInput): void {
  const db = getDb();
  const id = `AUD-${ulid()}`;
  const now = new Date();
  db.insert(cloudAudit)
    .values({
      id,
      workspaceId: input.workspaceId,
      artifactId: input.artifactId ?? null,
      folderId: input.folderId ?? null,
      action: input.action,
      actor: input.actor,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      at: now,
    })
    .run();
}

/* ------------------------------------------------------------------ */
/* Workspace-Guards                                                    */
/* ------------------------------------------------------------------ */

async function assertCanWrite(
  workspaceId: string,
  actor: string,
  ip?: string | null,
): Promise<{ requiresEncryption: boolean }> {
  const ws = await getWorkspace(workspaceId);
  if (!ws) {
    writeAudit({
      workspaceId,
      action: "blocked-not-found",
      actor,
      ip,
      metadata: { reason: "workspace-unknown" },
    });
    throw new CloudError(
      `Workspace ${workspaceId} nicht gefunden.`,
      "workspace-not-found",
    );
  }
  const check: CloudWriteCheck = canWriteToCloud(ws);
  if (!check.ok) {
    writeAudit({
      workspaceId,
      action:
        check.errorCode === "sensitivity-floor"
          ? "blocked-sensitivity"
          : "blocked-archived",
      actor,
      ip,
      metadata: { reason: check.reason ?? "blocked" },
    });
    throw new CloudError(
      check.reason ?? "Cloud-Schreibzugriff blockiert.",
      check.errorCode === "sensitivity-floor"
        ? "sensitivity-blocked"
        : "archived-blocked",
    );
  }
  return { requiresEncryption: !!check.requiresEncryption };
}

async function assertCanRead(
  workspaceId: string,
  actor: string,
  ip?: string | null,
): Promise<void> {
  const ws = await getWorkspace(workspaceId);
  if (!ws) {
    writeAudit({
      workspaceId,
      action: "blocked-not-found",
      actor,
      ip,
      metadata: { reason: "workspace-unknown" },
    });
    throw new CloudError(
      `Workspace ${workspaceId} nicht gefunden.`,
      "workspace-not-found",
    );
  }
  const check = canReadFromCloud(ws);
  if (!check.ok) {
    writeAudit({
      workspaceId,
      action: "blocked-archived",
      actor,
      ip,
      metadata: { reason: check.reason ?? "blocked" },
    });
    throw new CloudError(
      check.reason ?? "Cloud-Lesezugriff blockiert.",
      "archived-blocked",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Artifacts                                                           */
/* ------------------------------------------------------------------ */

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function uploadArtifact(
  input: UploadInput,
): Promise<CloudArtifactRow> {
  const writeCheck = await assertCanWrite(input.workspaceId, input.createdBy);

  const filename = sanitizeFilename(input.filename);
  if (!filename) {
    throw new CloudError("Filename leer oder ungültig.", "validation");
  }
  if (input.data.byteLength === 0) {
    throw new CloudError("Datei leer.", "validation");
  }
  if (input.folderId) {
    await assertFolderInWorkspace(input.workspaceId, input.folderId);
  }

  const id = `ART-${ulid()}`;
  const sha256 = sha256Hex(input.data);
  const storagePath = `${input.workspaceId}/${id}`;

  // Phase ORG+1: encrypting backend for sensitive workspaces.
  const storage = writeCheck.requiresEncryption
    ? (await import("./storage")).getEncryptedStorageBackend()
    : getStorageBackend();
  await storage.put(storagePath, input.data);
  const encryptionVersion = writeCheck.requiresEncryption ? 1 : 0;

  const pages = extractPdfPageCount(input.mime, input.data);
  const now = new Date();
  const db = getDb();
  // Best-effort rollback: if the DB insert throws (e.g. SQLite BUSY, schema
  // mismatch), we delete the just-written storage file again,
  // so no orphan byte block lies on disk. This closes the
  // half-write trap (GDPR-relevant on later sensitivity reclassification).
  try {
    db.insert(cloudArtifacts)
      .values({
        id,
        workspaceId: input.workspaceId,
        folderId: input.folderId ?? null,
        filename,
        mime: input.mime,
        bytes: input.data.byteLength,
        sha256,
        storagePath,
        encryptionVersion,
        pages: pages ?? null,
        thumbnailPath: null,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      })
      .run();
  } catch (dbErr) {
    await storage.delete(storagePath).catch(() => {
      /* best-effort, no nested throw */
    });
    throw dbErr;
  }

  writeAudit({
    workspaceId: input.workspaceId,
    artifactId: id,
    folderId: input.folderId ?? null,
    action: "upload",
    actor: input.createdBy,
    metadata: { bytes: input.data.byteLength, mime: input.mime, sha256 },
  });

  // Phase ORG+5: async thumbnail generation for unencrypted
  // image/* MIMEs. Skip for encrypted or non-image — the fallback stays
  // the SVG placeholder from the /thumb endpoint.
  try {
    const { generateThumbnailAsync } = await import("./thumbnails");
    generateThumbnailAsync(
      id,
      input.workspaceId,
      storagePath,
      input.mime,
      encryptionVersion,
    );
  } catch {
    /* thumbnail module missing? Let the upload through anyway. */
  }

  const row = getArtifactRowByIdRaw(id);
  if (!row) throw new CloudError("Insert verloren.", "validation");
  return row;
}

export async function getArtifact(
  id: string,
  actor: string,
): Promise<CloudArtifactRow> {
  const row = getArtifactRowByIdRaw(id);
  if (!row || row.deletedAt) {
    throw new CloudError(`Artifact ${id} nicht gefunden.`, "artifact-not-found");
  }
  await assertCanRead(row.workspaceId, actor);
  return row;
}

function getArtifactRowByIdRaw(id: string): CloudArtifactRow | null {
  const db = getDb();
  const rows = db
    .select()
    .from(cloudArtifacts)
    .where(eq(cloudArtifacts.id, id))
    .limit(1)
    .all();
  return rows[0] ?? null;
}

export async function streamArtifact(
  id: string,
  actor: string,
  audit: { ip?: string | null; userAgent?: string | null } = {},
): Promise<{ row: CloudArtifactRow; stream: NodeJS.ReadableStream }> {
  const row = await getArtifact(id, actor);
  // Phase ORG+1: at encryption_version >= 1 the encrypting backend is
  // used — it decrypts before the stream.
  const storage =
    row.encryptionVersion >= 1
      ? (await import("./storage")).getEncryptedStorageBackend()
      : getStorageBackend();
  let stream: NodeJS.ReadableStream;
  try {
    stream = await storage.getStream(row.storagePath);
  } catch (err) {
    if (err instanceof StorageNotFoundError) {
      throw new CloudError(
        `Artifact-Datei für ${id} fehlt im Storage.`,
        "artifact-not-found",
      );
    }
    throw err;
  }

  writeAudit({
    workspaceId: row.workspaceId,
    artifactId: row.id,
    action: "download",
    actor,
    ip: audit.ip ?? null,
    userAgent: audit.userAgent ?? null,
    metadata: { bytes: row.bytes },
  });

  return { row, stream };
}

/**
 * Stream without a membership check — ONLY for callers that perform their own
 * authorization (e.g. the token-gated sub-chat media endpoint:
 * there the security boundary is "the artifact is referenced in THIS sub-chat",
 * not workspace membership; external guests have no account). Returns the
 * raw bytes of the artifact. Throws if the artifact is missing/deleted.
 */
export async function streamArtifactUnchecked(
  id: string,
): Promise<{ row: CloudArtifactRow; stream: NodeJS.ReadableStream }> {
  const row = getArtifactRowByIdRaw(id);
  if (!row || row.deletedAt) {
    throw new CloudError(`Artifact ${id} nicht gefunden.`, "artifact-not-found");
  }
  const storage =
    row.encryptionVersion >= 1
      ? (await import("./storage")).getEncryptedStorageBackend()
      : getStorageBackend();
  try {
    const stream = await storage.getStream(row.storagePath);
    return { row, stream };
  } catch (err) {
    if (err instanceof StorageNotFoundError) {
      throw new CloudError(
        `Artifact-Datei für ${id} fehlt im Storage.`,
        "artifact-not-found",
      );
    }
    throw err;
  }
}

/**
 * Workspace of an artifact (unchecked) — for callers that validate attachment
 * references against the expected workspace (sub-chat attachments: an artifact may
 * only be referenced if it belongs to the sub-chat's workspace). NULL
 * if unknown/deleted.
 */
export function getArtifactWorkspaceId(id: string): string | null {
  const row = getArtifactRowByIdRaw(id);
  if (!row || row.deletedAt) return null;
  return row.workspaceId;
}

export async function listArtifacts(
  workspaceId: string,
  opts: {
    folderId?: string | null;
    actor: string;
    includeDeleted?: boolean;
    limit?: number;
  },
): Promise<CloudArtifactRow[]> {
  await assertCanRead(workspaceId, opts.actor);
  const db = getDb();

  const folderCond =
    opts.folderId === undefined
      ? undefined
      : opts.folderId === null
        ? isNull(cloudArtifacts.folderId)
        : eq(cloudArtifacts.folderId, opts.folderId);

  const conditions = [eq(cloudArtifacts.workspaceId, workspaceId)];
  if (folderCond) conditions.push(folderCond);
  if (!opts.includeDeleted) conditions.push(isNull(cloudArtifacts.deletedAt));

  const rows = db
    .select()
    .from(cloudArtifacts)
    .where(and(...conditions))
    .orderBy(desc(cloudArtifacts.createdAt))
    .limit(opts.limit ?? 200)
    .all();

  writeAudit({
    workspaceId,
    folderId: opts.folderId ?? null,
    action: "list",
    actor: opts.actor,
    metadata: { count: rows.length, folderId: opts.folderId ?? null },
  });

  return rows;
}

export async function deleteArtifact(
  id: string,
  actor: string,
): Promise<void> {
  const row = getArtifactRowByIdRaw(id);
  if (!row || row.deletedAt) {
    throw new CloudError(`Artifact ${id} nicht gefunden.`, "artifact-not-found");
  }
  await assertCanWrite(row.workspaceId, actor);
  const db = getDb();
  const now = new Date();
  db.update(cloudArtifacts)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(cloudArtifacts.id, id))
    .run();

  // GDPR-friendly soft delete: metadata stays for audit reconstruction,
  // but the bytes themselves are gone immediately. Prevents the "delete does not
  // mean delete" pattern. Best-effort: a storage fail must not undo the
  // DB mark — the cleanup cron clears orphans later.
  await getStorageBackend()
    .delete(row.storagePath)
    .catch((err) => {
      writeAudit({
        workspaceId: row.workspaceId,
        artifactId: id,
        action: "delete",
        actor: "system",
        metadata: { storage_delete_failed: String(err) },
      });
    });

  writeAudit({
    workspaceId: row.workspaceId,
    artifactId: id,
    action: "delete",
    actor,
  });
}

/* ------------------------------------------------------------------ */
/* Rename + Move (Phase ORG+4 — 2026-04-28)                            */
/* ------------------------------------------------------------------ */

export interface RenameArtifactInput {
  artifactId: string;
  newFilename: string;
  actor: string;
}

export async function renameArtifact(
  input: RenameArtifactInput,
): Promise<CloudArtifactRow> {
  const row = getArtifactRowByIdRaw(input.artifactId);
  if (!row || row.deletedAt) {
    throw new CloudError(
      `Artifact ${input.artifactId} nicht gefunden.`,
      "artifact-not-found",
    );
  }
  await assertCanWrite(row.workspaceId, input.actor);
  const cleanName = sanitizeFilename(input.newFilename);
  if (!cleanName) {
    throw new CloudError("Filename ungültig.", "validation");
  }
  const db = getDb();
  const now = new Date();
  db.update(cloudArtifacts)
    .set({ filename: cleanName, updatedAt: now })
    .where(eq(cloudArtifacts.id, input.artifactId))
    .run();
  writeAudit({
    workspaceId: row.workspaceId,
    artifactId: input.artifactId,
    action: "rename",
    actor: input.actor,
    metadata: { from: row.filename, to: cleanName },
  });
  const fresh = getArtifactRowByIdRaw(input.artifactId);
  if (!fresh) throw new CloudError("Rename verloren.", "validation");
  return fresh;
}

export interface MoveArtifactInput {
  artifactId: string;
  /** New folder_id; null = root of the workspace. */
  targetFolderId: string | null;
  actor: string;
}

export async function moveArtifact(
  input: MoveArtifactInput,
): Promise<CloudArtifactRow> {
  const row = getArtifactRowByIdRaw(input.artifactId);
  if (!row || row.deletedAt) {
    throw new CloudError(
      `Artifact ${input.artifactId} nicht gefunden.`,
      "artifact-not-found",
    );
  }
  await assertCanWrite(row.workspaceId, input.actor);
  if (input.targetFolderId) {
    await assertFolderInWorkspace(row.workspaceId, input.targetFolderId);
  }
  const db = getDb();
  const now = new Date();
  db.update(cloudArtifacts)
    .set({ folderId: input.targetFolderId, updatedAt: now })
    .where(eq(cloudArtifacts.id, input.artifactId))
    .run();
  writeAudit({
    workspaceId: row.workspaceId,
    artifactId: input.artifactId,
    action: "move",
    actor: input.actor,
    metadata: { from: row.folderId, to: input.targetFolderId },
  });
  const fresh = getArtifactRowByIdRaw(input.artifactId);
  if (!fresh) throw new CloudError("Move verloren.", "validation");
  return fresh;
}

export interface RenameFolderInput {
  folderId: string;
  newName: string;
  actor: string;
}

export async function renameFolder(
  input: RenameFolderInput,
): Promise<CloudFolderRow> {
  const folder = await getFolderById(input.folderId);
  if (!folder) {
    throw new CloudError(
      `Folder ${input.folderId} nicht gefunden.`,
      "folder-not-found",
    );
  }
  await assertCanWrite(folder.workspaceId, input.actor);
  const cleanName = sanitizeFolderName(input.newName);
  if (!cleanName) {
    throw new CloudError("Folder-Name ungültig.", "validation");
  }
  // Materialized-path update: old prefix → new prefix across all
  // descendants. SQLite LIKE replace via raw SQL.
  const db = getDb();
  const oldPath = folder.path;
  const parentPath =
    oldPath.lastIndexOf("/") > 0
      ? oldPath.slice(0, oldPath.lastIndexOf("/"))
      : "";
  const newPath = `${parentPath}/${cleanName}`;
  const now = new Date();

  db.$raw
    .prepare(
      `UPDATE cloud_folders
       SET path = ? || SUBSTR(path, ? + 1),
           updated_at = ?
       WHERE workspace_id = ? AND (path = ? OR path LIKE ? || '/%')`,
    )
    .run(
      newPath,
      oldPath.length,
      now.getTime(),
      folder.workspaceId,
      oldPath,
      oldPath,
    );
  // Additionally set the folder's own `name` to the new value.
  db.update(cloudFolders)
    .set({ name: cleanName, updatedAt: now })
    .where(eq(cloudFolders.id, input.folderId))
    .run();

  writeAudit({
    workspaceId: folder.workspaceId,
    folderId: input.folderId,
    action: "rename",
    actor: input.actor,
    metadata: { from: oldPath, to: newPath, name: cleanName },
  });
  const fresh = await getFolderById(input.folderId);
  if (!fresh) throw new CloudError("Rename verloren.", "validation");
  return fresh;
}

/* ------------------------------------------------------------------ */
/* Folders                                                             */
/* ------------------------------------------------------------------ */

export interface CreateFolderInput {
  workspaceId: string;
  name: string;
  parentId?: string | null;
  createdBy: string;
}

export async function createFolder(
  input: CreateFolderInput,
): Promise<CloudFolderRow> {
  await assertCanWrite(input.workspaceId, input.createdBy);
  const cleanName = sanitizeFolderName(input.name);
  if (!cleanName) {
    throw new CloudError(
      "Folder-Name leer oder ungültig (kein /, \\, ..).",
      "validation",
    );
  }

  let parentPath = "";
  if (input.parentId) {
    const parent = await getFolderById(input.parentId);
    if (!parent || parent.workspaceId !== input.workspaceId) {
      throw new CloudError(
        `Parent-Folder ${input.parentId} nicht gefunden oder anderer Workspace.`,
        "folder-not-found",
      );
    }
    parentPath = parent.path;
  }

  const id = `FLD-${ulid()}`;
  const fullPath = `${parentPath}/${cleanName}`;
  const now = new Date();
  const db = getDb();
  db.insert(cloudFolders)
    .values({
      id,
      workspaceId: input.workspaceId,
      parentId: input.parentId ?? null,
      name: cleanName,
      path: fullPath,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    })
    .run();

  writeAudit({
    workspaceId: input.workspaceId,
    folderId: id,
    action: "create-folder",
    actor: input.createdBy,
    metadata: { path: fullPath },
  });

  const row = await getFolderById(id);
  if (!row) throw new CloudError("Folder-Insert verloren.", "validation");
  return row;
}

export async function getFolderById(
  id: string,
): Promise<CloudFolderRow | null> {
  const db = getDb();
  const rows = db
    .select()
    .from(cloudFolders)
    .where(eq(cloudFolders.id, id))
    .limit(1)
    .all();
  const row = rows[0];
  return row && !row.deletedAt ? row : null;
}

async function assertFolderInWorkspace(
  workspaceId: string,
  folderId: string,
): Promise<void> {
  const folder = await getFolderById(folderId);
  if (!folder || folder.workspaceId !== workspaceId) {
    throw new CloudError(
      `Folder ${folderId} nicht im Workspace ${workspaceId}.`,
      "folder-not-found",
    );
  }
}

export async function listFolders(
  workspaceId: string,
  opts: { parentId?: string | null; actor: string } = { actor: "system" },
): Promise<CloudFolderRow[]> {
  await assertCanRead(workspaceId, opts.actor);
  const db = getDb();
  const conditions = [
    eq(cloudFolders.workspaceId, workspaceId),
    isNull(cloudFolders.deletedAt),
  ];
  if (opts.parentId !== undefined) {
    if (opts.parentId === null) {
      conditions.push(isNull(cloudFolders.parentId));
    } else {
      conditions.push(eq(cloudFolders.parentId, opts.parentId));
    }
  }
  return db
    .select()
    .from(cloudFolders)
    .where(and(...conditions))
    .orderBy(asc(cloudFolders.name))
    .all();
}

/* ------------------------------------------------------------------ */
/* Workspace-Cloud-Stats                                               */
/* ------------------------------------------------------------------ */

export async function workspaceCloudStats(workspaceId: string): Promise<{
  artifactCount: number;
  totalBytes: number;
  folderCount: number;
}> {
  const db = getDb();
  const counts = db
    .select({
      n: sql<number>`COUNT(*)`,
      bytes: sql<number>`COALESCE(SUM(${cloudArtifacts.bytes}), 0)`,
    })
    .from(cloudArtifacts)
    .where(
      and(
        eq(cloudArtifacts.workspaceId, workspaceId),
        isNull(cloudArtifacts.deletedAt),
      ),
    )
    .all();

  const folderCount = db
    .select({ n: sql<number>`COUNT(*)` })
    .from(cloudFolders)
    .where(
      and(
        eq(cloudFolders.workspaceId, workspaceId),
        isNull(cloudFolders.deletedAt),
      ),
    )
    .all();

  return {
    artifactCount: Number(counts[0]?.n ?? 0),
    totalBytes: Number(counts[0]?.bytes ?? 0),
    folderCount: Number(folderCount[0]?.n ?? 0),
  };
}

/**
 * Reads the PDF page count from the buffer. Heuristic via regex —
 * works for most PDF producers; for encrypted
 * or linearized PDFs possibly unreliable.
 *
 * Day-N: pdfjs for more robust extraction. Day-1 stays simple.
 */
function extractPdfPageCount(mime: string, data: Buffer): number | null {
  if (mime !== "application/pdf") return null;
  // Limit to the first 4 MB so as not to scan large PDFs completely.
  const slice = data.slice(0, Math.min(data.length, 4 * 1024 * 1024));
  const text = slice.toString("latin1");
  const matches = Array.from(text.matchAll(/\/Type\s*\/Page[^s]/g));
  if (matches.length > 0) return matches.length;
  return null;
}
