/**
 * lib/cloud/docx-from-markdown.ts — Markdown → DOCX (Built-In-Skills, 2026-06-03).
 *
 * Local, N2/N9-compliant Word generation (NO Anthropic cloud sandbox) for
 * client deliverables: quotes, reports, minutes. Used by the
 * `markdown-to-docx` branch in /api/cloud/generate and lands — like the
 * XLSX — via uploadArtifact in the workspace cloud + as <surface:document> in the chat.
 *
 * Pure Node (docx v9). Deterministic. N1: do NOT discard/truncate text.
 * N2: no global fallback — scope validation is the caller's responsibility.
 */

import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';

export interface DocxInput {
  /** Document title (metadata). */
  title: string;
  /** Markdown source — parsed deterministically line by line (N1). */
  markdown: string;
  /** Optional author for document metadata (default: 'laz.ing'). */
  creator?: string;
}

export class DocxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocxError';
  }
}

export const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Regex-split a line on **bold** and `code` spans → TextRun[]. N1: no text lost. */
function parseInlineRuns(line: string): TextRun[] {
  // Tokenization: **bold** and `code` in one pass via alternation.
  const TOKEN_RE = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  const runs: TextRun[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TOKEN_RE.exec(line)) !== null) {
    const before = line.slice(lastIndex, match.index);
    if (before) {
      runs.push(new TextRun({ text: before }));
    }
    const token = match[0];
    if (token.startsWith('**')) {
      // **bold** → text without asterisks, bold:true
      runs.push(new TextRun({ text: token.slice(2, -2), bold: true }));
    } else {
      // `code` → text without backticks, monospace
      runs.push(new TextRun({ text: token.slice(1, -1), font: 'Courier New' }));
    }
    lastIndex = TOKEN_RE.lastIndex;
  }

  // Remainder of the line after the last token (N1: verbatim)
  const tail = line.slice(lastIndex);
  if (tail) {
    runs.push(new TextRun({ text: tail }));
  }

  // Empty-line guard: at least one empty TextRun so the paragraph is not empty.
  if (runs.length === 0) {
    runs.push(new TextRun({ text: '' }));
  }

  return runs;
}

/**
 * Parses a Markdown string line by line deterministically into docx paragraphs.
 * Supported syntax (N1: everything else is emitted verbatim as a normal paragraph):
 *  - `# ` `## ` `### `         → Heading 1/2/3
 *  - `- ` or `* `             → bullet level 0
 *  - `1. ` `2. ` … (number.) → normal paragraph incl. numbering verbatim (N1)
 *  - empty line               → empty paragraph (vertical spacing)
 *  - inline **bold** / `code` → TextRun with the corresponding formats
 */
function markdownToParagraphs(markdown: string): Paragraph[] {
  const lines = markdown.split(/\r?\n/);
  const paragraphs: Paragraph[] = [];

  for (const raw of lines) {
    // Empty line → empty paragraph (spacing)
    if (raw.trim() === '') {
      paragraphs.push(new Paragraph({ children: [new TextRun({ text: '' })] }));
      continue;
    }

    // Heading 1: `# Text`
    if (/^# /.test(raw)) {
      const text = raw.slice(2);
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: parseInlineRuns(text),
        }),
      );
      continue;
    }

    // Heading 2: `## Text`
    if (/^## /.test(raw)) {
      const text = raw.slice(3);
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: parseInlineRuns(text),
        }),
      );
      continue;
    }

    // Heading 3: `### Text`
    if (/^### /.test(raw)) {
      const text = raw.slice(4);
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_3,
          children: parseInlineRuns(text),
        }),
      );
      continue;
    }

    // Bullet: `- text` or `* text` (not `**bold**` — those start with `**`)
    if (/^[-*] /.test(raw)) {
      const text = raw.slice(2);
      paragraphs.push(
        new Paragraph({
          bullet: { level: 0 },
          children: parseInlineRuns(text),
        }),
      );
      continue;
    }

    // Numbered item: `1. ` `12. ` etc. — N1: emit verbatim (incl. number)
    if (/^\d+\. /.test(raw)) {
      paragraphs.push(
        new Paragraph({
          children: parseInlineRuns(raw),
        }),
      );
      continue;
    }

    // Normal paragraph (fallback, N1: verbatim)
    paragraphs.push(
      new Paragraph({
        children: parseInlineRuns(raw),
      }),
    );
  }

  return paragraphs;
}

/**
 * Builds a DOCX as a buffer from a Markdown string.
 * Throws DocxError on empty markdown.
 */
export async function markdownToDocxBuffer(input: DocxInput): Promise<Buffer> {
  if (!input.markdown || input.markdown.trim() === '') {
    throw new DocxError('Leeres markdown übergeben.');
  }

  const paragraphs = markdownToParagraphs(input.markdown);

  const doc = new Document({
    creator: input.creator ?? 'laz.ing',
    title: input.title,
    sections: [
      {
        children: paragraphs,
      },
    ],
  });

  const result = await Packer.toBuffer(doc);
  // Packer.toBuffer returns a Node Buffer or Uint8Array — Buffer.from ensures a Buffer instance.
  // Double cast via unknown, since TypeScript refuses Buffer↔ArrayBuffer overlap (TS2352).
  return Buffer.from(result as unknown as ArrayBuffer);
}
