/**
 * /api/cloud/generate
 *
 * POST { workspace, type:"markdown-to-pdf", title, markdown, folder?, footer? }
 * Generates a PDF from Markdown, uploads it to the workspace cloud, and
 * returns the finished surface-markup line so the caller (agent or
 * UI) can insert it directly into the chat.
 *
 * The endpoint is auth-gated like all cloud routes — the sensitivity floor
 * and workspace-existence check happen transitively via uploadArtifact().
 *
 * Day-1: only `markdown-to-pdf`. Phase-N: `json-to-xlsx`, `md-to-docx`.
 */

import { NextResponse, type NextRequest } from "next/server";

import { BRAND_NAME } from "@/lib/brand";
import { resolveActor } from "@/lib/cloud/actor";
import {
  CloudError,
  uploadArtifact,
} from "@/lib/cloud/service";
import { markdownToPdfBuffer } from "@/lib/cloud/pdf-from-markdown";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 5 MB hard cap on Markdown input — prevents RAM hogs.
const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;

interface GenerateBody {
  workspace?: string;
  type?: string;
  title?: string;
  markdown?: string;
  /** Built-in skill json-to-xlsx (2026-06-03): { sheets:[{name?,headers[],rows[][]}] }. */
  data?: { sheets?: unknown } | unknown;
  /** Design-deck path html-to-pdf (2026-06-03): full HTML → PDF. */
  html?: string;
  /** html-to-pdf: landscape (decks). */
  landscape?: boolean;
  folder?: string | null;
  footer?: string;
  metadata?: Record<string, unknown>;
}

function sanitizeTitleForFilename(title: string): string {
  return title
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: GenerateBody;
  try {
    body = (await req.json()) as GenerateBody;
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const workspace = body.workspace?.trim();
  const type = body.type?.trim() ?? "markdown-to-pdf";
  const title = body.title?.trim() ?? "";
  const markdown = body.markdown ?? "";

  if (!workspace) {
    return NextResponse.json({ error: "missing-workspace" }, { status: 400 });
  }
  if (!title) {
    return NextResponse.json({ error: "missing-title" }, { status: 400 });
  }
  const SUPPORTED = ["markdown-to-pdf", "json-to-xlsx", "markdown-to-docx", "json-to-pptx", "html-to-pdf"];
  if (!SUPPORTED.includes(type)) {
    return NextResponse.json(
      { error: "unsupported-type", supported: SUPPORTED },
      { status: 400 },
    );
  }
  if (type === "markdown-to-pdf" || type === "markdown-to-docx") {
    if (markdown.length === 0) {
      return NextResponse.json({ error: "missing-markdown" }, { status: 400 });
    }
    if (Buffer.byteLength(markdown, "utf8") > MAX_MARKDOWN_BYTES) {
      return NextResponse.json(
        { error: "markdown-too-large", maxBytes: MAX_MARKDOWN_BYTES },
        { status: 413 },
      );
    }
  }

  const actor = resolveActor(req);

  // Phase ORG SP-7: resolve the brand (Org → Workspace → Default).
  const { resolveBrand } = await import("@/lib/branding/resolve");
  const brand = resolveBrand({ workspaceId: workspace });
  const audience: "internal" | "external" =
    (body as { audience?: "internal" | "external" }).audience === "external"
      ? "external"
      : "internal";

  // Type-dependent generation → { buffer, filename, mime }. Both paths share
  // the uploadArtifact/surface path below (DRY).
  let outBuffer: Buffer;
  let filename: string;
  let mime: string;
  if (type === "json-to-xlsx") {
    const { dataToXlsxBuffer, XLSX_MIME, XlsxError } = await import("@/lib/cloud/xlsx-from-data");
    const data = (body.data ?? {}) as { sheets?: unknown };
    const sheets = Array.isArray(data.sheets) ? data.sheets : [];
    if (sheets.length === 0) {
      return NextResponse.json(
        { error: "missing-data", hint: "Erwarte { data: { sheets: [{ headers, rows }] } }" },
        { status: 400 },
      );
    }
    try {
      outBuffer = await dataToXlsxBuffer({
        title,
        creator: brand.orgName ?? "laz.ing",
        sheets: sheets as { name?: string; headers: string[]; rows: (string | number | boolean | null)[][] }[],
      });
    } catch (err) {
      const status = err instanceof XlsxError ? 400 : 500;
      return NextResponse.json(
        { error: "xlsx-generation-failed", message: err instanceof Error ? err.message : "unknown" },
        { status },
      );
    }
    filename = `${sanitizeTitleForFilename(title) || "tabelle"}.xlsx`;
    mime = XLSX_MIME;
  } else if (type === "markdown-to-docx") {
    const { markdownToDocxBuffer, DOCX_MIME, DocxError } = await import("@/lib/cloud/docx-from-markdown");
    try {
      outBuffer = await markdownToDocxBuffer({
        title,
        markdown,
        creator: brand.orgName ?? "laz.ing",
      });
    } catch (err) {
      const status = err instanceof DocxError ? 400 : 500;
      return NextResponse.json(
        { error: "docx-generation-failed", message: err instanceof Error ? err.message : "unknown" },
        { status },
      );
    }
    filename = `${sanitizeTitleForFilename(title) || "dokument"}.docx`;
    mime = DOCX_MIME;
  } else if (type === "json-to-pptx") {
    const { dataToPptxBuffer, PPTX_MIME, PptxError } = await import("@/lib/cloud/pptx-from-data");
    const data = (body.data ?? {}) as { slides?: unknown; subtitle?: unknown };
    const slides = Array.isArray(data.slides) ? data.slides : [];
    if (slides.length === 0) {
      return NextResponse.json(
        { error: "missing-data", hint: "Erwarte { data: { slides: [{ title, bullets[] }] } }" },
        { status: 400 },
      );
    }
    try {
      outBuffer = await dataToPptxBuffer({
        title,
        author: brand.orgName ?? "laz.ing",
        ...(typeof data.subtitle === "string" ? { subtitle: data.subtitle } : {}),
        slides: slides as { title?: string; bullets?: string[]; body?: string }[],
      });
    } catch (err) {
      const status = err instanceof PptxError ? 400 : 500;
      return NextResponse.json(
        { error: "pptx-generation-failed", message: err instanceof Error ? err.message : "unknown" },
        { status },
      );
    }
    filename = `${sanitizeTitleForFilename(title) || "praesentation"}.pptx`;
    mime = PPTX_MIME;
  } else if (type === "html-to-pdf") {
    const html = typeof body.html === "string" ? body.html : "";
    if (html.trim().length === 0) {
      return NextResponse.json(
        { error: "missing-html", hint: "Erwarte { html: '<!doctype html>…' }" },
        { status: 400 },
      );
    }
    const { htmlToPdfBuffer, HtmlToPdfError } = await import("@/lib/cloud/html-to-pdf");
    try {
      outBuffer = await htmlToPdfBuffer({
        html,
        landscape: body.landscape === true,
      });
    } catch (err) {
      const status = err instanceof HtmlToPdfError ? 400 : 500;
      return NextResponse.json(
        { error: "html-pdf-generation-failed", message: err instanceof Error ? err.message : "unknown" },
        { status },
      );
    }
    filename = `${sanitizeTitleForFilename(title) || "deck"}.pdf`;
    mime = "application/pdf";
  } else {
    let pdfBuffer: Buffer;
    try {
      pdfBuffer = await markdownToPdfBuffer({
        title,
        markdown,
        footer:
          body.footer ??
          `${brand.orgName ?? BRAND_NAME} · ${workspace} · ${new Date().toISOString().slice(0, 10)}`,
        brand: {
          orgName: brand.orgName,
          workspaceLabel: brand.workspaceLabel,
          logoUrl: brand.logoUrl,
          brandColors: brand.brandColors,
          imprintMd: brand.imprintMd,
          addressLines: brand.addressLines,
          vatId: brand.vatId,
        },
        audience,
      });
    } catch (err) {
      return NextResponse.json(
        {
          error: "pdf-generation-failed",
          message: err instanceof Error ? err.message : "unknown",
        },
        { status: 500 },
      );
    }
    outBuffer = pdfBuffer;
    filename = `${sanitizeTitleForFilename(title) || "document"}.pdf`;
    mime = "application/pdf";
  }

  try {
    const row = await uploadArtifact({
      workspaceId: workspace,
      filename,
      mime,
      data: outBuffer,
      folderId: body.folder ?? null,
      createdBy: actor,
      metadata: {
        ...body.metadata,
        generated: true,
        generatorType: type,
        sourceTitle: title,
      },
    });

    const surfacePayload = {
      id: row.id,
      filename: row.filename,
      mime: row.mime,
      bytes: row.bytes,
      pages: row.pages,
      workspace: row.workspaceId,
      downloadUrl: `/api/cloud/${row.id}`,
      previewUrl: `/api/cloud/${row.id}/preview`,
      thumbnailUrl: `/api/cloud/${row.id}/thumb`,
    };

    return NextResponse.json(
      {
        artifact: {
          id: row.id,
          filename: row.filename,
          mime: row.mime,
          bytes: row.bytes,
          pages: row.pages,
          downloadUrl: surfacePayload.downloadUrl,
          previewUrl: surfacePayload.previewUrl,
          thumbnailUrl: surfacePayload.thumbnailUrl,
        },
        // Finished surface-markup line for direct insertion into the chat history
        surfaceMarkup: `<surface:document>${JSON.stringify(surfacePayload)}</surface:document>`,
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof CloudError) {
      const status =
        err.code === "workspace-not-found"
          ? 404
          : err.code === "sensitivity-blocked" || err.code === "archived-blocked"
            ? 403
            : err.code === "validation"
              ? 400
              : 500;
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status },
      );
    }
    console.error("[/api/cloud/generate] unexpected error:", err);
    return NextResponse.json(
      { error: "internal", message: (err as Error).message },
      { status: 500 },
    );
  }
}
