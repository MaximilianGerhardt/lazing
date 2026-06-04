/**
 * Thumbnail-Generator (Phase ORG+5 — 2026-04-28).
 *
 * Day-1:
 *   - image/* → sharp resize 256x256, fit:cover, PNG-output
 *   - application/pdf → SKIP (Phase-N needs poppler or pdf2pic;
 *     fallback stays the SVG placeholder from /api/cloud/[id]/thumb)
 *   - others → SKIP (SVG placeholder)
 *
 * Encrypted workspaces (encryption_version >= 1):
 *   Day-1 SKIP — thumbnails are NOT generated for sensitive files
 *   because they would otherwise lie unencrypted in the _thumbs/ directory.
 *   Phase-N: encrypted thumbnails over the same DEK path.
 *
 * Async pattern: the service returns after uploadArtifact. The caller
 * can optionally trigger `generateThumbnailAsync()` to run the thumbnail
 * generation in the background — the DB row is updated with
 * `thumbnail_path` when done.
 */

import { eq } from "drizzle-orm";
import sharp from "sharp";

import { getDb } from "@/db/client";
import { cloudArtifacts } from "@/db/schema/cloud";
import { getStorageBackend } from "./storage";

export const THUMB_SIZE = 256;

export function isThumbnailableMime(mime: string): boolean {
  return mime.startsWith("image/") && mime !== "image/svg+xml";
}

/**
 * Generates the thumbnail synchronously + stores it + updates
 * cloud_artifacts.thumbnail_path. Returns true if a thumb was generated,
 * false on skip or fail.
 */
export async function generateAndStoreThumbnail(
  artifactId: string,
  workspaceId: string,
  storagePath: string,
  mime: string,
  encryptionVersion: number,
): Promise<boolean> {
  // SKIP for encrypted (Day-1) and non-image
  if (encryptionVersion >= 1) return false;
  if (!isThumbnailableMime(mime)) return false;

  try {
    const storage = getStorageBackend();
    const buffer = await storage.get(storagePath);

    const thumbBuffer = await sharp(buffer)
      .rotate() // EXIF auto-orient
      .resize({
        width: THUMB_SIZE,
        height: THUMB_SIZE,
        fit: "cover",
        position: "center",
      })
      .png({ compressionLevel: 8 })
      .toBuffer();

    const thumbPath = `${workspaceId}/_thumbs/${artifactId}.png`;
    await storage.put(thumbPath, thumbBuffer);

    const db = getDb();
    db.update(cloudArtifacts)
      .set({ thumbnailPath: thumbPath, updatedAt: new Date() })
      .where(eq(cloudArtifacts.id, artifactId))
      .run();

    return true;
  } catch (err) {
    console.warn(
      "[thumbnails] generation failed for",
      artifactId,
      ":",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Async variant: fires the generation on the next tick + ignores the
 * result. The caller does not wait; the DB is updated asynchronously.
 */
export function generateThumbnailAsync(
  artifactId: string,
  workspaceId: string,
  storagePath: string,
  mime: string,
  encryptionVersion: number,
): void {
  setImmediate(() => {
    void generateAndStoreThumbnail(
      artifactId,
      workspaceId,
      storagePath,
      mime,
      encryptionVersion,
    );
  });
}
