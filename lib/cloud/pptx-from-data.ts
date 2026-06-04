/**
 * lib/cloud/pptx-from-data.ts — JSON → PPTX (Built-In-Skills, 2026-06-03).
 *
 * Local, N2/N9-compliant PowerPoint generation (NO Anthropic cloud sandbox) for
 * client deliverables: presentations, proposals, reports. Used by the
 * `json-to-pptx` branch in /api/cloud/generate and lands — like XLSX + PDF —
 * via uploadArtifact in the workspace cloud + as <surface:document> in the chat.
 *
 * Pure Node (pptxgenjs v4). Deterministic. N1: bullet texts verbatim (no slice).
 * N2: no global RAG fallback — the scope envelope is the caller's responsibility.
 */

import pptxgen from 'pptxgenjs';

export interface PptxSlideInput {
  /** Slide title (heading, bold, fontSize ~28). */
  title?: string;
  /** Bullet points — verbatim, N1: do not truncate. */
  bullets?: string[];
  /** Optional paragraph text below the bullets. */
  body?: string;
}

export interface PptxInput {
  /** Presentation title (title slide, large). */
  title: string;
  /** Optional subtitle on the title slide. */
  subtitle?: string;
  /** 1..n content slides. */
  slides: PptxSlideInput[];
  /** Metadata author. Default: 'laz.ing'. */
  author?: string;
}

export class PptxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PptxError';
  }
}

export const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const MAX_SLIDES = 200;
const MAX_BULLETS = 100;

/**
 * Builds a PPTX presentation as a buffer. Throws PptxError on empty/invalid input
 * or when the defensive limits are exceeded (N11 resource protection).
 */
export async function dataToPptxBuffer(input: PptxInput): Promise<Buffer> {
  if (!input || !Array.isArray(input.slides) || input.slides.length === 0) {
    throw new PptxError('Keine Folien übergeben.');
  }
  if (input.slides.length > MAX_SLIDES) {
    throw new PptxError(`Zu viele Folien (max ${MAX_SLIDES}).`);
  }

  // CJS default export — dynamic import as a safeguard against a strict-ESM setup.
  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_WIDE'; // 16:9 (13.33" × 7.5")
  pptx.author = (input.author ?? 'laz.ing').slice(0, 120);
  pptx.title = input.title.slice(0, 255);

  // --- Title slide ---
  const titleSlide = pptx.addSlide();
  titleSlide.addText(input.title, {
    x: 0.5,
    y: 2.2,
    w: '90%',
    fontSize: 40,
    bold: true,
    align: 'center',
    color: '363636',
  });
  if (input.subtitle) {
    titleSlide.addText(input.subtitle, {
      x: 0.5,
      y: 3.4,
      w: '90%',
      fontSize: 22,
      align: 'center',
      color: '666666',
    });
  }

  // --- Content slides ---
  for (let i = 0; i < input.slides.length; i++) {
    const s = input.slides[i]!;
    const bullets = Array.isArray(s.bullets) ? s.bullets : [];

    if (bullets.length > MAX_BULLETS) {
      throw new PptxError(
        `Zu viele Bullets in Folie ${i + 1} (max ${MAX_BULLETS}).`,
      );
    }

    const slide = pptx.addSlide();

    // Heading
    if (s.title) {
      slide.addText(s.title, {
        x: 0.5,
        y: 0.3,
        w: '92%',
        fontSize: 28,
        bold: true,
        color: '222222',
      });
    }

    // Bullets — N1: verbatim, no truncation
    if (bullets.length > 0) {
      const bulletY = s.title ? 1.1 : 0.5;
      const bulletItems = bullets.map((text) => ({
        text: `• ${text}`, // • + verbatim
        options: { fontSize: 18, color: '333333', breakLine: true },
      }));
      slide.addText(bulletItems, {
        x: 0.5,
        y: bulletY,
        w: '92%',
        h: s.body ? 3.5 : 5.5,
        fontSize: 18,
        color: '333333',
        valign: 'top',
      });
    }

    // Body paragraph (optional)
    if (s.body) {
      const bodyY = s.title
        ? bullets.length > 0
          ? 4.8
          : 1.1
        : bullets.length > 0
          ? 4.8
          : 0.5;
      slide.addText(s.body, {
        x: 0.5,
        y: bodyY,
        w: '92%',
        fontSize: 16,
        color: '555555',
        italic: true,
      });
    }
  }

  const raw = await pptx.write({ outputType: 'nodebuffer' });
  if (Buffer.isBuffer(raw)) return raw;
  // pptxgenjs may return an ArrayBuffer or Uint8Array depending on the environment.
  if (raw instanceof Uint8Array) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  // ArrayBuffer fallback
  return Buffer.from(raw as unknown as ArrayBuffer);
}
