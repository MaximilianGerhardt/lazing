/**
 * Minimal Markdown→PDF renderer.
 *
 * Day 1: only basic block elements (H1/H2/H3, paragraph, bullet list,
 * numbered list, code block, horizontal rule, blockquote). Inline markup
 * (bold, italic, code-span, links) is rendered as plain text — that is
 * enough for reports / write-ups / concepts. More complex markup
 * (tables, footnotes, images) → Phase N (markdown-it + puppeteer).
 *
 * Output: buffer with PDF bytes, ready for `uploadArtifact()`.
 *
 * Design principle: simple, readable, printable. The SF-Pro look is not
 * available (no font-embedding setup), so we use Helvetica + Courier.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import PDFDocument from "pdfkit";

import { BRAND_NAME } from "@/lib/brand";

/**
 * Loads the bundled AFM built-in fonts from the pdfkit package and
 * registers them on the doc instance. Workaround for the Next.js
 * production build, where `__dirname` inside pdfkit points to an
 * incorrect `/ROOT/...` path and the built-in font loader throws
 * a 404.
 *
 * We read the AFMs from `process.cwd()/node_modules/pdfkit/js/data/`.
 * With `pnpm start` that is the repo root — works. Phase N: with
 * standalone output the path must be relative to the standalone server.
 */
const STANDARD_FONTS = [
  "Helvetica",
  "Helvetica-Bold",
  "Helvetica-Oblique",
  "Helvetica-BoldOblique",
  "Courier",
  "Courier-Bold",
] as const;

let cachedAfms: Map<string, Buffer> | null = null;

function loadStandardAfms(): Map<string, Buffer> {
  if (cachedAfms) return cachedAfms;
  // turbopackIgnore: true — otherwise Turbopack-NFT would trace the whole
  // node_modules tree as an asset and blow up the Vercel build.
  // These paths are only relevant at runtime (PDF generation).
  const cwd = /* turbopackIgnore: true */ process.cwd();
  const candidates = [
    path.join(cwd, "node_modules", "pdfkit", "js", "data"),
    path.join(
      cwd,
      "node_modules",
      ".pnpm",
      "pdfkit@0.18.0",
      "node_modules",
      "pdfkit",
      "js",
      "data",
    ),
  ];
  let dataDir: string | null = null;
  for (const c of candidates) {
    if (existsSync(c)) {
      dataDir = c;
      break;
    }
  }
  const out = new Map<string, Buffer>();
  if (!dataDir) {
    cachedAfms = out;
    return out;
  }
  for (const name of STANDARD_FONTS) {
    const p = path.join(dataDir, `${name}.afm`);
    if (existsSync(p)) {
      out.set(name, readFileSync(p));
    }
  }
  cachedAfms = out;
  return out;
}

function registerStandardFonts(doc: PDFKit.PDFDocument): void {
  const afms = loadStandardAfms();
  for (const [name, buf] of afms) {
    try {
      // pdfkit allows registerFont(name, buffer) — this replaces the
      // built-in lookup path with the explicit buffer contents.
      doc.registerFont(name, buf);
    } catch {
      // ignore — fallback to built-in (was probably break in prod)
    }
  }
}

export interface MarkdownToPdfInput {
  title: string;
  markdown: string;
  /** Footer text (small line at bottom right — optional, e.g. "Generated 2026-04-27"). */
  footer?: string;
  /** A4 (210×297 mm) is the default. */
  pageSize?: "A4" | "LETTER";
  /**
   * Phase ORG SP-7: resolved brand from `lib/branding/resolve.ts`.
   * If set → logo header, brand color as heading accent, footer imprint.
   */
  brand?: {
    orgName: string | null;
    workspaceLabel: string | null;
    logoUrl: string | null;
    brandColors: string[];
    imprintMd: string | null;
    addressLines: string[];
    vatId: string | null;
  };
  /**
   * Recipient context for GDPR auto-imprint:
   *   "external" + brand.imprintMd → imprint shown in the footer.
   *   "internal" → no imprint (minimal footer).
   */
  audience?: "internal" | "external";
}

const PAGE_MARGIN = 56; // ~2 cm

interface CodeBlockBuf {
  type: "code";
  lang: string | null;
  lines: string[];
}

type Block =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "bullet"; text: string }
  | { type: "numbered"; text: string; index: number }
  | { type: "blockquote"; text: string }
  | { type: "hr" }
  | CodeBlockBuf;

function parseMarkdown(md: string): Block[] {
  const out: Block[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");

  let i = 0;
  let numberedIndex = 0;
  let lastWasNumbered = false;

  while (i < lines.length) {
    const line = lines[i];

    // Code Fence
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim() || null;
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1; // skip closing fence
      out.push({ type: "code", lang, lines: codeLines });
      lastWasNumbered = false;
      continue;
    }

    // Empty line → break run
    if (line.trim().length === 0) {
      lastWasNumbered = false;
      numberedIndex = 0;
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line.trim())) {
      out.push({ type: "hr" });
      lastWasNumbered = false;
      i += 1;
      continue;
    }

    // Headings
    const h = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = h[1].length as 1 | 2 | 3;
      out.push({ type: "heading", level, text: h[2] });
      lastWasNumbered = false;
      i += 1;
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      out.push({ type: "blockquote", text: line.slice(2) });
      lastWasNumbered = false;
      i += 1;
      continue;
    }

    // Bullet
    if (/^[-*+]\s+/.test(line)) {
      out.push({ type: "bullet", text: line.replace(/^[-*+]\s+/, "") });
      lastWasNumbered = false;
      i += 1;
      continue;
    }

    // Numbered
    const num = /^(\d+)\.\s+(.+)$/.exec(line);
    if (num) {
      if (!lastWasNumbered) numberedIndex = 0;
      numberedIndex += 1;
      out.push({
        type: "numbered",
        text: num[2],
        index: numberedIndex,
      });
      lastWasNumbered = true;
      i += 1;
      continue;
    }

    // Paragraph — concat consecutive non-special lines
    const paragraphLines: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim().length > 0 &&
      !/^(#{1,3}\s|>\s|[-*+]\s|\d+\.\s|```|[-*_]{3,}\s*$)/.test(lines[i])
    ) {
      paragraphLines.push(lines[i]);
      i += 1;
    }
    out.push({
      type: "paragraph",
      text: paragraphLines.join(" ").replace(/\s+/g, " "),
    });
    lastWasNumbered = false;
  }

  return out;
}

/**
 * Inline stripping: removes Markdown inline markup so the plain text
 * is readable. Phase N: render real inline spans.
 */
function stripInline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1")
    .replace(/(?<!_)_([^_]+)_(?!_)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "[Bild: $1]")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/<\/?[a-z]+[^>]*>/gi, "");
}

export function markdownToPdfBuffer(
  input: MarkdownToPdfInput,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const blocks = parseMarkdown(input.markdown);
      const doc = new PDFDocument({
        size: input.pageSize ?? "A4",
        margins: {
          top: PAGE_MARGIN,
          bottom: PAGE_MARGIN,
          left: PAGE_MARGIN,
          right: PAGE_MARGIN,
        },
        info: {
          Title: input.title,
          Producer: `${BRAND_NAME} Cloud`,
          Creator: `${BRAND_NAME} Cloud · markdown-to-pdf`,
        },
      });

      // Register standard fonts via buffer — workaround for the
      // Next.js production __dirname mismatch.
      registerStandardFonts(doc);

      const chunks: Buffer[] = [];
      doc.on("data", (c) => chunks.push(c as Buffer));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // ── BRAND HEADER (SP-7) ──────────────────────────────────────────
      // If brand is passed: logo left, org name top right, WS small
      // below it, then brand-color line as accent.
      const brand = input.brand;
      const accentColor =
        brand?.brandColors[0] && /^#[0-9a-fA-F]{3,8}$/.test(brand.brandColors[0])
          ? brand.brandColors[0]
          : "#dddddd";

      if (brand && (brand.orgName || brand.logoUrl)) {
        const headerStartY = doc.y;
        // Logo (if present + local/data URL — we block external URLs on
        // Day 1 due to async-fetch complexity; Phase N).
        if (brand.logoUrl && /^(\/|data:)/.test(brand.logoUrl)) {
          try {
            doc.image(brand.logoUrl, PAGE_MARGIN, headerStartY, {
              fit: [48, 48],
            });
          } catch {
            // Logo load fail: silent ignore, render the header anyway.
          }
        }
        // Text to the right of the logo.
        const textX = PAGE_MARGIN + 60;
        if (brand.orgName) {
          doc
            .font("Helvetica-Bold")
            .fontSize(13)
            .fillColor("#111111")
            .text(brand.orgName, textX, headerStartY + 4, {
              width: doc.page.width - textX - PAGE_MARGIN,
              align: "left",
            });
        }
        if (brand.workspaceLabel) {
          doc
            .font("Helvetica")
            .fontSize(9)
            .fillColor("#666666")
            .text(brand.workspaceLabel, textX, doc.y + 2, {
              width: doc.page.width - textX - PAGE_MARGIN,
              align: "left",
            });
        }
        // Y cursor below the header.
        doc.y = Math.max(headerStartY + 56, doc.y + 4);
        // Brand-color line.
        doc
          .strokeColor(accentColor)
          .lineWidth(1.0)
          .moveTo(PAGE_MARGIN, doc.y)
          .lineTo(doc.page.width - PAGE_MARGIN, doc.y)
          .stroke();
        doc.moveDown(0.8);
      }

      // Title-Block
      doc
        .font("Helvetica-Bold")
        .fontSize(22)
        .fillColor("#0a0a0a")
        .text(input.title, { align: "left" });

      doc
        .moveDown(0.4)
        .font("Helvetica")
        .fontSize(9)
        .fillColor("#666666")
        .text(new Date().toLocaleDateString("de-DE", {
          year: "numeric",
          month: "long",
          day: "numeric",
        }));

      doc
        .moveDown(1.2)
        .strokeColor(brand ? accentColor : "#dddddd")
        .lineWidth(0.5)
        .moveTo(PAGE_MARGIN, doc.y)
        .lineTo(doc.page.width - PAGE_MARGIN, doc.y)
        .stroke();

      doc.moveDown(0.8);

      // Blocks
      for (const block of blocks) {
        if (block.type === "heading") {
          doc.moveDown(block.level === 1 ? 0.7 : 0.4);
          doc
            .font("Helvetica-Bold")
            .fontSize(block.level === 1 ? 18 : block.level === 2 ? 15 : 12)
            .fillColor("#111111")
            .text(stripInline(block.text));
          doc.moveDown(0.25);
          continue;
        }

        if (block.type === "paragraph") {
          doc
            .font("Helvetica")
            .fontSize(11)
            .fillColor("#1a1a1a")
            .text(stripInline(block.text), {
              align: "left",
              lineGap: 2,
            });
          doc.moveDown(0.4);
          continue;
        }

        if (block.type === "bullet") {
          doc
            .font("Helvetica")
            .fontSize(11)
            .fillColor("#1a1a1a")
            .text(`•  ${stripInline(block.text)}`, {
              indent: 12,
              align: "left",
              lineGap: 2,
            });
          doc.moveDown(0.15);
          continue;
        }

        if (block.type === "numbered") {
          doc
            .font("Helvetica")
            .fontSize(11)
            .fillColor("#1a1a1a")
            .text(`${block.index}.  ${stripInline(block.text)}`, {
              indent: 12,
              align: "left",
              lineGap: 2,
            });
          doc.moveDown(0.15);
          continue;
        }

        if (block.type === "blockquote") {
          const startY = doc.y;
          doc
            .font("Helvetica-Oblique")
            .fontSize(11)
            .fillColor("#444444")
            .text(stripInline(block.text), {
              indent: 14,
              align: "left",
              lineGap: 2,
            });
          // Vertical line on the left
          doc
            .strokeColor("#cccccc")
            .lineWidth(2)
            .moveTo(PAGE_MARGIN + 4, startY)
            .lineTo(PAGE_MARGIN + 4, doc.y - 2)
            .stroke();
          doc.moveDown(0.4);
          continue;
        }

        if (block.type === "hr") {
          doc.moveDown(0.5);
          doc
            .strokeColor("#dddddd")
            .lineWidth(0.5)
            .moveTo(PAGE_MARGIN, doc.y)
            .lineTo(doc.page.width - PAGE_MARGIN, doc.y)
            .stroke();
          doc.moveDown(0.5);
          continue;
        }

        if (block.type === "code") {
          // Background box
          const boxX = PAGE_MARGIN;
          const boxW = doc.page.width - 2 * PAGE_MARGIN;
          const lineHeight = 13;
          const padding = 8;
          const boxH = block.lines.length * lineHeight + 2 * padding;
          doc
            .rect(boxX, doc.y, boxW, boxH)
            .fillColor("#f4f4f4")
            .fill();
          // Code text
          doc
            .font("Courier")
            .fontSize(9)
            .fillColor("#222222")
            .text(block.lines.join("\n"), boxX + padding, doc.y - boxH + padding, {
              width: boxW - 2 * padding,
            });
          doc.moveDown(0.5);
          continue;
        }
      }

      // Footer (Phase ORG SP-7: Imprint-Auto-Insertion + Footer-Text)
      const showImprint =
        input.audience === "external" &&
        brand?.imprintMd &&
        brand.imprintMd.trim().length > 0;

      if (input.footer || showImprint) {
        const range = doc.bufferedPageRange();
        for (let p = range.start; p < range.start + range.count; p += 1) {
          doc.switchToPage(p);
          // Imprint block (GDPR on external recipient detection)
          if (showImprint && brand?.imprintMd) {
            const imprintLines = brand.imprintMd
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean)
              .slice(0, 4)
              .join(" · ");
            doc
              .font("Helvetica-Oblique")
              .fontSize(7)
              .fillColor("#888888")
              .text(
                imprintLines,
                PAGE_MARGIN,
                doc.page.height - PAGE_MARGIN + 10,
                {
                  width: doc.page.width - 2 * PAGE_MARGIN,
                  align: "left",
                  lineBreak: false,
                },
              );
          }
          // Page counter centered
          const pageNum = p - range.start + 1;
          doc
            .font("Helvetica")
            .fontSize(7)
            .fillColor("#aaaaaa")
            .text(
              `${pageNum} / ${range.count}`,
              PAGE_MARGIN,
              doc.page.height - PAGE_MARGIN + 22,
              {
                width: doc.page.width - 2 * PAGE_MARGIN,
                align: "center",
                lineBreak: false,
              },
            );
          // User footer on the right
          if (input.footer) {
            doc
              .font("Helvetica")
              .fontSize(8)
              .fillColor("#888888")
              .text(
                input.footer,
                PAGE_MARGIN,
                doc.page.height - PAGE_MARGIN + 10,
                {
                  width: doc.page.width - 2 * PAGE_MARGIN,
                  align: "right",
                  lineBreak: false,
                },
              );
          }
        }
      }

      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
