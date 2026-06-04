/**
 * /api/cloud/[id]/thumb
 *
 * Day-1: returnt einen schlichten SVG-Placeholder mit Filename + Mime.
 * Day-N: echte Thumbnails (poppler/pdftoppm für PDF, sharp für Images,
 * libreoffice-headless für DOCX/XLSX) — Generation läuft asynchron im
 * Cloud-Service nach Upload und schreibt thumbnailPath zurück.
 *
 * Wenn `thumbnailPath` gesetzt ist, streamen wir die Datei direkt.
 * Sonst Placeholder.
 */

import { NextResponse, type NextRequest } from "next/server";

import { resolveActor } from "@/lib/cloud/actor";
import { CloudError, getArtifact } from "@/lib/cloud/service";
import { getStorageBackend } from "@/lib/cloud/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const actor = resolveActor(req);

  let row: import("@/db/schema/cloud").CloudArtifactRow;
  try {
    row = await getArtifact(id, actor);
  } catch (err) {
    if (err instanceof CloudError) {
      return NextResponse.json(
        { error: err.code, message: err.message },
        {
          status:
            err.code === "artifact-not-found" ? 404 : 403,
        },
      );
    }
    throw err;
  }

  if (row.thumbnailPath) {
    try {
      const stream = await getStorageBackend().getStream(row.thumbnailPath);
      return new Response(stream as unknown as ReadableStream, {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "private, max-age=300",
        },
      });
    } catch {
      // Fallthrough zu Placeholder
    }
  }

  return new Response(buildPlaceholderSvg(row), {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "private, max-age=60",
    },
  });
}

function buildPlaceholderSvg(
  row: import("@/db/schema/cloud").CloudArtifactRow,
): string {
  const ext = (row.filename.split(".").pop() || "?").slice(0, 6).toUpperCase();
  const sizeKb = (row.bytes / 1024).toFixed(0);
  // Schlichter Placeholder — pitch-black Canvas-Sprache mit passendem Akzent.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="260" viewBox="0 0 200 260">
  <rect width="200" height="260" rx="12" fill="#0b0b0b" stroke="#1f1f1f" stroke-width="1"/>
  <rect x="20" y="20" width="160" height="200" rx="6" fill="#141414" stroke="#222" stroke-width="1"/>
  <text x="100" y="120" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo" font-size="32" font-weight="600" fill="#e6e6e6">${escapeXml(ext)}</text>
  <text x="100" y="150" text-anchor="middle" font-family="ui-sans-serif,system-ui" font-size="11" fill="#7a7a7a">${escapeXml(sizeKb)} KB</text>
  <text x="100" y="245" text-anchor="middle" font-family="ui-sans-serif,system-ui" font-size="10" fill="#5a5a5a">${escapeXml(truncate(row.filename, 28))}</text>
</svg>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
